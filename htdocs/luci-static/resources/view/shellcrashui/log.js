'use strict';
'require view';
'require fs';
'require uci';
'require ui';
'require poll';
'require dom';

var CTL = '/usr/libexec/luci-shellcrashui/ctl.sh';

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

function warnBadge(text) {
	return E('span', { 'class': 'ifacebadge', 'style': 'background:#ef6c00;color:#fff;border-color:transparent' }, [ text ]);
}

function button(label, cls, fn) {
	return E('button', {
		'class': 'btn cbi-button ' + (cls || 'cbi-button-action'),
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
			ctl([ 'logs' ]).catch(function(e) {
				return { ok: false, error: e.message };
			})
		]);
	},

	render: function(data) {
		var self = this;
		var first = data[1] || {};
		this.autoRefresh = false;

		// 不设背景色：LuCI 有明暗两套主题，硬编码浅色底会让深色主题下的
		// 浅色文字彻底看不见。边框用 currentColor 跟随主题。
		this.logNode = E('pre', {
			'style': 'white-space:pre-wrap;word-break:break-all;height:60vh;overflow:auto;' +
				'border:1px solid;border-radius:4px;padding:10px;margin:0;font-size:12px'
		}, [ first.error ? ('读取日志失败：' + first.error) : (first.log || '（无内容）') ]);

		this.sourceNode = E('div', { 'class': 'cbi-section-descr' }, [
			first.error ? warnBadge('读取失败') : (first.source ? ('来源：' + first.source) : '来源：未找到日志文件')
		]);

		this.autoBox = E('input', {
			'type': 'checkbox',
			'style': 'margin-right:6px;vertical-align:middle',
			'change': function(ev) {
				self.autoRefresh = !!ev.target.checked;
				if (self.autoRefresh)
					return self.loadLogs();
			}
		});

		// 关掉自动刷新时不发请求，避免白跑
		poll.add(function() {
			return self.autoRefresh ? self.loadLogs() : Promise.resolve();
		}, 3);

		return E('div', {}, [
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ '运行日志' ]),
				this.sourceNode,
				E('div', { 'class': 'cbi-page-actions', 'style': 'text-align:left' }, [
					button('刷新', 'cbi-button-action', function() { return self.loadLogs(); }),
					' ',
					E('label', { 'style': 'cursor:pointer;margin-left:8px' }, [
						this.autoBox, '每 3 秒自动刷新'
					])
				]),
				this.logNode,
				E('div', { 'class': 'cbi-section-descr' }, [
					'行数可在「基础设置」里调整。日志文件是自动定位的：',
					'优先 ShellCrash 自己的日志文件，找不到时回退到系统日志并过滤 ShellCrash / 内核相关行。'
				])
			])
		]);
	},

	loadLogs: function() {
		var self = this;
		return ctl([ 'logs' ]).then(function(res) {
			dom.content(self.logNode, [ res.log || '（无内容）' ]);
			dom.content(self.sourceNode, [
				res.source ? ('来源：' + res.source) : '来源：未找到日志文件'
			]);
		}).catch(function(e) {
			dom.content(self.logNode, [ '读取日志失败：' + e.message ]);
		});
	}
});
