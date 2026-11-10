import { h, CONN, STEREO, badge, empty } from '../ui.js';
import { createGraph } from '../graph.js';

export function render(ctx) {
  const { report: r, el, params } = ctx;
  const cfg = r.config;
  el.append(h('div.vhead', h('div', h('h2', 'Connections'), h('p', 'External systems this application connects to, detected from application.yml/properties per profile (plus Spring Boot defaults implied by starters), with the beans that use them and matching docker-compose services.'))));
  if (!cfg.connections.length) { el.append(empty('No connections detected', 'No datasource, cache, broker, mail, auth or external URL properties were found.')); return; }

  const profiles = ['(all)', ...cfg.profiles];
  let profile = params.get('profile') || '(all)';
  const psel = h('select', { onchange: () => { profile = psel.value; ctx.setParam('profile', profile); g.setElements(elements()); fillCards(); } }, profiles.map((p) => h('option', { value: p, selected: p === profile }, p === '(all)' ? 'All profiles' : `profile: ${p}`)));
  const box = h('div', { style: { height: '520px', display: 'flex', flex: 'none' } });
  const cards = h('div.grid.g3');
  el.append(h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, psel, h('span.muted.small', 'Choose a profile to see the effective connection set for that environment.')), box, cards);

  const activeIn = (c, p) => { const vs = c.variants || { default: c }; return !!(vs[p] || vs.default); };
  const visibleConns = () => (profile === '(all)' ? cfg.connections : cfg.connections.filter((c) => {
    if (!activeIn(c, profile)) return false;
    // an implied default (e.g. embedded H2) disappears when the profile configures a real one
    if (c.implied && cfg.connections.some((o) => o !== c && !o.implied && o.type === c.type && activeIn(o, profile))) return false;
    return true;
  }));
  const variantOf = (c) => (c.variants && c.variants[profile]) || c;

  function elements() {
    const nodes = []; const edges = [];
    const app = 'app';
    nodes.push({ data: { id: app, label: `🚀 ${r.name}`, sub: `:${cfg.server.port}${cfg.server.contextPath}${cfg.server.applicationName ? ' · ' + cfg.server.applicationName : ''}`, color: '#6db33f', rank: 10 }, classes: 'hub' });
    const compose = r.infra.compose.flatMap((x) => x.services);
    for (const c of visibleConns()) {
      const v = variantOf(c);
      const ct = CONN[c.type] || CONN.http;
      const id = 'c:' + c.id;
      const ep = v.endpoint || {};
      nodes.push({ data: { id, label: `${ct.icon} ${c.name}`, sub: `${v.tech || c.tech}${ep.host ? ` · ${ep.host}${ep.port ? ':' + ep.port : ''}` : ep.mode ? ' · ' + ep.mode : ''}${ep.database ? ' / ' + ep.database : ''}`, color: ct.color, connId: c.id, rank: 1 }, classes: (c.type === 'database' || c.type === 'cache' ? 'db' : c.type === 'http' || c.type === 'auth' ? 'ext' : '') + (c.implied ? ' dim-node' : '') });
      edges.push({ data: { id: 'e:' + c.id, source: app, target: id, label: protocol(c, v), color: ct.color }, classes: c.type === 'broker' ? 'async' : '' });
      const svc = compose.find((s) => s.tech && ((v.tech || c.tech || '').includes(s.tech) || (s.tech || '').includes(v.tech || c.tech)));
      if (svc) {
        const sid = 'svc:' + svc.name;
        if (!nodes.some((n) => n.data.id === sid)) nodes.push({ data: { id: sid, label: `🐳 ${svc.name}`, sub: `${svc.image || ''} ${svc.ports.join(' ')}`, color: '#2496ed', rank: 0 } });
        edges.push({ data: { id: `d:${c.id}`, source: id, target: sid, label: 'docker-compose', color: '#2496ed' }, classes: 'dotted' });
      }
      // beans using it
      const users = r.classes.filter((x) => (c.type === 'database' && x.dataStore === c.id) || x.infra.some((i) => (v.tech || c.tech || '').toLowerCase().includes(i.tech.toLowerCase().split(' ')[0])) || (c.type === 'broker' && r.listeners.some((l) => l.class === x.id && (c.tech || '').includes(l.tech))));
      for (const u of users.slice(0, 8)) {
        const uid = 'u:' + u.id;
        if (!nodes.some((n) => n.data.id === uid)) nodes.push({ data: { id: uid, label: u.name, color: STEREO[u.stereotype]?.color || '#888', cls: u.id, rank: 5 } });
        edges.push({ data: { id: `${uid}->${id}`, source: uid, target: id }, classes: 'dashed' });
      }
    }
    return [...nodes, ...edges];
  }

  const g = createGraph(box, {
    elements: elements(), layout: 'dagre-lr', title: 'connections', layouts: ['dagre-lr', 'concentric', 'cose', 'dagre-tb'],
    onSelect: (d) => { if (d.connId) ctx.open({ type: 'connection', id: d.connId }); else if (d.cls) ctx.open({ type: 'class', id: d.cls }); },
    legend: Object.entries(CONN).filter(([k]) => cfg.connections.some((c) => c.type === k)).map(([, v]) => [v.label, v.color]).concat(r.infra.compose.length ? [['docker-compose service', '#2496ed']] : []),
  });

  function fillCards() {
    cards.replaceChildren(...visibleConns().map((c) => {
      const v = variantOf(c);
      const ct = CONN[c.type] || CONN.http;
      return h('div.card.clickable', { onclick: () => ctx.open({ type: 'connection', id: c.id }), style: { borderTop: `3px solid ${ct.color}` } },
        h('div.flow-meta', h('b', `${ct.icon} ${c.name}`), badge(v.tech || c.tech, ct.color), c.implied ? badge('implied', '#94a3b8') : null),
        h('div.mono.small', { style: { margin: '6px 0', wordBreak: 'break-all' } }, v.url || '—'),
        v.username ? h('div.small.muted', `user: ${v.username}`) : null,
        h('div.chips', c.profiles.map((p) => badge(p, '#6db33f'))),
        h('div.small.muted', { style: { marginTop: '6px' } }, `${Object.keys(v.props || {}).length} related properties`),
      );
    }));
  }
  fillCards();
  if (params.get('id')) setTimeout(() => ctx.open({ type: 'connection', id: params.get('id') }), 200);
  return () => g.destroy();
}

function protocol(c, v) {
  const t = (v.tech || c.tech || '').toLowerCase();
  if (c.type === 'database') return /mongo/.test(t) ? 'mongodb' : /r2dbc/.test(v.url || '') ? 'R2DBC' : 'JDBC';
  if (c.type === 'cache') return 'RESP';
  if (c.type === 'broker') return /kafka/.test(t) ? 'Kafka protocol' : /rabbit/.test(t) ? 'AMQP' : 'JMS';
  if (c.type === 'mail') return 'SMTP';
  if (c.type === 'auth') return 'OIDC / JWKS';
  return (v.url || '').split(':')[0].toUpperCase() || 'HTTP';
}
