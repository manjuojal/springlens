import { h, $, badge, methodBadge, tabs, toast, empty, short, highlight, STEREO, debounce } from '../ui.js';
import { renderMermaid, mermaidToolbar, mmd } from '../graph.js';

// Kept in memory only (per browser tab) so switching views doesn't lose the log. Never persisted.
const memory = { projectId: null, log: '', fileName: null, id: '', result: null, candidates: null, tab: 'diag' };

const ST = {
  executed: { icon: '✔', color: '#16a34a', label: 'executed (log evidence)' },
  inferred: { icon: '✓', color: '#65a30d', label: 'executed (inferred)' },
  taken: { icon: '◆', color: '#16a34a', label: 'branch taken' },
  'not-taken': { icon: '◇', color: '#94a3b8', label: 'branch not taken' },
  failed: { icon: '✖', color: '#dc2626', label: 'failed here' },
  'not-reached': { icon: '⊘', color: '#94a3b8', label: 'not reached' },
  unknown: { icon: '?', color: '#d97706', label: 'unknown' },
  recovered: { icon: '↺', color: '#d97706', label: 'failed but recovered' },
};
const LEVEL_C = { ERROR: '#dc2626', WARN: '#d97706', INFO: '#2563eb', DEBUG: '#64748b', TRACE: '#94a3b8' };

export function render(ctx) {
  const { report: r, el } = ctx;
  if (memory.projectId !== r.id) Object.assign(memory, { projectId: r.id, log: '', fileName: null, id: '', result: null, candidates: null, tab: 'diag' });

  el.append(h('div.vhead', h('div',
    h('h2', 'Log trace'),
    h('p', 'Paste or upload a log file and enter a correlation / trace id. Spring Lens maps every log line and stack frame to the code, reconstructs which conditions were true or false, which loops and catch blocks ran, where it failed and what was skipped.'),
  )));

  /* ---------------- input ---------------- */
  const ta = h('textarea.logbox', { placeholder: 'Paste log lines here, or drop a .log / .txt / .json file onto this box…', spellcheck: 'false' });
  ta.value = memory.log.length > 400000 ? '' : memory.log;
  const fileInfo = h('span.muted.small', memory.fileName ? `📄 ${memory.fileName} (${fmtSize(memory.log.length)}) loaded` : '');
  if (memory.log.length > 400000) ta.placeholder = `${memory.fileName || 'Large log'} loaded (${fmtSize(memory.log.length)}) — not shown in the editor`;
  const fileInput = h('input', { type: 'file', accept: '.log,.txt,.json,.out,text/*', style: { display: 'none' }, onchange: (e) => e.target.files[0] && loadFile(e.target.files[0]) });
  const idInput = h('input.search', { placeholder: 'Correlation / trace / request id', value: memory.id, style: { flex: 1, minWidth: '260px' } });
  const traceBtn = h('button.primary', { onclick: () => run() }, 'Trace');
  const findBtn = h('button.ghost', { onclick: () => run(true), title: 'List correlation / trace ids found in the log' }, 'Find IDs');
  const sampleBtn = /order-service/.test(r.root) ? h('button.ghost', { onclick: loadSample, title: 'Load samples/order-service/logs/order-service.log' }, 'Load sample log') : null;
  const idsBox = h('div.chips', { style: { marginTop: '8px' } });
  const status = h('span.muted.small');
  ta.addEventListener('input', debounce(() => { memory.log = ta.value; memory.fileName = null; fileInfo.textContent = ''; }, 200));
  idInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  ta.addEventListener('dragover', (e) => { e.preventDefault(); ta.classList.add('drag'); });
  ta.addEventListener('dragleave', () => ta.classList.remove('drag'));
  ta.addEventListener('drop', (e) => { e.preventDefault(); ta.classList.remove('drag'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

  el.append(h('div.card',
    ta,
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' } },
      h('button.ghost', { onclick: () => fileInput.click() }, '📂 Open log file…'), fileInput, sampleBtn, fileInfo,
      h('span.spacer'), h('span.muted.small', '🔒 Processed locally in memory — logs are never saved or sent anywhere'),
    ),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } }, idInput, findBtn, traceBtn, status),
    idsBox,
  ));
  const out = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  el.append(out);

  async function loadFile(f) {
    status.textContent = `Reading ${f.name}…`;
    const text = await f.text();
    memory.log = text; memory.fileName = f.name;
    if (text.length <= 400000) { ta.value = text; ta.placeholder = ''; } else { ta.value = ''; ta.placeholder = `${f.name} loaded (${fmtSize(text.length)}) — not shown in the editor`; }
    fileInfo.textContent = `📄 ${f.name} (${fmtSize(text.length)}) loaded`;
    status.textContent = '';
    if (!idInput.value.trim()) run(true);
  }
  async function loadSample() {
    try {
      const j = await ctx.api.get(`/api/projects/${r.id}/source?file=${encodeURIComponent('logs/order-service.log')}`);
      memory.log = j.text; memory.fileName = 'order-service.log'; ta.value = j.text; fileInfo.textContent = '📄 order-service.log (sample) loaded';
      run(true);
    } catch (e) { toast(e.message, 'err'); }
  }

  async function run(onlyIds) {
    const log = memory.log || ta.value;
    if (!log.trim()) { toast('Paste or open a log file first', 'err'); ta.focus(); return; }
    const id = onlyIds ? '' : idInput.value.trim();
    memory.id = idInput.value.trim();
    traceBtn.disabled = findBtn.disabled = true; status.textContent = onlyIds ? 'Scanning…' : 'Tracing…';
    try {
      const res = await ctx.api.post(`/api/projects/${r.id}/trace`, { log, correlationId: id || null });
      if (res.candidates) { memory.candidates = res.candidates; showIds(); }
      if (id) {
        if (res.error) { toast(res.error, 'err', 6000); memory.result = null; out.replaceChildren(); }
        else { memory.result = res; showResult(); }
      }
      status.textContent = id && !res.error ? `${res.selected} of ${res.totalEntries} entries · ${res.tookMs} ms` : `${res.totalEntries} log entries`;
    } catch (e) { toast(e.message, 'err', 6000); status.textContent = ''; } finally { traceBtn.disabled = findBtn.disabled = false; }
  }

  function showIds() {
    const c = memory.candidates || [];
    idsBox.replaceChildren(c.length ? h('span.muted.small', 'IDs found — click to trace:') : h('span.muted.small', 'No correlation/trace ids detected. Type any text that appears in the lines you want (e.g. an order number).'),
      ...c.slice(0, 24).map((x) => h('button.chip', { title: `${x.count} lines · first ${x.first || '?'} · source: ${x.key}`, style: { '--c': x.errors ? '#dc2626' : '#16a34a' }, onclick: () => { idInput.value = x.id; run(); } },
        h('span.mono', x.id.length > 40 ? x.id.slice(0, 38) + '…' : x.id), h('span.muted', `${x.count}`), x.errors ? badge(`${x.errors} ERROR`, '#dc2626') : null)));
  }

  /* ---------------- result ---------------- */
  function showResult() {
    const res = memory.result;
    out.replaceChildren();
    if (!res) return;
    const mByKey = new Map(res.methods.map((m) => [m.key, m]));
    const openRef = (ref) => { if (!ref) return; const m = mByKey.get(ref.key); if (m) ctx.open({ type: 'class', id: m.cls, line: ref.line }); };
    const o = res.outcome;
    const failed = o.status === 'failed';
    const e = o.error;
    const ep = res.entryPoint;
    const epLabel = ep ? (ep.kind === 'http' ? h('span', methodBadge(ep.label.split(' ')[0]), ' ', h('b.mono', ep.label.split(' ').slice(1).join(' '))) : h('b', ep.label)) : h('span.muted', 'entry point unknown');
    out.append(h('div.card.outcome.' + o.status,
      h('div.flow-meta',
        h('span.big', failed ? '✖ Request FAILED' : o.status === 'warning' ? '⚠ Completed with warnings' : '✔ Completed successfully'),
        epLabel,
        ep?.id ? h('a.lnk', { href: '#', onclick: (ev) => { ev.preventDefault(); ctx.go('flows', { id: ep.id }); } }, 'static flow →') : null,
        h('span.spacer'),
        badge(`${res.selected} log lines`, '#64748b'), res.durationMs != null ? badge(fmtMs(res.durationMs), '#64748b') : null,
        res.threads.length ? badge(`thread ${res.threads.join(', ')}`, '#64748b') : null,
        badge(`${res.stats.matched}/${res.selected} lines mapped to code`, res.stats.matched === res.selected ? '#16a34a' : '#d97706'),
      ),
      failed && e ? h('div.errbox',
        h('div', h('b', short(e.rootType || e.type || 'Error')), e.rootMessage || e.exceptionMessage ? h('span', ': ' + (e.rootMessage || e.exceptionMessage)) : null),
        e.at ? h('div', 'at ', h('a.lnk', { href: '#', onclick: (ev) => { ev.preventDefault(); ctx.open({ type: 'class', id: e.at.cls, line: e.at.line }); } }, `${e.at.className}.${e.at.method}()`), h('span.muted.mono', `  ${e.at.file}:${e.at.line}`)) : null,
        e.statement ? h('pre.code', { html: highlight(e.statement, 'java') }) : null,
        e.inferred ? h('div.small.muted', 'No stack trace was logged — the failure point was inferred from the code path and the log lines.') : null,
        e.chain && e.chain.length > 1 ? h('details', h('summary.small.clickable', `Exception chain (${e.chain.length})`), e.chain.map((c, i) => h('div.small', { style: { marginLeft: i * 14 + 'px' } }, i ? '↳ caused by ' : '', h('b', short(c.type)), c.message ? ': ' + c.message : '', c.frames[0] ? h('span.muted', `  @ ${c.frames[0].className}:${c.frames[0].line}`) : ''))) : null,
      ) : null,
      breadcrumb(res, (key) => { memory.tab = 'code'; renderTab(); setTimeout(() => $(`#m-${cssId(key)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }),
    ));
    const tabBox = h('div');
    const body = h('div');
    out.append(tabBox, body);
    const renderTab = () => {
      tabBox.replaceChildren(tabs([['diag', '🩺 Diagnosis'], ['walk', 'Step-by-step'], ['code', 'Code path'], ['tree', 'Call tree'], ['seq', 'Sequence'], ['logs', `Log lines (${res.selected})`]], memory.tab, (t) => { memory.tab = t; renderTab(); }));
      body.replaceChildren();
      if (memory.tab === 'diag') body.append(diagnosisView(res, openRef, () => { memory.tab = 'code'; renderTab(); }));
      else if (memory.tab === 'walk') body.append(walkthrough(res, openRef));
      else if (memory.tab === 'code') body.append(codePath(res, openRef, ctx));
      else if (memory.tab === 'tree') body.append(callTree(res, (key) => { memory.tab = 'code'; renderTab(); setTimeout(() => $(`#m-${cssId(key)}`)?.scrollIntoView({ behavior: 'smooth' }), 50); }));
      else if (memory.tab === 'seq') { const d = h('div.mmd', { style: { height: '640px', flex: 'none' } }); body.append(h('div.diagram-card', mermaidToolbar(d, 'trace-sequence'), d)); renderMermaid(d, sequence(res), { minScale: 0.7 }); }
      else body.append(logTable(res, openRef));
    };
    renderTab();
  }

  showIds();
  if (memory.result) showResult();
}

/* ---------- breadcrumb: entry → … → failure ---------- */
function breadcrumb(res, onClick) {
  const main = res.callTree.find((t) => !t.detached) || res.callTree[0];
  if (!main) return null;
  // prefer the path to the deepest failing method; otherwise the longest executed path
  const deepest = (pred) => {
    let best = [];
    (function find(n, acc) {
      const next = [...acc, n];
      if (pred(n) && next.length > best.length) best = next;
      n.children.forEach((c) => find(c, next));
    })(main, []);
    return best;
  };
  let path = deepest((n) => n.status === 'failed' && !n.children.some((c) => c.status === 'failed'));
  if (!path.length) path = deepest((n) => !n.children.length && !n.silent);
  if (!path.length) return null;
  return h('div.crumbs', h('span.muted.small', 'Path: '), path.map((n, i) => h('span', i ? h('span.muted', ' → ') : null,
    h('button.chip', { style: { '--c': (ST[n.status] || ST.inferred).color }, onclick: () => onClick(n.key) }, `${STEREO[n.stereotype]?.icon || ''} ${n.className}.${n.method}()`))));
}

/* ---------- diagnosis (root cause analysis) ---------- */
const PROP_ICON = { thrown: '💥', caught: '🛡️', logged: '📝', wrapped: '🎁', rethrown: '↪️', replaced: '⚠️', propagated: '⬆️', rollback: '↩️', handled: '🧯', response: '📤' };
const SE_ICON = { 'db-write': '🛢️', 'remote-call': '🌍', message: '📨', event: '⚡', mail: '✉️' };

function diagnosisView(res, openRef, gotoCode) {
  const d = res.diagnosis;
  if (!d) return empty('No diagnosis available');
  if (d.error) return h('div.error', d.error);
  const link = (ref, label) => (ref ? h('a.lnk', { href: '#', onclick: (e) => { e.preventDefault(); openRef(ref); } }, label) : h('span', label));
  const section = (title, ...content) => h('div.card.dsection', h('h3', title), ...content);
  const wrap = h('div.diag');
  const failed = d.status === 'failed';
  wrap.append(h('div.diag-summary.' + d.status, h('div.diag-icon', failed ? '🩺' : '✅'), h('div', h('div.diag-title', failed ? 'Diagnosis' : 'Summary'), h('div.diag-text', d.summary), d.statusSource ? h('div.small.muted', `HTTP status from ${d.statusSource}`) : null)));

  const rc = d.rootCause;
  if (rc) {
    wrap.append(section('🎯 Root cause',
      h('div.rc-head', h('span.rc-cat', rc.title), h('span.rc-type', rc.simpleType), rc.message ? h('span.rc-msg', rc.message) : null),
      rc.at ? h('div.rc-loc', 'Failing line: ', link({ key: rc.at.key, line: rc.at.line }, `${rc.at.className}.${rc.at.method}()  line ${rc.at.line}`), rc.stmtLines && rc.stmtLines[0] !== rc.at.line ? h('span.muted.small', ` (inside the statement at lines ${rc.stmtLines[0]}–${rc.stmtLines[1]})`) : null, h('span.muted.mono.small', `  ${rc.at.file}`), h('button.ghost', { style: { marginLeft: '10px', padding: '2px 8px' }, onclick: gotoCode }, 'show in code path')) : null,
      rc.statement ? h('pre.code.rc-stmt', { html: highlight(rc.statement, 'java') }) : null,
      h('div.rc-why', h('b', 'Why it happened'), h('ul', rc.why.map((w) => h('li', w)))),
      rc.guards?.length ? h('div.rc-why', h('b', 'Conditions that led to this line'), h('ul', rc.guards.map((g) => h('li', `${g.text} (line ${g.line})`, g.reason ? h('span.muted.small', ` — ${g.reason}`) : null)))) : null,
      rc.target ? h('div.rc-why', h('b', 'What was being called'), h('div.kv', h('span', h('b', 'via: '), rc.target.via), rc.target.service ? h('span', h('b', 'service: '), rc.target.service) : null, rc.target.baseUrl ? h('span', h('b', 'base URL: '), h('code', rc.target.baseUrl)) : null, rc.target.configKey ? h('span', h('b', 'config: '), h('code', rc.target.configKey)) : null)) : null,
      rc.valuesBefore?.length ? h('div.rc-why', h('b', 'Values logged in this method just before'), h('div.chips', rc.valuesBefore.map((v) => h('code.chip', `${v.name} = ${v.value}`)))) : null,
    ));
  }
  if (d.propagation?.length) {
    wrap.append(section('🧭 How the error travelled', h('div.prop', d.propagation.map((p) => h('div.prop-row.' + p.kind, { onclick: p.ref ? () => openRef(p.ref) : null },
      h('span.prop-icon', PROP_ICON[p.kind] || '•'), h('div', h('div', p.text), p.detail ? h('div.prop-detail', p.detail) : null))))));
  }
  if (rc?.checks?.length) wrap.append(section('🔧 What to check next', h('ol.checks', rc.checks.map((c) => h('li', c)))));
  if (d.warnings?.length) wrap.append(section('⚠ Warnings', d.warnings.map((w) => h('div.prop-row', { onclick: w.ref ? () => openRef(w.ref) : null }, h('span.prop-icon', '⚠'), h('div', w.text)))));
  if (d.sideEffects?.length) {
    wrap.append(section(failed ? '🧾 Side effects before the failure' : '🧾 Side effects',
      h('table.tbl', h('thead', h('tr', ['', 'What', 'Where', failed ? 'After the failure' : 'Note'].map((x) => h('th', x)))),
        h('tbody', d.sideEffects.map((s) => h('tr.clickable' + (failed && s.persistent && !s.rolledBack ? '.risk' : ''), { onclick: () => openRef(s.ref) },
          h('td', SE_ICON[s.kind] || '•'), h('td', h('b', s.label), h('div.mono.small.muted', s.statement.length > 90 ? s.statement.slice(0, 87) + '…' : s.statement)),
          h('td.mono.small', `${s.method}:${s.ref.line}`), h('td.small', s.note || (s.certain ? 'executed' : 'executed (inferred)'))))))));
  }
  if (d.decisions?.length) wrap.append(section('🔀 Decisions on the way', h('div', d.decisions.map((x) => h('div.step.decision.' + (x.status || ''), { onclick: x.ref ? () => openRef(x.ref) : null }, h('span', x.text), x.reason ? h('span.reason', ` — ${x.reason}`) : null)))));
  if (d.values?.length) {
    wrap.append(section('🔢 Runtime values (from log placeholders)',
      h('table.tbl', h('thead', h('tr', ['Expression', 'Value', 'Logged at', 'Time'].map((x) => h('th', x)))),
        h('tbody', d.values.map((v) => h('tr.clickable', { onclick: () => openRef(v.ref) }, h('td.mono.small', v.name), h('td.mono', h('b', v.value)), h('td.mono.small.muted', v.where || ''), h('td.mono.small.muted', shortTs(v.ts))))))));
  }
  return wrap;
}

/* ---------- step-by-step ---------- */
function walkthrough(res, openRef) {
  const list = h('div.steps.card');
  for (const s of res.steps) {
    const indent = { paddingLeft: `${10 + s.depth * 22}px` };
    const click = s.ref ? () => openRef(s.ref) : null;
    if (s.kind === 'section') { list.append(h('div.step-section' + (s.main ? '.main' : ''), s.text)); continue; }
    let row;
    if (s.kind === 'log') row = h('div.step.log', { style: indent, onclick: click }, h('span.lvl', { style: { '--c': LEVEL_C[s.level] || '#64748b' } }, s.level), h('span.ts', shortTs(s.ts)), h('span.mono', s.text));
    else row = h('div.step.' + s.kind + (s.status ? '.' + s.status : ''), { style: indent, onclick: click },
      h('span', s.text), s.reason ? h('span.reason', ` — ${s.reason}`) : null, s.detail ? h('div.detail', s.detail) : null);
    list.append(row);
  }
  return h('div', h('div.legend.small.muted', 'Click any step to open the code at that line. ◆ true / taken · ◇ false / not taken · ? undetermined · ✖ failure · ⏭ skipped'), list);
}

/* ---------- annotated code ---------- */
function codePath(res, openRef, ctx) {
  const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  wrap.append(h('div.legend.small', Object.entries(ST).filter(([k]) => k !== 'recovered').map(([, v]) => h('span', h('b', { style: { color: v.color } }, v.icon), ' ', v.label))));
  const entries = res.entries;
  for (const m of res.methods) {
    const card = h('div.card.mcard#m-' + cssId(m.key), { style: { borderLeft: `4px solid ${(ST[m.status] || ST.inferred).color}` } });
    card.append(h('div.flow-meta',
      h('b', { style: { color: (ST[m.status] || ST.inferred).color } }, (ST[m.status] || ST.inferred).icon),
      h('a.lnk', { href: '#', onclick: (e) => { e.preventDefault(); ctx.open({ type: 'class', id: m.cls, line: m.line }); } }, `${m.className}.${m.signature}`),
      h('span.muted.mono.small', `${m.file}:${m.line}`), m.annotations.filter((a) => /Transactional|Async|Cacheable|PreAuthorize|Retryable/.test(a)).map((a) => badge(a, '#8b5cf6')),
      m.silent ? badge('no log lines — reasoned from the code', '#94a3b8') : null,
      h('span.spacer'), badge(m.status, (ST[m.status] || ST.inferred).color),
    ));
    const code = h('div.cfg');
    const row = (n, depth, text, status, extra = {}) => {
      const st = ST[status] || ST.unknown;
      const r = h('div.crow.' + (status || 'unknown'), { title: [st.label, n?.reason || extra.reason].filter(Boolean).join(' — '), onclick: () => openRef({ key: m.key, line: extra.line || n.line }) },
        h('span.cicon', { style: { color: st.color } }, st.icon),
        h('span.cline', extra.line || n?.line || ''),
        h('span.ctext', { style: { paddingLeft: depth * 18 + 'px' }, html: highlight(text, 'java') }),
        (n?.reason || extra.reason) && ['not-taken', 'unknown', 'failed', 'taken'].includes(status) ? h('span.creason', n?.reason || extra.reason) : null);
      code.append(r);
      return r;
    };
    const logRows = (n, depth) => {
      for (const ev of (n.evidence || []).filter((x) => x.kind === 'log')) {
        const e = entries[ev.entry];
        code.append(h('div.crow.logline', h('span.cicon'), h('span.cline'), h('span.ctext', { style: { paddingLeft: depth * 18 + 'px' } }, h('span.lvl', { style: { '--c': LEVEL_C[e.level] } }, e.level), h('span.ts', shortTs(e.ts)), h('span.mono', e.message))));
      }
    };
    const render = (nodes, depth) => {
      for (const n of nodes || []) {
        if (n.type === 'block') { render(n.children, depth); continue; }
        if (n.type === 'if') {
          n.branches.forEach((b, i) => {
            const head = b.kind === 'if' ? `if (${b.cond}) {` : b.kind === 'elseif' ? `} else if (${b.cond}) {` : '} else {';
            row(n, depth, head, b.status || n.status, { line: b.line, reason: b.reason });
            render(b.body, depth + 1);
            if (i === n.branches.length - 1) row(n, depth, '}', b.status || n.status, { line: b.endLine });
          });
          continue;
        }
        if (n.type === 'switch') {
          row(n, depth, `switch (${n.expr}) {`, n.status);
          for (const c of n.cases) { row(n, depth + 1, `${c.label}:`, c.status || n.status, { line: c.line, reason: c.reason }); render(c.body, depth + 2); }
          row(n, depth, '}', n.status, { line: n.endLine });
          continue;
        }
        if (n.type === 'loop') {
          row(n, depth, `${n.kind === 'do' ? 'do' : n.kind === 'while' ? `while (${n.cond})` : `for (${n.cond})`} {${n.iterations ? `   // ${n.iterations} iteration(s) seen` : ''}`, n.status, { reason: n.reason });
          render(n.body, depth + 1);
          row(n, depth, n.kind === 'do' ? `} while (${n.cond});` : '}', n.status, { line: n.endLine });
          continue;
        }
        if (n.type === 'try') {
          row(n, depth, `try${n.resources ? ` (${n.resources})` : ''} {`, n.status);
          render(n.body, depth + 1);
          for (const c of n.catches) { row(n, depth, `} catch (${c.types.join(' | ')} ${c.var}) {`, c.status || 'unknown', { line: c.line, reason: c.reason }); render(c.body, depth + 1); }
          if (n.finally) { row(n, depth, '} finally {', 'executed', { line: n.finally.line }); render(n.finally.body, depth + 1); }
          row(n, depth, '}', n.status, { line: n.endLine });
          continue;
        }
        row(n, depth, n.text + (n.type === 'stmt' || n.type === 'return' || n.type === 'throw' ? ';' : ''), n.status, { reason: n.reason });
        logRows(n, depth);
        if (n.status === 'failed' && n.exception) code.append(h('div.crow.excline', h('span.cicon'), h('span.cline'), h('span.ctext', { style: { paddingLeft: depth * 18 + 'px' } }, `💥 ${short(n.exception.type)}${n.exception.message ? ': ' + n.exception.message : ''}${n.failedHere ? '' : '  (from the called method)'}`)));
      }
    };
    render(m.nodes, 0);
    card.append(code);
    wrap.append(card);
  }
  return wrap;
}

/* ---------- call tree ---------- */
function callTree(res, onClick) {
  const node = (n) => {
    const st = ST[n.status] || ST.inferred;
    return h('li', h('span.tnode', { onclick: () => onClick(n.key) },
      h('b', { style: { color: st.color } }, st.icon), h('span', STEREO[n.stereotype]?.icon || ''), h('span.cls', n.className), h('span.mono', `.${n.method}()`),
      n.callLine ? h('span.muted.small', `called at line ${n.callLine}`) : null, n.silent ? badge('no logs', '#94a3b8') : null, n.detached ? badge('separate', '#64748b') : null, badge(n.status || 'inferred', st.color)),
    n.children.length ? h('ul', n.children.map(node)) : null);
  };
  return h('div.card.tree', h('ul', res.callTree.map(node)));
}

/* ---------- sequence ---------- */
function sequence(res) {
  const L = ['sequenceDiagram'];
  const t = mmd.text;
  const parts = new Map();
  const mBy = new Map(res.methods.map((m) => [m.key, m]));
  const pid = (cls, name) => { if (!parts.has(cls)) { parts.set(cls, 'P' + parts.size); L.push(`  participant ${parts.get(cls)} as ${t(name)}`); } return parts.get(cls); };
  const client = (() => { L.push('  actor C as Caller'); return 'C'; })();
  let cur = client; let count = 0;
  // log lines of wrapping components (filters) that happen *after* the main flow started are
  // emitted at the end so the diagram stays chronological
  let inMain = false; let mainFirst = Infinity; const deferred = [];
  { let sec = false; for (const s of res.steps) { if (s.kind === 'section') sec = !!s.main; else if (sec && s.kind === 'log') mainFirst = Math.min(mainFirst, s.entry); } }
  for (const s of res.steps) {
    if (count > 250) break;
    const m = s.ref && mBy.get(s.ref.key);
    if (s.kind === 'section') { inMain = !!s.main; continue; }
    if (!inMain && s.kind === 'log' && s.entry > mainFirst) { deferred.push({ s, m }); continue; }
    if (s.kind === 'enter' && m) {
      const to = pid(m.cls, m.className);
      const from = s.via && mBy.get(s.via) ? pid(mBy.get(s.via).cls, mBy.get(s.via).className) : client;
      L.push(`  ${from}->>${to}: ${t(m.method)}()${m.silent ? ' (no logs)' : ''}`); count++;
      cur = to;
      continue;
    }
    const me = m ? pid(m.cls, m.className) : cur;
    if (s.kind === 'log') L.push(`  Note right of ${me}: [${s.level}] ${t(s.text.length > 70 ? s.text.slice(0, 67) + '…' : s.text)}`);
    else if (s.kind === 'decision') L.push(`  Note right of ${me}: ${s.status === 'taken' ? '◆' : '◇'} ${t(s.text.replace(/^[◆◇]\s*/, '').slice(0, 80))}`);
    else if (s.kind === 'fail') L.push(`  Note over ${me}: ❌ ${t((s.detail || s.text).slice(0, 90))}`);
    else if (s.kind === 'catch') L.push(`  Note right of ${me}: ${t(s.text.slice(0, 80))}`);
    else if (s.kind === 'skipped') L.push(`  Note right of ${me}: ⏭ skipped ${t(s.text.replace(/^.*?:\s*/, '').slice(0, 70))}`);
    else continue;
    count++;
  }
  for (const { s, m } of deferred.sort((a, b) => a.s.entry - b.s.entry)) {
    const me = m ? pid(m.cls, m.className) : cur;
    L.push(`  Note right of ${me}: [${s.level}] ${t(s.text.length > 70 ? s.text.slice(0, 67) + '…' : s.text)}`);
  }
  return L.join('\n');
}

/* ---------- log table ---------- */
function logTable(res, openRef) {
  const unmatched = new Set(res.unmatched);
  const tbody = h('tbody');
  for (const e of res.entries) {
    const mt = e.match;
    tbody.append(h('tr' + (unmatched.has(e.i) ? '.unmatched' : ''),
      h('td.mono.small.muted', e.lineNo), h('td.mono.small', shortTs(e.ts)), h('td', h('span.lvl', { style: { '--c': LEVEL_C[e.level] } }, e.level)),
      h('td.small.muted', e.thread || ''),
      h('td', h('div.mono.small', e.message), e.exception ? h('details', h('summary.small.clickable', `💥 ${short(e.exception.type)}: ${(e.exception.message || '').slice(0, 100)}`),
        e.exception.chain.map((c) => h('div.small', h('b', short(c.type)), ': ', c.message || '', c.frames.map((f) => h('div.mono.clickable', { style: { paddingLeft: '14px', color: 'var(--accent)' }, onclick: () => f.key && openRef({ key: f.key, line: f.line }) }, `at ${f.className}.${f.method}(${f.file.split('/').pop()}:${f.line})`)), c.totalFrames > c.frames.length ? h('div.muted', { style: { paddingLeft: '14px' } }, `… ${c.totalFrames - c.frames.length} framework frames`) : null))) : null),
      h('td.small', mt && mt.method ? h('a.lnk', { href: '#', onclick: (ev) => { ev.preventDefault(); openRef({ key: mt.key, line: mt.line }); } }, `${mt.className}.${mt.method}():${mt.line}`) : mt ? h('span.muted', `${mt.className} (statement not found)`) : h('span.warn-text', 'not mapped'),
        mt?.confidence && mt.method ? h('div', badge(mt.confidence, mt.confidence === 'exact' ? '#16a34a' : '#d97706')) : null),
    ));
  }
  return h('div.card', { style: { padding: 0, overflow: 'auto' } }, h('table.tbl', h('thead', h('tr', ['Line', 'Time', 'Level', 'Thread', 'Message', 'Code location'].map((x) => h('th', x)))), tbody));
}

function shortTs(ts) { if (!ts) return ''; const m = /(\d{2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)/.exec(ts); return m ? m[1] : ts; }
function fmtMs(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`; }
function fmtSize(n) { return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`; }
function cssId(k) { return String(k).replace(/[^\w-]/g, '_'); }
void empty;
