'use strict';
'require view';
'require form';
'require fs';
'require uci';
'require ui';
'require poll';
'require dom';
'require shellcrashui.panel as panel';

var CTL = '/usr/libexec/luci-shellcrashui/ctl.sh';
var ZASH = '/usr/libexec/luci-shellcrashui/zashboard.sh';

/* ---------------------------------------------------------------- 小工具 */

function callJson(script, args) {
	return fs.exec(script, args).then(function(res) {
		if (res.code !== 0)
			throw new Error((res.stderr || res.stdout || '').trim() || ('退出码 ' + res.code));
		try {
			return JSON.parse(res.stdout);
		}
		catch (e) {
			throw new Error('后端返回了无法解析的数据：' + String(res.stdout || '').substring(0, 160));
		}
	});
}

function ctl(args) { return callJson(CTL, args); }
function zash(args) { return callJson(ZASH, args); }

function cfgGet(name, def) {
	var v = uci.get('shellcrash', 'main', name);
	return (v === undefined || v === null || v === '') ? def : v;
}

function row(label, value) {
	var children = Array.isArray(value) ? value : [ value ];
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '34%' }, [ label ]),
		E('td', { 'class': 'td left' }, children)
	]);
}

function okBadge(text) {
	return E('span', { 'class': 'ifacebadge', 'style': 'background:#2e7d32;color:#fff;border-color:transparent' }, [ text ]);
}

function warnBadge(text) {
	return E('span', { 'class': 'ifacebadge', 'style': 'background:#ef6c00;color:#fff;border-color:transparent' }, [ text ]);
}

function button(label, cls, fn, disabled) {
	return E('button', {
		'class': 'btn cbi-button ' + (cls || 'cbi-button-action'),
		'disabled': disabled ? true : null,
		'click': function(ev) {
			ev.preventDefault();
			return fn(ev);
		}
	}, [ label ]);
}

function copyToClipboard(text) {
	var ta = document.createElement('textarea');
	ta.value = text;
	ta.setAttribute('readonly', 'readonly');
	ta.style.position = 'fixed';
	ta.style.top = '-1000px';
	document.body.appendChild(ta);
	ta.select();
	ta.setSelectionRange(0, text.length);

	var ok = false;
	try {
		ok = document.execCommand('copy');
	}
	catch (e) {
		ok = false;
	}
	document.body.removeChild(ta);
	return ok;
}

/*
 * 地址构造与可用性判断都在 shellcrashui/panel.js 里——运行控制页的
 * 「打开面板」按钮用的是同一份逻辑。这里只做名字转发，避免两边各写一份
 * 混合内容规则和各种「没部署」判断，改了一边忘了另一边。
 */
function panelUrl(mode, st) { return panel.panelUrl(mode, st); }
function effectiveMode(st) { return panel.effectiveMode(st); }
function remoteUsable(st) { return panel.remoteUsable(st); }

/* ------------------------------------------------------------------ 视图 */

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('shellcrash'),
			ctl([ 'status' ]).catch(function(e) { return { ok: false, error: e.message }; }),
			zash([ 'status' ]).catch(function(e) { return { ok: false, error: e.message }; })
		]);
	},

	notify: function(title, output, type) {
		var body = [ E('p', {}, [ title ]) ];
		if (output)
			body.push(E('pre', {
				'style': 'white-space:pre-wrap;word-break:break-all;max-height:30vh;overflow:auto;margin:6px 0 0'
			}, [ output ]));
		ui.addNotification(null, body, type || 'info');
	},

	refresh: function() {
		var self = this;
		return Promise.all([
			ctl([ 'status' ]).catch(function() { return null; }),
			zash([ 'status' ]).catch(function() { return null; })
		]).then(function(r) {
			if (r[0]) self.st = r[0];
			if (r[1]) self.zst = r[1];
			dom.content(self.body, self.statusRows());
			self.renderLinks();
		});
	},

	/* ---------------- 打开面板 ---------------- */

	openPanel: function(mode) {
		// 能不能打开、为什么打不开，都由 panel.js 统一判断
		var a = panel.availability(mode, this.st || {}, this.zst || {});

		if (!a.ready) {
			this.notify('面板打不开：' + a.reason, null, 'warning');
			return;
		}

		window.open(a.url, '_blank');
	},

	startAndOpen: function() {
		var self = this;
		var mode = effectiveMode(this.st);
		var url = panelUrl(mode, this.st);
		var tries = 0;

		ui.showModal('正在启动并等待内核 API…', [
			E('p', { 'class': 'spinner' }, [ '正在启动 ShellCrash，并等待 API 端口就绪，最多等待 60 秒。' ])
		]);

		function tick() {
			tries++;
			return ctl([ 'status' ]).then(function(st) {
				self.st = st;

				if (st.api_reachable) {
					ui.hideModal();
					self.notify('内核 API 已就绪，正在打开面板', url, 'info');
					window.open(panelUrl(effectiveMode(st), st), '_blank');
					return self.refresh();
				}

				if (tries >= 30) {
					ui.hideModal();
					self.notify('等待超时：60 秒内没有检测到内核 API，请查看运行日志排查。', null, 'error');
					return self.refresh();
				}

				return new Promise(function(resolve) {
					window.setTimeout(resolve, 2000);
				}).then(tick);
			}).catch(function(e) {
				ui.hideModal();
				self.notify('启动失败：' + e.message, null, 'error');
			});
		}

		return ctl([ 'start' ]).then(function() {
			return tick();
		}).catch(function(e) {
			ui.hideModal();
			self.notify('启动失败：' + e.message, null, 'error');
		});
	},

	/* ---------------- 后台部署任务 ---------------- */

	runJob: function(action, target) {
		var self = this;

		return zash([ action, target ]).then(function(res) {
			if (!res.ok)
				throw new Error(res.message || '任务启动失败');
			return self.watchJob(action === 'install' ? '正在部署 Zashboard…' : '正在卸载 Zashboard…');
		}).catch(function(e) {
			self.notify('任务启动失败：' + e.message, null, 'error');
		});
	},

	watchJob: function(title) {
		var self = this;
		// 同 main.js：不设背景色，避免深色主题下浅底浅字。
		var logNode = E('pre', {
			'style': 'white-space:pre-wrap;word-break:break-all;max-height:40vh;overflow:auto;border:1px solid;border-radius:4px;padding:8px;margin:0'
		}, [ '正在启动任务…' ]);

		ui.showModal(title, [
			logNode,
			E('p', { 'class': 'spinner' }, [ '任务在后台执行，可以关闭本窗口继续操作。' ]),
			E('div', { 'class': 'right' }, [
				button('后台运行', 'cbi-button-neutral', function() { ui.hideModal(); }, false)
			])
		]);

		var timer = window.setInterval(function() {
			zash([ 'job' ]).then(function(j) {
				dom.content(logNode, j.log || '（暂无输出）');
				logNode.scrollTop = logNode.scrollHeight;

				if (!j.running) {
					window.clearInterval(timer);
					ui.hideModal();
					var ok = (j.status === 'ok');
					self.notify(ok ? '任务执行完成' : '任务执行失败',
						String(j.log || '').slice(-3000), ok ? 'info' : 'error');
					self.refresh();
				}
			}).catch(function() {});
		}, 1500);
	},

	/* ---------------- 渲染 ---------------- */

	urlTable: function() {
		var st = this.st || {};
		var zst = this.zst || {};
		var self = this;
		var customUrl = String(cfgGet('panel_url', ''));

		var items = [
			{
				key: 'core', name: '内核 external-ui',
				url: panelUrl('core', st),
				ready: !!st.panel_core_installed,
				hint: st.panel_core_installed
					? String(zst.core_dir || st.panel_core_dir || '')
					: '在 ShellCrash 菜单里把面板选成 Zashboard，或者用下方「部署到内核 ui 目录」'
			},
			{
				key: 'local', name: 'LuCI 站点目录',
				url: panelUrl('local', st),
				ready: !!zst.luci_installed,
				hint: zst.luci_installed
					? String(zst.luci_dir || '')
					: '用下方「部署到 LuCI 站点目录」后由 uhttpd 提供访问'
			},
			{
				key: 'remote', name: '在线站点',
				url: panelUrl('remote', st),
				ready: remoteUsable(st),
				hint: remoteUsable(st)
					? '无需部署，直接用浏览器连你的内核'
					: '在线站点是 HTTPS，而内核 API 是 HTTP。浏览器会拦掉 HTTPS 页面发往 HTTP 后端的请求，所以这条路连不上——请改用上面两条本地面板，或给内核配上 HTTPS API（external-controller-tls）'
			},
			{
				key: 'custom', name: '自定义地址',
				url: customUrl ? panelUrl('custom', st) : '',
				ready: !!customUrl,
				hint: customUrl ? '' : '在下方「面板设置」里填写自定义面板地址'
			}
		];

		var rows = items.map(function(it) {
			var status = it.ready
				? okBadge(it.key === 'remote' ? '可用' : '已部署')
				: warnBadge('未部署');

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'width': '18%' }, [ it.name ]),
				E('td', { 'class': 'td left' }, [
					it.url
						? E('a', { 'href': it.url, 'target': '_blank', 'rel': 'noopener' }, [ it.url ])
						: E('em', {}, [ '（未配置）' ]),
					it.hint ? E('div', {}, [ E('small', {}, [ status, ' ', it.hint ]) ]) : ''
				]),
				E('td', { 'class': 'td right', 'width': '17%' }, [
					button('打开', 'cbi-button-action', function() { self.openPanel(it.key); },
						!it.url || !it.ready),
					' ',
					button('复制', 'cbi-button-neutral', function() {
						if (copyToClipboard(it.url))
							self.notify('链接已复制到剪贴板', null, 'info');
						else
							self.notify('复制失败，请手动选中链接复制', null, 'warning');
					}, !it.url)
				])
			]);
		});

		return E('table', { 'class': 'table' }, [ E('tbody', {}, rows) ]);
	},

	renderLinks: function() {
		if (!this.linkBox) return;
		dom.content(this.linkBox, this.urlTable());
		if (this.mainBtn)
			this.mainBtn.textContent = '打开面板（' + effectiveMode(this.st) + '）';
	},

	statusRows: function() {
		var st = this.st || {};
		var zst = this.zst || {};

		// 后端脚本没执行成功（最常见的原因是 rpcd 的 ACL 未生效）时，
		// 不能退化成「已停止 / 未部署」——那会把权限问题伪装成正常状态
		if (st.error || zst.error) {
			return [
				row('后端脚本执行失败', [ warnBadge('无法读取状态') ]),
				row('错误信息', [ String(st.error || zst.error) ]),
				row('排查建议', [
					'确认 /usr/libexec/luci-shellcrashui/ 下的脚本存在且可执行；' +
					'如果刚安装完插件，请重启 rpcd：/etc/init.d/rpcd restart'
				])
			];
		}

		return [
			row('ShellCrash 服务', [ st.running ? okBadge('运行中') : warnBadge('已停止') ]),
			row('内核 API', [
				(st.api_port || '9090') + ' 端口 ',
				st.api_reachable ? okBadge('可连接') : warnBadge('不可连接'),
				st.secret_set ? ' 已设置密钥' : ' 无密钥'
			]),
			row('面板部署位置', [
				st.panel_core_installed ? okBadge('内核 ui：' + (zst.core_version || '已部署')) : '',
				' ',
				zst.luci_installed ? okBadge('LuCI 站点：' + (zst.luci_version || '已部署')) : '',
				' ',
				(!st.panel_core_installed && !zst.luci_installed) ? warnBadge('尚未部署本地面板') : ''
			]),
			row('推荐打开方式', [ effectiveMode(st) === 'auto' ? 'remote' : effectiveMode(st) ]),
			row('目标版本', [ zst.wanted_version || 'latest' ]),
			row('解压工具', [ zst.unzip ? okBadge('unzip 可用') : warnBadge('缺少 unzip，部署时将尝试自动安装') ]),
			row('加速前缀', [ zst.mirror || '（内置默认列表）' ])
		];
	},

	render: function(data) {
		var self = this;
		this.st = data[1] || {};
		this.zst = data[2] || {};

		this.body = E('tbody', {});
		dom.content(this.body, this.statusRows());

		var statusCard = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ '面板状态' ]),
			E('table', { 'class': 'table' }, [ this.body ])
		]);

		/* -------- 主操作 -------- */
		this.mainBtn = button('打开面板（' + effectiveMode(this.st) + '）', 'cbi-button-apply', function() {
			self.openPanel(effectiveMode(self.st));
		}, false);

		var launchCard = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ '一键打开' ]),
			E('div', { 'class': 'cbi-page-actions', 'style': 'text-align:left' }, [
				this.mainBtn, ' ',
				button('启动服务并打开', 'cbi-button-action', function() { return self.startAndOpen(); }, false)
			]),
			E('div', { 'class': 'cbi-section-descr' }, [
				'跳转链接会自动带上 protocol / hostname / port / secret 参数，面板打开后无需再手工填写后端地址与密钥。',
				'注意：HTTPS 页面不允许请求 HTTP 后端（浏览器的混合内容策略，没有例外）。' +
				'内核 API 是 HTTP 时，请用本地面板（内核 ui 或 LuCI 站点目录），不要用在线 HTTPS 站点。'
			])
		]);

		/* -------- 直达链接 -------- */
		this.linkBox = E('div', {});
		dom.content(this.linkBox, this.urlTable());

		var linkCard = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ '各部署方式的直达链接' ]),
			this.linkBox
		]);

		/* -------- 部署 / 更新 -------- */
		var deployCard = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ '部署与更新' ]),
			E('div', { 'class': 'cbi-page-actions', 'style': 'text-align:left' }, [
				button('部署到 LuCI 站点目录', 'cbi-button-apply', function() {
					return self.runJob('install', 'luci');
				}, false),
				' ',
				button('部署到内核 ui 目录', 'cbi-button-action', function() {
					return self.runJob('install', 'core');
				}, false),
				' ',
				button('卸载 LuCI 站点面板', 'cbi-button-reset', function() {
					return self.runJob('uninstall', 'luci');
				}, false),
				' ',
				button('卸载内核 ui 面板', 'cbi-button-reset', function() {
					return self.runJob('uninstall', 'core');
				}, false)
			]),
			E('div', { 'class': 'cbi-section-descr' }, [
				'部署到 LuCI 站点目录后，面板由 uhttpd 提供，地址是 ',
				E('code', {}, [ (self.zst.web_root || '/www') + '/zashboard' ]),
				'，不依赖内核的 external-ui，也不受 ShellCrash 重新生成配置的影响。',
				'部署到内核 ui 目录则需要在 ShellCrash 菜单里把面板选择为 Zashboard（即设置 external-ui）。',
				'下载走 GitHub Release，失败时会依次尝试加速前缀。'
			])
		]);

		/* -------- 设置 -------- */
		var m = new form.Map('shellcrash', '面板设置', '决定“打开面板”按钮跳转到哪里，以及是否自动填充后端地址与密钥。');

		var s = m.section(form.NamedSection, 'main', 'shellcrash');
		s.anonymous = true;

		var o = s.option(form.ListValue, 'panel_mode', '面板模式');
		o.value('auto', '自动（优先内核 ui，其次本地站点，最后在线站点）');
		o.value('core', '内核 external-ui（http://路由器IP:API端口/ui/）');
		o.value('local', 'LuCI 站点目录（http://路由器IP/zashboard/）');
		o.value('remote', '在线站点（默认 board.zash.run.place）');
		o.value('custom', '自定义地址');
		o.default = 'auto';

		o = s.option(form.Value, 'panel_url', '自定义面板地址');
		o.placeholder = 'https://example.com/zashboard/';
		o.depends('panel_mode', 'custom');

		o = s.option(form.Value, 'remote_url', '在线站点地址');
		o.placeholder = 'https://board.zash.run.place/';
		o.depends('panel_mode', 'remote');

		o = s.option(form.Flag, 'panel_query', '自动填充后端地址和密钥',
			'打开面板时附加 protocol / hostname / port / secret 查询参数，实现免登录直连。');
		o.default = '1';

		o = s.option(form.ListValue, 'panel_protocol', '填充的协议');
		o.value('auto', '自动（跟随内核 API 实际使用的协议）');
		o.value('http', 'http');
		o.value('https', 'https');
		o.default = 'auto';
		o.description = '决定跳转链接里 protocol= 的取值。内核只开了 HTTP 控制器时填 https 会连不上，一般保持自动即可。';
		o.depends('panel_query', '1');

		o = s.option(form.Value, 'panel_query_extra', '附加查询参数');
		o.placeholder = 'theme=dark';
		o.description = '会原样拼接到面板地址后面，例如 theme=dark 或 label=我的路由器。';
		o.depends('panel_query', '1');

		o = s.option(form.Value, 'zashboard_version', 'Zashboard 版本');
		o.placeholder = 'latest';
		o.description = '填 latest 使用最新版，也可以填具体 tag，例如 v1.4.0。';

		o = s.option(form.Value, 'mirror', 'GitHub 加速前缀');
		o.placeholder = 'https://ghfast.top/';
		o.description = '多个用空格分隔，按顺序尝试；留空使用内置镜像列表。';

		/* -------- 轮询 -------- */
		var interval = parseInt(cfgGet('poll_interval', '5')) || 5;
		poll.add(function() {
			return Promise.all([
				ctl([ 'status' ]).catch(function() { return null; }),
				zash([ 'status' ]).catch(function() { return null; })
			]).then(function(r) {
				if (r[0]) self.st = r[0];
				if (r[1]) self.zst = r[1];
				dom.content(self.body, self.statusRows());
				self.renderLinks();
			});
		}, interval);

		return m.render().then(function(mapNode) {
			return E('div', {}, [ statusCard, launchCard, linkCard, deployCard, mapNode ]);
		});
	}
});
