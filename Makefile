#
# luci-app-shellcrashui - ShellCrashUI，给 ShellCrash 用的 LuCI 控制面板
#
# 纯 shell + 前端 JS 实现，不含任何与 CPU 架构相关的二进制，
# 因此在 aarch64 / arm64 等任意目标上编译产物都是 luci-app-shellcrashui_*_all.ipk。
#
# 本项目不是 ShellCrash 本体，也不包含它的任何代码。
#
# Copyright (C) 2026 ShellCrashUI contributors
# SPDX-License-Identifier: MIT
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=ShellCrashUI - Web UI for ShellCrash (control / Zashboard / settings)
LUCI_DESCRIPTION:=A LuCI interface for ShellCrash: start/stop/restart the service, \
	show core, API and panel status, test site latency, tweak kernel runtime options \
	via the Clash API, edit the ShellCrash config, and launch or deploy the Zashboard \
	panel. Architecture independent: the package is "all", installs on any target.
LUCI_DEPENDS:=+luci-base +curl +unzip +ca-bundle
LUCI_PKGARCH:=all

PKG_NAME:=luci-app-shellcrashui
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=ShellCrashUI contributors

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
