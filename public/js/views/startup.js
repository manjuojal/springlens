import { h, $$, tabs } from '../ui.js';
import { renderMermaid, mermaidToolbar, mmd } from '../graph.js';

export async function render(ctx) {
  const { report: r, el } = ctx;
  let timer = null;
  const playBtn = h('button.primary', { onclick: () => (timer ? stop() : play()) }, '▶ Play startup');
  el.append(h('div.vhead',
    h('div', h('h2', 'Startup flow'), h('p', 'What happens from main() until the application serves traffic — reconstructed from the main class, config files, starters, @Configuration classes, connections and runners. Click any item for its source.')),
    h('span.spacer'), h('div.seg', h('button', { onclick: () => $$('.phase').forEach((p) => p.classList.add('open')) }, 'Expand all'), h('button', { onclick: () => $$('.phase').forEach((p) => p.classList.remove('open')) }, 'Collapse')), playBtn,
  ));

  const tl = h('div.timeline');
  r.startup.forEach((p, i) => {
    const items = h('div.phase-items', p.items.map((it) => {
      const clickable = it.ref || it.flow;
      return h('div.pitem' + (clickable ? '.ref' : '') + (it.warn ? '.warn' : ''), {
        title: it.sub || '',
        onclick: clickable ? () => (it.flow ? ctx.go('flows', { id: it.flow }) : ctx.open(it.ref)) : null,
      }, h('b', it.label), it.detail ? h('div.d', it.detail) : null, it.sub ? h('div.d', it.sub) : null);
    }));
    const ph = h('div.phase' + (i < 2 ? '.open' : ''), { dataset: { i } },
      h('div.dot', i + 1),
      h('div.phase-head', { onclick: () => ph.classList.toggle('open') }, h('div', h('h3', p.title), h('p', p.description)), h('span.cnt', p.items.length ? `${p.items.length} item${p.items.length > 1 ? 's' : ''} ▾` : '')),
      items,
    );
    tl.append(ph);
  });

  const diag = h('div.mmd', { style: { height: 'calc(100vh - 230px)', minHeight: '480px', flex: 'none' } });
  const seqCard = h('div.diagram-card', { style: { display: 'none' } }, mermaidToolbar(diag, 'startup-sequence'), diag);
  let rendered = false;
  el.append(h('div', tabs([['timeline', 'Timeline'], ['sequence', 'Sequence diagram']], 'timeline', async (k) => {
    tl.style.display = k === 'timeline' ? '' : 'none';
    seqCard.style.display = k === 'sequence' ? '' : 'none';
    if (k === 'sequence' && !rendered) { rendered = true; await renderMermaid(diag, sequence(r), { minScale: 0.7 }); }
  })), tl, seqCard);

  function play() {
    playBtn.textContent = '■ Stop';
    const phases = $$('.phase', tl);
    phases.forEach((p) => p.classList.remove('active', 'done', 'open'));
    let i = 0;
    const step = () => {
      if (i > 0) { phases[i - 1].classList.remove('active'); phases[i - 1].classList.add('done'); }
      if (i >= phases.length) { stop(); return; }
      phases[i].classList.add('active', 'open');
      phases[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
      i++;
      timer = setTimeout(step, 1800);
    };
    step();
  }
  function stop() { clearTimeout(timer); timer = null; playBtn.textContent = '▶ Play startup'; }
  return stop;
}

/** Mermaid sequence of the bootstrap. */
function sequence(r) {
  const L = ['sequenceDiagram', '  autonumber'];
  const app = r.classes.find((c) => c.stereotype === 'application');
  const t = mmd.text;
  L.push(`  participant JVM`);
  L.push(`  participant SA as SpringApplication`);
  L.push(`  participant ENV as Environment`);
  L.push(`  participant CTX as ApplicationContext`);
  const conns = r.config.connections.slice(0, 6);
  conns.forEach((c, i) => L.push(`  participant C${i} as ${t(c.name)}`));
  const hasWeb = r.endpoints.length > 0;
  if (hasWeb) L.push('  participant WEB as Web server');
  L.push(`  JVM->>SA: ${t(app ? app.name : 'Main')}.main() → run()`);
  L.push(`  SA->>ENV: load ${t(r.config.files.map((f) => f.file.split('/').pop()).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4).join(', ') || 'defaults')}`);
  if (r.config.activeProfiles.length) L.push(`  Note over ENV: active profiles: ${t(r.config.activeProfiles.join(', '))}`);
  const envReq = r.config.envVars.filter((e) => e.default == null);
  if (envReq.length) L.push(`  Note over ENV: needs env ${t(envReq.slice(0, 4).map((e) => e.name).join(', '))}${envReq.length > 4 ? '…' : ''}`);
  L.push('  SA->>CTX: create & refresh context');
  const starters = r.build.dependencies.filter((d) => d.info && d.scope !== 'test').map((d) => d.info.name);
  if (starters.length) L.push(`  Note over CTX: auto-config: ${t(starters.slice(0, 5).join(', '))}${starters.length > 5 ? '…' : ''}`);
  const cfgs = r.classes.filter((c) => c.stereotype === 'configuration' || c.stereotype === 'security');
  if (cfgs.length) L.push(`  CTX->>CTX: process @Configuration (${t(cfgs.slice(0, 4).map((c) => c.name).join(', '))}${cfgs.length > 4 ? '…' : ''})`);
  L.push(`  CTX->>CTX: instantiate ${r.summary.counts.beans} beans & inject dependencies`);
  conns.forEach((c, i) => {
    const target = c.endpoint?.host ? `${c.endpoint.host}${c.endpoint.port ? ':' + c.endpoint.port : ''}` : (c.url || c.tech);
    L.push(`  CTX->>+C${i}: ${c.type === 'database' ? 'open pool' : c.type === 'broker' ? 'create client' : 'configure'} ${t(target)}`);
    L.push(`  C${i}-->>-CTX: ready`);
  });
  if (r.startup.find((p) => p.id === 'connections')?.items.some((i) => /Flyway|Liquibase|SQL init/.test(i.label)) && conns.some((c) => c.type === 'database')) {
    const db = conns.findIndex((c) => c.type === 'database');
    L.push(`  CTX->>C${db}: run migrations / schema init`);
  }
  if (r.postConstructs.length) L.push(`  CTX->>CTX: @PostConstruct ${t(r.postConstructs.slice(0, 3).map((p) => p.className + '.' + p.method).join(', '))}`);
  if (hasWeb) {
    L.push(`  CTX->>+WEB: start on :${t(r.config.server.port)}${t(r.config.server.contextPath)}`);
    if (r.security.configs.length) L.push(`  Note over WEB: SecurityFilterChain: ${t(r.security.features.slice(0, 3).join(', ') || 'custom')}`);
    L.push(`  WEB-->>-CTX: ${r.endpoints.length} mappings registered`);
  }
  for (const x of r.runners.slice(0, 4)) L.push(`  CTX->>CTX: ${t(x.kind)} ${t(x.className)}.run()`);
  if (r.listeners.length) L.push(`  CTX->>CTX: start ${r.listeners.length} listener container(s)`);
  if (r.scheduled.length) L.push(`  CTX->>CTX: schedule ${r.scheduled.length} job(s)`);
  L.push('  CTX-->>SA: ApplicationReadyEvent');
  L.push(`  SA-->>JVM: started ✔`);
  return L.join('\n');
}
