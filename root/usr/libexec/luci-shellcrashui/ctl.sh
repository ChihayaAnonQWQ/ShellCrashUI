#!/bin/sh
#
# luci-app-shellcrashui - ShellCrash 服务控制后端 (ctl.sh)
#
# 由 LuCI 前端通过 rpcd 的 file exec 调用，统一向 stdout 输出 JSON。
# 兼容 OpenWrt 21.02+ / busybox ash，无硬依赖（curl / wget / uclient-fetch 任选其一）。
#
# 用法：
#   ctl.sh status             输出运行状态 JSON
#   ctl.sh start|stop|restart 控制 ShellCrash 服务
#   ctl.sh reload             通过 Clash API 热重载当前配置
#   ctl.sh enable|disable     设置 / 取消开机自启
#   ctl.sh logs               输出日志尾部 JSON
#   ctl.sh version            输出后端版本
#
# SPDX-License-Identifier: MIT

CTL_VERSION="1.0.0"
UCI_PKG="shellcrash"
UCI_SEC="main"

CRASHDIR=""
CFG_FILE=""
CORE=""
RUN_MODE=""
API_PORT=""
MIX_PORT=""
REDIR_PORT=""
SECRET=""
ARCH=""

have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------ JSON 工具

# 把任意字符串转义成可以放进 JSON 双引号里的内容
jesc() {
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\r//g' \
		| awk '{ if (NR > 1) printf "\\n"; printf "%s", $0 }'
}

jstr() { printf '"%s"' "$(jesc "$1")"; }

jbool() {
	case "$1" in
		1|true|yes|on) printf 'true' ;;
		*) printf 'false' ;;
	esac
}

jnum() {
	case "$1" in
		''|*[!0-9-]*) printf 'null' ;;
		*) printf '%s' "$1" ;;
	esac
}

# 去掉首尾空白与成对的引号
strip_q() {
	printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
		-e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

uci_get() {
	have uci || return 1
	local v
	v=$(uci -q get "$UCI_PKG.$UCI_SEC.$1" 2>/dev/null)
	[ -n "$v" ] && { printf '%s' "$v"; return 0; }
	return 1
}

# -------------------------------------------------------------- ShellCrash 探测

# 依次尝试：UCI 覆盖 -> 常见安装目录 -> /usr/bin/crash 软链接 -> init 脚本里的 CRASHDIR
find_crashdir() {
	local d

	d=$(uci_get crashdir)
	[ -n "$d" ] && [ -f "$d/start.sh" ] && { CRASHDIR="$d"; return 0; }

	for d in /etc/ShellCrash /tmp/ShellCrash /usr/share/ShellCrash /opt/ShellCrash \
	         /data/ShellCrash /etc/ShellClash /tmp/ShellClash; do
		[ -f "$d/start.sh" ] && { CRASHDIR="$d"; return 0; }
	done

	if [ -L /usr/bin/crash ]; then
		d=$(readlink -f /usr/bin/crash 2>/dev/null)
		d=${d%/*}
		[ -n "$d" ] && [ -f "$d/start.sh" ] && { CRASHDIR="$d"; return 0; }
	fi

	if [ -f /etc/init.d/shellcrash ]; then
		d=$(sed -n 's/^[[:space:]]*CRASHDIR=//p' /etc/init.d/shellcrash 2>/dev/null | head -n1)
		d=$(strip_q "$d")
		case "$d" in *'$('*|'') ;; *) [ -f "$d/start.sh" ] && { CRASHDIR="$d"; return 0; } ;; esac
	fi

	# ShellCrash 自己也把 CRASHDIR 写进 /etc/profile（形如 export CRASHDIR="/etc/ShellCrash"）
	for f in /etc/profile /etc/profile.d/*.sh /root/.bashrc /etc/bashrc; do
		[ -f "$f" ] || continue
		d=$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}CRASHDIR=//p' "$f" 2>/dev/null | head -n1)
		d=$(strip_q "$d")
		case "$d" in *'$('*) continue ;; esac
		[ -n "$d" ] && [ -f "$d/start.sh" ] && { CRASHDIR="$d"; return 0; }
	done

	# 容器 / 非标准目录兜底：任意 ShellCrash 配置目录
	for d in /etc/ShellCrash* /opt/ShellCrash* /root/ShellCrash*; do
		[ -f "$d/start.sh" ] && { CRASHDIR="$d"; return 0; }
	done

	return 1
}

cfg_file() {
	local f
	for f in "$CRASHDIR/configs/ShellCrash.cfg" "$CRASHDIR/configs/ShellClash.cfg" \
	         "$CRASHDIR/ShellCrash.cfg" "$CRASHDIR/configs/config.cfg"; do
		[ -f "$f" ] && { printf '%s' "$f"; return 0; }
	done
	return 1
}

cfg_get() {
	[ -n "$CFG_FILE" ] && [ -f "$CFG_FILE" ] || return 1
	local v
	v=$(sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$CFG_FILE" 2>/dev/null | head -n1)
	v=$(strip_q "$v")
	[ -n "$v" ] && { printf '%s' "$v"; return 0; }
	return 1
}

cfg_get_any() {
	local k v
	for k in "$@"; do
		v=$(cfg_get "$k") && { printf '%s' "$v"; return 0; }
	done
	return 1
}

# ShellCrash 把自己真正执行的命令写在 configs/command.env 里，形如：
#   TMPDIR=/tmp/ShellCrash
#   BINDIR=/etc/ShellCrash
#   COMMAND="$TMPDIR/CrashCore -d $BINDIR -f $TMPDIR/config.yaml"
# 这些变量引用需要展开，所以直接在一个子 shell 里 source 它。
crash_command() {
	[ -n "$CRASHDIR" ] && [ -f "$CRASHDIR/configs/command.env" ] || return 1
	local cmd
	cmd=$(
		. "$CRASHDIR/configs/command.env" 2>/dev/null
		printf '%s' "$COMMAND"
	)
	[ -n "$cmd" ] && { printf '%s' "$cmd"; return 0; }
	return 1
}

# 内核可执行文件的绝对路径（内核没运行时也能从 command.env 得知）
crash_core_path() {
	local cmd
	cmd=$(crash_command 2>/dev/null) || return 1
	printf '%s' "$cmd" | awk '{print $1}'
}

# 内核实际读取的配置文件路径（从 command.env 的 -f 参数取）
crash_config_path() {
	local cmd f
	cmd=$(crash_command 2>/dev/null) || return 1
	f=$(printf '%s\n' "$cmd" | awk '{for (i = 1; i < NF; i++) if ($i == "-f") { print $(i + 1); exit }}')
	[ -n "$f" ] && [ -f "$f" ] && { printf '%s' "$f"; return 0; }
	return 1
}

# 内核进程 pid：优先按 command.env 声明的可执行文件匹配，其次按安装目录，
# 最后按常见内核进程名兜底
core_pid() {
	local p n bin

	bin=$(crash_core_path 2>/dev/null)
	if [ -n "$bin" ]; then
		for p in $(pgrep -f "$bin" 2>/dev/null); do
			printf '%s' "$p"; return 0
		done
	fi

	if [ -n "$CRASHDIR" ] && [ -d "$CRASHDIR/bin" ]; then
		for p in $(pgrep -f "$CRASHDIR/bin/" 2>/dev/null); do
			printf '%s' "$p"; return 0
		done
	fi

	for n in CrashCore mihomo clash-meta clash sing-box singbox xray; do
		# 用 [/]name 而不是 -x：部分 busybox 的 pgrep -x 拿完整 argv[0] 比对，
		# /tmp/ShellCrash/CrashCore 这种带路径的就匹配不上
		p=$(pgrep -f "[/]$n" 2>/dev/null | head -n1)
		[ -n "$p" ] && { printf '%s' "$p"; return 0; }
	done
	return 1
}

# 内核正在使用的配置文件。
# 关键：内核没在运行时也要能推出来，否则状态页只能拿到默认端口，
# 所以这里绝不能在拿不到 pid 时提前 return。
core_config_file() {
	local pid f d args

	# 1) 正在运行的内核，直接看它的命令行
	pid=$(core_pid 2>/dev/null)
	if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ]; then
		args=$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null)

		f=$(printf '%s\n' "$args" | awk '/^-f$/{getline; print; exit}')
		[ -z "$f" ] && f=$(printf '%s\n' "$args" | sed -n 's/^-f\(.\+\)$/\1/p' | head -n1)
		if [ -n "$f" ]; then
			case "$f" in
				/*) ;;
				*) f="$CRASHDIR/$f" ;;
			esac
			[ -f "$f" ] && { printf '%s' "$f"; return 0; }
		fi

		d=$(printf '%s\n' "$args" | awk '/^-d$/{getline; print; exit}')
		[ -n "$d" ] && [ -f "$d/config.yaml" ] && { printf '%s' "$d/config.yaml"; return 0; }
	fi

	# 2) ShellCrash 记录的启动命令（内核停止时同样可用）
	f=$(crash_config_path 2>/dev/null)
	[ -n "$f" ] && { printf '%s' "$f"; return 0; }

	# 3) 常见固定路径兜底
	for f in "$CRASHDIR/config.yaml" "$CRASHDIR/configs/config.yaml" \
	         "$CRASHDIR/yamls/config.yaml" "/tmp/ShellCrash/config.yaml"; do
		[ -f "$f" ] && { printf '%s' "$f"; return 0; }
	done
	return 1
}

yaml_key() {
	local v
	[ -f "$1" ] || return 1
	v=$(sed -n "s/^[[:space:]]*$2:[[:space:]]*//p" "$1" 2>/dev/null | head -n1)
	v=$(printf '%s' "$v" | sed -e 's/[[:space:]]*#.*$//')
	v=$(strip_q "$v")
	[ -n "$v" ] && { printf '%s' "$v"; return 0; }
	return 1
}

port_only() {
	case "$1" in
		*:*) printf '%s' "${1##*:}" ;;
		*) printf '%s' "$1" ;;
	esac
}

is_port() {
	case "$1" in
		''|*[!0-9]*) return 1 ;;
		*) [ "$1" -ge 1 ] && [ "$1" -le 65535 ] && return 0 ;;
	esac
	return 1
}

detect_api_port() {
	local v f
	v=$(uci_get api_port)
	is_port "$v" && { printf '%s' "$v"; return 0; }

	f=$(core_config_file 2>/dev/null)
	if [ -n "$f" ]; then
		v=$(yaml_key "$f" external-controller 2>/dev/null)
		v=$(port_only "$v")
		is_port "$v" && { printf '%s' "$v"; return 0; }
	fi

	# ShellCrash 的 hostdir 形如 ':9999/ui'
	v=$(cfg_get_any hostdir 2>/dev/null)
	if [ -n "$v" ]; then
		v=$(port_only "${v%%/*}")
		is_port "$v" && { printf '%s' "$v"; return 0; }
	fi

	v=$(cfg_get_any db_port api_port external_controller_port clash_api_port 2>/dev/null)
	is_port "$v" && { printf '%s' "$v"; return 0; }

	printf '9090'
}

detect_mix_port() {
	local v f
	v=$(uci_get mixed_port)
	is_port "$v" && { printf '%s' "$v"; return 0; }

	f=$(core_config_file 2>/dev/null)
	if [ -n "$f" ]; then
		v=$(yaml_key "$f" mixed-port 2>/dev/null)
		is_port "$v" && { printf '%s' "$v"; return 0; }
	fi

	v=$(cfg_get_any mix_port mixed_port 2>/dev/null)
	is_port "$v" && { printf '%s' "$v"; return 0; }

	printf '7890'
}

detect_redir_port() {
	local v f
	v=$(cfg_get_any redir_port tproxy_port 2>/dev/null)
	is_port "$v" && { printf '%s' "$v"; return 0; }

	f=$(core_config_file 2>/dev/null)
	if [ -n "$f" ]; then
		v=$(yaml_key "$f" redir-port 2>/dev/null)
		is_port "$v" && { printf '%s' "$v"; return 0; }
		v=$(yaml_key "$f" tproxy-port 2>/dev/null)
		is_port "$v" && { printf '%s' "$v"; return 0; }
	fi

	return 1
}

detect_secret() {
	local v f
	v=$(uci_get secret)
	[ -n "$v" ] && { printf '%s' "$v"; return 0; }

	f=$(core_config_file 2>/dev/null)
	if [ -n "$f" ]; then
		v=$(yaml_key "$f" secret 2>/dev/null)
		[ -n "$v" ] && { printf '%s' "$v"; return 0; }
	fi

	v=$(cfg_get_any secret api_secret db_secret 2>/dev/null)
	[ -n "$v" ] && { printf '%s' "$v"; return 0; }
	return 1
}

crash_version() {
	local f v
	for f in "$CRASHDIR/version" "$CRASHDIR/configs/version" "$CRASHDIR/.version"; do
		[ -f "$f" ] || continue
		v=$(head -n1 "$f" 2>/dev/null | tr -d '\r')
		v=$(strip_q "$v")
		[ -n "$v" ] && { printf '%s' "$v"; return 0; }
	done
	v=$(cfg_get_any version crash_version ShellCrash_ver 2>/dev/null)
	[ -n "$v" ] && { printf '%s' "$v"; return 0; }
	return 1
}

detect_all() {
	ARCH=$(uname -m 2>/dev/null)
	[ -n "$ARCH" ] || ARCH="unknown"

	find_crashdir 2>/dev/null
	if [ -n "$CRASHDIR" ]; then
		CFG_FILE=$(cfg_file 2>/dev/null)
		# ShellCrash 里内核类型记在 crashcore（meta / singbox / clash ...）
		CORE=$(cfg_get_any core crashcore clash_core 2>/dev/null)
		RUN_MODE=$(cfg_get_any redir_mod mod proxy_mode tun_mode 2>/dev/null)
	fi

	API_PORT=$(detect_api_port)
	MIX_PORT=$(detect_mix_port)
	REDIR_PORT=$(detect_redir_port 2>/dev/null)
	SECRET=$(detect_secret 2>/dev/null)
}

# ------------------------------------------------------------------ HTTP 小工具

http_get() {
	local url="$1" auth="$2"
	if have curl; then
		if [ -n "$auth" ]; then
			curl -kfsS -m 3 -H "Authorization: Bearer $auth" "$url" 2>/dev/null
		else
			curl -kfsS -m 3 "$url" 2>/dev/null
		fi
	elif have uclient-fetch; then
		if [ -n "$auth" ]; then
			uclient-fetch -q -T 3 -O - --header="Authorization: Bearer $auth" "$url" 2>/dev/null
		else
			uclient-fetch -q -T 3 -O - "$url" 2>/dev/null
		fi
	elif have wget; then
		if [ -n "$auth" ]; then
			wget -q -T 3 -O - --header="Authorization: Bearer $auth" "$url" 2>/dev/null
		else
			wget -q -T 3 -O - "$url" 2>/dev/null
		fi
	else
		return 127
	fi
}

# 探测内核 API，成功时打印内核版本号
api_probe() {
	local out ver
	[ -n "$API_PORT" ] || return 1
	out=$(http_get "http://127.0.0.1:$API_PORT/version" "$SECRET") || return 1
	[ -n "$out" ] || return 1
	ver=$(printf '%s' "$out" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
	[ -n "$ver" ] || ver="unknown"
	printf '%s' "$ver"
	return 0
}

# 内核也可能只开了 TLS API（external-controller-tls）。
# 这关系到面板能不能用：HTTPS 页面不允许请求 HTTP 后端，
# 所以只有 API 走 HTTPS 时，那些在线 HTTPS 面板才连得上。
api_tls_probe() {
	local out ver
	[ -n "$API_PORT" ] || return 1
	have curl || return 1
	out=$(http_get "https://127.0.0.1:$API_PORT/version" "$SECRET") || return 1
	[ -n "$out" ] || return 1
	ver=$(printf '%s' "$out" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
	[ -n "$ver" ] || ver="unknown"
	printf '%s' "$ver"
	return 0
}

api_curl() {
	local method="$1" url="$2" body="$3"
	if [ -n "$SECRET" ]; then
		if [ -n "$body" ]; then
			curl -fsS -m 10 -X "$method" -H 'Content-Type: application/json' \
				-H "Authorization: Bearer $SECRET" --data "$body" "$url" 2>&1
		else
			curl -fsS -m 10 -X "$method" -H "Authorization: Bearer $SECRET" "$url" 2>&1
		fi
	else
		if [ -n "$body" ]; then
			curl -fsS -m 10 -X "$method" -H 'Content-Type: application/json' \
				--data "$body" "$url" 2>&1
		else
			curl -fsS -m 10 -X "$method" "$url" 2>&1
		fi
	fi
}

# ---------------------------------------------------------------- 内核运行参数
#
# 这些参数通过 Clash API 的 PATCH /configs 修改，立即生效、不需要重启内核。
# 注意：它们只作用于当前这次运行，ShellCrash 重启后会用 config.yaml 里的值重建。
# 想永久生效要改 ShellCrash 自己的配置。

kernel_endpoint() {
	[ -n "$API_PORT" ] || return 1
	printf 'http://127.0.0.1:%s/configs' "$API_PORT"
}

kernel_apply() {
	local key="$1" val="$2" out rc

	detect_all

	if ! have curl; then
		printf '{"ok":false,"key":%s,"message":%s}\n' \
			"$(jstr "$key")" "$(jstr '修改内核参数需要 curl，请先安装：opkg install curl 或 apk add curl')"
		return 1
	fi

	if ! core_pid >/dev/null 2>&1; then
		printf '{"ok":false,"key":%s,"message":%s}\n' \
			"$(jstr "$key")" "$(jstr '内核未在运行，请先启动 ShellCrash')"
		return 1
	fi

	out=$(api_curl PATCH "$(kernel_endpoint)" "{\"$key\":$val}")
	rc=$?

	if [ "$rc" = 0 ]; then
		printf '{"ok":true,"key":%s,"value":%s,"message":%s}\n' \
			"$(jstr "$key")" "$val" "$(jstr "已应用：$key")"
		return 0
	fi

	printf '{"ok":false,"key":%s,"message":%s,"output":%s}\n' \
		"$(jstr "$key")" "$(jstr "设置 $key 失败")" "$(jstr "$out")"
	return 1
}

# 读取内核当前的运行参数，只回传关心的字段，不回传整份配置
do_kernel_get() {
	local out tmp="" k v
	local mode="" loglevel="" allowlan="" ipv6="" tcpconc="" unified="" mixport=""

	detect_all

	if ! core_pid >/dev/null 2>&1; then
		printf '{"ok":false,"running":false,"message":%s}\n' \
			"$(jstr '内核未在运行，读不到运行参数')"
		return 1
	fi

	out=$(http_get "$(kernel_endpoint)" "$SECRET" 2>/dev/null)
	if [ -z "$out" ]; then
		printf '{"ok":false,"running":true,"message":%s}\n' \
			"$(jstr '内核 API 不可达，读不到运行参数')"
		return 1
	fi

	if have ucode; then
		tmp="/tmp/luci-shellcrashui/kernel.$$"
		mkdir -p /tmp/luci-shellcrashui
		printf '%s' "$out" | ucode -e '
			let fs = require("fs");
			let d;
			try { d = json(fs.readfile("/dev/stdin")); } catch (e) { exit(1); }
			let keys = [ "mode", "log-level", "allow-lan", "ipv6",
			             "tcp-concurrent", "unified-delay", "mixed-port" ];
			for (let k in keys)
				if (k in d) print(k + "=" + d[k] + "\n");
		' > "$tmp" 2>/dev/null

		while IFS='=' read -r k v; do
			case "$k" in
				mode)           mode="$v" ;;
				log-level)      loglevel="$v" ;;
				allow-lan)      allowlan="$v" ;;
				ipv6)           ipv6="$v" ;;
				tcp-concurrent) tcpconc="$v" ;;
				unified-delay)  unified="$v" ;;
				mixed-port)     mixport="$v" ;;
			esac
		done < "$tmp"
		rm -f "$tmp"
	fi

	printf '{"ok":true,"running":true,'
	printf '"mode":%s,' "$(jstr "$mode")"
	printf '"log_level":%s,' "$(jstr "$loglevel")"
	printf '"allow_lan":%s,' "$(jstr "$allowlan")"
	printf '"ipv6":%s,' "$(jstr "$ipv6")"
	printf '"tcp_concurrent":%s,' "$(jstr "$tcpconc")"
	printf '"unified_delay":%s,' "$(jstr "$unified")"
	printf '"mixed_port":%s,' "$(jstr "$mixport")"
	printf '"parsed":%s' "$(jbool $([ -n "$mode" ] && echo 1 || echo 0))"
	printf '}\n'
	return 0
}

# ------------------------------------------------------------------ 延迟测试

ping_targets() {
	local t
	t=$(uci_get ping_targets)
	[ -n "$t" ] || t="百度|https://www.baidu.com/ 谷歌|https://www.google.com/generate_204 GitHub|https://github.com/ YouTube|https://www.youtube.com/"
	printf '%s' "$t"
}

do_ping() {
	local targets tmp name url res use_proxy=1 i=0

	detect_all

	if ! have curl; then
		printf '{"ok":false,"message":%s}\n' \
			"$(jstr '延迟测试需要 curl，请先安装：opkg install curl 或 apk add curl')"
		return 1
	fi

	# 走混合端口：这样请求会经过内核的规则分流，反映的是真实可达性
	# （国内站点按规则直连，国外站点走代理），而不是裸网络能不能通。
	if core_pid >/dev/null 2>&1; then
		use_proxy=1
	else
		use_proxy=0
	fi

	mkdir -p /tmp/luci-shellcrashui
	tmp="/tmp/luci-shellcrashui/ping.$$"
	: > "$tmp"

	for item in $(ping_targets); do
		name=${item%%|*}
		url=${item#*|}
		[ -n "$name" ] && [ -n "$url" ] && [ "$name" != "$url" ] || continue
		(
			if [ "$use_proxy" = 1 ]; then
				r=$(curl -x "http://127.0.0.1:$MIX_PORT" -o /dev/null -s -m 6 \
					-w '%{time_total} %{http_code}' "$url" 2>/dev/null)
			else
				r=$(curl -o /dev/null -s -m 6 -w '%{time_total} %{http_code}' "$url" 2>/dev/null)
			fi
			printf '%s\t%s\n' "$name" "$r" >> "$tmp"
		) &
	done

	wait

	printf '{"ok":true,"via":%s,"mixed_port":%s,"results":[' \
		"$(jstr "$([ "$use_proxy" = 1 ] && echo proxy || echo direct)")" "$(jstr "$MIX_PORT")"

	while IFS='	' read -r name res; do
		[ -n "$name" ] || continue
		i=$((i + 1))
		[ "$i" -gt 1 ] && printf ','
		printf '{"name":%s,"time":%s,"code":%s}' \
			"$(jstr "$name")" \
			"$(jstr "${res%% *}")" \
			"$(jstr "${res##* }")"
	done < "$tmp"

	printf ']}\n'
	rm -f "$tmp"
	return 0
}

# ---------------------------------------------------------------- 面板可用性

panel_core_dir() {
	[ -n "$CRASHDIR" ] && printf '%s/ui' "$CRASHDIR"
}

panel_local_dir() {
	local home
	home=$(uci -q get uhttpd.main.home 2>/dev/null)
	[ -n "$home" ] || home="/www"
	printf '%s/zashboard' "$home"
}

panel_core_installed() {
	local d
	d=$(panel_core_dir)
	[ -n "$d" ] && [ -f "$d/index.html" ]
}

panel_local_installed() {
	local d
	d=$(panel_local_dir)
	[ -f "$d/index.html" ]
}

# -------------------------------------------------------------------- 子命令

svc_msg() {
	case "$1" in
		start)   [ "$2" = 1 ] && printf '已启动' || printf '启动命令已执行，但未检测到内核进程' ;;
		stop)    [ "$2" = 1 ] && printf '停止命令已执行，但内核进程仍在运行' || printf '已停止' ;;
		restart) [ "$2" = 1 ] && printf '已重启' || printf '重启命令已执行，但未检测到内核进程' ;;
		enable)  printf '已设置开机自启' ;;
		disable) printf '已取消开机自启' ;;
		*)       printf '执行完成' ;;
	esac
}

run_service() {
	local a="$1" out rc ok running=0 i=0

	# 必须先探测：core_pid / crash_core_path 都依赖 CRASHDIR，
	# 少了这一步会把「已经在跑的内核」误判成未运行
	detect_all

	if [ -x /etc/init.d/shellcrash ]; then
		out=$(/etc/init.d/shellcrash "$a" 2>&1); rc=$?
	elif [ -n "$CRASHDIR" ] && [ -f "$CRASHDIR/start.sh" ]; then
		out=$(/bin/sh "$CRASHDIR/start.sh" "$a" 2>&1); rc=$?
	else
		printf '{"ok":false,"message":%s}\n' \
			"$(jstr '未找到 ShellCrash 服务脚本，请先在路由器上安装 ShellCrash')"
		return 1
	fi

	case "$a" in
		start|restart)
			# 最多等 10 秒，让内核进程起来后再回报状态
			while [ "$i" -lt 10 ]; do
				core_pid >/dev/null 2>&1 && break
				sleep 1
				i=$((i + 1))
			done
			;;
	esac

	core_pid >/dev/null 2>&1 && running=1
	ok=0
	[ "$rc" = 0 ] && ok=1

	printf '{"ok":%s,"code":%s,"running":%s,"message":%s,"output":%s}\n' \
		"$(jbool "$ok")" "$(jnum "$rc")" "$(jbool "$running")" \
		"$(jstr "$(svc_msg "$a" "$running")")" "$(jstr "$out")"

	[ "$rc" = 0 ] || return 1
	return 0
}

do_reload() {
	local out rc

	# 同样必须先探测，否则 core_pid 会因为 CRASHDIR 为空而找不到内核
	detect_all

	if ! have curl; then
		printf '{"ok":false,"message":%s}\n' \
			"$(jstr '热重载需要 curl，请先执行：opkg install curl')"
		return 1
	fi

	if ! core_pid >/dev/null 2>&1; then
		printf '{"ok":false,"message":%s}\n' \
			"$(jstr '内核未在运行，请先启动 ShellCrash')"
		return 1
	fi

	out=$(api_curl PUT "http://127.0.0.1:$API_PORT/configs?force=true" '{"path":""}')
	rc=$?
	if [ "$rc" = 0 ]; then
		printf '{"ok":true,"message":%s,"output":%s}\n' \
			"$(jstr '配置已热重载')" "$(jstr "$out")"
		return 0
	fi

	printf '{"ok":false,"message":%s,"output":%s}\n' \
		"$(jstr '热重载失败，请确认内核正在运行，且 API 端口与密钥正确')" "$(jstr "$out")"
	return 1
}

do_logs() {
	local n src="" f out

	# 日志路径基于 CRASHDIR，同样要先探测
	detect_all

	n=$(uci_get log_lines)
	case "$n" in ''|*[!0-9]*) n=200 ;; esac

	for f in "$CRASHDIR/log/ShellCrash.log" "$CRASHDIR/ShellCrash.log" \
	         "/tmp/ShellCrash/ShellCrash.log" "$CRASHDIR/logs/ShellCrash.log" \
	         "/tmp/ShellCrash/core.log" "$CRASHDIR/core.log"; do
		[ -f "$f" ] || continue
		out=$(tail -n "$n" "$f" 2>/dev/null)
		[ -n "$out" ] && { src="$f"; break; }
	done

	if [ -z "$out" ] && have logread; then
		out=$(logread 2>/dev/null | grep -iE 'shellcrash|mihomo|clash|sing-box|xray' | tail -n "$n")
		[ -n "$out" ] && src="logread"
	fi

	[ -n "$out" ] || { src=""; out="（未找到日志内容，可尝试在 ShellCrash 菜单中开启日志）"; }

	printf '{"ok":true,"source":%s,"log":%s}\n' "$(jstr "$src")" "$(jstr "$out")"
}

do_status() {
	local pid mem running=0 autostart=0 init_script=0
	local api_ver="" api_ok=0 api_tls=0 core_ui=0 local_ui=0 rec="remote"
	local crashdir_ui="" local_ui_dir=""

	detect_all

	pid=$(core_pid 2>/dev/null)
	[ -n "$pid" ] && running=1

	[ -x /etc/init.d/shellcrash ] && init_script=1
	ls /etc/rc.d/S*shellcrash >/dev/null 2>&1 && autostart=1

	mem=""
	if [ -n "$pid" ] && [ -r "/proc/$pid/status" ]; then
		mem=$(awk '/^VmRSS:/{print $2}' "/proc/$pid/status" 2>/dev/null)
	fi

	api_ver=$(api_probe 2>/dev/null) && api_ok=1
	# HTTP 探不通时再试 HTTPS：内核可能只开了 TLS 控制器
	if [ "$api_ok" = 0 ]; then
		api_ver=$(api_tls_probe 2>/dev/null) && { api_ok=1; api_tls=1; }
	fi
	# 内核没跑时 API 探测不到版本，退回 ShellCrash 自己记录的内核版本 core_v
	[ -n "$api_ver" ] || api_ver=$(cfg_get_any core_v 2>/dev/null)

	panel_core_installed && core_ui=1
	panel_local_installed && local_ui=1

	if [ "$core_ui" = 1 ]; then
		rec="core"
	elif [ "$local_ui" = 1 ]; then
		rec="local"
	fi

	crashdir_ui=$(panel_core_dir)
	local_ui_dir=$(panel_local_dir)

	printf '{'
	printf '"ok":true,'
	printf '"ctl_version":%s,' "$(jstr "$CTL_VERSION")"
	printf '"arch":%s,' "$(jstr "$ARCH")"
	printf '"installed":%s,' "$(jbool $([ -n "$CRASHDIR" ] && echo 1 || echo 0))"
	printf '"crashdir":%s,' "$(jstr "$CRASHDIR")"
	printf '"cfg_file":%s,' "$(jstr "$CFG_FILE")"
	printf '"version":%s,' "$(jstr "$(crash_version 2>/dev/null)")"
	printf '"core":%s,' "$(jstr "$CORE")"
	printf '"core_version":%s,' "$(jstr "$api_ver")"
	printf '"run_mode":%s,' "$(jstr "$RUN_MODE")"
	printf '"running":%s,' "$(jbool "$running")"
	printf '"pid":%s,' "$(jstr "$pid")"
	printf '"mem_kb":%s,' "$(jnum "$mem")"
	printf '"init_script":%s,' "$(jbool "$init_script")"
	printf '"autostart":%s,' "$(jbool "$autostart")"
	printf '"api_port":%s,' "$(jstr "$API_PORT")"
	printf '"api_reachable":%s,' "$(jbool "$api_ok")"
	printf '"api_tls":%s,' "$(jbool "$api_tls")"
	printf '"mixed_port":%s,' "$(jstr "$MIX_PORT")"
	printf '"redir_port":%s,' "$(jstr "$REDIR_PORT")"
	printf '"secret":%s,' "$(jstr "$SECRET")"
	printf '"secret_set":%s,' "$(jbool $([ -n "$SECRET" ] && echo 1 || echo 0))"
	printf '"curl":%s,' "$(jbool $(have curl && echo 1 || echo 0))"
	printf '"panel_core_dir":%s,' "$(jstr "$crashdir_ui")"
	printf '"panel_local_dir":%s,' "$(jstr "$local_ui_dir")"
	printf '"panel_core_installed":%s,' "$(jbool "$core_ui")"
	printf '"panel_local_installed":%s,' "$(jbool "$local_ui")"
	printf '"recommended_mode":%s,' "$(jstr "$rec")"
	printf '"time":%s' "$(date +%s 2>/dev/null || echo 0)"
	printf '}\n'
}

case "$1" in
	status)  do_status ;;
	start|stop|restart|enable|disable) run_service "$1" ;;
	reload)  do_reload ;;
	logs)    do_logs ;;
	ping)    do_ping ;;

	# 内核运行参数：每个动作都是无参数的，方便在 rpcd ACL 里逐条精确授权
	# （rpcd 会把「命令 + 参数」拼成一个字符串去匹配 ACL，用通配符并不保险）
	kernel-get)  do_kernel_get ;;

	mode-rule)          kernel_apply mode '"rule"' ;;
	mode-global)        kernel_apply mode '"global"' ;;
	mode-direct)        kernel_apply mode '"direct"' ;;

	log-silent)         kernel_apply log-level '"silent"' ;;
	log-error)          kernel_apply log-level '"error"' ;;
	log-warning)        kernel_apply log-level '"warning"' ;;
	log-info)           kernel_apply log-level '"info"' ;;
	log-debug)          kernel_apply log-level '"debug"' ;;

	allow-lan-on)       kernel_apply allow-lan 'true' ;;
	allow-lan-off)      kernel_apply allow-lan 'false' ;;
	ipv6-on)            kernel_apply ipv6 'true' ;;
	ipv6-off)           kernel_apply ipv6 'false' ;;
	tcp-concurrent-on)  kernel_apply tcp-concurrent 'true' ;;
	tcp-concurrent-off) kernel_apply tcp-concurrent 'false' ;;
	# 注意：unified-delay 不在 mihomo 的 PATCH /configs 支持列表里，
	# 实测会返回成功但值不变，所以这里不提供修改，只在状态里展示。

	version) printf '{"ok":true,"ctl_version":%s}\n' "$(jstr "$CTL_VERSION")" ;;
	*)
		printf '{"ok":false,"message":%s}\n' "$(jstr "未知操作：$1")"
		exit 1
		;;
esac
