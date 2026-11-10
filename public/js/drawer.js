import { h, $, esc, short, STEREO, CONN, stereoBadge, badge, methodBadge, highlight, langOf } from './ui.js';

const sourceCache = new Map();

export function closeDrawer() { const d = $('#drawer'); d.classList.remove('open'); d.replaceChildren(); }

function shell(title, sub, ...body) {
  const d = $('#drawer');
  d.replaceChildren(
    h('div.drawer-head', h('div', h('div.drawer-title', title), sub ? h('div.drawer-sub', sub) : null), h('button.icon', { title: 'Close (Esc)', onclick: closeDrawer }, '✕')),
    h('div.drawer-body', body),
  );
  d.classList.add('open');
  return d;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

export function openRef(report, ref, ctx) {
  if (!ref) return;
  if (ref.type === 'class') return showClass(report, ref.id, ctx, ref.line);
  if (ref.type === 'file') return showFile(report, ref.file, ref.line);
  if (ref.type === 'connection') return showConnection(report, ref.id, ctx);
  if (ref.type === 'view') return ctx.go(ref.id);
  if (ref.type === 'layer') return ctx.go('classes', { stereotype: ref.id });
  if (ref.type === 'dependency') return ctx.go('overview');
}

function section(title, ...content) {
  const items = content.flat().filter(Boolean);
  if (!items.length) return null;
  return h('section.dsec', h('h4', title), items);
}

const link = (label, fn) => h('a.lnk', { href: '#', onclick: (e) => { e.preventDefault(); fn(); } }, label);

export function showClass(report, id, ctx, line) {
  const c = report.classes.find((x) => x.id === id);
  if (!c) return;
  const usedBy = report.classes.filter((x) => x.deps.some((d) => d.target === id));
  const eps = report.endpoints.filter((e) => e.controller === id);
  const flows = report.flows.filter((f) => f.tree.class === id || JSON.stringify(f.tree).includes(`"class":"${id}"`)).slice(0, 30);
  const entity = report.entities.find((e) => e.id === id);
  const props = report.propertyUsages.filter((p) => p.class === id);
  const beanDefs = report.beanDefs.filter((b) => b.config === id);
  const st = STEREO[c.stereotype] || STEREO.other;
  shell(
    h('span', h('span.dicon', { style: { color: st.color } }, st.icon), ' ', c.name),
    h('span', stereoBadge(c.stereotype), ' ', c.kind !== 'class' ? badge(c.kind) : null, ' ', h('span.mono.muted', c.pkg)),
    c.registeredBy ? h('div.note', `Registered as a bean by ${c.registeredBy}`) : null,
    !c.isBean && ['model', 'entity', 'other', 'exception'].includes(c.stereotype) ? null : null,
    section('Annotations', h('div.chips', c.annotations.map((a) => h('code.chip', `@${a.name}${a.raw ? '(' + a.raw + ')' : ''}`)))),
    (c.extends.length || c.implements.length) ? section('Type hierarchy', h('div.mono.small', c.extends.length ? `extends ${c.extends.join(', ')}` : '', c.implements.length ? ` implements ${c.implements.join(', ')}` : '')) : null,
    section('Injected dependencies', c.injections.map((d) => {
      const target = c.deps.find((x) => x.field === d.name);
      return h('div.drow', h('span.mono', d.type), ' ', h('span.muted', d.name), ' ', badge(d.via), d.qualifier ? badge('@Qualifier ' + d.qualifier) : null, d.value ? h('code.small', d.value) : null,
        target ? h('span', ' → ', link(short(target.target), () => showClass(report, target.target, ctx)), target.through ? h('span.muted', ` (via ${target.through})`) : null) : null);
    })),
    section('Infrastructure used', c.infra.map((i) => h('div.drow', badge(i.tech, '#0ea5e9'), ' ', h('span.mono', `${i.type} ${i.field}`)))),
    section(`Used by (${usedBy.length})`, h('div.chips', usedBy.map((u) => h('button.chip', { onclick: () => showClass(report, u.id, ctx), style: { '--c': STEREO[u.stereotype]?.color } }, u.name)))),
    c.entity ? section('Repository', h('div', 'Manages ', link(short(c.entity), () => showClass(report, c.entity, ctx)), c.idType ? ` with id ${c.idType}` : '', c.repoBase ? h('span.muted', ` · extends ${c.repoBase}`) : null)) : null,
    entity ? section('Entity', h('div', `Table/collection: `, h('code', entity.table)), h('table.mini', entity.fields.map((f) => h('tr', h('td.mono', f.id ? '🔑 ' + f.name : f.name), h('td.mono.muted', f.type), h('td', f.relation ? badge(`${f.relation.type} → ${f.relation.targetName}`, '#8b5cf6') : f.column ? h('code.small', f.column) : ''))))) : null,
    section(`Endpoints (${eps.length})`, eps.map((e) => h('div.drow.clickable', { onclick: () => ctx.go('flows', { id: e.id }) }, methodBadge(e.method), ' ', h('span.mono', e.path), h('span.muted', ` → ${e.handler}()`)))),
    section('@Bean definitions', beanDefs.map((b) => h('div.drow', h('span.mono', `${b.typeName} ${b.name}()`), b.conditions.length ? h('span.muted.small', ' ' + b.conditions.join(' ')) : null))),
    section('Properties read', props.map((p) => h('div.drow.clickable', { onclick: () => ctx.go('config', { q: p.key.replace(/\.\*$/, '') }) }, h('code', p.key), h('span.muted.small', ` ${p.kind}${p.member ? ' · ' + p.member : ''}${p.default != null ? ' · default ' + p.default : ''}`)))),
    section(`Participates in flows (${flows.length})`, flows.map((f) => h('div.drow.clickable', { onclick: () => ctx.go('flows', { id: f.id }) }, f.method ? methodBadge(f.method) : badge(f.kind), ' ', h('span.mono.small', f.label)))),
    section('Methods', h('div.methods', c.methods.map((m) => h('div.mrow.clickable', { onclick: () => loadSource(report, c.file, m.line, $('#drawer .src')) },
      m.annotations.length ? h('div.ann', m.annotations.join(' ')) : null,
      h('span.mono', h('span.muted', m.returnType + ' '), h('b', m.name), `(${m.params.map((p) => `${p.annotations.join(' ')} ${short(p.type)} ${p.name}`.trim()).join(', ')})`))))),
    section('Source', h('div.muted.small', `${c.file}:${c.line}`), h('div.src')),
  );
  loadSource(report, c.file, line || c.line, $('#drawer .src'));
}

export function showConnection(report, id, ctx) {
  const c = report.config.connections.find((x) => x.id === id);
  if (!c) return;
  const ct = CONN[c.type] || CONN.http;
  const compose = report.infra.compose.flatMap((x) => x.services.map((s) => ({ ...s, file: x.file }))).filter((s) => s.tech && (s.tech === c.tech || (c.tech || '').includes(s.tech)));
  const users = report.classes.filter((x) => (c.type === 'database' && x.dataStore === c.id) || x.infra.some((i) => (c.tech || '').toLowerCase().includes(i.tech.toLowerCase().split(' ')[0])));
  shell(
    h('span', h('span.dicon', ct.icon), ' ', c.name),
    h('span', badge(ct.label, ct.color), ' ', badge(c.tech, ct.color), c.implied ? badge('implied default', '#94a3b8') : null),
    c.note ? h('div.note', c.note) : null,
    section('Endpoint', h('div.mono', c.url || '—'), c.endpoint ? h('div.kv', Object.entries(c.endpoint).filter(([, v]) => v).map(([k, v]) => h('span', h('b', k + ': '), String(v)))) : null),
    section('Profiles', Object.keys(c.variants || { default: 1 }).length > 1 || c.profiles[0] !== 'default'
      ? (c.variants ? Object.entries(c.variants).map(([p, v]) => h('div.drow', badge(p, '#6db33f'), ' ', h('span.mono', v.url || ''), v.username ? h('span.muted', ` user: ${v.username}`) : null)) : null)
      : h('div.muted', 'Same in all profiles')),
    section('Properties', h('table.mini', Object.entries(c.props || {}).map(([k, v]) => h('tr.clickable', { onclick: () => showFile(report, v.file, v.line) }, h('td.mono', k), h('td.mono', v.value), v.resolved !== v.value ? h('td.mono.muted', '→ ' + v.resolved) : h('td'))))),
    section('Used by', h('div.chips', users.map((u) => h('button.chip', { onclick: () => showClass(report, u.id, ctx), style: { '--c': STEREO[u.stereotype]?.color } }, u.name)))),
    section('Runs locally via docker-compose', compose.map((s) => h('div.drow', h('b', s.name), ' ', h('span.mono', s.image || ''), ' ', s.ports.map((p) => badge(p)), h('span.muted.small', ' ' + s.file)))),
  );
}

export function showFile(report, file, line) {
  shell(h('span', '📄 ', file.split('/').pop()), h('span.mono.muted', file), h('div.src'));
  loadSource(report, file, line, $('#drawer .src'));
}

async function loadSource(report, file, line, box) {
  if (!box) return;
  box.replaceChildren(h('div.muted', 'Loading source…'));
  try {
    const key = report.id + '|' + file;
    if (!sourceCache.has(key)) {
      const r = await fetch(`/api/projects/${report.id}/source?file=${encodeURIComponent(file)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      sourceCache.set(key, j.text);
    }
    const text = sourceCache.get(key);
    const lines = highlight(text, langOf(file)).split('\n');
    const pre = h('pre.code.numbered', { html: lines.map((l, i) => `<span class="ln${i + 1 === line ? ' hl' : ''}" data-n="${i + 1}">${l || ' '}</span>`).join('\n') });
    box.replaceChildren(pre);
    if (line) { const el = pre.querySelector(`[data-n="${line}"]`); if (el) setTimeout(() => { pre.scrollTop = Math.max(0, el.offsetTop - pre.clientHeight / 3); }, 30); }
  } catch (e) {
    box.replaceChildren(h('div.muted', esc(e.message)));
  }
}
