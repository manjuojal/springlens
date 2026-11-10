import { h, STEREO, CONN } from '../ui.js';
import { createGraph } from '../graph.js';

const DEFAULT_HIDDEN = new Set(['configuration', 'properties', 'model', 'exception', 'annotation', 'other', 'application', 'entity']);

export function render(ctx) {
  const { report: r, el, params } = ctx;
  el.classList.add('full');
  const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, padding: '14px 18px', gap: '10px' } });
  el.append(wrap);
  wrap.append(h('div.vhead', h('div', h('h2', 'Architecture'), h('p', 'Spring beans and how they are wired (constructor/field injection), plus the data stores, brokers and external systems they talk to. Hover to trace neighbours, double-click to zoom, click for details.'))));

  const show = { entities: false, config: false, infra: true, packages: false, isolated: false };
  const box = h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } });
  wrap.append(box);

  const elements = () => build(r, show);
  const g = createGraph(box, {
    elements: elements(),
    layout: 'dagre-lr',
    title: 'architecture',
    filters: [
      { key: 'infra', label: 'Infrastructure', checked: true },
      { key: 'entities', label: 'Entities', checked: false },
      { key: 'config', label: 'Config classes', checked: false },
      { key: 'packages', label: 'Group by package', checked: false },
      { key: 'isolated', label: 'Unconnected', checked: false },
    ],
    onFilter: (k, v) => { show[k] = v; g.setElements(elements()); },
    onSelect: (d) => {
      if (d.kind === 'class') ctx.open({ type: 'class', id: d.id });
      else if (d.kind === 'conn') ctx.open({ type: 'connection', id: d.connId });
    },
    legend: ['controller', 'service', 'component', 'repository', 'client', 'listener', 'filter', 'entity'].map((k) => [STEREO[k].label, STEREO[k].color]).concat([['Database / infra', CONN.database.color]]),
  });
  if (params.get('focus')) setTimeout(() => g.focus(params.get('focus')), 300);
  return () => g.destroy();
}

function build(r, show) {
  const nodes = []; const edges = [];
  const ids = new Set();
  const visible = r.classes.filter((c) => {
    if (c.stereotype === 'entity') return show.entities;
    if (c.stereotype === 'configuration' || c.stereotype === 'properties' || c.stereotype === 'application') return show.config;
    return c.isBean && !DEFAULT_HIDDEN.has(c.stereotype);
  });
  for (const c of visible) ids.add(c.id);
  const pkgs = new Set();
  const basePkg = r.summary.basePackage || '';
  for (const c of visible) {
    const st = STEREO[c.stereotype] || STEREO.other;
    const pkg = c.pkg.startsWith(basePkg) ? c.pkg.slice(basePkg.length).replace(/^\./, '') || '(root)' : c.pkg;
    if (show.packages) pkgs.add(pkg);
    const eps = r.endpoints.filter((e) => e.controller === c.id).length;
    nodes.push({ data: { id: c.id, label: `${st.icon} ${c.name}`, sub: eps ? `${eps} endpoint${eps > 1 ? 's' : ''}` : c.stereotype === 'repository' && c.entity ? `‹${c.entity.split('.').pop()}›` : st.label, color: st.color, kind: 'class', parent: show.packages ? 'pkg:' + pkg : undefined } });
  }
  for (const p of pkgs) nodes.push({ data: { id: 'pkg:' + p, label: p, color: '#94a3b8' } });

  for (const c of visible) {
    const seen = new Set();
    for (const d of c.deps) {
      if (!ids.has(d.target) || seen.has(d.target)) continue; seen.add(d.target);
      edges.push({ data: { id: `${c.id}->${d.target}`, source: c.id, target: d.target, label: d.through ? `via ${d.through}` : '' } });
    }
    if (show.entities && c.entity && ids.has(c.entity)) edges.push({ data: { id: `${c.id}=>${c.entity}`, source: c.id, target: c.entity, label: 'manages', color: STEREO.entity.color }, classes: 'dashed' });
  }
  if (show.entities) for (const e of r.entities) for (const f of e.fields) if (f.relation && ids.has(f.relation.target) && !f.relation.mappedBy) edges.push({ data: { id: `${e.id}~${f.name}`, source: e.id, target: f.relation.target, label: `${f.relation.type}`, color: STEREO.entity.color }, classes: 'dotted' });

  if (show.infra) {
    const conn = (c) => {
      const id = 'conn:' + c.id;
      if (!ids.has(id)) {
        const ct = CONN[c.type] || CONN.http;
        nodes.push({ data: { id, label: `${ct.icon} ${c.name}`, sub: c.tech + (c.endpoint?.host ? ` · ${c.endpoint.host}${c.endpoint.port ? ':' + c.endpoint.port : ''}` : ''), color: ct.color, kind: 'conn', connId: c.id }, classes: c.type === 'database' || c.type === 'cache' ? 'db' : c.type === 'http' || c.type === 'auth' ? 'ext' : '' });
        ids.add(id);
      }
      return id;
    };
    const findConn = (tech) => r.config.connections.find((c) => (c.tech || '').toLowerCase().includes(tech.toLowerCase()));
    for (const c of visible) {
      if (c.stereotype === 'repository' && c.dataStore) { const cn = r.config.connections.find((x) => x.id === c.dataStore); if (cn) edges.push({ data: { id: `${c.id}->db`, source: c.id, target: conn(cn), label: 'SQL/queries', color: CONN.database.color } }); }
      for (const i of c.infra) {
        const map = { Kafka: 'Kafka', RabbitMQ: 'RabbitMQ', Redis: 'Redis', SMTP: 'SMTP', 'Cloud Stream': 'Kafka', MongoDB: 'MongoDB' };
        let cn = map[i.tech] ? findConn(map[i.tech]) : null;
        if (!cn && i.kind === 'db') cn = r.config.connections.find((x) => x.type === 'database');
        if (!cn && i.connection) cn = r.config.connections.find((x) => x.id === i.connection);
        if (cn) edges.push({ data: { id: `${c.id}->${cn.id}:${i.field}`, source: c.id, target: conn(cn), label: i.type, color: (CONN[cn.type] || CONN.http).color } });
        else if (i.kind === 'http') {
          const hc = r.httpCalls.filter((x) => x.from === c.id);
          const urls = [...new Set(hc.map((x) => hostOf(x.url)).filter(Boolean))];
          const targets = urls.length ? urls : ['external HTTP'];
          for (const u of targets) {
            const known = r.config.connections.find((x) => x.type === 'http' && (x.url || '').includes(u));
            const id = known ? conn(known) : 'ext:' + u;
            if (!known && !ids.has(id)) { nodes.push({ data: { id, label: '🌍 ' + u, sub: i.tech, color: CONN.http.color, kind: 'ext' }, classes: 'ext' }); ids.add(id); }
            edges.push({ data: { id: `${c.id}->${id}`, source: c.id, target: id, label: i.type, color: CONN.http.color } });
          }
        }
      }
      if (c.stereotype === 'client') {
        const cl = r.clients.find((x) => x.id === c.id);
        const known = r.config.connections.find((x) => x.type === 'http' && cl && (x.url || '') && ((cl.url || '').includes(x.keyProp) || (cl.serviceName && x.id.includes(cl.serviceName))));
        const label = cl ? (cl.serviceName || cl.url || 'remote service') : 'remote service';
        const id = known ? conn(known) : 'ext:' + label;
        if (!known && !ids.has(id)) { nodes.push({ data: { id, label: '🌍 ' + label, sub: cl?.url || 'Feign / service discovery', color: CONN.http.color, kind: 'ext' }, classes: 'ext' }); ids.add(id); }
        edges.push({ data: { id: `${c.id}->${id}`, source: c.id, target: id, label: 'HTTP', color: CONN.http.color } });
      }
    }
    for (const l of r.listeners) {
      if (!ids.has(l.class)) continue;
      const cn = findConn(l.tech === 'Cloud Stream' ? 'Kafka' : l.tech);
      const id = cn ? conn(cn) : null;
      if (id) edges.push({ data: { id: `${id}=>${l.class}:${l.method}`, source: id, target: l.class, label: l.destinations.join(', '), color: CONN.broker.color }, classes: 'async' });
    }
    if (r.security.configs.length) {
      const auth = r.config.connections.find((x) => x.type === 'auth');
      if (auth) for (const c of visible.filter((x) => x.stereotype === 'security' || x.stereotype === 'filter')) edges.push({ data: { id: `${c.id}->auth`, source: c.id, target: conn(auth), label: 'validate token', color: CONN.auth.color }, classes: 'dashed' });
    }
    // event publishers → listeners
    for (const e of r.eventListeners) for (const p of r.messaging.publishers.filter((x) => x.tech === 'Spring Events' && x.destination === e.event)) {
      if (ids.has(p.class) && ids.has(e.class)) edges.push({ data: { id: `${p.class}~ev~${e.class}`, source: p.class, target: e.class, label: `⚡ ${e.event}`, color: '#eab308' }, classes: 'async' });
    }
  }
  if (!show.isolated) {
    const linked = new Set(edges.flatMap((e) => [e.data.source, e.data.target]));
    const keep = nodes.filter((n) => linked.has(n.data.id) || n.data.id.startsWith('pkg:') || ['controller', 'listener', 'scheduler'].includes(r.classes.find((c) => c.id === n.data.id)?.stereotype));
    const keepIds = new Set(keep.map((n) => n.data.id));
    return [...keep.filter((n) => !n.data.id.startsWith('pkg:') || keep.some((x) => x.data.parent === n.data.id)), ...edges.filter((e) => keepIds.has(e.data.source) && keepIds.has(e.data.target))];
  }
  return [...nodes, ...edges];
}

function hostOf(url) {
  if (!url) return null;
  try { return new URL(url).host; } catch { return /^\$\{/.test(url) ? url : url.startsWith('/') ? null : url.split('/')[0]; }
}
