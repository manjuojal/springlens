import { h, badge, tabs, empty, debounce, highlight, langOf } from '../ui.js';

export function render(ctx) {
  const { report: r, el, params } = ctx;
  const cfg = r.config;
  let tab = params.get('tab') || 'tree';
  // start on the profile activated by spring.profiles.active (what actually runs by default)
  let profile = params.get('profile') || cfg.activeProfiles.find((p) => cfg.profiles.includes(p)) || 'default';
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  el.append(h('div.vhead',
    h('div', h('h2', 'Configuration'), h('p', `${cfg.files.length} config document(s) · profiles: ${cfg.profiles.join(', ')}${cfg.activeProfiles.length ? ` · active by default: ${cfg.activeProfiles.join(', ')}` : ''} · ${cfg.envVars.length} environment variable(s) referenced`)),
    h('span.spacer'),
    tabs([['tree', 'Effective properties'], ['compare', 'Profile comparison'], ['env', `Env variables (${cfg.envVars.length})`], ['usage', `Used in code (${r.propertyUsages.length})`], ['files', 'Files']], tab, (t) => { tab = t; ctx.setParam('tab', t); show(); }),
  ), body);

  const usageFor = (key) => r.propertyUsages.filter((u) => u.key === key || (u.key.endsWith('.*') && key.startsWith(u.key.slice(0, -1))));

  function show() {
    body.replaceChildren();
    if (!cfg.files.length && tab !== 'usage') { body.append(empty('No application.yml / application.properties found')); return; }
    ({ tree, compare, env, usage, files })[tab]();
  }

  function tree() {
    const q = h('input.search', { type: 'search', placeholder: 'Search keys or values…', value: params.get('q') || '', style: { width: '300px' } });
    const psel = h('select', { onchange: () => { profile = psel.value; ctx.setParam('profile', profile); fill(); } }, cfg.profiles.map((p) => h('option', { value: p, selected: p === profile }, p === 'default' ? 'default (no profile)' : `profile: ${p}`)));
    const showResolved = h('input', { type: 'checkbox', checked: true });
    const out = h('div.card.ptree', { style: { overflow: 'auto' } });
    body.append(h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, psel, q, h('label.chk', showResolved, 'show resolved values'), h('span.muted.small', 'Profile-specific values override defaults; placeholders like ${DB_URL:default} are resolved.')), out);
    const fill = () => {
      const s = q.value.trim().toLowerCase();
      const props = (cfg.effective[profile] || []).filter((p) => !s || p.key.toLowerCase().includes(s) || String(p.resolved).toLowerCase().includes(s));
      out.replaceChildren(props.length ? buildTree(props, !!s) : h('div.muted', 'No properties.'));
    };
    const buildTree = (props, open) => {
      const rootNode = { children: new Map(), props: [] };
      for (const p of props) {
        const segs = p.key.split('.');
        let n = rootNode;
        for (const seg of segs.slice(0, -1)) { if (!n.children.has(seg)) n.children.set(seg, { children: new Map(), props: [] }); n = n.children.get(seg); }
        n.props.push({ ...p, leaf: segs[segs.length - 1] });
      }
      const renderNode = (n, depth) => {
        const out2 = [];
        for (const [k, c] of n.children) {
          // collapse single-child chains: spring.datasource
          let key = k; let node = c;
          while (node.children.size === 1 && !node.props.length) { const [k2, c2] = [...node.children][0]; key += '.' + k2; node = c2; }
          const count = countLeaves(node);
          out2.push(h('details', { open: open || depth < 1 || count <= 4 }, h('summary', h('span.k', key), h('span.muted', `  (${count})`)), h('div', renderNode(node, depth + 1))));
        }
        for (const p of n.props) {
          const uses = usageFor(p.key);
          const differs = showResolved.checked && p.resolved !== p.value;
          out2.push(h('div.prow',
            h('span.k', p.leaf), h('span.muted', '='), h('span.v', p.value || '""'),
            differs ? h('span.r', `→ ${p.resolved}`) : null,
            p.from !== 'default' ? badge(p.from, '#6db33f') : null,
            p.overridden ? badge('overrides default', '#d97706') : null,
            ...uses.slice(0, 3).map((u) => h('button.chip', { style: { padding: '0 6px', fontSize: '11px' }, title: `${u.kind} in ${u.className}${u.member ? '.' + u.member : ''}`, onclick: () => ctx.open({ type: 'class', id: u.class, line: u.line }) }, `↳ ${u.className}`)),
            h('span.src', { title: 'Open file', onclick: () => ctx.open({ type: 'file', file: p.file, line: p.line }) }, `${p.file.split('/').pop()}:${p.line}`),
          ));
        }
        return out2;
      };
      return h('div', renderNode(rootNode, 0));
    };
    q.addEventListener('input', debounce(fill, 150));
    showResolved.addEventListener('change', fill);
    fill();
  }

  function compare() {
    const profs = cfg.profiles;
    const keys = new Set(profs.flatMap((p) => cfg.effective[p].map((x) => x.key)));
    const val = (p, k) => cfg.effective[p].find((x) => x.key === k);
    const onlyDiff = h('input', { type: 'checkbox', checked: true });
    const q = h('input.search', { type: 'search', placeholder: 'Filter keys…' });
    const tbody = h('tbody');
    const fill = () => {
      tbody.replaceChildren();
      const s = q.value.trim().toLowerCase();
      for (const k of [...keys].sort()) {
        if (s && !k.toLowerCase().includes(s)) continue;
        const vals = profs.map((p) => val(p, k)?.resolved);
        if (onlyDiff.checked && vals.every((v) => v === vals[0])) continue;
        tbody.append(h('tr', h('td.mono.small', k), profs.map((p, i) => { const v = val(p, k); return h('td.mono.small' + (i > 0 && vals[i] !== vals[0] ? '.warn-text' : ''), { title: v ? `${v.file}:${v.line}` : 'not set' }, v ? v.resolved : h('span.muted', '—')); })));
      }
      if (!tbody.children.length) tbody.append(h('tr', h('td', { colspan: profs.length + 1 }, h('span.muted', 'No differences between profiles.'))));
    };
    onlyDiff.addEventListener('change', fill); q.addEventListener('input', debounce(fill, 150));
    body.append(h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, q, h('label.chk', onlyDiff, 'only keys that differ')),
      h('div.card', { style: { padding: 0, overflow: 'auto' } }, h('table.tbl', h('thead', h('tr', h('th', 'Property'), profs.map((p) => h('th', p)))), tbody)));
    fill();
  }

  function env() {
    if (!cfg.envVars.length) { body.append(empty('No environment variable placeholders', 'Properties like ${DB_PASSWORD} that are not defined in any config file appear here.')); return; }
    body.append(h('div.card', { style: { padding: 0 } }, h('table.tbl', h('thead', h('tr', ['Variable', 'Default', 'Used by property', 'Where'].map((x) => h('th', x)))),
      h('tbody', cfg.envVars.map((e) => h('tr', h('td.mono', h('b', e.name)), h('td.mono', e.default != null ? e.default || '""' : badge('required', '#dc2626')),
        h('td.mono.small', e.usedBy.map((u) => h('div', u.key, u.profile !== 'default' ? badge(u.profile, '#6db33f') : null))),
        h('td.small', e.usedBy.map((u) => h('div.clickable.muted', { onclick: () => ctx.open({ type: 'file', file: u.file, line: u.line }) }, `${u.file.split('/').pop()}:${u.line}`)))))))),
    h('div.card', h('h3', 'Sample .env'), h('pre.code', cfg.envVars.map((e) => `${e.name}=${e.default ?? ''}`).join('\n'))));
  }

  function usage() {
    if (!r.propertyUsages.length) { body.append(empty('No @Value / @ConfigurationProperties / Environment usages found')); return; }
    const defined = new Set(Object.values(cfg.effective).flat().map((p) => p.key));
    body.append(h('div.card', { style: { padding: 0 } }, h('table.tbl', h('thead', h('tr', ['Property', 'Mechanism', 'Class / member', 'Default in code', 'Defined in config'].map((x) => h('th', x)))),
      h('tbody', r.propertyUsages.map((u) => {
        const isPrefix = u.key.endsWith('.*');
        const def = isPrefix ? [...defined].some((k) => k.startsWith(u.key.slice(0, -1))) : defined.has(u.key);
        return h('tr.clickable', { onclick: () => ctx.open({ type: 'class', id: u.class, line: u.line }) },
          h('td.mono', u.key), h('td', badge(u.kind)), h('td.mono.small', `${u.className}${u.member ? '.' + u.member : ''}`), h('td.mono.small', u.default ?? ''),
          h('td', def ? badge('✓ yes', '#10b981') : u.default != null ? badge('uses default', '#64748b') : u.kind === 'PropertySource' ? '' : badge('missing!', '#dc2626')));
      })))));
  }

  function files() {
    const seenFiles = [...new Set(cfg.files.map((f) => f.file))];
    const viewer = h('div');
    const sel = h('select', { onchange: () => load(sel.value) }, seenFiles.map((f) => h('option', { value: f }, f)));
    body.append(h('div', sel), viewer);
    const load = async (file) => {
      viewer.replaceChildren(h('div.muted', 'Loading…'));
      try {
        const j = await ctx.api.get(`/api/projects/${r.id}/source?file=${encodeURIComponent(file)}`);
        const lines = highlight(j.text, langOf(file)).split('\n');
        viewer.replaceChildren(h('pre.code.numbered', { style: { maxHeight: 'none' }, html: lines.map((l, i) => `<span class="ln" data-n="${i + 1}">${l || ' '}</span>`).join('\n') }));
      } catch (e) { viewer.replaceChildren(h('div.error', e.message)); }
    };
    if (seenFiles[0]) load(seenFiles[0]);
  }

  show();
}

function countLeaves(n) { let c = n.props.length; for (const x of n.children.values()) c += countLeaves(x); return c; }
