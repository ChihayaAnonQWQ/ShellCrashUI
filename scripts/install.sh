#!/bin/sh
#
# luci-app-shellcrashui - arm64 / aarch64 OpenWrt 一键安装脚本
#
# 在路由器上执行（不是在你的电脑上）：
#
#   # 把 ipk 和本脚本一起上传到 /tmp 后：
#   sh /tmp/install-arm64.sh
#
#   # 需要顺便安装 ShellCrash 本体时：
#   sh /tmp/install-arm64.sh --with-shellcrash
#
# SPDX-License-Identifier: MIT

set -u

SELF_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
WITH_CRASH=0
FORCE_MANUAL=0

usage() {
	cat <<-'EOF'
	luci-app-shellcrashui - arm64 / aarch64 OpenWrt 安装脚本

	用法：
	  sh install-arm64.sh [选项]

	选项：
	  --with-shellcrash  顺便下载并安装 ShellCrash 本体（交互式）
	  --manual           跳过后面的包管理器，直接用 rootfs.tar.gz 解包安装
	  -h, --help         显示本帮助

	需要把安装件放在脚本同级目录或 /tmp 下：
	  luci-app-shellcrashui-1.0.0-r1.apk            （OpenWrt 25.12+，apk）
	  luci-app-shellcrashui_1.0.0-1_all.ipk         （OpenWrt 24.10 及更早，opkg）
	  luci-app-shellcrashui-1.0.0-rootfs.tar.gz     （手动安装，通用兜底）
	EOF
}

for arg in "$@"; do
	case "$arg" in
		--with-shellcrash) WITH_CRASH=1 ;;
		--manual) FORCE_MANUAL=1 ;;
		-h|--help) usage; exit 0 ;;
		*) ;;
	esac
done

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 环境检查

say "检查运行环境"

[ "$(id -u)" = "0" ] || die "请用 root 运行本脚本"

ARCH=$(uname -m)
case "$ARCH" in
	aarch64|arm64)
		say "架构检查通过：$ARCH"
		;;
	*)
		die "本脚本面向 arm64 / aarch64 设备，当前架构是 $ARCH。
     64 位 ARM 设备请确认固件是 aarch64 版本（不是 arm_cortex-a7 之类的 32 位）。"
		;;
esac

[ -f /etc/openwrt_release ] || warn "没有检测到 /etc/openwrt_release，仍然继续"

if command -v apk >/dev/null 2>&1; then
	PKGMGR=apk
elif command -v opkg >/dev/null 2>&1; then
	PKGMGR=opkg
else
	die "找不到 apk 或 opkg，无法安装软件包"
fi
say "包管理器：$PKGMGR"

pkg_install() {
	if [ "$PKGMGR" = "apk" ]; then
		apk add --no-cache "$@"
	else
		opkg update >/dev/null 2>&1
		opkg install "$@"
	fi
}

# ---------------------------------------------------------------- 依赖安装

say "安装依赖（luci-base / curl / unzip / ca-bundle）"
for p in luci-base curl unzip ca-bundle; do
	if [ "$PKGMGR" = "apk" ]; then
		apk info -e "$p" >/dev/null 2>&1 && { say "已安装：$p"; continue; }
	else
		opkg list-installed 2>/dev/null | grep -q "^$p " && { say "已安装：$p"; continue; }
	fi
	pkg_install "$p" || warn "安装 $p 失败，插件仍可运行，但相关功能可能受限"
done

# ---------------------------------------------------------------- 安装插件
#
# 按包管理器选择安装件：
#   apk  系统 -> luci-app-shellcrashui-<版本>-r<修订>.apk
#   opkg 系统 -> luci-app-shellcrashui_<版本>-<修订>_all.ipk
# 两条路都失败时，回退到 rootfs.tar.gz 直接解包，保证一定装得上。

IPK_GLOB="luci-app-shellcrashui_*_all.ipk"
APK_GLOB="luci-app-shellcrashui-*-r*.apk"
TAR_GLOB="luci-app-shellcrashui-*-rootfs.tar.gz"

find_artifact() {
	local glob="$1" f
	for f in "$SELF_DIR"/$glob /tmp/$glob ./$glob; do
		[ -f "$f" ] && { printf '%s' "$f"; return 0; }
	done
	return 1
}

manual_install() {
	local tarball="$1"
	[ -n "$tarball" ] || return 1
	say "改用手动安装：解包 $tarball 到 /"
	tar -xzf "$tarball" -C / || return 1
	chmod 0755 /usr/libexec/luci-shellcrashui/ctl.sh 2>/dev/null
	chmod 0755 /usr/libexec/luci-shellcrashui/zashboard.sh 2>/dev/null
	chmod 0755 /etc/uci-defaults/99-luci-app-shellcrashui 2>/dev/null
	if [ -x /etc/uci-defaults/99-luci-app-shellcrashui ]; then
		/etc/uci-defaults/99-luci-app-shellcrashui
		rm -f /etc/uci-defaults/99-luci-app-shellcrashui
	fi
	return 0
}

TARBALL=$(find_artifact "$TAR_GLOB" 2>/dev/null)
INSTALLED=0

if [ "$FORCE_MANUAL" = 1 ]; then
	say "按 --manual 要求，跳过后面的包管理器"
	if [ -n "$TARBALL" ]; then
		manual_install "$TARBALL" && INSTALLED=1
	else
		warn "没有找到 $TAR_GLOB，无法手动安装"
	fi
elif [ "$PKGMGR" = "apk" ]; then
	ARTIFACT=$(find_artifact "$APK_GLOB" 2>/dev/null)
	if [ -n "$ARTIFACT" ]; then
		say "安装插件：$ARTIFACT"
		apk add --allow-untrusted "$ARTIFACT" && INSTALLED=1
		[ "$INSTALLED" = 1 ] || warn "apk 安装失败，尝试手动安装"
	fi
else
	ARTIFACT=$(find_artifact "$IPK_GLOB" 2>/dev/null)
	if [ -n "$ARTIFACT" ]; then
		say "安装插件：$ARTIFACT"
		opkg install --force-reinstall "$ARTIFACT" && INSTALLED=1
		[ "$INSTALLED" = 1 ] || warn "opkg 安装失败，尝试手动安装"
	fi
fi

if [ "$INSTALLED" != 1 ]; then
	if [ -n "$TARBALL" ]; then
		manual_install "$TARBALL" && INSTALLED=1
	else
		warn "没有在脚本同级目录或 /tmp 下找到安装件"
		warn "需要其中之一：$APK_GLOB / $IPK_GLOB / $TAR_GLOB"
	fi
fi

[ "$INSTALLED" = 1 ] || die "插件安装失败，请把上面的报错贴出来"
say "插件已安装"

# -------------------------------------------------------- 可选的 ShellCrash

if [ "$WITH_CRASH" = 1 ]; then
	if [ -f /etc/ShellCrash/start.sh ] || [ -f /tmp/ShellCrash/start.sh ]; then
		say "已经检测到 ShellCrash，跳过安装"
	else
		say "开始安装 ShellCrash 本体（安装过程会询问安装目录与内核，请按提示选择 arm64 对应的选项）"
		INSTALL_URL="https://raw.githubusercontent.com/juewuy/ShellCrash/master/install.sh"
		if command -v curl >/dev/null 2>&1; then
			curl -kfsSL -o /tmp/shellcrash-install.sh "$INSTALL_URL" \
				|| curl -kfsSL -o /tmp/shellcrash-install.sh "https://ghfast.top/$INSTALL_URL"
		else
			uclient-fetch -q -O /tmp/shellcrash-install.sh "$INSTALL_URL" \
				|| uclient-fetch -q -O /tmp/shellcrash-install.sh "https://ghfast.top/$INSTALL_URL"
		fi
		if [ -s /tmp/shellcrash-install.sh ]; then
			sh /tmp/shellcrash-install.sh
		else
			warn "下载 ShellCrash 安装脚本失败，请到 GitHub 仓库 juewuy/ShellCrash 手动安装"
		fi
	fi
fi

# ---------------------------------------------------------------- 收尾

say "刷新 LuCI 缓存与 rpcd"
rm -f /tmp/luci-indexcache 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null
[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd restart >/dev/null 2>&1
[ -x /etc/init.d/uhttpd ] && /etc/init.d/uhttpd restart >/dev/null 2>&1

LANIP=$(uci -q get network.lan.ipaddr 2>/dev/null)
[ -n "$LANIP" ] || LANIP="路由器IP"

printf '\n'
say "安装完成"
printf '  控制页面：http://%s/cgi-bin/luci/admin/services/shellcrashui/control\n' "$LANIP"
printf '  面板页面：http://%s/cgi-bin/luci/admin/services/shellcrashui/zashboard\n' "$LANIP"
printf '\n提示：如果菜单没有立刻出现，请强制刷新浏览器（Ctrl+F5）或退出重新登录 LuCI。\n'
