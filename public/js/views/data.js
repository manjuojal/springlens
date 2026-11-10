import { h, badge, empty, short, STEREO, CONN, tabs } from '../ui.js';
import { renderMermaid, mermaidToolbar, createGraph, mmd } from '../graph.js';

export async function render(ctx) {
  const { report: r, el, params } = ctx;
  const sql = r.sqlTables || [];
  el.append(h('div.vhead', h('div', h('h2', 'Data model'), h('p', `${r.entities.length} persistent entities with their columns and JPA relationships${sql.length ? `, and ${sql.length} table(s) referenced directly in SQL (JDBC / native queries)` : ''}.`))));
  const sqlSection = () => (sql.length ? h('div.card', h('h3', `🗃️ Tables used in SQL (${sql.length})`),
    h('div.small.muted', { style: { marginBottom: '8px' } }, 'Found in JdbcTemplate / JDBC strings, SQL constants and @Query(nativeQuery = true). Click a usage to open the code.'),
    h('table.tbl', h('thead', h('tr', ['Table', 'Operations', 'Used by', 'Example'].map((x) => h('th', x)))),
      h('tbody', sql.map((tb) => h('tr',
        h('td.mono', h('b', tb.table)), h('td', tb.ops.map((o) => badge(o, o === 'SELECT' ? '#0ea5e9' : o === 'DELETE' ? '#dc2626' : '#f59e0b'))),
        h('td.small', tb.usedBy.map((u) => h('div', h('a.lnk', { href: '#', onclick: (e) => { e.preventDefault(); ctx.open({ type: 'class', id: u.class, line: u.line }); } }, `${u.className}.${u.member}${/^[a-z]/.test(u.member) ? '()' : ''}`)))),
        h('td.mono.small.muted', (tb.usedBy[0]?.sample || '').slice(0, 110))))))) : null);
  if (!r.entities.length) {
    el.append(sql.length ? sqlSection() : empty('No @Entity / @Document classes and no SQL table references found', 'This service may not access a database directly (e.g. it calls other services that own the data).'));
    return;
  }
  el.append(sqlSection());
  let mode = params.get('mode') || 'er';
  let graph = null;
  const host = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  el.append(h('div', tabs([['er', 'ER diagram'], ['graph', 'Interactive graph']], mode, (m) => { mode = m; ctx.setParam('mode', m); show(); })), host);

  async function show() {
    if (graph) { graph.destroy(); graph = null; }
    host.replaceChildren();
    if (mode === 'er') {
      const diag = h('div.mmd', { style: { height: '560px', flex: 'none' } });
      host.append(h('div.diagram-card', mermaidToolbar(diag, 'er-diagram'), diag));
      await renderMermaid(diag, er(r), {
        onReady: (svg) => {
          if (!svg) return;
          for (const e of r.entities) {
            const g = svg.querySelector(`[id^="entity-${mmd.id(e.name)}-"]`) || [...svg.querySelectorAll('g')].find((x) => x.id && x.id.includes(`-${mmd.id(e.name)}-`));
            if (g) { g.style.cursor = 'pointer'; g.addEventListener('click', (ev) => { ev.stopPropagation(); ctx.open({ type: 'class', id: e.id }); }); }
          }
        },
      });
    } else {
      const box = h('div', { style: { height: '560px', display: 'flex', flex: 'none' } });
      host.append(box);
      graph = createGraph(box, { elements: graphEls(r), layout: 'dagre-lr', title: 'entities', onSelect: (d) => d.cls && ctx.open({ type: 'class', id: d.cls }), legend: [['Entity', STEREO.entity.color], ['Repository', STEREO.repository.color], ['Database', CONN.database.color]] });
    }
    host.append(h('div.grid.g3', r.entities.map((e) => h('div.card', { style: { borderTop: `3px solid ${STEREO.entity.color}` } },
      h('div.flow-meta', h('a.lnk', { href: '#', onclick: (ev) => { ev.preventDefault(); ctx.open({ type: 'class', id: e.id }); } }, `📦 ${e.name}`), badge(`${e.kind}: ${e.table}`, STEREO.entity.color)),
      e.repositories.length ? h('div.small.muted', { style: { margin: '4px 0' } }, 'managed by ', e.repositories.map((x) => h('a.lnk', { href: '#', onclick: (ev) => { ev.preventDefault(); ctx.open({ type: 'class', id: x }); } }, short(x) + ' '))) : h('div.small.warn-text', 'no repository'),
      h('table.mini', e.fields.map((f) => h('tr', h('td.mono', f.id ? '🔑 ' : '', f.name, f.inherited ? h('span.muted', ` ↑${f.inherited}`) : null), h('td.mono.muted', short(f.type)), h('td.small', f.relation ? badge(`${f.relation.type} → ${f.relation.targetName}${f.relation.mappedBy ? ' (mappedBy ' + f.relation.mappedBy + ')' : ''}`, STEREO.entity.color) : null, f.column ? h('code', f.column) : null, f.unique ? badge('unique') : null, !f.nullable ? badge('not null') : null, f.validation.length ? h('span.muted', ' ' + f.validation.join(' ')) : null)))),
    ))));
  }
  await show();
  return () => graph && graph.destroy();
}

function er(r) {
  const L = ['erDiagram'];
  const name = (e) => mmd.id(e.name);
  const known = new Set(r.entities.map((e) => e.id));
  const added = new Set();
  for (const e of r.entities) {
    L.push(`  ${name(e)} {`);
    for (const f of e.fields) {
      if (f.relation && f.relation.type !== 'ManyToOne' && f.relation.type !== 'OneToOne') continue;
      const type = mmd.id(short(f.relation ? f.relation.targetName : f.typeName || f.type).replace(/<.*$/, '')) || 'Object';
      const key = f.id ? ' PK' : f.relation ? ' FK' : f.unique ? ' UK' : '';
      const col = f.relation ? f.relation.joinColumn || f.name + '_id' : f.column || f.name;
      L.push(`    ${type} ${mmd.id(col)}${key}${f.relation ? ` "→ ${mmd.text(f.relation.targetName)}"` : !f.nullable ? ' "not null"' : ''}`);
    }
    L.push('  }');
  }
  for (const e of r.entities) for (const f of e.fields) {
    const rel = f.relation;
    if (!rel || !known.has(rel.target)) continue;
    const t = r.entities.find((x) => x.id === rel.target);
    const pair = [e.id, t.id].sort().join('|') + '|' + (rel.mappedBy || f.name);
    // skip the inverse side when the owning side is present
    if (rel.mappedBy && t.fields.some((tf) => tf.name === rel.mappedBy && tf.relation)) continue;
    if (added.has(pair)) continue; added.add(pair);
    const card = { OneToMany: '||--o{', ManyToOne: '}o--||', OneToOne: '||--||', ManyToMany: '}o--o{' }[rel.type] || '||--o{';
    L.push(`  ${name(e)} ${card} ${name(t)} : "${mmd.text(f.name)}"`);
  }
  return L.join('\n');
}

function graphEls(r) {
  const nodes = []; const edges = [];
  for (const e of r.entities) nodes.push({ data: { id: e.id, label: `📦 ${e.name}`, sub: e.table, color: STEREO.entity.color, cls: e.id } });
  for (const e of r.entities) for (const f of e.fields) if (f.relation && r.entities.some((x) => x.id === f.relation.target)) edges.push({ data: { id: `${e.id}.${f.name}`, source: e.id, target: f.relation.target, label: `${f.name} (${f.relation.type})`, color: STEREO.entity.color }, classes: f.relation.mappedBy ? 'dotted' : '' });
  for (const c of r.classes.filter((x) => x.stereotype === 'repository' && x.entity && r.entities.some((e) => e.id === x.entity))) {
    nodes.push({ data: { id: c.id, label: `🗄️ ${c.name}`, sub: c.repoBase || '', color: STEREO.repository.color, cls: c.id } });
    edges.push({ data: { id: c.id + '>', source: c.id, target: c.entity, label: 'manages', color: STEREO.repository.color }, classes: 'dashed' });
    if (c.dataStore) {
      const conn = r.config.connections.find((x) => x.id === c.dataStore);
      if (conn && !nodes.some((n) => n.data.id === 'db:' + conn.id)) nodes.push({ data: { id: 'db:' + conn.id, label: `🛢️ ${conn.tech}`, sub: conn.name, color: CONN.database.color }, classes: 'db' });
      if (conn) edges.push({ data: { id: c.id + '>db', source: c.id, target: 'db:' + conn.id, color: CONN.database.color } });
    }
  }
  return [...nodes, ...edges];
}
