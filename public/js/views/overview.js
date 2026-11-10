import { h, short, CONN, STEREO } from '../ui.js';
import { renderMermaid, mermaidToolbar, mmd } from '../graph.js';

export async function render(ctx) {
  const { report: r, el, go } = ctx;
  const c = r.summary.counts;
  const s = r.summary;

  el.append(h('div.vhead', h('div',
    h('h2', r.name),
    h('p', [
      s.springBootVersion ? `Spring Boot ${s.springBootVersion}` : 'Spring (Boot version unknown)',
      s.javaVersion ? `Java ${s.javaVersion}` : null, s.buildTool, s.basePackage ? `base package ${s.basePackage}` : null,
      `${s.javaFiles} Java files · ${s.linesOfCode.toLocaleString()} lines`,
    ].filter(Boolean).join(' · ')),
  )));

  const stat = (n, l, view, params) => h('div.stat', { onclick: () => go(view, params) }, h('div.n', n), h('div.l', l));
  el.append(h('div.stats',
    stat(c.endpoints, 'HTTP endpoints', 'apis'), stat(c.controllers, 'controllers', 'classes', { stereotype: 'controller' }), stat(c.services, 'services', 'classes', { stereotype: 'service' }),
    stat(c.repositories, 'repositories', 'classes', { stereotype: 'repository' }), stat(c.entities, 'entities', 'data'), stat(c.beans, 'beans', 'architecture'),
    stat(c.connections, 'connections', 'connections'), stat(c.listeners + c.scheduled, 'listeners & jobs', 'messaging'), stat(r.config.profiles.length, 'profiles', 'config'), stat(c.specs, 'OpenAPI specs', 'apis', { tab: 'spec' }),
  ));

  // System context diagram (mermaid flowchart) — boxes expand in place
  const diag = h('div.mmd', { style: { height: '460px', flex: 'none' } });
  const expanded = new Set();
  let refs = [];
  const groups = groupsOf(r);
  const draw = async () => {
    const built = systemDiagram(r, groups, expanded);
    refs = built.refs;
    diag.style.height = expanded.size ? `${Math.min(820, 520 + expanded.size * 60)}px` : '460px';
    await renderMermaid(diag, built.code, { minScale: expanded.size ? 0.55 : 0 });
  };
  window.__slToggle = (id) => { if (expanded.has(id)) expanded.delete(id); else expanded.add(id); draw(); };
  window.__slOpen = (i) => { const ref = refs[+i]; if (!ref) return; if (ref.view) go(ref.view, ref.params); else ctx.open(ref); };
  el.append(h('div.diagram-card', { style: { flexShrink: 0 } },
    h('div.graph-toolbar', h('b', 'System overview'), h('span.muted.small', 'Click a box to expand it · click an item to open its code · ▲ collapses'), h('span.spacer'),
      h('button.ghost', { onclick: () => { groups.forEach((g) => expanded.add(g.id)); draw(); } }, 'Expand all'),
      h('button.ghost', { onclick: () => { expanded.clear(); draw(); } }, 'Collapse all')),
    mermaidToolbar(diag, 'overview'), diag));
  await draw();

  // findings + stack
  const findings = buildFindings(r);
  el.append(h('div.grid.g2',
    h('div.card', h('h3', `Findings (${findings.length})`), findings.length ? findings.map((f) => h('div.drow' + (f.view ? '.clickable' : ''), { onclick: f.view ? () => go(f.view, f.params) : null }, h('span', { style: { color: f.level === 'warn' ? 'var(--warn)' : 'var(--muted)' } }, f.level === 'warn' ? '⚠ ' : 'ℹ '), f.text)) : h('div.muted', 'Nothing noteworthy.')),
    h('div.card', h('h3', 'Tech stack (from build file)'),
      h('div.chips', r.build.dependencies.filter((d, i, a) => d.info && d.scope !== 'test' && a.findIndex((x) => x.info?.name === d.info.name) === i).map((d) => h('span.chip', { title: `${d.group}:${d.artifact}${d.version ? ':' + d.version : ''}\n${d.info.desc}` }, d.info.name))),
      h('details', { style: { marginTop: '10px' } }, h('summary.muted.small.clickable', `All ${r.build.dependencies.length} dependencies`),
        h('table.mini', r.build.dependencies.map((d) => h('tr', h('td.mono', `${d.group}:${d.artifact}`), h('td.mono.muted', d.version || ''), h('td.muted', d.scope))))),
    ),
  ));
  if (r.warnings.length) el.append(h('div.card', h('h3', 'Analysis warnings'), r.warnings.map((w) => h('div.small.muted', w))));
}

/** The boxes of the system overview and their members (shown when a box is expanded). */
function groupsOf(r) {
  const by = (st) => r.classes.filter((c) => c.stereotype === st && c.isBean);
  const cls = (c, sub) => ({ label: c.name, sub, ref: { type: 'class', id: c.id } });
  const listenerClasses = [...by('listener'), ...r.classes.filter((c) => r.listeners.some((l) => l.class === c.id) && c.stereotype !== 'listener')];
  const filters = r.classes.filter((c) => ['security', 'filter', 'interceptor'].includes(c.stereotype));
  return [
    { id: 'sec', icon: '🔐', title: 'Security & filters', color: STEREO.security.color, outside: true, shape: 'hex',
      summary: r.security.features.slice(0, 3).join(', ') || filters.map((c) => c.name).join(', '),
      items: [...filters.map((c) => cls(c, STEREO[c.stereotype].label)), ...r.security.rules.slice(0, 8).map((x) => ({ label: `${x.method ? x.method + ' ' : ''}${x.patterns.join(', ')}`, sub: `${x.rule}${x.args ? '(' + x.args + ')' : ''}`, ref: { view: 'startup' } }))] },
    { id: 'web', icon: '🌐', title: 'Controllers', extra: `${r.endpoints.length} endpoints`, color: STEREO.controller.color,
      items: by('controller').map((c) => { const eps = r.endpoints.filter((e) => e.controller === c.id); return cls(c, eps.slice(0, 3).map((e) => `${e.method} ${e.path}`).join('<br/>') + (eps.length > 3 ? `<br/>+${eps.length - 3} more` : '')); }) },
    { id: 'lis', icon: '📥', title: 'Listeners', color: STEREO.listener.color,
      items: listenerClasses.map((c) => cls(c, r.listeners.filter((l) => l.class === c.id).map((l) => `${l.tech} ${l.destinations.join(', ')}`).join('<br/>'))) },
    { id: 'sch', icon: '⏰', title: 'Scheduled jobs', color: STEREO.scheduler.color,
      items: r.scheduled.map((s) => ({ label: `${s.className}.${s.method}()`, sub: s.cron ? `cron ${s.cron}` : s.fixedRate ? `every ${s.fixedRate} ms` : `delay ${s.fixedDelay} ms`, ref: { type: 'class', id: s.class, line: s.line } })) },
    { id: 'svc', icon: '⚙️', title: 'Services / components', color: STEREO.service.color,
      items: [...by('service'), ...by('component')].map((c) => cls(c, `${c.deps.length} dependencies`)) },
    { id: 'repo', icon: '🗄️', title: 'Repositories', color: STEREO.repository.color,
      items: by('repository').map((c) => cls(c, c.entity ? `‹${short(c.entity)}›` : c.repoBase || '')) },
    { id: 'cli', icon: '📡', title: 'HTTP clients', color: STEREO.client.color,
      items: by('client').map((c) => { const cl = r.clients.find((x) => x.id === c.id); return cls(c, cl ? (cl.serviceName || cl.url || '') : ''); }) },
    { id: 'ent', icon: '📦', title: 'Entities', color: STEREO.entity.color, shape: 'db',
      items: r.entities.map((e) => ({ label: e.name, sub: `table ${e.table} · ${e.fields.length} fields`, ref: { type: 'class', id: e.id } })) },
  ].filter((g) => g.items.length);
}

function systemDiagram(r, groups, expanded) {
  const L = ['flowchart LR'];
  const refs = [];
  const clicks = [];
  const t = mmd.text;
  const has = (id) => groups.some((g) => g.id === id);
  const port = r.config.server.port; const ctxp = r.config.server.contextPath;

  const box = (g, indent) => {
    const pad = ' '.repeat(indent);
    if (!expanded.has(g.id)) {
      const preview = g.items.slice(0, 4).map((x) => t(x.label)).join('<br/>') + (g.items.length > 4 ? `<br/>+${g.items.length - 4} more` : '');
      const text = `${g.icon} ${g.items.length} ${t(g.title)}${g.extra ? ' · ' + t(g.extra) : ''}<br/><small>${g.summary ? t(g.summary) : preview}</small><br/><small><i>▼ click to expand</i></small>`;
      L.push(g.shape === 'db' ? `${pad}${g.id}[("${text}")]` : g.shape === 'hex' ? `${pad}${g.id}{{"${text}"}}` : `${pad}${g.id}["${text}"]`);
      clicks.push(`  click ${g.id} call __slToggle("${g.id}")`);
      L.push(`  style ${g.id} stroke:${g.color},stroke-width:2px`);
      return;
    }
    L.push(`${pad}subgraph ${g.id}["${g.icon} ${t(g.title)} (${g.items.length})${g.extra ? ' · ' + t(g.extra) : ''}"]`);
    L.push(`${pad}  direction TB`);
    L.push(`${pad}  ${g.id}_x(["▲ collapse"])`);
    clicks.push(`  click ${g.id}_x call __slToggle("${g.id}")`);
    L.push(`  style ${g.id}_x stroke-dasharray:3 3`);
    const shown = g.items.slice(0, 60);
    const perCol = 6;
    shown.forEach((it, i) => {
      const nid = `${g.id}_${i}`;
      const label = `${t(it.label)}${it.sub ? `<br/><small>${it.sub.split('<br/>').map(t).join('<br/>')}</small>` : ''}`;
      L.push(g.shape === 'db' ? `${pad}  ${nid}[("${label}")]` : `${pad}  ${nid}["${label}"]`);
      refs.push(it.ref);
      clicks.push(`  click ${nid} call __slOpen("${refs.length - 1}")`);
      L.push(`  style ${nid} stroke:${g.color},stroke-width:1.5px`);
    });
    // stack items vertically (columns of 6) with invisible links instead of one very wide row
    L.push(`${pad}  ${g.id}_x ~~~ ${g.id}_0`);
    for (let i = 1; i < shown.length; i++) if (i % perCol !== 0) L.push(`${pad}  ${g.id}_${i - 1} ~~~ ${g.id}_${i}`);
    if (g.items.length > 60) L.push(`${pad}  ${g.id}_more["+${g.items.length - 60} more"]`);
    L.push(`${pad}end`);
    L.push(`  style ${g.id} stroke:${g.color},stroke-width:2px,stroke-dasharray:6 3`);
  };

  L.push('  user(["👤 Client / Browser"])');
  const sec = groups.find((g) => g.id === 'sec');
  if (sec) box(sec, 2);
  L.push(`  subgraph app["🚀 ${t(r.name)} :${port}${t(ctxp)}"]`);
  L.push('    direction LR');
  for (const g of groups) if (!g.outside) box(g, 4);
  L.push('  end');

  if (has('web')) { L.push(has('sec') ? '  user --> sec --> web' : '  user -->|HTTP| web'); L.push(has('svc') ? '  web --> svc' : has('repo') ? '  web --> repo' : ''); }
  if (has('lis') && has('svc')) L.push('  lis --> svc');
  if (has('sch') && has('svc')) L.push('  sch --> svc');
  if (has('svc') && has('repo')) L.push('  svc --> repo');
  if (has('svc') && has('cli')) L.push('  svc --> cli');
  if (has('repo') && has('ent')) L.push('  repo -.- ent');

  r.config.connections.forEach((c, i) => {
    const ct = CONN[c.type] || CONN.http;
    const id = 'c' + i;
    const shape = c.type === 'database' ? ['[(', ')]'] : c.type === 'broker' ? ['[/', '/]'] : c.type === 'http' || c.type === 'auth' ? ['>', ']'] : ['([', '])'];
    L.push(`  ${id}${shape[0]}"${ct.icon} ${t(c.name)}<br/><small>${t(c.tech)}${c.endpoint?.host ? ' · ' + t(c.endpoint.host) : ''}</small>"${shape[1]}`);
    const from = c.type === 'database' ? (has('repo') ? 'repo' : has('svc') ? 'svc' : 'app') : c.type === 'broker' ? (has('svc') ? 'svc' : 'app') : c.type === 'http' ? (has('cli') ? 'cli' : has('svc') ? 'svc' : 'app') : c.type === 'auth' ? (has('sec') ? 'sec' : 'app') : 'app';
    L.push(c.type === 'broker' && has('lis') ? `  ${from} <-->|${t(c.tech)}| ${id}` : `  ${from} -->|${t(c.tech)}| ${id}`);
    if (c.type === 'broker' && has('lis')) L.push(`  ${id} -.-> lis`);
    refs.push({ type: 'connection', id: c.id });
    clicks.push(`  click ${id} call __slOpen("${refs.length - 1}")`);
    L.push(`  style ${id} stroke:${ct.color},stroke-width:2px`);
  });
  L.push(...clicks);
  return { code: L.filter(Boolean).join('\n'), refs };
}

function buildFindings(r) {
  const f = [];
  const req = r.config.envVars.filter((e) => e.default == null);
  if (req.length) f.push({ level: 'warn', text: `${req.length} environment variable(s) required without default: ${req.slice(0, 6).map((e) => e.name).join(', ')}`, view: 'config', params: { tab: 'env' } });
  const literalSecrets = r.config.files.flatMap((x) => x.props.filter((p) => p.secret && p.value && !p.value.startsWith('${') && p.value === '••••••').map((p) => `${p.key} (${x.file.split('/').pop()})`));
  if (literalSecrets.length) f.push({ level: 'warn', text: `Hard-coded secret values in config: ${literalSecrets.slice(0, 4).join(', ')}`, view: 'config' });
  const specOps = r.infra.openapi.flatMap((o) => o.operations);
  const missing = specOps.filter((o) => !o.implemented);
  if (missing.length) f.push({ level: 'warn', text: `${missing.length} OpenAPI operation(s) not implemented by any controller`, view: 'apis', params: { tab: 'spec' } });
  if (specOps.length) { const notIn = r.endpoints.filter((e) => !e.inSpec); if (notIn.length) f.push({ level: 'info', text: `${notIn.length} endpoint(s) not documented in OpenAPI spec`, view: 'apis' }); }
  if (r.security.configs.length) {
    const permit = r.security.rules.filter((x) => x.rule === 'permitAll').flatMap((x) => x.patterns);
    f.push({ level: 'info', text: `Security: ${r.security.features.join(', ') || 'custom filter chain'}${permit.length ? ` · public: ${permit.slice(0, 5).join(', ')}` : ''}`, view: 'startup' });
  } else if (r.endpoints.length && !r.build.dependencies.some((d) => /security/.test(d.artifact))) f.push({ level: 'info', text: 'No Spring Security on the classpath — endpoints are unauthenticated.' });
  const implied = r.config.connections.filter((c) => c.implied);
  for (const c of implied) f.push({ level: 'info', text: c.note, view: 'connections' });
  const multi = r.config.connections.filter((c) => c.profiles.length > 1);
  for (const c of multi) f.push({ level: 'info', text: `${c.name} differs per profile: ${c.profiles.join(', ')}`, view: 'connections', params: { id: c.id } });
  const unusedRepos = r.classes.filter((c) => c.stereotype === 'repository' && !r.classes.some((x) => x.deps.some((d) => d.target === c.id)));
  if (unusedRepos.length) f.push({ level: 'info', text: `Repositories not injected anywhere: ${unusedRepos.map((c) => c.name).join(', ')}` });
  const cycles = findCycles(r);
  if (cycles.length) f.push({ level: 'warn', text: `Circular bean dependencies: ${cycles.slice(0, 3).map((c) => c.map(short).join(' → ')).join(' | ')}`, view: 'architecture' });
  return f;
}

function findCycles(r) {
  const g = new Map(r.classes.map((c) => [c.id, c.deps.filter((d) => d.via !== 'field' || true).map((d) => d.target)]));
  const cycles = []; const seen = new Set();
  for (const start of g.keys()) {
    const stack = [[start, [start]]];
    while (stack.length && cycles.length < 5) {
      const [n, path] = stack.pop();
      for (const m of g.get(n) || []) {
        if (m === start && path.length > 1) { const k = [...path].sort().join(); if (!seen.has(k)) { seen.add(k); cycles.push([...path, start]); } }
        else if (!path.includes(m) && path.length < 6) stack.push([m, [...path, m]]);
      }
    }
  }
  return cycles;
}
