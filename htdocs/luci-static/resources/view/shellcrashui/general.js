'use strict';
'require view';
'require form';
'require uci';

return view.extend({
	load: function() {
		return uci.load('shellcrash');
	},

	render: function() {
		var m = new form.Map('shellcrash', '基础设置',
			'这些是插件自己的选项，用来在自动探测不准时手工覆盖，以及调整刷新与测试的行为。' +
			'它们不涉及 ShellCrash 或内核本身的配置——那些在「内核与 ShellCrash 设置」页。');

		var s = m.section(form.NamedSection, 'main', 'shellcrash');
		s.anonymous = true;

		var o;

		/* ---- 自动探测覆盖 ---- */

		o = s.option(form.Value, 'crashdir', 'ShellCrash 安装目录');
		o.placeholder = '自动检测';
		o.description = '留空自动检测 /etc/ShellCrash、/tmp/ShellCrash，或从 /usr/bin/crash 软链接推断。';

		o = s.option(form.Value, 'api_port', 'API 端口覆盖');
		o.datatype = 'orport';
		o.placeholder = '自动检测';
		o.description = '对应内核配置里的 external-controller 端口，mihomo 默认 9090。';

		o = s.option(form.Value, 'secret', 'API 密钥覆盖');
		o.placeholder = '自动检测';
		o.description = '对应内核配置里的 secret，留空表示自动读取；如果内核确实没有密钥，请留空。';

		o = s.option(form.Value, 'mixed_port', '混合代理端口覆盖');
		o.datatype = 'orport';
		o.placeholder = '自动检测';
		o.description = '用于延迟测试与展示，留空自动读取 mixed-port。';

		/* ---- 行为 ---- */

		o = s.option(form.Value, 'poll_interval', '状态刷新间隔（秒）');
		o.datatype = 'uinteger';
		o.placeholder = '5';
		o.description = '运行控制页的状态与内核参数刷新频率。';

		o = s.option(form.Value, 'log_lines', '日志显示行数');
		o.datatype = 'uinteger';
		o.placeholder = '200';

		o = s.option(form.Value, 'ping_targets', '延迟测试目标');
		o.placeholder = '百度|https://www.baidu.com/ 谷歌|https://www.google.com/generate_204';
		o.description = '格式是「名称|URL」，多个用空格分隔。测试走内核混合端口，' +
			'所以国内站点按规则直连、国外站点走代理。名称里有空格请改用英文或去掉空格。';

		return m.render().then(function(mapNode) {
			return E('div', {}, [
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, [ '自动探测顺序' ]),
					E('div', { 'class': 'cbi-section-descr' }, [
						'插件不硬编码 ShellCrash 的布局，按下面的顺序推断，任一步成功即停止。',
						'上面留空的项目才走自动探测；填了就以填的为准。'
					]),
					E('ul', {}, [
						E('li', {}, [ '安装目录：', E('code', {}, [ 'crashdir' ]),
							' → /etc/ShellCrash → /tmp/ShellCrash → 其他常见目录 → /usr/bin/crash 软链接 → /etc/profile 里的 CRASHDIR' ]),
						E('li', {}, [ 'API 端口：', E('code', {}, [ 'api_port' ]),
							' → 内核运行时 config.yaml 的 external-controller → ShellCrash 的 hostdir → 9090' ]),
						E('li', {}, [ 'API 密钥：', E('code', {}, [ 'secret' ]),
							' → 运行时 config.yaml 的 secret → ShellCrash 配置里的 secret 类键' ]),
						E('li', {}, [ '内核进程：先按 configs/command.env 里声明的可执行文件匹配，再按常见内核进程名兜底' ])
					])
				]),
				mapNode
			]);
		});
	}
});
