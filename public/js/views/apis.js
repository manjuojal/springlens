import { h, methodBadge, badge, short, tabs, empty, debounce, METHOD_COLORS, STEREO, CONN, download } from '../ui.js';
import { createGraph } from '../graph.js';

export function render(ctx) {
  const { report: r, el, params } = ctx;
  let tab = params.get('tab') || 'endpoints';
  let graph = null;
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, minHeight: 0 } });
  const specOps = r.infra.openapi.flatMap((s) => s.operations);
  el.append(h('div.vhead',
    h('div', h('h2', 'APIs'), h('p', `${r.endpoints.length} endpoints in code${r.infra.openapi.length ? `, ${specOps.length} operations in ${r.infra.openapi.length} OpenAPI spec(s)` : ''}${r.clients.length || r.httpCalls.length ? `, ${r.clients.length + r.httpCalls.length} outbound calls` : ''}. Base URL: http://localhost:${r.config.server.port}${r.config.server.contextPath}`)),
    h('span.spacer'),
    tabs([['endpoints', 'Endpoints'], ['map', 'API map'], ['spec', `OpenAPI specs (${r.infra.openapi.length})`], ['outbound', 'Outbound calls']], tab, (t) => { tab = t; ctx.setParam('tab', t); show(); }),
  ), body);

  function show() {
    if (graph) { graph.destroy(); graph = null; }
    body.replaceChildren();
    if (tab === 'endpoints') endpointsTab();
    else if (tab === 'map') mapTab();
    else if (tab === 'spec') specTab();
    else outboundTab();
  }

  function endpointsTab() {
    if (!r.endpoints.length) { body.append(empty('No HTTP endpoints found')); return; }
    const q = h('input.search', { type: 'search', placeholder: 'Filter endpoints…', style: { width: '280px' } });
    const methods = [...new Set(r.endpoints.map((e) => e.method))];
    const mSel = h('select', h('option', { value: '' }, 'All methods'), methods.map((m) => h('option', m)));
    const tbody = h('tbody');
    const fill = () => {
      const s = q.value.trim().toLowerCase();
      tbody.replaceChildren();
      let lastCtrl = null;
      for (const e of r.endpoints.slice().sort((a, b) => a.controllerName.localeCompare(b.controllerName) || a.path.localeCompare(b.path))) {
        if (mSel.value && e.method !== mSel.value) continue;
        if (s && !`${e.path} ${e.controllerName} ${e.handler} ${e.summary || ''}`.toLowerCase().includes(s)) continue;
        if (e.controllerName !== lastCtrl) { lastCtrl = e.controllerName; tbody.append(h('tr.group', h('td', { colspan: 6 }, h('a.lnk', { href: '#', onclick: (ev) => { ev.preventDefault(); ctx.open({ type: 'class', id: e.controller }); } }, `${STEREO.controller.icon} ${e.controllerName}`)))); }
        const ps = e.params.filter((p) => p.kind !== 'framework');
        tbody.append(h('tr.clickable', { onclick: () => ctx.go('flows', { id: e.id }) },
          h('td', methodBadge(e.method)),
          h('td', h('div.mono', e.path), e.summary ? h('div.small.muted', e.summary) : null),
          h('td.mono.small', `${e.handler}()`),
          h('td.small', ps.map((p) => h('div', h('span.muted', `${p.kind.replace('Request', '').replace('Variable', '')} `), h('span.mono', `${p.binding || p.name}: ${short(p.type)}`), p.validated ? badge('@Valid', '#10b981') : null))),
          h('td.mono.small', e.returnType, e.view ? h('div', badge('view', '#a855f7')) : null, e.produces ? h('div.muted', e.produces) : null),
          h('td', e.security.map((s) => h('div', badge(s.length > 40 ? s.slice(0, 37) + '…' : s, '#dc2626'))), specOps.length ? (e.inSpec ? badge('✓ spec', '#10b981') : badge('not in spec', '#d97706')) : null, e.source === 'router-function' ? badge('RouterFunction') : null, e.declaredIn ? badge(`from ${short(e.declaredIn)}`, '#64748b') : null),
        ));
      }
    };
    q.addEventListener('input', debounce(fill, 120)); mSel.addEventListener('change', fill);
    const curl = () => download('endpoints.http', r.endpoints.map((e) => `### ${e.controllerName}.${e.handler}\n${e.method === 'ANY' ? 'GET' : e.method} http://localhost:${r.config.server.port}${r.config.server.contextPath}${e.path.replace(/\{(\w+)[^}]*\}/g, '{{$1}}')}${e.params.some((p) => p.kind === 'RequestBody') ? '\nContent-Type: application/json\n\n{}' : ''}\n`).join('\n'), 'text/plain');
    body.append(h('div', { style: { display: 'flex', gap: '8px' } }, q, mSel, h('span.spacer'), h('button.ghost', { onclick: curl, title: 'Download a .http file (IntelliJ / VS Code REST client)' }, '⇩ .http requests')),
      h('div.card', { style: { padding: 0, overflow: 'auto' } }, h('table.tbl', h('thead', h('tr', ['Method', 'Path', 'Handler', 'Parameters', 'Returns', 'Security / spec'].map((x) => h('th', x)))), tbody)));
    fill();
  }

  function mapTab() {
    const box = h('div', { style: { flex: 1, display: 'flex', minHeight: '520px' } });
    body.append(box);
    const nodes = new Map(); const edges = [];
    const root = 'path:/';
    nodes.set(root, { data: { id: root, label: `${r.config.server.contextPath || '/'}  :${r.config.server.port}`, color: '#6db33f' }, classes: 'hub' });
    const all = [...r.endpoints.map((e) => ({ method: e.method, path: e.path, impl: true, ep: e })), ...specOps.filter((o) => !o.implemented).map((o) => ({ method: o.method, path: o.path, impl: false, op: o }))];
    for (const e of all) {
      const segs = e.path.split('/').filter(Boolean);
      let parent = root; let acc = '';
      for (const s of segs) {
        acc += '/' + s;
        const id = 'path:' + acc;
        if (!nodes.has(id)) { nodes.set(id, { data: { id, label: '/' + s, color: s.startsWith('{') ? '#a855f7' : '#64748b' } }); edges.push({ data: { id: parent + '>' + id, source: parent, target: id } }); }
        parent = id;
      }
      const leaf = `ep:${e.method}:${e.path}`;
      if (!nodes.has(leaf)) {
        nodes.set(leaf, { data: { id: leaf, label: `${e.method}${e.impl ? '  ' + e.ep.handler + '()' : '  (spec only)'}`, sub: e.impl ? e.ep.controllerName : e.op.operationId || '', color: METHOD_COLORS[e.method] || '#64748b', ep: e.impl ? e.ep.id : null }, classes: e.impl ? '' : 'ext' });
        edges.push({ data: { id: parent + '>' + leaf, source: parent, target: leaf, color: METHOD_COLORS[e.method] } });
      }
    }
    graph = createGraph(box, { elements: [...nodes.values(), ...edges], layout: 'dagre-lr', title: 'api-map', layouts: ['dagre-lr', 'dagre-tb', 'breadthfirst', 'concentric'], onSelect: (d) => d.ep && ctx.go('flows', { id: d.ep }), legend: Object.entries(METHOD_COLORS).slice(0, 5).concat([['path variable', '#a855f7']]) });
  }

  function specTab() {
    if (!r.infra.openapi.length) { body.append(empty('No OpenAPI / Swagger specification files found', 'Spring Lens looks for *.yaml / *.yml / *.json files containing an "openapi:" or "swagger:" root key (e.g. src/main/resources/openapi.yaml).')); return; }
    for (const s of r.infra.openapi) {
      const impl = s.operations.filter((o) => o.implemented).length;
      body.append(h('div.card',
        h('div.flow-meta', h('h3', { style: { margin: 0 } }, `${s.title}`), badge(`OpenAPI ${s.version}`, '#10b981'), s.apiVersion ? badge('v' + s.apiVersion) : null, h('span.muted.mono.small.clickable', { onclick: () => ctx.open({ type: 'file', file: s.file, line: 1 }) }, s.file), h('span.spacer'), badge(`${impl}/${s.operations.length} implemented`, impl === s.operations.length ? '#10b981' : '#d97706')),
        s.description ? h('p.muted.small', s.description.slice(0, 300)) : null,
        s.servers.length ? h('div.small', 'Servers: ', s.servers.map((x) => h('code', x + ' '))) : null,
        h('table.tbl', { style: { marginTop: '8px' } }, h('thead', h('tr', ['Method', 'Path', 'Operation', 'Request', 'Responses', 'Code'].map((x) => h('th', x)))),
          h('tbody', s.operations.map((o) => {
            const ep = r.endpoints.find((e) => e.inSpec && e.method === o.method && e.inSpec.operationId === o.operationId && e.inSpec.file === s.file) || r.endpoints.find((e) => e.method === o.method && e.path.replace(/\{[^}]+\}/g, '{}') === o.path.replace(/\{[^}]+\}/g, '{}'));
            return h('tr' + (ep ? '.clickable' : ''), { onclick: ep ? () => ctx.go('flows', { id: ep.id }) : null },
              h('td', methodBadge(o.method)), h('td.mono', o.path, o.deprecated ? badge('deprecated', '#d97706') : null),
              h('td.small', h('b', o.operationId || ''), o.summary ? h('div.muted', o.summary) : null, o.tags.length ? h('div', o.tags.map((t) => badge(t))) : null),
              h('td.small.mono', o.params.map((p) => h('div', p.ref ? `$ref ${p.ref}` : `${p.in}: ${p.name}${p.required ? '*' : ''} ${p.type || ''}`)), o.requestBody.map((b) => h('div', `body: ${b.schema || b.contentType}`))),
              h('td.small.mono', o.responses.map((x) => h('div', `${x.code} ${x.schema || ''}`))),
              h('td', ep ? h('span', badge('✓', '#10b981'), ' ', h('span.mono.small', `${ep.controllerName}.${ep.handler}()`)) : badge('missing', '#dc2626')));
          }))),
        s.schemas.length ? h('details', { style: { marginTop: '10px' } }, h('summary.clickable.muted', `${s.schemas.length} schemas`), h('div.grid.g3', { style: { marginTop: '8px' } }, s.schemas.map((sc) => h('div.pitem', h('b', sc.name, ' ', h('span.muted.small', sc.type)), sc.properties.map((p) => h('div.d', `${p.name}${p.required ? '*' : ''}: ${p.type || '?'}`)))))) : null,
      ));
    }
  }

  function outboundTab() {
    if (!r.clients.length && !r.httpCalls.length) { body.append(empty('No outbound HTTP calls detected', 'Looks for @FeignClient / @HttpExchange interfaces and RestTemplate / WebClient / RestClient usage.')); return; }
    if (r.clients.length) body.append(h('div.card', h('h3', 'Declarative clients (@FeignClient / @HttpExchange)'), r.clients.map((c) => h('div', { style: { marginBottom: '10px' } },
      h('div.flow-meta', h('a.lnk', { href: '#', onclick: (e) => { e.preventDefault(); ctx.open({ type: 'class', id: c.id }); } }, `${STEREO.client.icon} ${c.name}`), c.serviceName ? badge('service: ' + c.serviceName, CONN.http.color) : null, c.url ? h('code', c.url) : null, c.fallback ? badge('fallback ' + c.fallback) : null),
      h('table.mini', c.operations.map((o) => h('tr', h('td', methodBadge(o.method)), h('td.mono', o.path), h('td.mono.muted', `${o.name}() → ${o.returnType}`))))))));
    if (r.httpCalls.length) body.append(h('div.card', h('h3', 'Programmatic HTTP calls'), h('table.tbl', h('thead', h('tr', ['From', 'Client', 'Method', 'URL'].map((x) => h('th', x)))), h('tbody', r.httpCalls.map((c) => h('tr.clickable', { onclick: () => ctx.open({ type: 'class', id: c.from }) }, h('td.mono.small', `${c.fromName}.${c.method}()`), h('td', badge(c.tech, CONN.http.color)), h('td', c.httpMethod ? methodBadge(c.httpMethod) : '—'), h('td.mono.small', c.url || '?')))))));
  }

  show();
  return () => graph && graph.destroy();
}
