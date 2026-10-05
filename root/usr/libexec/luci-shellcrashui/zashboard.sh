#!/bin/sh
#
# luci-app-shellcrashui - Zashboard 面板部署后端 (zashboard.sh)
#
# 功能：
#   * 把 Zashboard 静态面板部署到 LuCI 的 web 根目录（/www/zashboard），
#     由 uhttpd 直接提供访问，不依赖内核的 external-ui；
#   * 或者部署到 ShellCrash / 内核的 ui 目录（$CRASHDIR/ui）；
#   * 支持 GitHub 直连与镜像加速、版本固定、卸载。
#
# 下载是耗时操作，因此 install/uninstall 会以后台任务方式执行，
# 前端通过 job 子命令轮询进度，避免 rpcd 的 30 秒超时。
#
# 用法：
#   zashboard.sh status              面板状态 JSON
#   zashboard.sh install luci|core   后台部署 / 更新
#   zashboard.sh uninstall luci|core 后台卸载
#   zashboard.sh job                 查询后台任务进度
#   zashboard.sh cancel              结束正在进行的后台任务
#   zashboard.sh _worker luci|core   内部使用
#
# SPDX-License-Identifier: MIT

UCI_PKG="shellcrash"
UCI_SEC="main"
REPO="Zephyruso/zashboard"
JOB_DIR="/tmp/luci-shellcrashui"
JOB_LOG="$JOB_DIR/job.log"
JOB_STATUS="$JOB_DIR/job.status"
JOB_META="$JOB_DIR/job.meta"
JOB_PID="$JOB_DIR/job.pid"
VERSION_MARK=".luci-shellcrashui.version"
VERSION_MARK_LEGACY=".luci-app-shellcrash.version"

# 默认镜像加速前缀（GitHub 直连失败时按顺序尝试），可在 UCI 中用 mirror 覆盖
DEFAULT_MIRRORS="https://ghfast.top/ https://gh-proxy.com/ https://ghproxy.net/ https://mirror.ghproxy.com/"

CTL="/usr/libexec/luci-shellcrashui/ctl.sh"

have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------ JSON 工具

jesc() {
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\r//g' \
		| awk '{ if (NR > 1) printf "\\n"; printf "%s", $0 }'
}
jstr() { printf '"%s"' "$(jesc "$1")"; }
jbool() { case "$1" in 1|true|yes|on) printf 'true' ;; *) printf 'false' ;; esac; }
jnum() { case "$1" in ''|*[!0-9]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }

uci_get() {
	have uci || return 1
	local v
	v=$(uci -q get "$UCI_PKG.$UCI_SEC.$1" 2>/dev/null)
	[ -n "$v" ] && { printf '%s' "$v"; return 0; }
	return 1
}

# 从 ctl.sh 的状态输出里取一个字段
ctl_field() {
	[ -x "$CTL" ] || return 1
	"$CTL" status 2>/dev/null | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n1
}

ctl_flag() {
	[ -x "$CTL" ] || return 1
	"$CTL" status 2>/dev/null | sed -n "s/.*\"$1\":\(true\|false\).*/\1/p" | head -n1
}

# ------------------------------------------------------------------ 路径解析

crashdir() {
	[ -x "$CTL" ] || return 1
	local d
	d=$(ctl_field crashdir)
	[ -n "$d" ] && { printf '%s' "$d"; return 0; }
	return 1
}

web_root() {
	local home
	home=$(uci -q get uhttpd.main.home 2>/dev/null)
	[ -n "$home" ] || home="/www"
	printf '%s' "$home"
}

target_dir() {
	case "$1" in
		luci) printf '%s/zashboard' "$(web_root)" ;;
		core) crashdir >/dev/null 2>&1 || return 1; printf '%s/ui' "$(crashdir)" ;;
		*) return 1 ;;
	esac
}

target_desc() {
	case "$1" in
		luci) printf 'LuCI 站点目录' ;;
		core) printf '内核 external-ui 目录' ;;
		*) printf '未知目标' ;;
	esac
}

installed_version() {
	local d
	d=$(target_dir "$1" 2>/dev/null) || return 1

	# 改名前的旧标记也认，免得升级后版本号显示不出来
	local m
	for m in "$VERSION_MARK" "$VERSION_MARK_LEGACY"; do
		[ -f "$d/$m" ] && { head -n1 "$d/$m" 2>/dev/null | tr -d '\r'; return 0; }
	done
	return 1
}

# ------------------------------------------------------------------ 下载与解包

mirrors() {
	local m
	m=$(uci_get mirror 2>/dev/null)
	[ -n "$m" ] || m="$DEFAULT_MIRRORS"
	printf '%s' "$m"
}

# 生成候选下载地址：直连 + 各镜像
build_urls() {
	local base="$1" m
	printf '%s\n' "$base"
	for m in $(mirrors); do
		[ -n "$m" ] || continue
		case "$m" in
			*/) printf '%s%s\n' "$m" "$base" ;;
			*)  printf '%s/%s\n' "$m" "$base" ;;
		esac
	done
}

fetch_to_stdout() {
	local url="$1"
	if have curl; then
		curl -kfsSL -m 20 "$url" 2>/dev/null
	elif have uclient-fetch; then
		uclient-fetch -q -T 20 -O - "$url" 2>/dev/null
	elif have wget; then
		wget -q -T 20 -O - "$url" 2>/dev/null
	else
		return 127
	fi
}

# 通过 GitHub API 找到 release 里的 zip 资源，失败则回退到固定地址
resolve_asset() {
	local tag="$1" api json url

	if [ "$tag" = "latest" ] || [ -z "$tag" ]; then
		api="https://api.github.com/repos/$REPO/releases/latest"
	else
		api="https://api.github.com/repos/$REPO/releases/tags/$tag"
	fi

	json=$(fetch_to_stdout "$api" 2>/dev/null)
	if [ -n "$json" ]; then
		# 先按逗号切成多行，兼容压缩成一行的 JSON（避免贪婪匹配只取到最后一个）
		urls=$(printf '%s' "$json" | tr ',' '\n' \
			| sed -n 's/.*"browser_download_url":[[:space:]]*"\([^"]*\.zip\)".*/\1/p')
		# ShellCrash 自己用的就是 dist-cdn-fonts.zip（字体走 CDN，体积更小），优先选它
		url=$(printf '%s\n' "$urls" | grep -i 'dist-cdn-fonts\.zip$' | head -n1)
		[ -n "$url" ] || url=$(printf '%s\n' "$urls" | grep -i '/dist\.zip$' | head -n1)
		[ -n "$url" ] || url=$(printf '%s\n' "$urls" | head -n1)
		[ -n "$url" ] && { printf '%s' "$url"; return 0; }
	fi

	if [ "$tag" = "latest" ] || [ -z "$tag" ]; then
		printf 'https://github.com/%s/releases/latest/download/dist-cdn-fonts.zip' "$REPO"
	else
		printf 'https://github.com/%s/releases/download/%s/dist-cdn-fonts.zip' "$REPO" "$tag"
	fi
	return 0
}

resolve_tag() {
	local tag="$1" api json t
	if [ "$tag" != "latest" ] && [ -n "$tag" ]; then
		printf '%s' "$tag"
		return 0
	fi
	api="https://api.github.com/repos/$REPO/releases/latest"
	json=$(fetch_to_stdout "$api" 2>/dev/null)
	t=$(printf '%s' "$json" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
	[ -n "$t" ] || t="latest"
	printf '%s' "$t"
}

download() {
	local base="$1" out="$2" u n=0
	rm -f "$out"
	for u in $(build_urls "$base"); do
		n=$((n + 1))
		printf '[下载] 第 %s 个源：%s\n' "$n" "$u"
		if have curl; then
			curl -kfsSL --connect-timeout 10 -m 600 -o "$out" "$u" 2>/dev/null && [ -s "$out" ]
		elif have uclient-fetch; then
			uclient-fetch -q -T 600 -O "$out" "$u" 2>/dev/null && [ -s "$out" ]
		elif have wget; then
			wget -q -T 600 -O "$out" "$u" 2>/dev/null && [ -s "$out" ]
		else
			printf '[下载] 找不到可用的下载工具（curl / uclient-fetch / wget）\n'
			return 127
		fi
		if [ -s "$out" ]; then
			printf '[下载] 成功，%s 字节\n' "$(wc -c < "$out" 2>/dev/null)"
			return 0
		fi
		printf '[下载] 该源失败，换下一个\n'
	done
	return 1
}

extract_zip() {
	local zip="$1" dest="$2"

	mkdir -p "$dest" || return 1

	if have unzip; then
		unzip -oq "$zip" -d "$dest" && return 0
	fi
	if have python3; then
		python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' \
			"$zip" "$dest" && return 0
	fi
	if have bsdtar; then
		bsdtar -xf "$zip" -C "$dest" && return 0
	fi
	if have tar && tar -tf "$zip" >/dev/null 2>&1; then
		tar -xf "$zip" -C "$dest" && return 0
	fi

	printf '[解包] 缺少解压工具，请先安装：opkg update && opkg install unzip\n'
	return 1
}

ensure_unzip() {
	have unzip && return 0
	have python3 && return 0
	have bsdtar && return 0

	printf '[依赖] 未找到 unzip，尝试自动安装…\n'
	if have apk; then
		apk add unzip >/dev/null 2>&1 || {
			apk update >/dev/null 2>&1
			apk add unzip >/dev/null 2>&1
		}
	elif have opkg; then
		opkg update >/dev/null 2>&1
		opkg install unzip >/dev/null 2>&1
	fi
	have unzip
}

# ------------------------------------------------------------------ 安装逻辑

install_target() {
	local target="$1" tag="$2" dest tmp zip asset real_tag top

	dest=$(target_dir "$target") || {
		printf '[错误] 无法确定 %s 的部署目录（ShellCrash 是否已安装？）\n' "$target"
		return 1
	}

	printf '===== Zashboard 部署 =====\n'
	printf '目标位置：%s（%s）\n' "$dest" "$(target_desc "$target")"
	printf '版本要求：%s\n' "$tag"

	ensure_unzip || {
		printf '[错误] 解压工具不可用，部署终止\n'
		return 1
	}

	asset=$(resolve_asset "$tag")
	real_tag=$(resolve_tag "$tag")
	printf '下载地址：%s\n' "$asset"
	printf '实际版本：%s\n' "$real_tag"

	tmp="$JOB_DIR/extract"
	zip="$JOB_DIR/dist.zip"
	rm -rf "$tmp"
	mkdir -p "$tmp"

	download "$asset" "$zip" || {
		printf '[错误] 所有下载源都失败了，请检查网络或在 LuCI 里配置镜像加速前缀\n'
		rm -rf "$tmp"
		return 1
	}

	extract_zip "$zip" "$tmp" || { rm -rf "$tmp"; return 1; }
	printf '[解包] 完成\n'

	# 发布包可能带一层顶层目录，自动下钻找到 index.html
	top="$tmp"
	if [ ! -f "$top/index.html" ]; then
		top=""
		for d in "$tmp"/*/; do
			[ -f "$d/index.html" ] || continue
			top="${d%/}"
			break
		done
	fi
	if [ -z "$top" ] || [ ! -f "$top/index.html" ]; then
		printf '[错误] 压缩包里没有找到 index.html，可能资源格式已变化\n'
		rm -rf "$tmp"
		return 1
	fi

	printf '[安装] 清理旧文件并写入 %s\n' "$dest"
	mkdir -p "$dest"
	rm -rf "$dest"/* 2>/dev/null

	# 逐个拷贝，兼容 busybox cp
	(cd "$top" && cp -R . "$dest"/) || {
		printf '[错误] 写入 %s 失败（空间不足或目录只读？）\n' "$dest"
		rm -rf "$tmp"
		return 1
	}

	printf '%s\n' "$real_tag" > "$dest/$VERSION_MARK"
	chmod -R a+rX "$dest" 2>/dev/null

	rm -rf "$tmp"
	rm -f "$zip"

	printf '[完成] Zashboard %s 已部署到 %s\n' "$real_tag" "$dest"
	return 0
}

uninstall_target() {
	local target="$1" dest
	dest=$(target_dir "$target") || {
		printf '[错误] 无法确定 %s 的部署目录\n' "$target"
		return 1
	}
	printf '===== 卸载 Zashboard =====\n'
	printf '目标位置：%s\n' "$dest"
	if [ ! -d "$dest" ]; then
		printf '[跳过] 目录不存在\n'
		return 0
	fi
	rm -rf "$dest"
	printf '[完成] 已删除 %s\n' "$dest"
	return 0
}

# ------------------------------------------------------------------ 后台任务

job_running() {
	local p

	[ -f "$JOB_STATUS" ] || return 1
	[ "$(cat "$JOB_STATUS" 2>/dev/null)" = "running" ] || return 1

	# 状态还是 running，确认工作进程确实活着（可能被 kill 或断电中断）
	if [ -f "$JOB_PID" ]; then
		p=$(cat "$JOB_PID" 2>/dev/null)
		if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
			return 0
		fi
	fi

	# 退化为按命令行匹配，兼容 setsid / start-stop-daemon 的进程模型差异
	pgrep -f "zashboard.sh _worker" >/dev/null 2>&1
}

start_job() {
	local action="$1" target="$2"

	if job_running; then
		printf '{"ok":false,"message":%s}\n' "$(jstr '已有任务正在执行，请等待完成或先取消')"
		return 1
	fi

	mkdir -p "$JOB_DIR"
	: > "$JOB_LOG"
	printf 'running' > "$JOB_STATUS"
	printf '%s|%s' "$action" "$target" > "$JOB_META"

	if have setsid; then
		setsid /bin/sh "$0" _worker "$action" "$target" >>"$JOB_LOG" 2>&1 </dev/null &
		printf '%s' "$!" > "$JOB_PID"
	elif have start-stop-daemon; then
		start-stop-daemon -S -b -q -x /bin/sh -- "$0" _worker "$action" "$target" >>"$JOB_LOG" 2>&1
		printf '%s' "$!" > "$JOB_PID"
	else
		/bin/sh "$0" _worker "$action" "$target" >>"$JOB_LOG" 2>&1 </dev/null &
		printf '%s' "$!" > "$JOB_PID"
	fi

	printf '{"ok":true,"message":%s}\n' "$(jstr '任务已启动')"
	return 0
}

worker_main() {
	local action="$1" target="$2" rc=0 message=""

	case "$action" in
		install)   install_target "$target" "$(uci_get zashboard_version 2>/dev/null || echo latest)"; rc=$? ;;
		uninstall) uninstall_target "$target"; rc=$? ;;
		*)         printf '[错误] 未知任务：%s\n' "$action"; rc=1 ;;
	esac

	if [ "$rc" = 0 ]; then
		printf 'ok' > "$JOB_STATUS"
		message="任务执行成功"
	else
		printf 'fail' > "$JOB_STATUS"
		message="任务执行失败，请查看日志输出"
	fi

	printf '\n' >> "$JOB_LOG"
	printf '[结束] %s\n' "$message" >> "$JOB_LOG"
	printf '%s|%s|%s' "$action" "$target" "$message" > "$JOB_META"
	rm -f "$JOB_PID"
	return $rc
}

do_job() {
	local running=0 status="" action="" target="" message="" log=""

	if job_running; then
		running=1
	fi

	[ -f "$JOB_STATUS" ] && status=$(cat "$JOB_STATUS" 2>/dev/null)

	# 用 cut 拆分，避免 IFS='|' 修改到当前 shell 的分隔符
	if [ -f "$JOB_META" ]; then
		action=$(cut -d'|' -f1 "$JOB_META" 2>/dev/null)
		target=$(cut -d'|' -f2 "$JOB_META" 2>/dev/null)
		message=$(cut -d'|' -f3- "$JOB_META" 2>/dev/null)
	fi

	[ -n "$status" ] || status="idle"
	[ -n "$message" ] || message=""

	if [ -f "$JOB_LOG" ]; then
		log=$(tail -n 120 "$JOB_LOG" 2>/dev/null)
	fi

	printf '{"ok":true,"running":%s,"status":%s,"action":%s,"target":%s,"message":%s,"log":%s}\n' \
		"$(jbool "$running")" "$(jstr "$status")" "$(jstr "$action")" \
		"$(jstr "$target")" "$(jstr "$message")" "$(jstr "$log")"
}

do_cancel() {
	local p
	if ! job_running; then
		printf '{"ok":true,"message":%s}\n' "$(jstr '当前没有正在执行的任务')"
		return 0
	fi
	p=$(cat "$JOB_PID" 2>/dev/null)
	[ -n "$p" ] && kill "$p" 2>/dev/null
	sleep 1
	[ -n "$p" ] && kill -9 "$p" 2>/dev/null
	# 兜底：按命令行结束残留的工作进程（部分固件的 busybox 没编译 pkill）
	for p in $(pgrep -f "zashboard.sh _worker" 2>/dev/null); do
		kill "$p" 2>/dev/null
	done
	rm -f "$JOB_PID"
	printf 'fail' > "$JOB_STATUS"
	printf '%s|%s|%s' "" "" "任务已被用户取消" > "$JOB_META"
	printf '{"ok":true,"message":%s}\n' "$(jstr '任务已取消')"
	return 0
}

# ------------------------------------------------------------------ 状态输出

do_status() {
	local luci_dir core_dir core_ui=0 luci_ui=0
	local core_ver="" luci_ver="" running=0

	luci_dir=$(target_dir luci 2>/dev/null)
	core_dir=$(target_dir core 2>/dev/null)

	[ -n "$luci_dir" ] && [ -f "$luci_dir/index.html" ] && luci_ui=1
	[ -n "$core_dir" ] && [ -f "$core_dir/index.html" ] && core_ui=1

	luci_ver=$(installed_version luci 2>/dev/null)
	core_ver=$(installed_version core 2>/dev/null)

	job_running && running=1

	printf '{'
	printf '"ok":true,'
	printf '"repo":%s,' "$(jstr "$REPO")"
	printf '"web_root":%s,' "$(jstr "$(web_root)")"
	printf '"luci_dir":%s,' "$(jstr "$luci_dir")"
	printf '"core_dir":%s,' "$(jstr "$core_dir")"
	printf '"luci_installed":%s,' "$(jbool "$luci_ui")"
	printf '"core_installed":%s,' "$(jbool "$core_ui")"
	printf '"luci_version":%s,' "$(jstr "$luci_ver")"
	printf '"core_version":%s,' "$(jstr "$core_ver")"
	printf '"wanted_version":%s,' "$(jstr "$(uci_get zashboard_version 2>/dev/null || echo latest)")"
	printf '"mirror":%s,' "$(jstr "$(mirrors)")"
	printf '"unzip":%s,' "$(jbool $(have unzip && echo 1 || echo 0))"
	printf '"job_running":%s,' "$(jbool "$running")"
	printf '"api_port":%s,' "$(jstr "$(ctl_field api_port)")"
	printf '"secret":%s,' "$(jstr "$(ctl_field secret)")"
	printf '"remote_url":%s' "$(jstr "$(uci_get remote_url 2>/dev/null || echo https://board.zash.run.place/)")"
	printf '}\n'
}

case "$1" in
	status)    do_status ;;
	install)   [ -n "$2" ] || { printf '{"ok":false,"message":%s}\n' "$(jstr '缺少目标参数')"; exit 1; }; start_job install "$2" ;;
	uninstall) [ -n "$2" ] || { printf '{"ok":false,"message":%s}\n' "$(jstr '缺少目标参数')"; exit 1; }; start_job uninstall "$2" ;;
	job)       do_job ;;
	cancel)    do_cancel ;;
	_worker)   worker_main "$2" "$3" ;;
	*)
		printf '{"ok":false,"message":%s}\n' "$(jstr "未知操作：$1")"
		exit 1
		;;
esac
