#!/bin/sh
#
# luci-app-shellcrashui - 路由器环境诊断脚本
#
# 用途：在安装插件之前，先把 ShellCrash 的真实布局打印出来，
#       用于校准 LuCI 插件的自动探测逻辑。
#       脚本只读，不修改任何配置，密钥会脱敏。
#
# 用法（在路由器 SSH 里执行）：
#   sh /tmp/diag.sh
#
# SPDX-License-Identifier: MIT

echo "############ 1. 系统信息 ############"
echo "uname -m      : $(uname -m)"
echo "kernel        : $(uname -r)"
[ -f /etc/openwrt_release ] && . /etc/openwrt_release && {
	echo "发行版        : $DISTRIB_ID $DISTRIB_RELEASE"
	echo "target        : $DISTRIB_TARGET"
	echo "arch          : $DISTRIB_ARCH"
}
echo "包管理器      : $(command -v apk >/dev/null 2>&1 && echo apk || echo opkg)"
echo "内存          : $(awk '/MemTotal/{print $2" kB"}' /proc/meminfo)"
echo "overlay 可用  : $(df -h /overlay 2>/dev/null | awk 'NR==2{print $4}')"
echo "根分区可用    : $(df -h / | awk 'NR==2{print $4}')"

echo
echo "############ 2. ShellCrash 安装位置 ############"
for d in /etc/ShellCrash /tmp/ShellCrash /usr/share/ShellCrash /opt/ShellCrash /data/ShellCrash; do
	[ -d "$d" ] && echo "发现目录: $d"
done
echo "--- /usr/bin/crash ---"
ls -l /usr/bin/crash 2>/dev/null || echo "(不存在)"
echo "--- 顶层文件 ---"
for d in /etc/ShellCrash /tmp/ShellCrash; do
	[ -d "$d" ] || continue
	echo "[$d]"
	ls -1 "$d" 2>/dev/null | head -n 40
	echo "[$d/configs]"
	ls -1 "$d/configs" 2>/dev/null | head -n 20
	echo "[$d/bin]"
	ls -l "$d/bin" 2>/dev/null | head -n 20
done

echo
echo "############ 3. 服务脚本 ############"
if [ -f /etc/init.d/shellcrash ]; then
	echo "--- /etc/init.d/shellcrash ---"
	cat /etc/init.d/shellcrash
else
	echo "(没有 /etc/init.d/shellcrash)"
fi
echo "--- /etc/rc.d 中的自启链接 ---"
ls -l /etc/rc.d/ 2>/dev/null | grep -i -E 'shellcrash|clash' || echo "(无)"

echo
echo "############ 4. ShellCrash 配置文件键名 ############"
for f in /etc/ShellCrash/configs/ShellCrash.cfg /tmp/ShellCrash/configs/ShellCrash.cfg \
         /etc/ShellCrash/configs/ShellClash.cfg /etc/ShellCrash/ShellCrash.cfg; do
	[ -f "$f" ] || continue
	echo "--- $f ---"
	# 打印键名；密钥类只显示是否设置
	sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$f" | sort -u | tr '\n' ' '
	echo
	echo "端口相关:"
	grep -E '^[[:space:]]*(mix_port|mixed_port|db_port|api_port|redir_port|tproxy_port|redir_mod|mod|core|version)[[:space:]]*=' "$f" 2>/dev/null
	echo "密钥相关:"
	if grep -qE '^[[:space:]]*secret[[:space:]]*=' "$f" 2>/dev/null; then
		SEC=$(sed -n 's/^[[:space:]]*secret[[:space:]]*=[[:space:]]*//p' "$f" | head -n1 | tr -d '\r')
		SEC=$(printf '%s' "$SEC" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
		if [ -n "$SEC" ]; then
			echo "  secret = 已设置（长度 ${#SEC}）"
		else
			echo "  secret = 存在但为空"
		fi
	else
		echo "  (没有 secret 这个键)"
	fi
done

echo
echo "############ 5. 内核进程 ############"
ps w 2>/dev/null | grep -E 'mihomo|clash|sing-box|singbox|xray|ShellCrash|start.sh' | grep -v grep || echo "(没有相关进程)"

PID=""
for name in mihomo clash-meta clash sing-box xray; do
	P=$(pidof "$name" 2>/dev/null | awk '{print $1}')
	[ -n "$P" ] && { PID="$P"; echo "pidof $name -> $P"; break; }
done

if [ -z "$PID" ]; then
	PID=$(ps w 2>/dev/null | grep -E 'ShellCrash/bin|/bin/(mihomo|clash)' | grep -v grep | awk '{print $1}' | head -n1)
fi

if [ -n "$PID" ]; then
	echo "--- /proc/$PID/cmdline ---"
	tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null
	echo
fi

echo
echo "############ 6. 内核运行时配置 ############"
# 从进程命令行推断 -f / -d
CFG=""
if [ -n "$PID" ]; then
	ARGS=$(tr '\0' '\n' < "/proc/$PID/cmdline" 2>/dev/null)
	F=$(printf '%s\n' "$ARGS" | awk '/^-f$/{getline; print; exit}')
	D=$(printf '%s\n' "$ARGS" | awk '/^-d$/{getline; print; exit}')
	echo "-f 参数: ${F:-（无）}"
	echo "-d 参数: ${D:-（无）}"
	[ -n "$F" ] && [ -f "$F" ] && CFG="$F"
	[ -z "$CFG" ] && [ -n "$D" ] && [ -f "$D/config.yaml" ] && CFG="$D/config.yaml"
fi
for f in /etc/ShellCrash/config.yaml /etc/ShellCrash/yamls/config.yaml /tmp/ShellCrash/config.yaml; do
	[ -n "$CFG" ] && break
	[ -f "$f" ] && CFG="$f"
done
echo "推断出的配置文件: ${CFG:-（未找到）}"
if [ -n "$CFG" ]; then
	echo "--- 关键行（secret 脱敏）---"
	grep -nE '^[[:space:]]*(external-controller|mixed-port|port|socks-port|secret|external-ui|external-ui-url|external-ui-name)[[:space:]]*:' "$CFG" 2>/dev/null \
		| sed 's/\(secret[[:space:]]*:\).*/\1 ***已脱敏***/'
	echo "--- yamls 目录 ---"
	ls -1 /etc/ShellCrash/yamls 2>/dev/null | head -n 20
fi

echo
echo "############ 7. API 可用性 ############"
PORT=$(grep -E '^[[:space:]]*external-controller[[:space:]]*:' "$CFG" 2>/dev/null | head -n1 \
	| sed -e 's/.*://' -e 's/[[:space:]]//g' -e 's/"//g' -e "s/'//g" | tr -d '\r')
[ -n "$PORT" ] || PORT=9090
echo "测试端口: $PORT"
if command -v curl >/dev/null 2>&1; then
	echo "curl /version : $(curl -s -m 3 "http://127.0.0.1:$PORT/version" 2>&1 | head -c 200)"
	echo "curl /ui/     : HTTP $(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$PORT/ui/" 2>&1)"
else
	echo "(没有 curl)"
	command -v uclient-fetch >/dev/null 2>&1 && echo "uclient-fetch: $(uclient-fetch -q -T 3 -O - "http://127.0.0.1:$PORT/version" 2>&1 | head -c 200)"
fi

echo
echo "############ 8. 面板目录 ############"
for d in /etc/ShellCrash/ui /tmp/ShellCrash/ui /www/zashboard; do
	if [ -d "$d" ]; then
		echo "$d 存在，文件数 $(ls -1 "$d" 2>/dev/null | wc -l)"
		ls -1 "$d" 2>/dev/null | head -n 10
	else
		echo "$d 不存在"
	fi
done
echo "uhttpd home : $(uci -q get uhttpd.main.home 2>/dev/null || echo /www)"

echo
echo "############ 9. 工具可用性 ############"
for t in curl wget uclient-fetch unzip python3 bsdtar setsid start-stop-daemon pgrep pkill kill logread nc; do
	printf '%-18s %s\n' "$t" "$(command -v $t 2>/dev/null || echo '缺失')"
done

echo
echo "############ 10. 端口监听 ############"
netstat -lntp 2>/dev/null | grep -E 'LISTEN' | head -n 20 || ss -lntp 2>/dev/null | head -n 20 || echo "(netstat/ss 不可用)"

echo
echo "############ 11. 现有 LuCI 应用（参考） ############"
ls -1 /usr/share/luci/menu.d/ 2>/dev/null | head -n 30

echo
echo "############ 诊断结束 ############"
