import { h, STEREO, stereoBadge, debounce } from '../ui.js';

export function render(ctx) {
  const { report: r, el, params } = ctx;
  el.append(h('div.vhead', h('div', h('h2', 'Classes & beans'), h('p', `${r.classes.length} types, ${r.classes.filter((c) => c.isBean).length} Spring beans and ${r.beanDefs.length} @Bean factory methods.`))));
  const q = h('input.search', { type: 'search', placeholder: 'Search classes…', style: { width: '280px' }, value: params.get('q') || '' });
  const st = h('select', h('option', { value: '' }, 'All stereotypes'), Object.keys(STEREO).filter((k) => r.classes.some((c) => c.stereotype === k)).map((k) => h('option', { value: k, selected: params.get('stereotype') === k }, `${STEREO[k].label} (${r.classes.filter((c) => c.stereotype === k).length})`)));
  const beansOnly = h('input', { type: 'checkbox' });
  const tbody = h('tbody');
  el.append(h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, q, st, h('label.chk', beansOnly, 'beans only')),
    h('div.card', { style: { padding: 0 } }, h('table.tbl', h('thead', h('tr', ['Class', 'Stereotype', 'Package', 'Injects', 'Used by', 'Annotations'].map((x) => h('th', x)))), tbody)));
  const usedBy = new Map();
  for (const c of r.classes) for (const d of c.deps) usedBy.set(d.target, (usedBy.get(d.target) || 0) + 1);
  const fill = () => {
    const s = q.value.trim().toLowerCase();
    ctx.setParam('stereotype', st.value || null);
    tbody.replaceChildren(...r.classes
      .filter((c) => (!st.value || c.stereotype === st.value) && (!beansOnly.checked || c.isBean) && (!s || `${c.name} ${c.pkg} ${c.annotations.map((a) => a.name).join(' ')}`.toLowerCase().includes(s)))
      .sort((a, b) => a.stereotype.localeCompare(b.stereotype) || a.name.localeCompare(b.name))
      .map((c) => h('tr.clickable', { onclick: () => ctx.open({ type: 'class', id: c.id }) },
        h('td', h('b', `${STEREO[c.stereotype]?.icon || ''} ${c.name}`), c.kind !== 'class' ? h('span.muted.small', ` ${c.kind}`) : null),
        h('td', stereoBadge(c.stereotype)), h('td.mono.small.muted', c.pkg), h('td', c.deps.length || ''), h('td', usedBy.get(c.id) || ''),
        h('td.mono.small.muted', c.annotations.map((a) => '@' + a.name).join(' ')))));
  };
  q.addEventListener('input', debounce(fill, 120)); st.addEventListener('change', fill); beansOnly.addEventListener('change', fill);
  fill();
}
