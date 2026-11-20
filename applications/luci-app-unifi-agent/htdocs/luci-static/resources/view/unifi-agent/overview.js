'use strict';
'require view';
'require form';
'require rpc';
'require uci';

const callDescribe = rpc.declare({
	object: 'luci.unifi-agent',
	method: 'describe',
	expect: { result: {} }
});

const callModels = rpc.declare({
	object: 'luci.unifi-agent',
	method: 'models',
	expect: { result: [] }
});

const callGetBuiltinEthernetPorts = rpc.declare({
	object: 'luci',
	method: 'getBuiltinEthernetPorts',
	expect: { result: [] }
});

const BANDS = { ng: '2.4 GHz', na: '5 GHz', '6e': '6 GHz' };

function isFiber(media) {
	return /^Q?SFP/.test(media ?? '');
}

function speedLabel(mbit) {
	if (!mbit)
		return '';

	return mbit >= 1000 ? `${mbit / 1000}G` : `${mbit}M`;
}

function portsLabel(runs) {
	return runs.map(([ media, n, poe ]) => `${n}x ${media}${poe ? ' PoE' : ''}`).join(' + ');
}

/* One box per UniFi port, copper and fibre in separate blocks, like the
 * front panel of the UniFi model the controller is shown. */
function renderPanel(d) {
	const groups = [];

	for (const p of d.ports ?? []) {
		const fiber = isFiber(p.media);

		if (!groups.length || groups[groups.length - 1].fiber != fiber)
			groups.push({ fiber, ports: [] });

		groups[groups.length - 1].ports.push(p);
	}

	const box = (p) => E('div', {
		'style': 'display:inline-flex;flex-direction:column;align-items:center;justify-content:space-between;' +
			'width:5.5em;min-height:6em;margin:2px;padding:.3em;border:1px solid;border-radius:4px;' +
			(p.device ? '' : 'opacity:.45;border-style:dashed;'),
		'title': p.device
			? _('UniFi port %d is local port %s (%s)').format(p.idx, p.device, (p.speeds ?? []).map(speedLabel).join('/') || _('speeds unknown'))
			: _('UniFi port %d has no local port').format(p.idx)
	}, [
		E('strong', {}, String(p.idx)),
		E('small', {}, p.media),
		E('span', {}, p.device ?? '—'),
		E('small', {}, [ speedLabel(p.max_speed), p.poe ? ' PoE' : '' ].join(''))
	]);

	return E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:1em;align-items:flex-start' },
		groups.map((g) => E('div', { 'style': 'display:flex;flex-wrap:wrap' }, g.ports.map(box))));
}

function renderSummary(d) {
	const rows = [
		[ _('Shown as'), `${d.model_display} (${d.model})` ],
		[ _('Controller'), d.inform_url || _('not set') ],
		[ _('State'), d.adopted ? (d.gcm ? _('Adopted, AES-GCM') : _('Adopted')) : _('Not adopted') ],
		[ _('Changes from the controller'), d.apply ? _('Applied') : _('Logged only') ]
	];

	if (d.radios?.length)
		rows.push([ _('Radios'), d.radios.map((r) => `${r.name}: ${BANDS[r.band] ?? r.band}, ${r.nss ?? '?'}x${r.nss ?? '?'} → ${r.device}`).join(', ') ]);

	if (d.unmapped_ports?.length)
		rows.push([ _('Not reported'), d.unmapped_ports.join(', ') ]);

	if (d.candidates?.length)
		rows.push([ _('Models that fit'), d.candidates.join(', ') ]);

	if (d.unhandled?.length)
		rows.push([ _('Controller settings not applied'), E('small', {}, d.unhandled.join(' ')) ]);

	return E('table', { 'class': 'table' }, rows.map(([ k, v ]) =>
		E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left', 'width': '33%' }, k), E('td', { 'class': 'td left' }, v) ])));
}

return view.extend({
	load() {
		return Promise.all([
			L.resolveDefault(callDescribe(), {}),
			L.resolveDefault(callModels(), []),
			L.resolveDefault(callGetBuiltinEthernetPorts(), []),
			uci.load('wireless').catch(() => null),
			uci.load('unifi-agent')
		]);
	},

	render([ desc, models, builtinPorts ]) {
		const ports = builtinPorts.map((p) => p.device).sort(L.naturalCompare);
		const radios = uci.sections('wireless', 'wifi-device').map((s) => s['.name']);
		const maxPorts = Math.max(8, ...models.map((m) => m.ports.reduce((n, r) => n + r[1], 0)));

		const m = new form.Map('unifi-agent', _('UniFi controller'),
			_('Presents this device to a UniFi Network controller as a UniFi switch or access point. The controller adopts it, applies its port, VLAN and Wi-Fi settings here, and shows its status. Firmware upgrades from the controller are always refused.'));

		let s = m.section(form.NamedSection, 'main', 'agent', _('Device as the controller sees it'));
		s.render = () => E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Device as the controller sees it')),
			renderPanel(desc),
			renderSummary(desc),
			E('p', { 'class': 'cbi-section-descr' }, _('Reflects the saved configuration; save and apply to update it.'))
		]);

		s = m.section(form.NamedSection, 'main', 'agent', _('Settings'));

		let o = s.option(form.Flag, 'enabled', _('Enable'));

		o = s.option(form.Value, 'inform_url', _('Inform URL'),
			_('The controller\'s inform address, with an IP address: <code>http://192.168.1.2:8080/inform</code>. Not needed when the controller adopts the device over SSH.'));
		o.placeholder = 'http://192.168.1.2:8080/inform';
		o.validate = (id, v) => (!v || /^http:\/\/\d{1,3}(\.\d{1,3}){3}(:\d+)?\/inform$/.test(v)) || _('Use http://<IP address>:8080/inform');

		o = s.option(form.ListValue, 'model', _('Model'),
			_('The UniFi model the controller is shown. Its port layout decides which settings the controller offers.'));
		o.value('auto', _('Automatic: closest to this hardware'));
		models.sort((a, b) => a.id.localeCompare(b.id)).forEach((md) =>
			o.value(md.id, `${md.id}: ${md.name} (${portsLabel(md.ports)}${md.radios.length ? ', ' + md.radios.map((r) => BANDS[r] ?? r).join('/') : ''})`));
		o.default = 'auto';

		o = s.option(form.Flag, 'apply', _('Apply controller settings'),
			_('When off, changes from the controller are only logged.'));
		o.default = '1';

		o = s.option(form.Value, 'bridge', _('Bridge'), _('The bridge whose ports the controller manages; empty for the bridge of the management interface.'));
		o.placeholder = desc.bridge ?? 'br-lan';

		o = s.option(form.Value, 'interface', _('Management interface'));
		o.placeholder = 'lan';

		o = s.option(form.Flag, 'ssh_adopt', _('SSH adoption'),
			_('While not adopted, let the controller adopt over SSH as user ubnt, which can only adopt the device and is removed once adopted.'));
		o.default = '1';

		o = s.option(form.Value, 'ssh_port', _('SSH adoption port'));
		o.datatype = 'port';
		o.placeholder = '2222';
		o.depends('ssh_adopt', '1');

		s = m.section(form.GridSection, 'port', _('Port mapping'),
			_('Which local port stands behind each UniFi port. Without entries, every port of the bridge is mapped in order, copper before fibre.'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;

		o = s.option(form.ListValue, 'unifi', _('UniFi port'));
		o.value('', _('next free'));
		for (let i = 1; i <= maxPorts; i++)
			o.value(String(i));
		o.textvalue = function(section_id) {
			return this.cfgvalue(section_id) || _('next free');
		};

		o = s.option(form.ListValue, 'device', _('Local port'));
		ports.forEach((p) => o.value(p));
		o.rmempty = false;

		o = s.option(form.ListValue, 'media', _('Media'));
		o.value('', _('detect'));
		[ 'GE', 'SFP', 'SFP+', 'SFP28' ].forEach((v) => o.value(v));
		o.textvalue = function(section_id) {
			return this.cfgvalue(section_id) || _('detect');
		};

		o = s.option(form.Flag, 'poe', _('PoE'), _('Report PoE and switch it through netifd.'));

		s = m.section(form.GridSection, 'radio', _('Radio mapping'),
			_('Which radio stands behind each UniFi radio. Without entries, every enabled radio is used.'));
		s.anonymous = true;
		s.addremove = true;
		s.nodescriptions = true;

		o = s.option(form.ListValue, 'device', _('Radio'));
		radios.forEach((r) => o.value(r));
		o.rmempty = false;

		o = s.option(form.ListValue, 'band', _('UniFi band'));
		Object.entries(BANDS).forEach(([ k, v ]) => o.value(k, v));

		return m.render();
	}
});
