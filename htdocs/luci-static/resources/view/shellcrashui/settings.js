'use strict';
'require view';
'require form';
'require fs';
'require uci';
'require ui';
'require poll';
'require dom';

var CTL = '/usr/libexec/luci-shellcrashui/ctl.sh';

/* ---------------------------------------------------------------- 小工具 */

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

function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '26%' }, [ label ]),
		E('td', { 'class': 'td left' }, Array.isArray(value) ? value : [ value ])
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

/* 内核运行参数：每项都是「无参数动作」，方便在 rpcd ACL 里逐条精确授权 */
var KERNEL_SPECS = [
	{
		key: 'mode', label: '代理模式', kind: 'text',
		text: { rule: '规则', global: '全局', direct: '直连' },
		actions: [ [ 'mode-rule', '规则' ], [ 'mode-global', '全局' ], [ 'mode-direct', '直连' ] ]
	},
	{
		key: 'log_level', label: '日志等级', kind: 'text',
		actions: [
			[ 'log-silent', '静默' ], [ 'log-error', '错误' ], [ 'log-warning', '警告' ],
			[ 'log-info', '信息' ], [ 'log-debug', '调试' ]
		]
	},
	{
		key: 'allow_lan', label: '允许局域网连接', kind: 'bool',
		actions: [ [ 'allow-lan-on', '开启' ], [ 'allow-lan-off', '关闭' ] ]
	},
	{
		key: 'ipv6', label: 'IPv6', kind: 'bool',
		actions: [ [ 'ipv6-on', '开启' ], [ 'ipv6-off', '关闭' ] ]
	},
	{
		key: 'tcp_concurrent', label: 'TCP 并发', kind: 'bool',
		actions: [ [ 'tcp-concurrent-on', '开启' ], [ 'tcp-concurrent-off', '关闭' ] ]
	}
];

/* ---------------------------------------------------------------- 视图 */

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('shellcrash'),
			ctl([ 'status' ]).catch(function(e) { return { ok: false, error: e.message }; }),
			ctl([ 'kernel-get' ]).catch(function(e) { return { ok: false, error: e.message }; })
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

	/* ---------------- 内核运行参数 ---------------- */

	kernelText: function(key, kind) {
		var v = this.kst ? this.kst[key] : undefined;
		if (v === undefined || v === null || v === '')
			return '—';
		if (kind === 'bool')
			return (v === true || v === 'true') ? '已开启' : '已关闭';
		return String(v);
	},

	refreshKernel: function() {
		var self = this;
		return ctl([ 'kernel-get' ]).then(function(k) {
			self.kst = k;
			if (!self.kernelValueNodes) return;
			for (var i = 0; i < KERNEL_SPECS.length; i++) {
				var spec = KERNEL_SPECS[i];
				dom.content(self.kernelValueNodes[spec.key], [ self.kernelText(spec.key, spec.kind) ]);
			}
			dom.content(self.kernelHint, [ self.kernelSummary() ]);
		}).catch(function() {});
	},

	kernelSummary: function() {
		var k = this.kst || {};
		if (k.error)
			return [ warnBadge('读取失败'), ' ', String(k.error) ];
		if (k.ok === false)
			return [ warnBadge('不可用'), ' ', String(k.message || '内核未运行或 API 不可达') ];
		if (!k.parsed)
			return [ warnBadge('未解析'), ' ', '读到了配置但没能解析出字段（ucode 不可用？）' ];
		return [ okBadge('已连接'), ' 混合端口 ', String(k.mixed_port || '—') ];
	},

	applyKernel: function(action, label) {
		var self = this;
		return ctl([ action ]).then(function(res) {
			if (res && res.ok === false)
				throw new Error(res.message || '设置失败');
			self.notify('已应用：' + label, null, 'info');
			return self.refreshKernel();
		}).catch(function(e) {
			self.notify('设置失败：' + e.message, null, 'error');
		});
	},

	kernelCard: function() {
		var self = this;
		this.kernelValueNodes = {};

		var rows = KERNEL_SPECS.map(function(spec) {
			var vnode = E('span', {}, [ self.kernelText(spec.key, spec.kind) ]);
			self.kernelValueNodes[spec.key] = vnode;

			var btns = [];
			spec.actions.forEach(function(a, i) {
				if (i) btns.push(' ');
				btns.push(button(a[1], 'cbi-button-action', function() {
					return self.applyKernel(a[0], spec.label + ' → ' + a[1]);
				}, false));
			});

			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'width': '26%' }, [ spec.label ]),
				E('td', { 'class': 'td left', 'width': '16%' }, [ vnode ]),
				E('td', { 'class': 'td left' }, btns)
			]);
		});

		this.kernelHint = E('div', { 'class': 'cbi-section-descr' }, [ this.kernelSummary() ]);

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ '内核运行参数' ]),
			this.kernelHint,
			E('table', { 'class': 'table' }, [ E('tbody', {}, rows) ]),
			E('div', { 'class': 'cbi-section-descr' }, [
				'这些参数通过 Clash API 的 PATCH /configs 下发，**立即生效、不需要重启内核**。',
				'但它们只作用于本次运行：ShellCrash 重启后会按 config.yaml 重建，改动即失效。',
				'想要永久生效，请改下方的 ShellCrash 配置，或者用 ShellCrash 自己的菜单。'
			]),
			E('div', { 'class': 'cbi-section-descr' }, [
				'另：统一延迟（unified-delay）不在 mihomo 的运行时接口支持范围内，',
				'调用会返回成功但值不变，所以这里不提供修改。'
			])
		]);
	},

	/* ---------------- ShellCrash 配置文件 ---------------- */

	cfgPath: function() {
		var st = this.st || {};
		if (st.cfg_file)
			return st.cfg_file;
		if (st.crashdir)
			return st.crashdir + '/configs/ShellCrash.cfg';
		return '/etc/ShellCrash/configs/ShellCrash.cfg';
	},

	loadCfgFile: function() {
		var self = this;
		return fs.read(this.cfgPath()).then(function(text) {
			self.cfgOriginal = text;
			if (self.cfgArea) self.cfgArea.value = text;
			dom.content(self.cfgStatus, [ okBadge('已载入'), ' ', String(text.length), ' 字节 · ', self.cfgPath() ]);
		}).catch(function(e) {
			dom.content(self.cfgStatus, [
				warnBadge('读取失败'), ' ', self.cfgPath(), ' —— ',
				String(e.message || e),
				'（如果 ShellCrash 装在别的目录，rpcd 的 ACL 需要放行那个路径）'
			]);
		});
	},

	saveCfgFile: function(restart) {
		var self = this;
		var text = this.cfgArea ? this.cfgArea.value : '';

		if (!text || text.indexOf('=') < 0) {
			this.notify('内容看起来不像 ShellCrash 配置（没有找到任何 key=value），已拒绝保存。', null, 'error');
			return Promise.resolve();
		}

		// 先备份当前磁盘上的内容，再写入新内容
		return fs.read(this.cfgPath()).then(function(old) {
			return fs.write(self.cfgPath() + '.bak', old);
		}).catch(function() {
			/* 备份失败不阻塞保存，但要提示 */
		}).then(function() {
			return fs.write(self.cfgPath(), text);
		}).then(function() {
			self.cfgOriginal = text;
			self.notify('已保存到 ' + self.cfgPath() + '，备份在 ' + self.cfgPath() + '.bak', null, 'info');
			return self.loadCfgFile();
		}).then(function() {
			if (!restart)
				return null;
			return ctl([ 'restart' ]).then(function(res) {
				self.notify('ShellCrash 已重启' + (res && res.message ? '：' + res.message : ''), res && res.output, 'info');
				return self.refreshStatus();
			}).catch(function(e) {
				self.notify('重启失败：' + e.message, null, 'error');
			});
		}).catch(function(e) {
			self.notify('保存失败：' + (e.message || e), null, 'error');
		});
	},

	restoreCfgFile: function() {
		var self = this;
		return fs.read(this.cfgPath() + '.bak').then(function(text) {
			self.cfgArea.value = text;
			self.notify('已把备份内容读回编辑框，确认无误后点「保存」写入。', null, 'info');
		}).catch(function(e) {
			self.notify('没有可用的备份：' + (e.message || e), null, 'error');
		});
	},

	cfgCard: function() {
		var self = this;

		this.cfgStatus = E('div', { 'class': 'cbi-section-descr' }, [ '尚未载入' ]);
		this.cfgArea = E('textarea', {
			'rows': 22,
			'spellcheck': 'false',
			'style': 'width:100%;font-family:monospace;font-size:12px;box-sizing:border-box'
		}, [ '' ]);

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ 'ShellCrash 配置' ]),
			this.cfgStatus,
			E('div', { 'class': 'cbi-page-actions', 'style': 'text-align:left' }, [
				button('重新载入', 'cbi-button-neutral', function() { return self.loadCfgFile(); }, false),
				' ',
				button('保存', 'cbi-button-apply', function() { return self.saveCfgFile(false); }, false),
				' ',
				button('保存并重启 ShellCrash', 'cbi-button-action', function() { return self.saveCfgFile(true); }, false),
				' ',
				button('从备份恢复', 'cbi-button-reset', function() { return self.restoreCfgFile(); }, false)
			]),
			this.cfgArea,
			E('div', { 'class': 'cbi-section-descr' }, [
				'这是 ShellCrash 自己的配置（ShellCrash.cfg）。它是内核配置的「源头」——' +
				'ShellCrash 启动时会据此重新生成内核的 config.yaml，所以这里改完需要重启 ShellCrash 才会生效。',
				'保存前会自动把原内容备份成同名 .bak 文件；改坏了可以点「从备份恢复」把内容读回编辑框再保存。',
				'格式是每行一个 key=value，请不要增删你不理解的键，也不要改动内核选择、CPU 架构之类的字段。'
			])
		]);
	},

	/* ---------------- 渲染 ---------------- */

	refreshStatus: function() {
		var self = this;
		return ctl([ 'status' ]).then(function(st) {
			self.st = st;
		}).catch(function() {});
	},

	render: function(data) {
		var self = this;
		this.st = data[1] || {};
		this.kst = data[2] || {};

		var kernelCard = this.kernelCard();
		var cfgCard = this.cfgCard();

		// 首次载入配置文件内容
		this.loadCfgFile();

		var interval = parseInt(uci.get('shellcrash', 'main', 'poll_interval')) || 5;
		if (interval < 3) interval = 3;
		poll.add(function() {
			return self.refreshKernel();
		}, interval);

		return E('div', {}, [ kernelCard, cfgCard ]);
	}
});
