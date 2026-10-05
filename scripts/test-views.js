#!/usr/bin/env node
'use strict';
/*
 * LuCI 视图的无头渲染测试。
 *
 * 为什么需要它：
 *   node --check 只验证语法，抓不到运行时错误。而 LuCI 视图里只要写错一个
 *   变量名（例如在 render() 里用 zst 而不是 self.zst），页面就会直接抛
 *   ReferenceError，用户在浏览器里只看到一个红色错误框。
 *
 * 做法：
 *   把这个文件用 new Function 包起来，把 LuCI 注入的模块（view / form / fs /
 *   uci / ui / poll / dom）以及全局的 E / L / _ / window 全部替换成桩，
 *   然后真的调用 load() 和 render()，最后把渲染出的 DOM 树转成纯文本打印出来。
 *
 * 用法：
 *   node scripts/test-views.js
 */

const nodeFs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGETS = [
	{ name: 'main.js', file: 'htdocs/luci-static/resources/view/shellcrashui/main.js' },
	{ name: 'log.js', file: 'htdocs/luci-static/resources/view/shellcrashui/log.js' },
	{ name: 'general.js', file: 'htdocs/luci-static/resources/view/shellcrashui/general.js' },
	{ name: 'zashboard.js', file: 'htdocs/luci-static/resources/view/shellcrashui/zashboard.js' },
	{ name: 'settings.js', file: 'htdocs/luci-static/resources/view/shellcrashui/settings.js' }
];

const CTL = '/usr/libexec/luci-shellcrashui/ctl.sh';
const ZASH = '/usr/libexec/luci-shellcrashui/zashboard.sh';

/* ---------------------------------------------------------------- 测试数据 */
/* 下面这份 JSON 是从真机（OpenWrt 25.12.4 / ShellCrash 1.9.5beta3）抓的真实输出 */

const REAL_STATUS = {
	ok: true, ctl_version: '1.0.0', arch: 'aarch64',
	installed: true, crashdir: '/etc/ShellCrash',
	cfg_file: '/etc/ShellCrash/configs/ShellCrash.cfg',
	version: '1.9.5beta3', core: 'meta', core_version: 'v1.19.17',
	run_mode: 'Mix', running: true, pid: '22144', mem_kb: '41148',
	init_script: true, autostart: true,
	api_port: '9999', api_reachable: true, api_tls: false,
	mixed_port: '7890', redir_port: '7892',
	secret: '', secret_set: false, curl: true,
	panel_core_dir: '/etc/ShellCrash/ui', panel_local_dir: '/www/zashboard',
	panel_core_installed: true, panel_local_installed: false,
	recommended_mode: 'core', time: 1791227348
};

const REAL_ZSTATUS = {
	ok: true, repo: 'Zephyruso/zashboard', web_root: '/www',
	luci_dir: '/www/zashboard', core_dir: '/etc/ShellCrash/ui',
	luci_installed: false, core_installed: true,
	luci_version: '', core_version: '', wanted_version: 'latest',
	mirror: 'https://ghfast.top/ https://gh-proxy.com/ https://ghproxy.net/ https://mirror.ghproxy.com/',
	unzip: true, job_running: false,
	api_port: '9999', secret: '', remote_url: 'https://board.zash.run.place/'
};

const REAL_LOGS = {
	ok: true, source: '/tmp/ShellCrash/ShellCrash.log',
	log: '2026-10-04_23:15:30~ShellCrash服务已启动！\n2026-10-04_23:16:55~ShellCrash服务即将关闭......\n'
};

const REAL_KERNEL = {
	ok: true, running: true, mode: 'rule', log_level: 'info', allow_lan: 'true',
	ipv6: 'true', tcp_concurrent: 'false', unified_delay: 'true',
	mixed_port: '7890', parsed: true
};

const REAL_PING = {
	ok: true, via: 'proxy', mixed_port: '7890',
	results: [
		{ name: '谷歌', time: '0.352260', code: '204' },
		{ name: '百度', time: '0.375638', code: '200' },
		{ name: 'YouTube', time: '0.567351', code: '200' },
		{ name: 'GitHub', time: '0.658103', code: '200' }
	]
};

const REAL_CFG_FILE = [
	'crashcore=meta',
	'core_v=v1.19.17',
	'redir_mod=Mix',
	'dns_mod=mix',
	'firewall_area=1',
	'hostdir=\':9999/ui\'',
	'version=1.9.5beta3',
	''
].join('\n');

const SCENARIOS = [
	{
		title: 'A. 正常运行（真机数据）',
		status: REAL_STATUS,
		zstatus: REAL_ZSTATUS
	},
	{
		title: 'B. 内核已停止',
		status: Object.assign({}, REAL_STATUS, {
			running: false, pid: '', mem_kb: null, api_reachable: false,
			core_version: '', autostart: false
		}),
		zstatus: REAL_ZSTATUS
	},
	{
		title: 'C. 未安装 ShellCrash',
		status: {
			ok: true, ctl_version: '1.0.0', arch: 'aarch64', installed: false,
			crashdir: '', cfg_file: '', version: '', core: '', core_version: '',
			run_mode: '', running: false, pid: '', mem_kb: null,
			init_script: false, autostart: false, api_port: '9090',
			api_reachable: false, mixed_port: '7890', redir_port: '',
			secret: '', secret_set: false, curl: false,
			panel_core_dir: '', panel_local_dir: '/www/zashboard',
			panel_core_installed: false, panel_local_installed: false,
			recommended_mode: 'remote', time: 0
		},
		zstatus: {
			ok: true, repo: 'Zephyruso/zashboard', web_root: '/www',
			luci_dir: '/www/zashboard', core_dir: '', luci_installed: false,
			core_installed: false, luci_version: '', core_version: '',
			wanted_version: 'latest', mirror: '', unzip: false,
			job_running: false, api_port: '9090', secret: '',
			remote_url: 'https://board.zash.run.place/'
		}
	},
	{
		title: 'D. apk 目录不存在 / 后端返回失败对象',
		status: { ok: false, error: 'fs.exec 被拒绝' },
		zstatus: { ok: false, error: 'fs.exec 被拒绝' }
	},
	{
		// 内核只开了 TLS 控制器时，在线 HTTPS 面板才连得上
		title: 'E. 内核 API 走 HTTPS',
		status: Object.assign({}, REAL_STATUS, { api_tls: true }),
		zstatus: REAL_ZSTATUS
	}
];

/* ------------------------------------------------------------- LuCI 运行时桩 */

if (!String.prototype.format) {
	String.prototype.format = function () {
		const args = Array.prototype.slice.call(arguments);
		let i = 0;
		return String(this).replace(/%[sdj%]/g, (m) =>
			m === '%%' ? '%' : String(args[i++]));
	};
}

function E(tag, attrs, children) {
	return { tag: tag, attrs: attrs || {}, children: children === undefined ? [] : children };
}

function makeOptionStub(kind, key) {
	return {
		kind: kind, key: key,
		default: '', placeholder: '', description: '', datatype: '',
		value: function () { return this; },
		depends: function () { return this; }
	};
}

function makeFormStub() {
	const sectionStub = {
		anonymous: false,
		option: function (kind, key) { return makeOptionStub(kind, key); }
	};
	return {
		Map: function (cfg, title, desc) {
			return {
				section: function () { return sectionStub; },
				render: function () {
					return Promise.resolve(E('div', { class: 'cbi-map' }, [ '[表单：' + title + ']' ]));
				}
			};
		},
		NamedSection: 'NamedSection',
		TypedSection: 'TypedSection',
		Value: 'Value',
		Flag: 'Flag',
		ListValue: 'ListValue'
	};
}

function buildRuntime(scenario, record) {
	const uciValues = { poll_interval: '5', log_lines: '200' };

	const fsStub = {
		exec: function (cmd, args) {
			const key = cmd + ' ' + (args || []).join(' ');
			record.calls.push(key);
			const a0 = (args || [])[0];
			let payload;
			if (cmd === CTL && a0 === 'status') payload = scenario.status;
			else if (cmd === ZASH && a0 === 'status') payload = scenario.zstatus;
			else if (cmd === CTL && a0 === 'logs') payload = REAL_LOGS;
			else if (cmd === CTL && a0 === 'kernel-get') payload = scenario.kernel || REAL_KERNEL;
			else if (cmd === CTL && a0 === 'ping') payload = scenario.ping || REAL_PING;
			else return Promise.resolve({ code: 1, stdout: '', stderr: '未打桩的命令: ' + key });
			return Promise.resolve({ code: 0, stdout: JSON.stringify(payload), stderr: '' });
		},
		read: function (path) {
			record.calls.push('read ' + path);
			// 备份文件故意不存在，用来覆盖「没有备份」的错误分支
			if (String(path).indexOf('.bak') >= 0)
				return Promise.reject(new Error('No such file or directory'));
			return Promise.resolve(REAL_CFG_FILE);
		},
		write: function (path, data) {
			record.calls.push('write ' + path + ' (' + String(data).length + ' 字节)');
			return Promise.resolve();
		}
	};

	const uciStub = {
		load: function () { return Promise.resolve(); },
		get: function (pkg, sec, opt) { return uciValues[opt]; },
		sections: function () { return [{}]; }
	};

	const pollStub = {
		add: function (fn) { record.pollFns.push(fn); }
	};

	const viewStub = {
		extend: function (obj) {
			function V() { }
			Object.assign(V.prototype, obj);
			return V;
		}
	};

	// panel.js 里会读 window.location、调 window.open，所以要一并注入
	const windowStub = {
		location: { hostname: '192.168.1.1', protocol: 'http:', host: '192.168.1.1' },
		open: function (url) { record.opened.push(url); },
		setTimeout: function () { return 0; },
		setInterval: function () { return 0; },
		clearInterval: function () { }
	};

	// 视图会 'require shellcrashui.panel as panel'，这里把真实模块装进来，
	// 这样面板地址构造与可用性判断走的是跟线上同一份代码。
	// LuCI 拿到模块返回的 Class 后会 new 出实例再交给使用方，这里照做。
	const baseclassStub = {
		extend: function (obj) {
			function C() { }
			Object.assign(C.prototype, obj);
			return C;
		}
	};

	const panelStub = new (loadView(
		'htdocs/luci-static/resources/shellcrashui/panel.js',
		{ uci: uciStub, window: windowStub, baseclass: baseclassStub }))();

	return {
		view: viewStub,
		form: makeFormStub(),
		fs: fsStub,
		uci: uciStub,
		panel: panelStub,
		ui: {
			addNotification: function (title, content) { record.notifyNodes.push(content); },
			showModal: function (title, content) { record.modalNodes.push(content); },
			hideModal: function () { }
		},
		poll: pollStub,
		dom: { content: function (node, children) { if (node) node.children = children; } },
		E: E,
		L: { url: function (p) { return '/cgi-bin/luci/' + p; }, env: {} },
		_: function (s) { return s; },
		window: windowStub,
		document: {
			createElement: function () { return { style: {}, setAttribute: function () { }, select: function () { }, setSelectionRange: function () { } }; },
			body: { appendChild: function () { }, removeChild: function () { } },
			execCommand: function () { return true; }
		},
		setInterval: function () { return 0; },
		clearInterval: function () { }
	};
}

/* ------------------------------------------------------------------ 渲染执行 */

/* 加载一个 LuCI 资源模块（视图或普通模块）并取回它 return 的构造函数 */
function loadView(file, runtime) {
	const src = nodeFs.readFileSync(path.join(ROOT, file), 'utf8');
	const names = Object.keys(runtime);
	const fn = new Function(...names, src);
	const exported = fn(...names.map((n) => runtime[n]));

	/*
	 * 复刻 LuCI 加载器的检查：
	 *     if (!Class.isSubclass(_class)) error('"%s" factory yields invalid constructor')
	 * 模块必须返回构造函数（baseclass.extend / view.extend），返回普通对象
	 * 会让依赖它的页面全部白屏。这里挡住，别等用户到浏览器里才发现。
	 */
	if (typeof exported !== 'function')
		throw new TypeError('"%s" factory yields invalid constructor（LuCI 要求模块返回 Class 而不是普通对象）'.format(file));

	return exported;
}

function collectText(node, out, depth) {
	if (node === null || node === undefined) return out;
	if (typeof node === 'string') {
		const t = node.trim();
		if (t) out.push(t);
		return out;
	}
	if (typeof node === 'number' || typeof node === 'boolean') return out;
	if (Array.isArray(node)) {
		node.forEach((n) => collectText(n, out, depth));
		return out;
	}
	if (node.tag === 'pre') {
		out.push('[预格式文本 ' + String(node.children).length + ' 字符]');
		return out;
	}
	if (node.children) collectText(node.children, out, depth + 1);
	return out;
}

/* 收集渲染树里所有的 click 处理函数，用来真正执行按钮逻辑 */
function collectHandlers(node, out, labels) {
	if (node === null || node === undefined) return out;
	if (Array.isArray(node)) {
		node.forEach((n) => collectHandlers(n, out, labels));
		return out;
	}
	if (typeof node !== 'object') return out;

	const label = collectText(node.children || [], [], 0).join(' ').slice(0, 24);
	if (typeof node.attrs.click === 'function')
		out.push({ fn: node.attrs.click, label: label || '(无文字按钮)' });

	if (node.children) collectHandlers(node.children, out, labels);
	return out;
}

/* 收集所有内联样式 */
function collectStyles(node, out) {
	if (node === null || node === undefined) return out;
	if (Array.isArray(node)) {
		node.forEach((n) => collectStyles(n, out));
		return out;
	}
	if (typeof node !== 'object') return out;
	if (node.attrs && typeof node.attrs.style === 'string') out.push(node.attrs.style);
	if (node.children) collectStyles(node.children, out);
	return out;
}

/*
 * 主题安全检查。
 *
 * LuCI 同时存在明暗两套主题，页面文字颜色由主题决定。如果内联样式里设了
 * 背景色却没有同时指定文字颜色，那么必有一套主题会变成「浅底浅字」或
 * 「深底深字」，文字直接看不见——这个错误在任何无头测试里都不会报错，
 * 只有用户换成对应的主题才会发现。
 */
function checkThemeSafety(styles, issues) {
	for (const s of styles) {
		const hasBg = /(^|;)\s*background(-color)?\s*:/i.test(s);
		if (!hasBg) continue;
		// 注意用 (^|;) 锚定，避免把 border-color 误判成文字颜色
		const hasFg = /(^|;)\s*color\s*:/i.test(s);
		if (!hasFg)
			issues.push('设了背景色但没设文字颜色（明暗主题必有一边看不见）: ' + s);
	}
	return issues;
}

async function runTarget(target, scenario) {
	const record = { calls: [], pollFns: [], opened: [], modalNodes: [], notifyNodes: [] };
	const runtime = buildRuntime(scenario, record);

	const ViewClass = loadView(target.file, runtime);
	if (typeof ViewClass !== 'function')
		throw new Error('视图没有返回可实例化的类（拿到的是 ' + typeof ViewClass + '）');

	const inst = new ViewClass();
	const data = await inst.load();
	const root = await inst.render(data);

	// 再驱动一次轮询回调，覆盖 refresh() 这条路径
	for (const fn of record.pollFns) await fn();

	// 真正执行每个按钮的处理函数，覆盖面板 URL 构造、日志加载、动作封装等路径
	const handlers = collectHandlers(root, [], []);
	const handlerErrors = [];
	for (const h of handlers) {
		try {
			await h.fn({ preventDefault: function () { } });
		} catch (e) {
			handlerErrors.push(h.label + ' -> ' + (e && e.message ? e.message : e));
		}
	}

	// 主题安全检查：设了背景色又没设文字颜色的内联样式，在明/暗主题里必有一边看不见
	const themeIssues = checkThemeSafety(collectStyles(root, []), []);
	// 弹窗（部署任务日志等）也要一起查
	for (const modal of record.modalNodes) checkThemeSafety(collectStyles(modal, []), themeIssues);

	return {
		text: collectText(inst.body || inst.statusBody || inst.linkBox || [], [], 0),
		calls: record.calls,
		handlers: handlers.length,
		handlerErrors: handlerErrors,
		opened: record.opened,
		themeIssues: themeIssues
	};
}

async function main() {
	let failed = 0;
	for (const target of TARGETS) {
		console.log('\n' + '='.repeat(72));
		console.log('视图：' + target.name);
		console.log('='.repeat(72));
		for (const scenario of SCENARIOS) {
			process.stdout.write('  ' + scenario.title + ' ... ');
			try {
				const res = await runTarget(target, scenario);
				const text = res.text.filter((t, i) => res.text.indexOf(t) === i);
				console.log('渲染成功（执行了 ' + res.handlers + ' 个按钮处理函数）');
				console.log('      后端调用: ' + (res.calls.join(', ') || '(无)'));
				console.log('      页面文本: ' + text.slice(0, 12).join(' | '));
				if (res.opened.length) {
					console.log('      打开的链接:');
					for (const u of res.opened) console.log('        ' + u);
				}
				if (res.handlerErrors.length) {
					failed++;
					console.log('      按钮处理函数报错:');
					for (const e of res.handlerErrors) console.log('        ' + e);
				}
				if (res.themeIssues.length) {
					failed++;
					console.log('      主题安全检查未通过:');
					for (const e of res.themeIssues) console.log('        ' + e);
				}
			} catch (e) {
				failed++;
				console.log('渲染失败');
				console.log('      错误: ' + (e && e.message ? e.message : e));
				if (e && e.stack) {
					const line = String(e.stack).split('\n')[1];
					if (line) console.log('      位置:' + line.trim());
				}
			}
		}
	}
	console.log('\n' + '='.repeat(72));
	if (failed) {
		console.log('结果：' + failed + ' 个场景渲染失败');
		process.exit(1);
	}
	console.log('结果：全部场景渲染通过');
}

main().catch((e) => {
	console.error('测试脚本自身出错：', e);
	process.exit(1);
});
