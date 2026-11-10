import { h, badge, empty, STEREO, CONN } from '../ui.js';
import { createGraph } from '../graph.js';

export function render(ctx) {
  const { report: r, el } = ctx;
  el.append(h('div.vhead', h('div', h('h2', 'Messaging, events & jobs'), h('p', 'Who publishes to which topic/queue/event and who consumes it, plus scheduled jobs, async methods and startup runners. Click a node to open it, or a row to see its flow.'))));
  const pubs = r.messaging.publishers; const subs = r.listeners;
  const hasTopo = pubs.length || subs.length || r.eventListeners.length;
  let g = null;
  if (hasTopo) {
    const box = h('div', { style: { height: '480px', display: 'flex', flex: 'none' } });
    el.append(box);
    const nodes = new Map(); const edges = [];
    const node = (id, data, classes = '') => { if (!nodes.has(id)) nodes.set(id, { data: { id, ...data }, classes }); return id; };
    const cls = (id, name) => { const c = r.classes.find((x) => x.id === id); return node(id, { label: name, color: STEREO[c?.stereotype]?.color || '#888', cls: id }); };
    for (const p of pubs) {
      const tid = node(`t:${p.tech}:${p.destination}`, { label: `${p.tech === 'Spring Events' ? '⚡' : '📨'} ${p.destination}`, sub: p.tech, color: p.tech === 'Spring Events' ? '#eab308' : CONN.broker.color }, 'topic');
      edges.push({ data: { id: `p:${p.class}:${p.method}:${tid}`, source: cls(p.class, p.className), target: tid, label: `${p.method}()` }, classes: 'async' });
    }
    for (const l of subs) for (const d of l.destinations) {
      const tid = node(`t:${l.tech === 'Cloud Stream' ? 'Cloud Stream' : l.tech}:${d}`, { label: `📨 ${d}`, sub: l.tech, color: CONN.broker.color }, 'topic');
      edges.push({ data: { id: `s:${tid}:${l.class}:${l.method}`, source: tid, target: cls(l.class, l.className), label: `${l.method}()${l.group ? ' [' + l.group + ']' : ''}`, flow: `listener:${l.class}#${l.method}` }, classes: 'async' });
    }
    for (const e of r.eventListeners) {
      if (!e.event) continue;
      const tid = node(`t:Spring Events:${e.event}`, { label: `⚡ ${e.event}`, sub: 'Spring Events', color: '#eab308' }, 'topic');
      edges.push({ data: { id: `ev:${tid}:${e.class}:${e.method}`, source: tid, target: cls(e.class, e.className), label: `${e.method}()${e.async ? ' async' : ''}` }, classes: 'async' });
    }
    g = createGraph(box, { elements: [...nodes.values(), ...edges], layout: 'dagre-lr', title: 'messaging', onSelect: (d) => d.cls && ctx.open({ type: 'class', id: d.cls }), onEdge: (d) => d.flow && ctx.go('flows', { id: d.flow }), legend: [['Topic / queue', CONN.broker.color], ['Application event', '#eab308'], ['Listener', STEREO.listener.color], ['Service', STEREO.service.color]] });
  } else el.append(empty('No messaging detected', 'No Kafka/Rabbit/JMS listeners, template sends, or Spring application events found.'));

  const table = (title, cols, rows) => (rows.length ? h('div.card', { style: { padding: 0 } }, h('div', { style: { padding: '12px 14px 0' } }, h('h3', title)), h('table.tbl', h('thead', h('tr', cols.map((c) => h('th', c)))), h('tbody', rows))) : null);
  el.append(
    table('Message listeners', ['Tech', 'Destination', 'Handler', 'Group / payload'], subs.map((l) => h('tr.clickable', { onclick: () => ctx.go('flows', { id: `listener:${l.class}#${l.method}` }) }, h('td', badge(l.tech, CONN.broker.color)), h('td.mono', l.destinations.join(', ')), h('td.mono.small', `${l.className}.${l.method}()`), h('td.small.muted', [l.group, l.payload].filter(Boolean).join(' · '))))),
    table('Publishers', ['Tech', 'Destination', 'From'], pubs.map((p) => h('tr.clickable', { onclick: () => ctx.open({ type: 'class', id: p.class, line: p.line }) }, h('td', badge(p.tech, p.tech === 'Spring Events' ? '#eab308' : CONN.broker.color)), h('td.mono', p.destination), h('td.mono.small', `${p.className}.${p.method}()`)))),
    table('Scheduled jobs', ['Job', 'Schedule', 'Description'], r.scheduled.map((s) => h('tr.clickable', { onclick: () => ctx.go('flows', { id: `scheduled:${s.class}#${s.method}` }) }, h('td.mono.small', `${s.className}.${s.method}()`), h('td.mono', s.cron ? `cron ${s.cron}` : s.fixedRate ? `fixedRate ${s.fixedRate}` : `fixedDelay ${s.fixedDelay}`, s.initialDelay ? h('div.muted.small', `initial delay ${s.initialDelay}`) : null), h('td.small', describeCron(s))))),
    table('Event listeners', ['Event', 'Listener', 'Mode'], r.eventListeners.map((e) => h('tr.clickable', { onclick: () => ctx.go('flows', { id: `event:${e.class}#${e.method}` }) }, h('td.mono', e.event || '?'), h('td.mono.small', `${e.className}.${e.method}()`), h('td', e.async ? badge('async', '#eab308') : null, e.transactional ? badge(`tx ${e.phase || 'AFTER_COMMIT'}`, '#8b5cf6') : null, e.condition ? h('code.small', e.condition) : null)))),
    table('@Async methods', ['Method', 'Executor'], r.asyncMethods.map((a) => h('tr.clickable', { onclick: () => ctx.open({ type: 'class', id: a.class, line: a.line }) }, h('td.mono.small', `${a.className}.${a.method}()`), h('td.mono', a.executor || 'default')))),
    table('Startup runners', ['Runner', 'Kind'], r.runners.map((x) => h('tr.clickable', { onclick: () => ctx.go('flows', { id: `runner:${x.class}#${x.method}` }) }, h('td.mono.small', `${x.className}.${x.method}()`), h('td', badge(x.kind))))),
    table('Caching', ['Method', 'Operation', 'Cache', 'Key'], r.caches.map((c) => h('tr.clickable', { onclick: () => ctx.open({ type: 'class', id: c.class, line: c.line }) }, h('td.mono.small', `${c.className}.${c.method}()`), h('td', badge('@' + c.op, '#ef4444')), h('td.mono', c.cache || ''), h('td.mono.small', c.key || '')))),
  );
  return () => g && g.destroy();
}

function describeCron(s) {
  if (!s.cron) return s.fixedRate ? `Runs every ${fmtMs(s.fixedRate)}` : s.fixedDelay ? `Runs ${fmtMs(s.fixedDelay)} after the previous run finishes` : '';
  if (/^\$\{/.test(s.cron)) return 'Configured via property';
  const p = s.cron.trim().split(/\s+/);
  if (p.length < 6) return '';
  const [sec, min, hour, dom, mon, dow] = p;
  if (sec === '0' && /^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && (dow === '*' || dow === '?')) return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (sec === '0' && min.startsWith('*/') && hour === '*') return `Every ${min.slice(2)} minutes`;
  if (sec === '0' && min === '0' && hour.startsWith('*/')) return `Every ${hour.slice(2)} hours`;
  if (sec.startsWith('*/')) return `Every ${sec.slice(2)} seconds`;
  if (sec === '0' && /^\d+$/.test(min) && hour === '*') return `Hourly at minute ${min}`;
  return '';
}
function fmtMs(v) { const n = Number(v); if (!Number.isFinite(n)) return v; return n >= 3600000 ? `${n / 3600000} h` : n >= 60000 ? `${n / 60000} min` : n >= 1000 ? `${n / 1000} s` : `${n} ms`; }
