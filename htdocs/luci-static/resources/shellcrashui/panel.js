'use strict';
'require baseclass';
'require uci';

/*
 * Zashboard 面板地址的构造与可用性判断。
 *
 * 运行控制页和 Zashboard 面板页都要用这套逻辑，所以抽成共享模块：
 * 混合内容规则、各种「没部署」的判断散在两个文件里迟早会不同步。
 *
 * 用法：
 *   'require shellcrashui.panel as panel'
 *   var a = panel.availability('core', st, zst);
 *   if (a.ready) window.open(a.url, '_blank');
 */

function cfgGet(name, def) {
	var v = uci.get('shellcrash', 'main', name);
	return (v === undefined || v === null || v === '') ? def : v;
}

/* 内核 API 走 HTTP 还是 HTTPS，由后端探测得出 */
function apiScheme(st) {
	return (st && st.api_tls) ? 'https' : 'http';
}

/*
 * 在线站点基本都是 HTTPS。HTTPS 页面不允许请求 HTTP 后端——这是浏览器的
 * 混合内容策略，没有例外（只有 localhost 除外）。所以只有内核 API 也走
 * HTTPS 时，「在线站点」这条路才真的能连上。
 */
function remoteUsable(st) {
	var url = String(cfgGet('remote_url', 'https://board.zash.run.place/'));
	if (url.indexOf('https:') !== 0)
		return true;
	return !!(st && st.api_tls);
}

function appendQuery(url, qs) {
	if (!url)
		return '';
	if (!qs)
		return url;
	return url + (url.indexOf('?') >= 0 ? '&' : '?') + qs;
}

/* zashboard 支持 protocol / hostname / port / secret 查询参数，用它实现免登录直连 */
function panelQuery(st) {
	var params = [];

	if (cfgGet('panel_query', '1') === '1') {
		var proto = String(cfgGet('panel_protocol', 'auto'));
		if (proto === 'auto' || proto === '')
			proto = apiScheme(st);

		params.push('protocol=' + encodeURIComponent(proto));
		params.push('hostname=' + encodeURIComponent(window.location.hostname));
		params.push('port=' + encodeURIComponent((st && st.api_port) || '9090'));
		if (st && st.secret)
			params.push('secret=' + encodeURIComponent(st.secret));
	}

	var extra = String(cfgGet('panel_query_extra', '')).replace(/^[?&]+/, '');
	if (extra)
		params.push(extra);

	return params.join('&');
}

function panelUrl(mode, st) {
	var host = window.location.hostname;
	var qs = panelQuery(st);

	switch (mode) {
	case 'core':
		return appendQuery('http://' + host + ':' + ((st && st.api_port) || '9090') + '/ui/', qs);
	case 'local':
		return appendQuery(window.location.protocol + '//' + window.location.host + '/zashboard/', qs);
	case 'custom': {
		var base = String(cfgGet('panel_url', ''));
		return base ? appendQuery(base, qs) : '';
	}
	case 'remote':
		return appendQuery(String(cfgGet('remote_url', 'https://board.zash.run.place/')), qs);
	default:
		return '';
	}
}

/* auto 模式下按内核 ui → 本地站点 → 在线站点的顺序挑一个 */
function effectiveMode(st) {
	var mode = String(cfgGet('panel_mode', 'auto'));
	if (mode === 'auto')
		mode = (st && st.recommended_mode) || 'remote';
	return mode;
}

/*
 * 这条路现在能不能打开。不能的话给出人话的原因，由调用方决定怎么提示。
 * zst 可以传 zashboard.sh 的完整状态，也可以只从 ctl.sh 状态里拼一个
 * （{ luci_installed: st.panel_local_installed, luci_dir: st.panel_local_dir }）。
 */
function availability(mode, st, zst) {
	zst = zst || {};

	var url = panelUrl(mode, st);
	if (!url)
		return { ready: false, url: '', reason: '「自定义地址」还没填，请在「Zashboard 面板」页的「面板设置」里填写。' };

	if (mode === 'core' && !(st && st.panel_core_installed))
		return {
			ready: false, url: url,
			reason: '内核 ui 目录里还没有面板文件。可以用「部署到内核 ui 目录」，' +
				'或者在 ShellCrash 菜单里把面板选成 Zashboard。'
		};

	if (mode === 'local' && !zst.luci_installed)
		return {
			ready: false, url: url,
			reason: 'LuCI 站点目录（' + (zst.luci_dir || '/www/zashboard') + '）里还没有面板文件，' +
				'打开会是 404。到「Zashboard 面板」页点「部署到 LuCI 站点目录」即可启用。'
		};

	if (mode === 'remote' && !remoteUsable(st))
		return {
			ready: false, url: url,
			reason: '在线站点是 HTTPS，而内核 API 是 HTTP。浏览器会拦截 HTTPS 页面发往 HTTP 后端的请求' +
				'（混合内容策略，没有例外）。请改用本地面板，或给内核配上 external-controller-tls。'
		};

	return { ready: true, url: url, reason: '' };
}

/*
 * 必须返回 Class，不能返回普通对象。
 *
 * LuCI 的模块加载器会这样处理模块：
 *     _class = _factory.apply(...)
 *     if (!Class.isSubclass(_class)) error('"%s" factory yields invalid constructor')
 *     const instance = new _class()
 * 也就是说它要的是一个构造函数，拿到对象会直接报错，依赖这个模块的页面
 * 全部白屏。返回 baseclass.extend({...}) 之后，require 拿到的是实例。
 */
return baseclass.extend({
	cfgGet: cfgGet,
	apiScheme: apiScheme,
	remoteUsable: remoteUsable,
	panelQuery: panelQuery,
	panelUrl: panelUrl,
	effectiveMode: effectiveMode,
	availability: availability
});
