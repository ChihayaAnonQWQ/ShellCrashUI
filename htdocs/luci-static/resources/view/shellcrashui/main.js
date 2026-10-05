'use strict';
'require view';
'require fs';
'require uci';
'require ui';
'require poll';
'require dom';
'require shellcrashui.panel as panel';

var CTL = '/usr/libexec/luci-shellcrashui/ctl.sh';

/* 调用后端脚本并解析 JSON */
function ctl(args) {
	return fs.exec(CTL, args).then(function(res) {
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

function badge(text, color) {
	return E('span', {
		'class': 'ifacebadge',
		'style': 'background:%s;color:#fff;border-color:transparent'.format(color)
	}, [ text ]);
}

function okBadge(text) { return badge(text, '#2e7d32'); }
function badBadge(text) { return badge(text, '#c62828'); }
function warnBadge(text) { return badge(text, '#ef6c00'); }

function row(label, value) {
	var children = Array.isArray(value) ? value : [ value ];
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '34%' }, [ label ]),
		E('td', { 'class': 'td left' }, children)
	]);
}

function dash() { return E('em', {}, [ '—' ]); }

/*
 * 概览条里的一个指标块。
 * 只设文字颜色层面的对比（opacity），背景一律不设——LuCI 有明暗两套主题，
 * 硬编码底色必有一套会变成「浅底浅字」。分隔线用 currentColor 跟随主题。
 */
function tile(label, main, sub, last) {
	return E('td', {
		'class': 'td left',
		'style': 'width:25%;padding:12px 10px;vertical-align:top' +
			(last ? '' : ';border-right:1px solid currentColor')
	}, [
		E('div', { 'style': 'font-size:12px;opacity:0.65;margin-bottom:6px' }, [ label ]),
		E('div', { 'style': 'font-size:15px;font-weight:bold' }, [ main ]),
		E('div', { 'style': 'font-size:12px;opacity:0.75;margin-top:4px' }, [ sub || '' ])
	]);
}

function actionButton(label, cls, fn, disabled) {
	return E('button', {
		'class': 'btn cbi-button ' + (cls || 'cbi-button-action'),
		'disabled': disabled ? true : null,
		'click': function(ev) {
			ev.preventDefault();
			return fn(ev);
		}
	}, [ label ]);
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('shellcrash'),
			ctl([ 'status' ]).catch(function(e) {
				return { ok: false, error: e.message };
			})
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

	handleAction: function(args, title) {
		var self = this;
		ui.showModal(title, [
			E('p', { 'class': 'spinner' }, [ '正在执行，请稍候…' ])
		]);
		return ctl(args).then(function(res) {
			ui.hideModal();
			self.notify((res && res.message) || '操作完成', res && res.output, 'info');
			return self.refresh();
		}).catch(function(e) {
			ui.hideModal();
			self.notify('操作失败：' + e.message, null, 'error');
			return self.refresh();
		});
	},

	/* 概览条：四个一眼要看到的指标 */
	overviewTiles: function(st) {
		if (st && st.error)
			return [ tile('状态', badBadge('读取失败'), String(st.error).substring(0, 80), true) ];

		if (!st || st.installed === false)
			return [ tile('服务状态', badBadge('未安装'), '没有在路由器上找到 ShellCrash', true) ];

		var mem = st.mem_kb ? (Math.round(parseInt(st.mem_kb, 10) / 1024) + ' MB') : null;
		var sub = st.running
			? ('PID ' + (st.pid || '—') + (mem ? ' · 内存 ' + mem : ''))
			: '内核未在运行';

		var panelReady = !!(st.panel_core_installed || st.panel_local_installed);
		var panelText = st.panel_core_installed ? '已部署到内核 ui 目录'
			: (st.panel_local_installed ? '已部署到 LuCI 站点目录' : '尚未部署本地面板');

		return [
			tile('服务状态', st.running ? okBadge('运行中') : badBadge('已停止'), sub, false),
			tile('内核', st.core || dash(),
				(st.core_version || '版本未知') + ' · ' + (st.run_mode || '模式未知'), false),
			tile('API 接口', (st.api_port || '9090') + ' 端口',
				st.api_reachable
					? ('可连接 · ' + (st.secret_set ? '已设密钥' : '无密钥'))
					: '不可连接',
				false),
			tile('本地面板', panelReady ? okBadge('已部署') : warnBadge('未部署'), panelText, true)
		];
	},

	overviewCard: function(st) {
		this.overviewBody = E('tbody', {});
		dom.content(this.overviewBody, [ E('tr', { 'class': 'tr' }, this.overviewTiles(st)) ]);

		return E('div', { 'class': 'cbi-section' }, [
			E('table', { 'class': 'table' }, [ this.overviewBody ]),
			E('div', { 'class': 'cbi-section-descr' }, [
				'状态每 ', String(uci.get('shellcrash', 'main', 'poll_interval') || 5), ' 秒自动刷新一次。'
			])
		]);
	},

	/* 详情表：概览条放不下的东西放这里 */
	detailRows: function(st) {
		// 后端脚本没执行成功（最常见的原因是 rpcd 的 ACL 未生效）时，
		// 不能退化成「未安装」——那会把权限问题伪装成正常状态
		if (st && st.error) {
			return [
				row('后端脚本执行失败', [ badBadge('无法读取状态') ]),
				row('错误信息', [ String(st.error) ]),
				row('排查建议', [
					'确认 /usr/libexec/luci-shellcrashui/ctl.sh 存在且可执行；' +
					'如果刚安装完插件，请重启 rpcd：/etc/init.d/rpcd restart'
				])
			];
		}

		if (!st || st.installed === false) {
			return [
				row('检测结果', [ badBadge('未安装 ShellCrash') ]),
				row('说明', [ '没有在路由器上找到 ShellCrash。请先在终端执行官方安装脚本，安装完成后再回到本页面刷新。' ]),
				row('主机架构', [ st && st.arch ? st.arch : dash() ])
			];
		}

		return [
			row('ShellCrash 版本', [ st.version || dash() ]),
			row('安装目录', [ st.crashdir || dash() ]),
			row('配置文件', [ st.cfg_file || dash() ]),
			row('主机架构', [ st.arch || dash() ]),
			row('混合代理端口', [ st.mixed_port || dash() ]),
			row('透明代理端口', [ st.redir_port || dash() ]),
			row('API 密钥', [ st.secret_set ? '已设置' : '未设置' ]),
			row('开机自启', [ st.autostart ? okBadge('已启用') : warnBadge('未启用') ])
		];
	},

	refresh: function() {
		var self = this;
		return ctl([ 'status' ]).then(function(st) {
			dom.content(self.overviewBody, [ E('tr', { 'class': 'tr' }, self.overviewTiles(st)) ]);
			dom.content(self.detailBody, self.detailRows(st));
			self.lastStatus = st;
			self.updateButtons(st);
		}).catch(function() {});
	},

	updateButtons: function(st) {
		if (!st) return;
		var running = !!st.running;
		if (this.btnStart) this.btnStart.disabled = running;
		if (this.btnStop) this.btnStop.disabled = !running;
		if (this.btnOpenPanel)
			this.btnOpenPanel.textContent = '打开面板（' + panel.effectiveMode(st) + '）';
		if (this.btnAutostart) {
			this.btnAutostart.textContent = st.autostart ? '取消开机自启' : '开启开机自启';
			this.btnAutostart.className = 'btn cbi-button ' +
				(st.autostart ? 'cbi-button-reset' : 'cbi-button-action');
		}
	},

	/*
	 * 打开面板。地址构造与可用性判断在 shellcrashui/panel.js 里，
	 * 和「Zashboard 面板」页用的是同一份逻辑。
	 * 本页没有 zashboard.sh 的状态，就从 ctl.sh 的字段拼一个够用的 zst。
	 */
	openPanel: function() {
		var st = this.lastStatus || {};
		var zst = {
			luci_installed: st.panel_local_installed,
			luci_dir: st.panel_local_dir
		};

		var mode = panel.effectiveMode(st);
		var a = panel.availability(mode, st, zst);

		if (!a.ready) {
			this.notify('面板打不开：' + a.reason, null, 'warning');
			return Promise.resolve();
		}

		window.open(a.url, '_blank');
		return Promise.resolve();
	},

	loadLogs: null,

	/* ---------------- 延迟测试 ---------------- */

	pingRows: function(res) {
		if (!res)
			return [ row('状态', [ dash() ]) ];

		if (res.ok === false)
			return [ row('状态', [ badBadge('测试失败'), ' ', String(res.message || '') ]) ];

		var list = res.results || [];
		if (!list.length)
			return [ row('状态', [ warnBadge('没有可测的目标'), ' ', '检查「基础设置」里的延迟测试目标' ]) ];

		return list.map(function(r) {
			var ms = Math.round(parseFloat(r.time) * 1000);
			var reachable = r.code && r.code !== '000' && !isNaN(ms) && ms > 0;

			return row(r.name, [
				reachable
					? (ms < 300 ? okBadge(ms + ' ms') : (ms < 800 ? warnBadge(ms + ' ms') : badBadge(ms + ' ms')))
					: badBadge('超时 / 不可达'),
				' ',
				E('small', {}, [ 'HTTP ' + (r.code || '—') ])
			]);
		});
	},

	runPing: function() {
		var self = this;
		dom.content(this.pingHint, [ E('span', { 'class': 'spinner' }, [ '正在测试…' ]) ]);

		return ctl([ 'ping' ]).then(function(res) {
			dom.content(self.pingBody, self.pingRows(res));
			dom.content(self.pingHint, [
				res.via === 'proxy'
					? ('经内核混合端口 ' + res.mixed_port + ' 发出，所以结果反映的是规则分流后的真实可达性')
					: '内核未在运行，本次是路由器直连测试'
			]);
		}).catch(function(e) {
			dom.content(self.pingBody, self.pingRows({ ok: false, message: e.message }));
			dom.content(self.pingHint, [ '测试失败' ]);
		});
	},

	pingCard: function() {
		var self = this;

		this.pingBody = E('tbody', {}, [ row('状态', [ dash() ]) ]);
		this.pingHint = E('div', { 'class': 'cbi-section-descr' }, [
			'测试经内核混合端口发出，所以国内站点按规则直连、国外站点走代理，反映的是真实可达性。'
		]);

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ '延迟测试' ]),
			this.pingHint,
			E('div', { 'class': 'cbi-page-actions', 'style': 'text-align:left' }, [
				actionButton('测延迟', 'cbi-button-action', function() { return self.runPing(); }, false)
			]),
			E('table', { 'class': 'table' }, [ this.pingBody ])
		]);
	},

	render: function(data) {
		var self = this;
		var st = data[1] || {};

		/* ---------------- 概览区 ---------------- */
		var overviewCard = this.overviewCard(st);

		this.detailBody = E('tbody', {});
		dom.content(this.detailBody, this.detailRows(st));

		var detailCard = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ '服务详情' ]),
			E('table', { 'class': 'table' }, [ this.detailBody ])
		]);

		/* ---------------- 控制区 ---------------- */
		this.btnStart = actionButton('启动', 'cbi-button-apply', function() {
			return self.handleAction([ 'start' ], '正在启动 ShellCrash…');
		}, !!st.running);

		this.btnStop = actionButton('停止', 'cbi-button-reset', function() {
			return self.handleAction([ 'stop' ], '正在停止 ShellCrash…');
		}, !st.running);

		this.btnRestart = actionButton('重启', 'cbi-button-action', function() {
			return self.handleAction([ 'restart' ], '正在重启 ShellCrash…');
		}, false);

		this.btnReload = actionButton('热重载配置', 'cbi-button-action', function() {
			return self.handleAction([ 'reload' ], '正在通过 API 热重载配置…');
		}, false);

		// 开机自启用单个切换按钮：原来两个按钮里总有一个是灰的，
		// 既占地方又容易看错自己现在到底是开还是关
		this.btnAutostart = actionButton(
			st.autostart ? '取消开机自启' : '开启开机自启',
			st.autostart ? 'cbi-button-reset' : 'cbi-button-action',
			function() {
				var on = !!((self.lastStatus || st).autostart);
				return self.handleAction([ on ? 'disable' : 'enable' ],
					on ? '正在取消开机自启…' : '正在设置开机自启…');
			}, false);

		// 最常用的动作放最前面：直接打开面板，不用先跳到另一个页
		this.btnOpenPanel = actionButton(
			'打开面板（' + panel.effectiveMode(st) + '）', 'cbi-button-apply',
			function() { return self.openPanel(); }, false);

		var controlCard = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ '服务控制' ]),
			E('div', { 'class': 'cbi-page-actions', 'style': 'text-align:left' }, [
				this.btnOpenPanel, ' ',
				this.btnStart, ' ',
				this.btnStop, ' ',
				this.btnRestart, ' ',
				this.btnReload, ' ',
				this.btnAutostart
			]),
			E('div', { 'class': 'cbi-section-descr' }, [
				'「热重载配置」让内核重新读取 config.yaml，不重启进程，适合改完配置后立即生效。',
				'命令行等价操作：',
				E('code', {}, [ '/etc/init.d/shellcrash restart' ]),
				'，交互式菜单：',
				E('code', {}, [ 'crash' ]),
				'。'
			])
		]);

		/* ---------------- 相关页面 ---------------- */
		var linkCard = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ '相关页面' ]),
			E('div', { 'class': 'cbi-page-actions', 'style': 'text-align:left' }, [
				E('a', {
					'class': 'btn cbi-button cbi-button-action',
					'href': L.url('admin/services/shellcrashui/zashboard')
				}, [ 'Zashboard 面板' ]),
				' ',
				E('a', {
					'class': 'btn cbi-button cbi-button-action',
					'href': L.url('admin/services/shellcrashui/settings')
				}, [ '内核与 ShellCrash 设置' ])
			]),
			E('div', { 'class': 'cbi-section-descr' }, [
				'面板的打开方式与本地部署在「Zashboard 面板」页；',
				'内核运行参数与 ShellCrash 配置在「内核与 ShellCrash 设置」页。'
			])
		]);

		/* ---------------- 延迟测试区 ---------------- */
		var pingCard = this.pingCard();

		/* ---------------- 轮询 ---------------- */
		var interval = parseInt(uci.get('shellcrash', 'main', 'poll_interval')) || 5;
		poll.add(function() {
			return ctl([ 'status' ]).then(function(s) {
				dom.content(self.overviewBody, [ E('tr', { 'class': 'tr' }, self.overviewTiles(s)) ]);
				dom.content(self.detailBody, self.detailRows(s));
				self.lastStatus = s;
				self.updateButtons(s);
			}).catch(function() {});
		}, interval);

		// 进页面先自动测一次，省得每次都要手点
		this.runPing();

		return E('div', {}, [
			overviewCard, controlCard, pingCard, detailCard, linkCard
		]);
	}
});
