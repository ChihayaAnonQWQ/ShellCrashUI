#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
构建 luci-app-shellcrashui 的安装包（纯 Python 标准库，跨平台）。

一次产出三种格式：

  1. .ipk    —— OpenWrt 24.10 及更早（opkg）
                 opkg install luci-app-shellcrashui_1.0.0-1_all.ipk

  2. .apk    —— OpenWrt 25.12 及以后（apk-tools 3）
                 apk add --allow-untrusted ./luci-app-shellcrashui-1.0.0-r1.apk

  3. .tar.gz —— 手动安装包（任何版本都能用，不依赖包管理器）
                 tar -xzf luci-app-shellcrashui-1.0.0-rootfs.tar.gz -C /

三种格式包含完全相同的文件内容，且都是架构无关的（ipk 为 all，
apk 为 noarch），因此在 aarch64 / arm64 目标上可直接使用。

用法：
    python3 build.py                       # 全部构建
    python3 build.py --format apk          # 只构建 apk
    python3 build.py --src .. --out ../dist
"""

import argparse
import gzip
import hashlib
import io
import os
import sys
import tarfile
import time

# ----------------------------------------------------------------- 包元信息

PKG_NAME = "luci-app-shellcrashui"
PKG_VERSION = "1.0.0"
PKG_RELEASE = "1"
PKG_LICENSE = "MIT"
PKG_MAINTAINER = "luci-app-shellcrashui contributors"
PKG_URL = "https://github.com/juewuy/ShellCrash"

PKG_DESCRIPTION = (
    "LuCI support for ShellCrash control and Zashboard panel\n"
    " Web UI to control the ShellCrash service (start / stop / restart /\n"
    " autostart), show core, API and panel status, and launch or deploy the\n"
    " Zashboard panel. Architecture independent, installs on aarch64 / arm64."
)

PKG_DEPENDS = ["luci-base", "curl", "unzip", "ca-bundle"]

# 支持 SOURCE_DATE_EPOCH，便于复现构建
MTIME = int(os.environ.get("SOURCE_DATE_EPOCH", time.time()))

# ------------------------------------------------------------------ 控制脚本

POSTINST = """#!/bin/sh
# luci-app-shellcrashui 安装后处理
if [ -x /etc/uci-defaults/99-luci-app-shellcrashui ]; then
	/etc/uci-defaults/99-luci-app-shellcrashui
	rm -f /etc/uci-defaults/99-luci-app-shellcrashui
fi
rm -f /tmp/luci-indexcache 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null
[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd reload 2>/dev/null
[ -x /etc/init.d/uhttpd ] && /etc/init.d/uhttpd reload 2>/dev/null
exit 0
"""

PRERM = """#!/bin/sh
# luci-app-shellcrashui 卸载前处理
rm -f /tmp/luci-indexcache 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null
exit 0
"""

CONFFILES = "/etc/config/shellcrash\n"


def die(msg):
    sys.stderr.write("错误：%s\n" % msg)
    sys.exit(1)


# -------------------------------------------------------------- 文件收集

def file_mode(rel):
    """显式指定安装后的权限位：Windows 文件系统不保存可执行位。"""
    rel = rel.replace("\\", "/")
    if rel.endswith(".sh"):
        return 0o755
    if rel.startswith("etc/uci-defaults/") or rel.startswith("etc/init.d/"):
        return 0o755
    if rel.startswith("usr/libexec/"):
        return 0o755
    return 0o644


def collect(src_root):
    """收集要打包的文件：(安装路径, 本地绝对路径) 列表。

    root/    -> 直接落到文件系统根目录，例如 root/usr/... -> /usr/...
    htdocs/  -> 落到 web 根目录 /www，例如 htdocs/luci-static/... -> /www/luci-static/...
                （与 luci.mk 的行为保持一致）
    """
    entries = []
    for sub, prefix in (("root", ""), ("htdocs", "www/")):
        base = os.path.join(src_root, sub)
        if not os.path.isdir(base):
            die("找不到目录：%s" % base)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames.sort()
            for name in sorted(filenames):
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, base).replace("\\", "/")
                entries.append((prefix + rel, full))
    return sorted(entries, key=lambda x: x[0])


def normalize(info):
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mtime = MTIME
    return info


def tar_used_length(raw):
    """返回 tar 中所有成员实际占用的字节数。

    不能简单地对 tar 做 rstrip(b"\\0")：文件内容本身可能以 0 字节结尾，
    那样会把内容一起削掉；而且 Python 的 tarfile 在关闭时还会按 10240
    字节的记录块补齐，留下大段零块。这里按成员头里的 size 字段精确累加。
    """
    pos = 0
    n = len(raw)
    while pos + 512 <= n:
        block = raw[pos:pos + 512]
        if block == b"\0" * 512:
            break
        size_field = block[124:136].split(b"\0")[0].strip()
        try:
            size = int(size_field, 8) if size_field else 0
        except ValueError:
            die("内部错误：无法解析 tar 成员长度字段 %r" % size_field)
        pos += 512 + ((size + 511) // 512) * 512
    return pos


def tar_bytes(build, end_of_archive=True, pad_record=True, pax=False):
    """把一个 tar 构建过程包进 gzip 字节流。

    end_of_archive=False 时只保留成员本身，去掉结尾的全零块与记录块填充。
    apk 会把解压后的控制段与数据段当成一个连续的 tar 流来读，只有最后的
    数据段才允许出现结束标记；否则 apk 读到控制段末尾就认为归档结束，
    再去取数据段就会报 unexpected end of file。

    pax=True 时使用 PAX 格式，这样每个文件才能带上 apk 需要的内嵌校验和。
    """
    buf = io.BytesIO()
    fmt = tarfile.PAX_FORMAT if pax else tarfile.GNU_FORMAT
    with tarfile.open(fileobj=buf, mode="w", format=fmt) as tf:
        build(tf)
    raw = buf.getvalue()
    used = tar_used_length(raw)

    if end_of_archive:
        out = raw[:used] + b"\0" * 1024
        if pad_record:
            rem = len(out) % 10240
            if rem:
                out += b"\0" * (10240 - rem)
    else:
        out = raw[:used]

    gz = io.BytesIO()
    # gzip 头部的 mtime 固定为 0，避免打包时刻混进压缩流
    with gzip.GzipFile(fileobj=gz, mode="wb", compresslevel=9, mtime=0) as fh:
        fh.write(out)
    return gz.getvalue()


def build_data_tar(entries, dot_prefix, end_of_archive=True, apk_checksums=False):
    """数据段 tar。

    dot_prefix 为 True 时成员名带 ./ 前缀（ipk 习惯）。

    apk_checksums 为 True 时给每个普通文件加 PAX 扩展头
    APK-TOOLS.checksum.SHA1=<内容 SHA1>。apk-tools 3 在解包时强制要求这个
    内嵌校验和，缺失会直接报
    "file format is obsolete (e.g. missing embedded checksum)"。
    目录没有内容，不加。
    """

    def build(tf):
        dirs_added = set()

        def add_dir(arc):
            arc = arc.rstrip("/")
            if not arc or arc in dirs_added:
                return
            parts = arc.split("/")
            for i in range(1, len(parts) + 1):
                partial = "/".join(parts[:i])
                if partial in dirs_added:
                    continue
                info = tarfile.TarInfo(partial)
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                normalize(info)
                tf.addfile(info)
                dirs_added.add(partial)

        for rel, full in entries:
            arc = ("./" + rel) if dot_prefix else rel
            add_dir(os.path.dirname(arc))
            with open(full, "rb") as fh:
                data = fh.read()
            info = tarfile.TarInfo(arc)
            info.size = len(data)
            info.mode = file_mode(rel)
            if apk_checksums:
                info.pax_headers = {
                    "APK-TOOLS.checksum.SHA1": hashlib.sha1(data).hexdigest()
                }
            normalize(info)
            tf.addfile(info, io.BytesIO(data))

    return tar_bytes(build, end_of_archive=end_of_archive, pax=apk_checksums)


def add_text_member(tf, arc, text, mode=0o644):
    data = text.encode("utf-8") if isinstance(text, str) else text
    info = tarfile.TarInfo(arc)
    info.size = len(data)
    info.mode = mode
    normalize(info)
    tf.addfile(info, io.BytesIO(data))


# ------------------------------------------------------------------ ipk 构建

def build_ipk(src_root, out_dir):
    entries = collect(src_root)
    total = sum(os.path.getsize(p) for _, p in entries)
    installed_size = max(1, (total + 1023) // 1024)

    control = (
        "Package: %s\n"
        "Version: %s-%s\n"
        "Depends: libc, %s\n"
        "Source: package/%s\n"
        "SourceName: %s\n"
        "License: %s\n"
        "Section: luci\n"
        "Architecture: all\n"
        "Installed-Size: %d\n"
        "Description: %s\n"
    ) % (
        PKG_NAME, PKG_VERSION, PKG_RELEASE, ", ".join(PKG_DEPENDS),
        PKG_NAME, PKG_NAME, PKG_LICENSE, installed_size, PKG_DESCRIPTION,
    )

    def build_control(tf):
        add_text_member(tf, "./control", control)
        add_text_member(tf, "./conffiles", CONFFILES)
        add_text_member(tf, "./postinst", POSTINST, 0o755)
        add_text_member(tf, "./prerm", PRERM, 0o755)

    control_tar = tar_bytes(build_control)
    data_tar = build_data_tar(entries, dot_prefix=True)

    name = "%s_%s-%s_all.ipk" % (PKG_NAME, PKG_VERSION, PKG_RELEASE)
    path = os.path.join(out_dir, name)

    def build_outer(tf):
        for arc, content in (
            ("./debian-binary", b"2.0\n"),
            ("./control.tar.gz", control_tar),
            ("./data.tar.gz", data_tar),
        ):
            info = tarfile.TarInfo(arc)
            info.size = len(content)
            info.mode = 0o644
            normalize(info)
            tf.addfile(info, io.BytesIO(content))

    with open(path, "wb") as fh:
        fh.write(tar_bytes(build_outer))

    return path, len(entries)


# ------------------------------------------------------------------ apk 构建
#
# apk v2 格式 = 若干段 gzip 流顺序拼接：
#     [签名段] [控制段] [数据段]
# 每一段本身是一个 gzip 压缩的 tar，但 apk 解压后是当成「一个连续的 tar 流」
# 来解析的，所以：
#   * 控制段必须去掉 tar 结尾的两个全零块；
#   * 只有数据段保留结束标记；
#   * .PKGINFO 必须带 datahash = 数据段压缩后的 SHA256（apk-tools 3 强制校验）。
# 我们没有可信私钥，所以不打签名段，安装时需要 --allow-untrusted。

def build_apk(src_root, out_dir, arch="noarch"):
    entries = collect(src_root)
    installed_size = sum(os.path.getsize(p) for _, p in entries)

    # 先建数据段：下面的 datahash 需要它压缩后的字节
    data_tar = build_data_tar(entries, dot_prefix=False,
                              end_of_archive=True, apk_checksums=True)
    datahash = hashlib.sha256(data_tar).hexdigest()

    pkginfo_lines = [
        "# Generated by luci-app-shellcrashui build.py",
        "pkgname = %s" % PKG_NAME,
        "pkgver = %s-r%s" % (PKG_VERSION, PKG_RELEASE),
        "pkgdesc = %s" % PKG_DESCRIPTION.split("\n")[0],
        "url = %s" % PKG_URL,
        "builddate = %d" % MTIME,
        "packager = %s" % PKG_MAINTAINER,
        "size = %d" % installed_size,
        "arch = %s" % arch,
        "origin = %s" % PKG_NAME,
        "license = %s" % PKG_LICENSE,
        "datahash = %s" % datahash,
    ]
    for dep in PKG_DEPENDS:
        pkginfo_lines.append("depend = %s" % dep)

    def build_control(tf):
        add_text_member(tf, ".PKGINFO", "\n".join(pkginfo_lines) + "\n")
        add_text_member(tf, ".post-install", POSTINST, 0o755)
        # apk 在「替换/升级」安装时只跑 .post-upgrade，不跑 .post-install。
        # 少这一个文件，升级后 rpcd 不会重启，新装的 ACL 就不会生效。
        add_text_member(tf, ".post-upgrade", POSTINST, 0o755)
        add_text_member(tf, ".post-deinstall", PRERM, 0o755)

    control_tar = tar_bytes(build_control, end_of_archive=False)

    name = "%s-%s-r%s.apk" % (PKG_NAME, PKG_VERSION, PKG_RELEASE)
    path = os.path.join(out_dir, name)

    # 顺序拼接：控制段在前，数据段在后
    with open(path, "wb") as fh:
        fh.write(control_tar)
        fh.write(data_tar)

    return path, len(entries)


# ------------------------------------------------------- 手动安装包（tar.gz）

def build_rootfs_tar(src_root, out_dir):
    entries = collect(src_root)

    def build(tf):
        dirs_added = set()

        def add_dir(arc):
            arc = arc.rstrip("/")
            if not arc or arc in dirs_added:
                return
            parts = arc.split("/")
            for i in range(1, len(parts) + 1):
                partial = "/".join(parts[:i])
                if partial in dirs_added:
                    continue
                info = tarfile.TarInfo(partial)
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                normalize(info)
                tf.addfile(info)
                dirs_added.add(partial)

        for rel, full in entries:
            add_dir(os.path.dirname(rel))
            with open(full, "rb") as fh:
                data = fh.read()
            info = tarfile.TarInfo(rel)
            info.size = len(data)
            info.mode = file_mode(rel)
            normalize(info)
            tf.addfile(info, io.BytesIO(data))

    name = "%s-%s-rootfs.tar.gz" % (PKG_NAME, PKG_VERSION)
    path = os.path.join(out_dir, name)
    with open(path, "wb") as fh:
        fh.write(tar_bytes(build))
    return path, len(entries)


# ---------------------------------------------------------------------- 入口

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_src = os.path.dirname(here)

    ap = argparse.ArgumentParser(description="构建 luci-app-shellcrashui 安装包")
    ap.add_argument("--src", default=default_src, help="包根目录（含 root/ 与 htdocs/）")
    ap.add_argument("--out", default=os.path.join(default_src, "dist"), help="输出目录")
    ap.add_argument("--format", default="all",
                    choices=["all", "ipk", "apk", "tar"], help="构建哪种格式")
    ap.add_argument("--apk-arch", default="noarch",
                    help="apk 的 arch 字段。默认 noarch（架构无关）；"
                         "若设备上 apk 报架构不匹配，可改成 apk --print-arch 的输出")
    args = ap.parse_args()

    src = os.path.abspath(args.src)
    if not os.path.isdir(os.path.join(src, "root")):
        die("--src 指向的目录里没有 root/：%s" % src)

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    results = []
    if args.format in ("all", "ipk"):
        results.append(("ipk",) + build_ipk(src, out_dir))
    if args.format in ("all", "apk"):
        results.append(("apk",) + build_apk(src, out_dir, arch=args.apk_arch))
    if args.format in ("all", "tar"):
        results.append(("tar",) + build_rootfs_tar(src, out_dir))

    print("=" * 72)
    for kind, path, count in results:
        size = os.path.getsize(path)
        print("[%s] %s" % (kind, os.path.basename(path)))
        print("      路径   : %s" % path)
        print("      大小   : %d 字节（%.1f KiB）" % (size, size / 1024.0))
        print("      文件数 : %d" % count)
        print("      SHA256 : %s" % sha256(path))
    print("=" * 72)

    with open(os.path.join(out_dir, "SHA256SUMS"), "w", encoding="utf-8") as fh:
        for _, path, _ in results:
            fh.write("%s  %s\n" % (sha256(path), os.path.basename(path)))
    print("校验和已写入 %s" % os.path.join(out_dir, "SHA256SUMS"))

    print("\n安装方式：")
    print("  opkg（24.10 及更早）: opkg install %s_%s-%s_all.ipk"
          % (PKG_NAME, PKG_VERSION, PKG_RELEASE))
    print("  apk （25.12 及以后）: apk add --allow-untrusted ./%s-%s-r%s.apk"
          % (PKG_NAME, PKG_VERSION, PKG_RELEASE))
    print("  手动 （任何版本）    : tar -xzf %s-%s-rootfs.tar.gz -C / && "
          "sh /etc/uci-defaults/99-luci-app-shellcrashui"
          % (PKG_NAME, PKG_VERSION))


if __name__ == "__main__":
    main()
