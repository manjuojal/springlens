import { h, STEREO, CONN, methodBadge, badge, short, debounce, tabs, empty } from '../ui.js';
import { renderMermaid, mermaidToolbar, createGraph, mmd } from '../graph.js';

const KIND_LABEL = { http: 'HTTP endpoints', listener: 'Message listeners', scheduled: 'Scheduled jobs', runner: 'Startup runners', event: 'Event listeners' };

export function render(ctx) {
  const { report: r, el, params } = ctx;
  el.classList.add('full');
  const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, padding: '14px 18px', gap: '10px' } });
  el.append(wrap);
  wrap.append(h('div.vhead', h('div', h('h2', 'Request flows'), h('p', 'Every entry point traced through the beans it calls — controllers → services → repositories, outbound HTTP, messages and events. Pick one to see its sequence diagram.'))));
  if (!r.flows.length) { wrap.append(empty('No entry points found', 'No controllers, listeners, scheduled jobs or runners were detected.')); return; }

  const search = h('input.search', { type: 'search', placeholder: 'Filter: path, class, method…', value: params.get('q') || '' });
  const kindSel = h('select', h('option', { value: '' }, 'All entry points'), Object.entries(KIND_LABEL).filter(([k]) => r.flows.some((f) => f.kind === k)).map(([k, l]) => h('option', { value: k }, l)));
  const list = h('div.lp-body');
  const detail = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, minWidth: 0 } });
  wrap.append(h('div.split', h('div.listpane', h('div.lp-head', search, kindSel), list), detail));

  let current = params.get('id') || r.flows[0].id;
  let mode = params.get('mode') || 'sequence';
  let graph = null;

  function renderList() {
    const q = search.value.trim().toLowerCase();
    const k = kindSel.value;
    list.replaceChildren();
    const groups = new Map();
    for (const f of r.flows) {
      if (k && f.kind !== k) continue;
      if (q && !`${f.label} ${f.group} ${f.tree.method}`.toLowerCase().includes(q)) continue;
      const g = f.kind === 'http' ? f.group : KIND_LABEL[f.kind];
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(f);
    }
    for (const [g, fs] of groups) {
      list.append(h('div.li-group', g));
      for (const f of fs) {
        const item = h('div.li' + (f.id === current ? '.active' : ''), { title: f.label, onclick: () => { current = f.id; ctx.setParam('id', f.id); renderList(); show(); } },
          f.kind === 'http' ? methodBadge(f.method) : badge(f.kind, f.kind === 'listener' ? STEREO.listener.color : f.kind === 'scheduled' ? STEREO.scheduler.color : '#64748b'),
          h('span.mono', f.kind === 'http' ? f.path : f.label.replace(/^.*?: /, '')),
          f.stats.calls ? h('span.muted.small', { style: { marginLeft: 'auto' } }, f.stats.calls) : null);
        list.append(item);
      }
    }
    if (!list.children.length) list.append(h('div.muted', { style: { padding: '12px' } }, 'No match'));
  }
  search.addEventListener('input', debounce(renderList, 150));
  kindSel.addEventListener('change', renderList);

  async function show() {
    if (graph) { graph.destroy(); graph = null; }
    const f = r.flows.find((x) => x.id === current) || r.flows[0];
    const ep = f.kind === 'http' ? r.endpoints.find((e) => e.id === f.endpoint) : null;
    detail.replaceChildren();
    detail.append(h('div.card', { style: { padding: '12px 14px' } },
      h('div.flow-meta',
        f.kind === 'http' ? methodBadge(f.method) : badge(f.kind), h('b.mono', f.kind === 'http' ? f.path : f.label),
        h('span.muted', '→'), h('a.lnk', { href: '#', onclick: (e) => { e.preventDefault(); ctx.open({ type: 'class', id: f.tree.class, line: f.tree.line }); } }, `${f.tree.className}.${f.tree.method}()`),
        h('span.spacer'),
        tabs([['sequence', 'Sequence'], ['graph', 'Call graph'], ['tree', 'Call tree']], mode, (m) => { mode = m; ctx.setParam('mode', m); show(); }),
      ),
      h('div.flow-meta', { style: { marginTop: '8px' } },
        ep ? ep.params.filter((p) => p.kind !== 'framework').map((p) => badge(`${p.kind.replace('Request', '').replace('Variable', '')}: ${p.binding || p.name} ‹${short(p.type)}›`, '#64748b')) : null,
        ep && ep.returnType ? badge(`returns ${ep.returnType}`, '#0ea5e9') : null,
        ep?.view ? badge('server-rendered view', '#a855f7') : null,
        ...(ep?.security || []).map((s) => badge(s, '#dc2626')),
        ep?.inSpec ? badge(`in spec: ${ep.inSpec.operationId || ep.inSpec.file.split('/').pop()}`, '#10b981') : null,
        f.stats.repositories.length ? badge(`DB: ${f.stats.entities.join(', ') || f.stats.repositories.join(', ')}`, CONN.database.color) : null,
        f.stats.external ? badge(`${f.stats.external} external call(s)`, CONN.http.color) : null,
        f.stats.publishes ? badge(`${f.stats.publishes} message/event(s)`, CONN.broker.color) : null,
        f.schedule ? badge(f.schedule.cron ? `cron ${f.schedule.cron}` : `every ${f.schedule.fixedRate || f.schedule.fixedDelay} ms`, STEREO.scheduler.color) : null,
      ),
    ));
    if (mode === 'sequence') {
      const diag = h('div.mmd');
      detail.append(h('div.diagram-card', { style: { flex: 1 } }, mermaidToolbar(diag, 'flow'), diag));
      await renderMermaid(diag, toSequence(r, f), { minScale: 0.7 });
    } else if (mode === 'graph') {
      const box = h('div', { style: { flex: 1, display: 'flex', minHeight: '400px' } });
      detail.append(box);
      graph = createGraph(box, { elements: toGraph(r, f), layout: 'dagre-lr', title: 'flow', layouts: ['dagre-lr', 'dagre-tb', 'breadthfirst'], onSelect: (d) => d.cls && ctx.open({ type: 'class', id: d.cls, line: d.line }) });
    } else {
      detail.append(h('div.card.tree', { style: { overflow: 'auto', flex: 1 } }, h('ul', treeNode(f.tree, ctx, true))));
    }
  }

  renderList();
  show();
  return () => graph && graph.destroy();
}

function treeNode(n, ctx, root) {
  const st = n.kind && STEREO[n.stereotype] ? STEREO[n.stereotype] : (STEREO[n.stereotype] || STEREO.infra);
  const label = h('span.tnode', { onclick: () => (n.class ? ctx.open({ type: 'class', id: n.class, line: n.line }) : null) },
    h('span', { style: { color: st.color } }, st.icon),
    n.kind && !n.class ? h('span.cls', n.tech || n.kind) : h('span.cls', n.className),
    h('span.mono', n.kind === 'http' || n.kind === 'publish' || n.kind === 'event' || n.kind === 'db' ? n.signature : '.' + (n.signature || n.method)),
    n.kind === 'repository' && n.entity ? badge(`${n.operation} ${short(n.entity)}`, CONN.database.color) : null,
    n.query ? h('code.small.muted', n.query.length > 90 ? n.query.slice(0, 87) + '…' : n.query) : null,
    n.kind === 'http-client' ? badge(`${n.httpMethod || ''} ${n.service || ''}${n.path || ''}`, CONN.http.color) : null,
    n.via ? h('span.muted.small', `via ${n.via}`) : null,
    n.self && !root ? h('span.muted.small', '(this)') : null,
    n.async ? badge('async', '#eab308') : null,
    n.repeat ? badge('×' + n.repeat) : null,
    n.recursive ? badge('recursive', '#ef4444') : null,
    n.truncated ? badge('depth limit') : null,
    ...(n.annotations || []).map((a) => h('span.ann', a)),
  );
  return h('li', label, n.children?.length ? h('ul', n.children.map((c) => treeNode(c, ctx))) : null);
}

/* ----------- Mermaid sequence from call tree ----------- */
export function toSequence(r, f) {
  const t = mmd.text;
  const parts = new Map(); // key -> {id, label, type}
  const lines = [];
  let count = 0;
  const MAX = 220;
  const part = (key, label, type = 'participant') => {
    if (!parts.has(key)) parts.set(key, { id: 'P' + parts.size, label, type });
    return parts.get(key).id;
  };
  const dbFor = (n) => {
    const repo = r.classes.find((c) => c.id === n.class);
    const conn = repo && r.config.connections.find((c) => c.id === repo.dataStore);
    return conn ? { key: 'conn:' + conn.id, label: `${conn.tech}` } : { key: 'db', label: 'Database' };
  };
  const push = (s) => { if (count < MAX) { lines.push('  ' + s); count++; } };

  let entryId;
  if (f.kind === 'http') {
    const client = part('client', 'Client', 'actor');
    const hasSec = r.security.configs.length || r.classes.some((c) => c.stereotype === 'filter');
    const sec = hasSec ? part('security', r.security.configs.length ? 'Security filter chain' : 'Filters') : null;
    const ctrl = part(f.tree.class, f.tree.className);
    if (hasSec) {
      const filters = r.classes.filter((c) => c.stereotype === 'filter').map((c) => c.name);
      const interceptors = r.interceptors.filter((i) => antMatch(i.paths.split(',')[0].trim(), f.path)).map((i) => i.interceptor);
      if (interceptors.length) filters.push(...interceptors.map((i) => `${i} (interceptor)`));
      push(`${client}->>+${sec}: ${t(f.method)} ${t(f.path)}`);
      if (filters.length) push(`Note over ${sec}: ${t(filters.join(', '))}`);
      const rule = matchRule(r, f.method, f.path);
      if (rule) push(`Note over ${sec}: ${t(rule)}`);
      push(`${sec}->>+${ctrl}: ${t(f.tree.method)}()`);
      entryId = { from: sec, to: ctrl, client, sec };
    } else {
      push(`${client}->>+${ctrl}: ${t(f.method)} ${t(f.path)}`);
      entryId = { from: client, to: ctrl, client };
    }
    const ep = r.endpoints.find((e) => e.id === f.endpoint);
    const validated = ep && ep.params.some((p) => p.validated);
    if (validated) push(`Note over ${ctrl}: @Valid → bean validation`);
    walk(f.tree, ctrl);
    const ret = ep ? (ep.view ? `view "${ep.returnType === 'String' ? 'template' : ep.returnType}"` : ep.returnType || 'response') : 'response';
    if (entryId.sec) { push(`${ctrl}-->>-${entryId.sec}: ${t(ret)}`); push(`${entryId.sec}-->>-${entryId.client}: ${ep?.status ? 'HTTP ' + t(ep.status) : '200 OK'}`); }
    else push(`${ctrl}-->>-${entryId.client}: ${t(ret)}${ep?.status ? ' (' + t(ep.status) + ')' : ''}`);
    const advice = r.exceptionHandlers.filter((x) => x.global);
    if (advice.length) {
      const adv = part(advice[0].class, advice[0].className);
      push(`opt exception thrown`);
      push(`${ctrl}--)${adv}: ${t(advice.slice(0, 3).map((a) => a.exceptions.join('/')).join(', ') || 'Exception')}`);
      push(`${adv}--)${entryId.client}: error response${advice[0].status ? ' ' + t(advice[0].status) : ''}`);
      push('end');
    }
  } else {
    let src;
    if (f.kind === 'listener') src = part('broker:' + f.tech, `${f.tech} ${(f.destinations || []).join(', ')}`, 'participant');
    else if (f.kind === 'scheduled') src = part('scheduler', 'Scheduler', 'participant');
    else if (f.kind === 'event') src = part('events', 'Event bus', 'participant');
    else src = part('boot', 'Spring Boot', 'participant');
    const root = part(f.tree.class, f.tree.className);
    const trigger = f.kind === 'listener' ? `consume ${t((f.destinations || []).join(', '))}` : f.kind === 'scheduled' ? `trigger ${t(f.schedule?.cron || (f.schedule?.fixedRate ? 'every ' + f.schedule.fixedRate + 'ms' : ''))}` : f.kind === 'event' ? `on ${t(f.event)}` : 'run() on startup';
    push(`${src}-)+${root}: ${trigger} → ${t(f.tree.method)}()`);
    walk(f.tree, root);
    push(`${root}-->>-${src}: ${f.kind === 'listener' ? 'ack' : 'done'}`);
  }

  function walk(n, me) {
    const tx = (n.annotations || []).find((a) => a.startsWith('@Transactional'));
    if (tx) push(`Note right of ${me}: ${t(tx.length > 50 ? '@Transactional' : tx)}`);
    for (const a of (n.annotations || []).filter((x) => /@(Cacheable|CacheEvict|CachePut|PreAuthorize|Retryable|CircuitBreaker|Async)/.test(x))) push(`Note right of ${me}: ${t(a.length > 60 ? a.slice(0, 57) + '…' : a)}`);
    for (const c of n.children || []) {
      if (count >= MAX) break;
      const rep = c.repeat ? ` ×${c.repeat}` : '';
      if (c.kind === 'repository') {
        const repo = part(c.class, c.className);
        const db = dbFor(c);
        const dbId = part(db.key, db.label, 'database');
        push(`${me}->>+${repo}: ${t(c.method)}()${rep}`);
        if (c.children?.length) walk(c, repo);
        else {
          const what = c.query ? (c.native ? 'native SQL' : 'JPQL') + ': ' + c.query : `${c.operation.toUpperCase()} ${c.entity ? short(c.entity) : ''}${c.derived ? ' (derived query)' : c.inherited ? ' (inherited)' : ''}`;
          push(`${repo}->>+${dbId}: ${t(what.length > 90 ? what.slice(0, 87) + '…' : what)}`);
          push(`${dbId}-->>-${repo}: ${c.operation === 'write' ? 'saved' : c.operation === 'delete' ? 'deleted' : 'rows'}`);
        }
        push(`${repo}-->>-${me}: ${t(c.entity ? short(c.entity) : 'result')}`);
      } else if (c.kind === 'http-client') {
        const cl = part(c.class, c.className);
        const ext = part('ext:' + (c.service || c.url || 'remote'), `🌍 ${c.service || c.url || 'Remote service'}`);
        push(`${me}->>+${cl}: ${t(c.method)}()${rep}`);
        push(`${cl}->>+${ext}: ${t(c.httpMethod || 'HTTP')} ${t(c.path || '')}`);
        push(`${ext}-->>-${cl}: response`);
        push(`${cl}-->>-${me}: result`);
      } else if (c.kind === 'http') {
        const host = c.service || hostOf(c.baseUrl) || hostOf(c.url) || 'external API';
        const ext = part('ext:' + host, `🌍 ${host}`);
        if (c.baseUrl && c.url && c.url.startsWith('/')) push(`Note over ${ext}: ${t(c.baseUrl)}`);
        push(`${me}->>+${ext}: ${t(c.httpMethod || 'HTTP')} ${t(c.url || '')} (${t(c.tech)})${rep}`);
        push(`${ext}-->>-${me}: response`);
      } else if (c.kind === 'publish') {
        const br = part('broker:' + c.tech, `📨 ${c.tech}`);
        push(`${me}-)${br}: ${t(c.method)} → ${t(c.destination || '?')}${rep}`);
        // who consumes it?
        const consumers = r.listeners.filter((l) => l.destinations.includes(c.destination));
        for (const l of consumers) push(`Note over ${br}: consumed by ${t(l.className)}.${t(l.method)}()`);
      } else if (c.kind === 'event') {
        const bus = part('events', '⚡ Event bus');
        push(`${me}-)${bus}: publish ${t(c.event)}`);
        for (const sub of c.children || []) {
          const lid = part(sub.class, sub.className);
          push(`${bus}-)+${lid}: ${t(sub.method)}()${sub.async ? ' [async]' : ''}${sub.transactionalPhase ? ' [' + t(sub.transactionalPhase) + ']' : ''}`);
          walk(sub, lid);
          push(`${lid}-->>-${bus}: done`);
        }
      } else if (c.kind === 'cache' || c.kind === 'db' || c.kind === 'mail' || c.kind === 'storage') {
        const p2 = part('infra:' + c.tech, `${c.kind === 'cache' ? '⚡' : c.kind === 'db' ? '🛢️' : c.kind === 'mail' ? '✉️' : '🗂️'} ${c.tech}`, c.kind === 'db' ? 'database' : 'participant');
        push(`${me}->>${p2}: ${t(c.signature || c.method)}${rep}`);
      } else if (c.self || c.class === n.class) {
        push(`${me}->>+${me}: ${t(c.method)}()${rep}`);
        walk(c, me);
        push(`deactivate ${me}`);
      } else {
        const tgt = part(c.class, c.className);
        push(`${me}${c.async ? '-)' : '->>'}+${tgt}: ${t(c.method)}()${rep}${c.via ? ' [via ' + t(c.via) + ']' : ''}`);
        walk(c, tgt);
        push(`${tgt}-->>-${me}: ${t(c.returnType && c.returnType !== 'void' ? short(c.returnType.replace(/<.*$/, '')) + (c.returnType.includes('<') ? '‹…›' : '') : ' ')}`);
      }
    }
  }

  const header = ['sequenceDiagram'];
  for (const p of parts.values()) {
    const kw = p.type === 'actor' ? 'actor' : p.type === 'database' ? 'participant' : 'participant';
    header.push(`  ${kw} ${p.id} as ${t(p.label)}`);
  }
  if (count >= MAX) lines.push('  Note over P0: … diagram truncated (very deep flow) — see Call tree');
  return [...header, ...lines].join('\n');
}

function matchRule(r, method, path) {
  for (const rule of r.security.rules) {
    if (rule.method && rule.method !== method) continue;
    if (rule.patterns.some((p) => antMatch(p, path))) return `${rule.patterns.join(', ')} → ${rule.rule}${rule.args ? '(' + rule.args + ')' : ''}`;
  }
  return null;
}
function antMatch(pattern, path) {
  const re = '^' + pattern.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*').replace(/\{[^}]+\}/g, '[^/]+') + '$';
  try { return new RegExp(re).test(path) || new RegExp(re).test(path + '/'); } catch { return false; }
}
function hostOf(url) { try { return new URL(url).host; } catch { return url && !url.startsWith('/') ? url.split('/')[0] : null; } }

/* ----------- Cytoscape call graph ----------- */
function toGraph(r, f) {
  const nodes = new Map(); const edges = [];
  const node = (key, label, color, extra = {}, classes = '') => { if (!nodes.has(key)) nodes.set(key, { data: { id: key, label, color, ...extra }, classes }); return key; };
  const entry = f.kind === 'http' ? node('entry', `${f.method} ${f.path}`, '#0ea5e9', {}, 'hub') : node('entry', f.label, '#f97316', {}, 'hub');
  let n = 0;
  function walk(t, from) {
    for (const c of t.children || []) {
      let id;
      if (c.kind === 'http' || c.kind === 'http-client') id = node('ext:' + (c.service || hostOf(c.url) || c.url || 'http'), '🌍 ' + (c.service || hostOf(c.url) || 'external'), CONN.http.color, {}, 'ext');
      else if (c.kind === 'publish') id = node('topic:' + c.destination, '📨 ' + c.destination, CONN.broker.color, {}, 'topic');
      else if (c.kind === 'event') id = node('event:' + c.event, '⚡ ' + c.event, '#eab308', {}, 'topic');
      else if (c.kind && !c.class) id = node('infra:' + c.tech, c.tech, CONN.database.color, {}, 'db');
      else { const st = STEREO[c.stereotype] || STEREO.other; id = node(c.class + '#' + c.method, `${c.className}\n.${c.method}()`, st.color, { cls: c.class, line: c.line }); }
      edges.push({ data: { id: 'e' + (n++), source: from, target: id, label: c.kind === 'repository' && !c.children?.length ? c.operation : '' }, classes: c.kind === 'publish' || c.kind === 'event' || c.async ? 'async' : '' });
      if (c.kind === 'repository' && c.entity) {
        const repo = r.classes.find((x) => x.id === c.class);
        const conn = repo && r.config.connections.find((x) => x.id === repo.dataStore);
        const db = node('db:' + (conn?.id || 'db'), `🛢️ ${conn ? conn.tech : 'Database'}\n${short(c.entity)}`, CONN.database.color, {}, 'db');
        edges.push({ data: { id: 'e' + (n++), source: id, target: db, label: c.operation, color: CONN.database.color } });
      }
      walk(c, id);
    }
  }
  const st = STEREO[f.tree.stereotype] || STEREO.other;
  const root = node(f.tree.class + '#' + f.tree.method, `${f.tree.className}\n.${f.tree.method}()`, st.color, { cls: f.tree.class, line: f.tree.line });
  edges.push({ data: { id: 'e-root', source: entry, target: root } });
  walk(f.tree, root);
  const seen = new Set();
  return [...nodes.values(), ...edges.filter((e) => { const k = e.data.source + '>' + e.data.target; if (seen.has(k)) return false; seen.add(k); return true; })];
}
