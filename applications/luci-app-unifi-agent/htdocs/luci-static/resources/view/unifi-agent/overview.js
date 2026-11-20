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
		E('strong', {}, [ p.idx ]),
		E('small', {}, [ p.media ]),
		E('span', {}, [ p.device ?? '—' ]),
		E('small', {}, [ speedLabel(p.max_speed) + (p.poe ? ' PoE' : '') ])
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
		rows.push([ _('Ports not reported'), d.unmapped_ports.join(', ') ]);

	if (d.unmapped_radios?.length)
		rows.push([ _('Radios not reported'), d.unmapped_radios.join(', ') ]);

	if (d.candidates?.length)
		rows.push([ _('Models that fit'), d.candidates.join(', ') ]);

	if (d.unhandled?.length)
		rows.push([ _('Controller settings not applied'), E('small', {}, [ d.unhandled.join(' ') ]) ]);

	return E('table', { 'class': 'table' }, rows.map(([ k, v ]) =>
		E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left', 'width': '33%' }, k), E('td', { 'class': 'td left' }, [ v ]) ])));
}

return view.extend({
	load() {
		return Promise.all([
			L.resolveDefault(callDescribe(), {}),
			L.resolveDefault(callModels(), []),
			L.resolveDefault(callGetBuiltinEthernetPorts(), []),
			uci.load('unifi-agent')
		]);
	},

	render([ desc, models, builtinPorts ]) {
		/* Offer every port the agent could map, and keep values already set,
		 * so saving a row never swaps its port for another. */
		const ports = [ ...new Set([
			...builtinPorts.map((p) => p.device),
			...(desc.ports ?? []).map((p) => p.device).filter((d) => d),
			...(desc.unmapped_ports ?? []),
			...uci.sections('unifi-agent', 'port').map((s) => s.device).filter((d) => d)
		]) ].sort(L.naturalCompare);
		const radios = [ ...new Set([
			...(desc.radio_devices ?? []),
			...uci.sections('unifi-agent', 'radio').map((s) => s.device).filter((d) => d)
		]) ];
		/* Any model can be picked on this page, so offer up to the largest
		 * model, plus any other value already saved so it stays selectable. */
		const portCount = (id) => (models.find((md) => md.id == id)?.ports ?? []).reduce((n, r) => n + r[1], 0);
		const maxPorts = Math.max(8, ...models.map((md) => portCount(md.id)));
		const savedPorts = uci.sections('unifi-agent', 'port').map((s) => s.unifi).filter((v) => v && !(+v >= 1 && +v <= maxPorts));

		const m = new form.Map('unifi-agent', _('UniFi controller'),
			_('Presents this device to a UniFi Network controller as a UniFi switch or access point. The controller adopts it, applies its port, VLAN and Wi-Fi settings here, and shows its status. Firmware upgrades from the controller are always refused.'));

		let s = m.section(form.NamedSection, 'main', 'agent');
		s.render = () => E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Device as the controller sees it')),
			desc.model ? renderPanel(desc) : E('p', { 'class': 'alert-message warning' }, [ desc.error
				? _('The device description is not available: %s').format(desc.error)
				: _('The agent did not answer; the device description is not available.') ]),
			desc.model ? renderSummary(desc) : '',
			E('p', { 'class': 'cbi-section-descr' }, _('Reflects the saved configuration; save and apply to update it.'))
		]);

		s = m.section(form.NamedSection, 'main', 'agent', _('Settings'));

		let o = s.option(form.Flag, 'enabled', _('Enable'));

		o = s.option(form.Value, 'inform_url', _('Inform URL'),
			_('The controller\'s inform address, with an IP address: <code>http://192.168.1.2:8080/inform</code>. Not needed when the controller adopts the device over SSH.'));
		o.placeholder = 'http://192.168.1.2:8080/inform';
		o.validate = (id, v) => {
			/* No leading zeros: the resolver would read such an octet as octal. */
			const m = /^http:\/\/((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})(?::([1-9]\d{0,4}))?\/inform$/.exec(v);

			if (!v || (m && m[1].split('.').every((o) => +o <= 255) && (m[2] == null || +m[2] <= 65535)))
				return true;

			return _('Use http://<IP address>:8080/inform');
		};

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
		o.placeholder = desc.interface ?? 'lan';

		o = s.option(form.Flag, 'ssh_adopt', _('SSH adoption'),
			_('Needed when the controller is on this device\'s subnet. While not adopted, user ubnt (password ubnt) can log in to adopt the device; the account is removed once adopted. Turn it on only for the adoption: on port 22 that login can also forward connections.'));
		o.default = '0';

		o = s.option(form.Value, 'ssh_port', _('SSH adoption port'));
		o.datatype = 'port';
		o.placeholder = '2222';
		o.retain = true;
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
		savedPorts.forEach((v) => o.value(v));
		o.textvalue = function(section_id) {
			return this.cfgvalue(section_id) || _('next free');
		};
		o.validate = function(section_id, value) {
			if (!value)
				return true;

			/* The agent ignores an index the model does not have. */
			const model = uci.get('unifi-agent', 'main', 'model') ?? 'auto';
			const count = portCount((model == 'auto') ? desc.model : model);

			if (count && +value > count)
				return _('The model has %d ports').format(count);

			/* The row editor works on a copy of one section, so check the
			 * other rows the agent uses in the configuration itself. To swap
			 * two rows, set one to "next free" first. */
			const taken = uci.sections('unifi-agent', 'port').filter((s) =>
				s['.name'] != section_id && s.unifi == value && s.device && s.enabled != '0');

			return !taken.length || _('UniFi port %s is already mapped').format(value);
		};

		o = s.option(form.ListValue, 'device', _('Local port'));
		ports.forEach((p) => o.value(p));
		o.rmempty = false;

		o = s.option(form.ListValue, 'media', _('Media'));
		o.value('', _('detect'));
		[ 'GE', 'SFP', 'SFP+', 'SFP28', 'QSFP28' ].forEach((v) => o.value(v));
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
