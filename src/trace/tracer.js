'use strict';
/**
 * Correlation-ID log tracing.
 *
 *   log lines ──► matched to log statements / stack frames in code
 *            ──► evidence per method (which lines certainly ran / aborted)
 *            ──► call path from the entry point (controller / listener / job)
 *            ──► control-flow annotation of every involved method:
 *                which if/else/switch branches were taken, loops entered,
 *                exceptions caught, where it failed and what was skipped
 *            ──► step-by-step narrative
 */
const { listFiles, read, classify } = require('../analyzer/files');
const { parseFile, extractLocals } = require('../analyzer/java-parser');
const { buildModel } = require('../analyzer/spring');
const { buildCfg, walk } = require('./cfg');
const { parseLog, detectIds, filterById, parseTs, rank } = require('./logparse');
const { diagnose } = require('./diagnose');

const MAX_ENTRIES = 20000;

/* ------------------------------------------------------------------ */
/* code model                                                          */
/* ------------------------------------------------------------------ */

function loadCode(root) {
  const parsed = [];
  for (const f of listFiles(root)) {
    const c = classify(f);
    if (!c.java || c.isTest) continue;
    try { parsed.push(parseFile(read(root, f), f)); } catch { /* skip */ }
  }
  const model = buildModel(parsed);
  const methods = new Map(); // key -> {key, t, m, cfg, logs[], throws[]}
  const byType = new Map(); // fqn -> [method entries]
  const allLogs = [];
  const allThrows = [];
  for (const t of model.types) {
    const list = [];
    for (const m of [...t.methods, ...t.constructors.map((c) => ({ ...c, name: '<init>', returnType: '' }))]) {
      if (!m.body) continue;
      const key = `${t.fqn}#${m.name}:${m.line}`;
      let cfg = null;
      try { cfg = buildCfg(m, t._file); } catch { cfg = null; }
      const me = { key, t, m, cfg, logs: [], throws: [] };
      if (cfg) walk(cfg.nodes, (n) => {
        for (const l of n.logs || []) { const x = { ...l, me, node: n, re: l.regex ? safeRe(l.regex) : null }; me.logs.push(x); allLogs.push(x); }
        for (const th of n.throws || []) { const x = { ...th, me, node: n, re: th.regex ? safeRe(th.regex) : null }; me.throws.push(x); allThrows.push(x); }
      });
      methods.set(key, me);
      list.push(me);
    }
    byType.set(t.fqn, list);
  }
  // exception classes: message template from `super("Customer " + id + " is blocked")`
  const excTemplates = new Map();
  for (const t of model.types) {
    if (!/(Exception|Error)$/.test(t.name)) continue;
    const res = [];
    for (const c of t.constructors) {
      const body = t._file.restore(c.body || '');
      const sm = /\bsuper\s*\(([\s\S]*?)\)\s*;/.exec(body);
      if (!sm) continue;
      const lits = (sm[1].split(',')[0].match(/"((?:[^"\\]|\\.)*)"/g) || []).map((x) => JSON.parse(x));
      if (lits.join('').trim().length >= 4) res.push(new RegExp(lits.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*?').replace(/^/, lits[0] && sm[1].trim().startsWith('"') ? '' : '\\S*?'), 's'));
    }
    if (res.length) excTemplates.set(t.name, res);
  }
  return { model, methods, byType, allLogs, allThrows, excTemplates };
}

function safeRe(src) { try { return { full: new RegExp('^\\s*' + src + '\\s*$', 's'), part: new RegExp(src, 's') }; } catch { return null; } }

/* ------------------------------------------------------------------ */

function trace(code, report, logText, correlationId, opts = {}) {
  const { model, methods, byType, allLogs, allThrows } = code;
  const all = parseLog(logText);
  const result = { totalEntries: all.length, correlationId: correlationId || null };
  if (!correlationId) { result.candidates = detectIds(all); }
  let sel = filterById(all, correlationId);
  if (correlationId && !sel.length) { result.candidates = detectIds(all); result.error = `No log lines contain "${correlationId}".`; return result; }
  if (sel.length > MAX_ENTRIES) { sel = sel.slice(0, MAX_ENTRIES); result.truncated = true; }
  sel.forEach((e, i) => { e.i = i; });

  /* ---------- class lookup helpers ---------- */
  const typeByName = new Map();
  for (const t of model.types) { if (!typeByName.has(t.name)) typeByName.set(t.name, []); typeByName.get(t.name).push(t); }
  const typeFor = (cls) => {
    if (!cls) return null;
    const c = cls.replace(/\$\$.*$/, '').replace(/\$\d+$/, '').replace(/\$/g, '.');
    return model.byFqn.get(c) || model.byFqn.get(cls.split('$')[0]) || null;
  };
  const loggerTypes = (name) => {
    if (!name) return [];
    const n = name.replace(/\$.*$/, '').trim();
    const exact = model.byFqn.get(n);
    if (exact) return [exact];
    const segs = n.split('.');
    const simple = segs.pop();
    const cands = typeByName.get(simple) || [];
    if (!segs.length) return cands;
    const ok = cands.filter((t) => { const ps = t.pkg.split('.'); return ps.length >= segs.length && segs.every((s, i) => ps[ps.length - segs.length + i].startsWith(s.replace(/~$/, ''))); });
    return ok.length ? ok : cands;
  };
  const methodAt = (t, line) => (byType.get(t.fqn) || []).find((me) => line >= me.m.line && line <= (me.m.endLine || me.m.line)) || null;

  /* ---------- per-class enabled log levels ---------- */
  const minRankByClass = new Map(); let globalMin = 4;
  for (const e of all) {
    const r = rank(e.level);
    for (const t of loggerTypes(e.logger)) minRankByClass.set(t.fqn, Math.min(minRankByClass.get(t.fqn) ?? 4, r));
    if (loggerTypes(e.logger).length) globalMin = Math.min(globalMin, r);
  }
  if (globalMin === 4) globalMin = 2;
  const enabled = (fqn, level) => rank(level) >= (minRankByClass.get(fqn) ?? globalMin);

  /* ---------- match entries to code ---------- */
  const evidence = new Map(); // method key -> [{line, kind, entry, node}]
  const addEv = (me, ev) => { if (!evidence.has(me.key)) evidence.set(me.key, []); evidence.get(me.key).push(ev); };
  for (const e of sel) {
    const msg = (e.message || '').trim();
    const types = loggerTypes(e.logger);
    let best = null;
    const consider = (l, scope) => {
      if (!l.re) return;
      let score = 0;
      if (l.re.full.test(msg)) score = 100 + l.literalLen; else if (l.literalLen >= 6 && l.re.part.test(msg)) score = 40 + l.literalLen; else return;
      if (l.level === e.level) score += 15;
      if (scope === 'class') score += 50;
      if (!best || score > best.score) best = { l, score };
    };
    const scoped = new Set(types.map((t) => t.fqn));
    for (const l of allLogs) if (scoped.has(l.me.t.fqn) || (l.me.t.outer && scoped.has(l.me.t.outer))) consider(l, 'class');
    if (!best) for (const l of allLogs) if (l.literalLen >= 8) consider(l, 'global');
    if (best) {
      const l = best.l;
      e.match = { key: l.me.key, cls: l.me.t.fqn, className: l.me.t.name, method: l.me.m.name, line: l.line, file: l.me.t.file, template: l.template, confidence: best.score >= 150 ? 'exact' : best.score >= 100 ? 'high' : 'partial', level: l.level };
      // runtime values: "{}" placeholders ↔ argument expressions of the log call
      const mm = l.re.full.exec(msg);
      if (mm && l.argExprs && mm.length - 1 === l.argExprs.length) e.values = l.argExprs.map((name, i) => ({ name, value: mm[i + 1] }));
      addEv(l.me, { line: l.line, kind: 'log', entry: e.i, nodeId: l.node.id, ts: e.ts, level: e.level });
    } else if (types.length) {
      e.match = { cls: types[0].fqn, className: types[0].name, confidence: 'class-only', file: types[0].file, line: types[0].line };
    }
    // stack trace frames
    if (e.exception) {
      for (const [ci, ex] of e.exception.chain.entries()) {
        ex.projectFrames = [];
        for (const f of ex.frames) {
          const t = typeFor(f.cls);
          if (!t || !f.line) continue;
          const me = methodAt(t, f.line);
          ex.projectFrames.push({ cls: t.fqn, className: t.name, method: me ? me.m.name : f.method, line: f.line, file: t.file, key: me ? me.key : null });
        }
        // A stack trace lists every caller at throw time, but the exception only propagated up to
        // the frame that handled it: a method that logged later (after this entry) past the call
        // site, or Spring MVC's dispatcher when a @ControllerAdvice handled it.
        const boundary = ex.frames.findIndex((f) => /^org\.springframework\.web\.(servlet\.(FrameworkServlet|DispatcherServlet)|method\.support\.InvocableHandlerMethod|reactive\.DispatcherHandler)|^org\.springframework\.(kafka\.listener|amqp\.rabbit\.listener|jms\.listener)\./.test(f.cls));
        ex.projectFrames.forEach((pf, idx) => {
          const me = pf.key && methods.get(pf.key);
          if (!me) return;
          const rawIdx = ex.frames.findIndex((f) => f.line === pf.line && typeFor(f.cls)?.fqn === pf.cls);
          pf.beyondBoundary = boundary !== -1 && rawIdx > boundary;
          addEv(me, { line: pf.line, kind: idx === 0 ? 'throw' : 'call', entry: e.i, chain: ci, exception: ex.type, exceptionMessage: ex.message, pending: pf.beyondBoundary });
        });
        // exceptions without stack: find "throw new X(msg)" by message template
        if (!ex.projectFrames.length && ex.message) {
          const simple = ex.type.split('.').pop();
          const th = allThrows.filter((x) => x.exception === simple && x.re && x.re.full.test(ex.message.split('\n')[0])).sort((a, b) => b.literalLen - a.literalLen)[0];
          if (th) { ex.inferredThrow = { cls: th.me.t.fqn, className: th.me.t.name, method: th.me.m.name, line: th.node.line, file: th.me.t.file, key: th.me.key }; addEv(th.me, { line: th.node.line, kind: 'throw', entry: e.i, chain: ci, exception: ex.type, inferred: true }); }
        }
      }
    }
  }

  /* ---------- decide which stack frames really aborted ----------
     A frame is "handled" (its call returned normally) when it is beyond a framework boundary that
     handles exceptions, or when the same method logged something later, after the call site. */
  const handledByAdvice = sel.some((e) => e.match?.key && methods.get(e.match.key)?.t.stereotype === 'advice');
  for (const [key, list] of evidence) {
    for (const ev of list) {
      if (ev.kind !== 'call' && ev.kind !== 'throw') continue;
      const laterLog = list.some((o) => o.kind === 'log' && o.entry > ev.entry && o.line > ev.line);
      if ((ev.pending && handledByAdvice) || laterLog) { ev.kind = 'callee-ok'; ev.handled = true; }
    }
    void key;
  }

  /* ---------- outcome ---------- */
  const withExc = sel.filter((e) => e.exception && e.exception.chain.some((c) => c.projectFrames?.length || c.inferredThrow || c.frames.length));
  const errors = sel.filter((e) => e.level === 'ERROR');
  const primary = withExc[0] || errors[0] || null;
  const outcome = { status: primary ? 'failed' : sel.some((e) => e.level === 'WARN') ? 'warning' : 'success' };
  if (primary) {
    const ex = primary.exception;
    const root = ex ? ex.root : null;
    const throwEl = ex ? ([...ex.chain].reverse().find((c) => c.projectFrames?.length || c.inferredThrow) || null) : null;
    const site = throwEl ? (throwEl.projectFrames?.[0] || throwEl.inferredThrow) : (primary.match?.line ? primary.match : null);
    outcome.error = {
      entry: primary.i, message: primary.message, level: primary.level,
      type: ex ? ex.type : null, exceptionMessage: ex ? ex.message : null,
      rootType: root ? root.type : null, rootMessage: root ? root.message : null,
      chain: ex ? ex.chain.map((c) => ({ type: c.type, message: c.message, frames: c.projectFrames || [], totalFrames: c.frames.length })) : [],
      at: site ? { cls: site.cls, className: site.className, method: site.method, line: site.line, file: site.file, key: site.key } : null,
    };
    if (site?.key && methods.get(site.key)) {
      const me = methods.get(site.key);
      let stmtNode = null;
      walk(me.cfg?.nodes || [], (n) => { if (n.text && site.line >= n.line && site.line <= n.endLine) stmtNode = n; });
      if (stmtNode) outcome.error.statement = stmtNode.text;
    }
  }

  /* ---------- call graph among methods ---------- */
  const calleeCache = new Map();
  function callees(me) {
    if (calleeCache.has(me.key)) return calleeCache.get(me.key);
    const out = [];
    calleeCache.set(me.key, out);
    if (!me.cfg) return out;
    const vars = {};
    for (const f of allFields(me.t)) vars[f.name] = f.typeInfo;
    for (const p of me.m.params) vars[p.name] = p.typeInfo;
    Object.assign(vars, extractLocals(me.m.body));
    walk(me.cfg.nodes, (n) => {
      for (const c of n.calls || []) {
        if (c.chained) continue;
        let targets = [];
        if (!c.receiver) targets = findMethods(me.t, c.method);
        else {
          let ti = vars[c.receiver];
          if (!ti && /^[A-Z]/.test(c.receiver)) { const st = model.resolve(c.receiver, me.t); if (st) targets = findMethods(st, c.method); continue; }
          if (!ti) continue;
          for (const r of model.resolveBeans(ti.name, me.t, ti.args || [])) {
            const tt = r.fqn && model.byFqn.get(r.fqn);
            if (tt) targets.push(...findMethods(tt, c.method));
          }
        }
        for (const tm of targets) if (tm.key !== me.key) out.push({ to: tm.key, line: c.line, nodeId: n.id, method: c.method });
      }
    });
    return out;
  }
  function allFields(t, seen = new Set()) {
    if (!t || seen.has(t.fqn)) return [];
    seen.add(t.fqn);
    return [...t.fields, ...t.extends.flatMap((s) => allFields(model.resolve(s, t), seen))];
  }
  function findMethods(t, name, seen = new Set()) {
    if (!t || seen.has(t.fqn)) return [];
    seen.add(t.fqn);
    const own = (byType.get(t.fqn) || []).filter((me) => me.m.name === name);
    if (own.length) return own;
    // interface: implementations; class: superclass
    const out = [];
    for (const s of [...t.extends]) out.push(...findMethods(model.resolve(s, t), name, seen));
    if (!out.length && (t.kind === 'interface' || t.modifiers.includes('abstract'))) for (const impl of model.implementors.get(t.fqn) || []) out.push(...findMethods(model.byFqn.get(impl), name, seen));
    return out;
  }

  /* ---------- entry point & call tree ---------- */
  const touched = new Set(evidence.keys());
  const firstTime = (key) => Math.min(...(evidence.get(key) || []).map((e) => e.entry));
  const messagesText = sel.map((e) => e.message).join('\n');

  let rootKey = null; let entryInfo = null;
  // 1) bottom-most project frame of the outermost exception
  if (primary?.exception) {
    const frames = (primary.exception.chain[0].projectFrames || []).filter((f) => !f.beyondBoundary);
    const bottom = frames[frames.length - 1];
    if (bottom?.key) rootKey = bottom.key;
  }
  // 2) flows from the static analysis that contain touched methods
  const flowCands = [];
  for (const f of report.flows || []) {
    const rootMe = (byType.get(f.tree.class) || []).find((me) => me.m.name === f.tree.method && me.m.line === f.tree.line) || (byType.get(f.tree.class) || []).find((me) => me.m.name === f.tree.method);
    if (!rootMe) continue;
    let hits = 0; let depthSum = 0;
    (function w(n, d) { const k = (byType.get(n.class) || []).find((me) => me.m.name === n.method); if (k && touched.has(k.key)) { hits++; depthSum += d; } (n.children || []).forEach((c) => w(c, d + 1)); })(f.tree, 0);
    if (!hits && !(rootKey && rootMe.key === rootKey)) continue;
    let score = hits * 10 - depthSum;
    if (f.method && f.path) { const pat = new RegExp(`\\b${f.method}\\b\\s+\\S*${f.path.replace(/\{[^}]+\}/g, '[^/\\s]+').replace(/[.*+?^$()|[\]\\]/g, (c) => (c === '[' || c === ']' ? c : '\\' + c))}(?:[?\\s]|$)`, 'm'); if (pat.test(messagesText)) score += 100; }
    if (rootKey && rootMe.key === rootKey) score += 200;
    flowCands.push({ f, rootMe, score });
  }
  flowCands.sort((a, b) => b.score - a.score);
  if (flowCands[0] && (!rootKey || flowCands[0].rootMe.key === rootKey || flowCands[0].score >= 100)) { rootKey = flowCands[0].rootMe.key; entryInfo = { id: flowCands[0].f.id, label: flowCands[0].f.label, kind: flowCands[0].f.kind }; }
  if (!rootKey && touched.size) rootKey = [...touched].sort((a, b) => firstTime(a) - firstTime(b))[0];
  if (rootKey && !entryInfo) { const me = methods.get(rootKey); entryInfo = { id: null, label: `${me.t.name}.${me.m.name}()`, kind: me.t.stereotype }; }

  // DFS from root keeping branches that lead to touched methods
  const involved = new Map(); // key -> {key, children:[{key,line,nodeId}], ...}
  function build(key, stack) {
    const me = methods.get(key);
    const node = { key, cls: me.t.fqn, className: me.t.name, method: me.m.name, line: me.m.line, file: me.t.file, stereotype: me.t.stereotype, children: [] };
    let hasTouched = touched.has(key);
    if (stack.size < 14) {
      stack.add(key);
      const seenTo = new Set();
      for (const c of callees(me)) {
        if (stack.has(c.to) || seenTo.has(c.to)) continue;
        const sub = build(c.to, stack);
        if (sub) { seenTo.add(c.to); hasTouched = true; node.children.push({ ...sub, callLine: c.line, callNodeId: c.nodeId }); continue; }
        // a callee that printed nothing: still worth analysing when it *has* log/throw statements,
        // because their absence tells which branches did NOT run (kept only if the call ran)
        const cm = methods.get(c.to);
        if (touched.has(key) && cm && (cm.logs.length || cm.throws.length)) { seenTo.add(c.to); node.children.push({ key: c.to, cls: cm.t.fqn, className: cm.t.name, method: cm.m.name, line: cm.m.line, file: cm.t.file, stereotype: cm.t.stereotype, children: [], silent: true, callLine: c.line, callNodeId: c.nodeId }); }
      }
      stack.delete(key);
    }
    return hasTouched ? node : null;
  }
  const trees = [];
  if (rootKey) { const t = build(rootKey, new Set()) || { ...build0(rootKey) }; trees.push(t); }
  function build0(key) { const me = methods.get(key); return { key, cls: me.t.fqn, className: me.t.name, method: me.m.name, line: me.m.line, file: me.t.file, stereotype: me.t.stereotype, children: [] }; }
  const covered = new Set();
  const mark = (n) => { covered.add(n.key); n.children.forEach(mark); };
  trees.forEach(mark);
  // touched methods not reachable from the entry (filters, async listeners, exception handlers…)
  for (const k of [...touched].filter((x) => !covered.has(x)).sort((a, b) => firstTime(a) - firstTime(b))) {
    if (covered.has(k)) continue;
    const t = build(k, new Set()) || build0(k);
    t.detached = true;
    trees.push(t); mark(t);
  }
  const order = [];
  (function collect(list) { for (const n of list) { if (!involved.has(n.key)) { involved.set(n.key, n); order.push(n.key); } collect(n.children); } })(trees);

  // callee evidence: a call statement whose callee ran certainly executed
  const keyEv = new Set(touched);
  (function propagate(list) {
    for (const n of list) {
      propagate(n.children);
      for (const c of n.children) {
        const me = methods.get(n.key);
        if (keyEv.has(c.key)) { addEv(me, { line: c.callLine, kind: 'callee', callee: c.key, nodeId: c.callNodeId }); keyEv.add(n.key); }
      }
    }
  })(trees);

  /* ---------- annotate control flow (callees before callers) ----------
     If a callee is found to throw (stack trace or a reached `throw`), the caller's call site
     becomes an abort point too, so the failure propagates upwards even without a stack trace. */
  const annotated = new Map();
  function annotateTree(node, parent) {
    for (const c of node.children) annotateTree(c, node);
    if (annotated.has(node.key)) return;
    const evs = evidence.get(node.key) || [];
    const res = annotateMethod(methods.get(node.key), evs, {
      enabled, sel, assumeRuns: !!node.silent, excTemplates: code.excTemplates,
      propagates: evs.some((ev) => (ev.kind === 'call' || ev.kind === 'throw') && ev.chain === 0),
    });
    res.silent = !!node.silent;
    annotated.set(node.key, res);
    if (res.thrownOut && parent && node.callLine) {
      const pev = evidence.get(parent.key) || [];
      if (!pev.some((e) => (e.kind === 'call' || e.kind === 'throw') && e.line === node.callLine)) addEv(methods.get(parent.key), { line: node.callLine, kind: 'call', chain: 0, inferred: true, exception: res.thrownOut.type, exceptionMessage: res.thrownOut.message });
    }
  }
  trees.forEach((t) => annotateTree(t, null));
  // drop "silent" callees whose call statement did not actually run
  const stmtStatus = (key, nodeId) => { let st = null; walk(annotated.get(key)?.nodes || [], (n) => { if (n.id === nodeId) st = n.status; }); return st; };
  (function prune(list) {
    for (const n of list) {
      n.children = n.children.filter((c) => !c.silent || ['executed', 'inferred', 'failed'].includes(stmtStatus(n.key, c.callNodeId)));
      prune(n.children);
    }
  })(trees);
  const keep = new Set(); (function k(list) { for (const n of list) { keep.add(n.key); k(n.children); } })(trees);
  const methodsOut = order.filter((k) => keep.has(k)).map((k) => annotated.get(k)).filter(Boolean);

  // failure without any stack trace: a reached `throw` that escaped the main flow
  if (outcome.status !== 'failed') {
    const main = trees.find((t) => !t.detached);
    const thrown = main && annotated.get(main.key)?.thrownOut;
    if (thrown) {
      let site = null;
      for (const m of methodsOut) walk(m.nodes, (n) => { if (!site && n.failedHere) site = { m, n }; });
      outcome.status = 'failed';
      outcome.error = { inferred: true, type: thrown.type, exceptionMessage: thrown.message, rootType: thrown.type, rootMessage: thrown.message, message: 'No stack trace in the logs — failure inferred from the code path', chain: [], at: site ? { cls: site.m.cls, className: site.m.className, method: site.m.method, line: site.n.line, file: site.m.file, key: site.m.key } : null, statement: site ? site.n.text : null };
    }
  }

  /* ---------- narrative ---------- */
  const methodByKey = new Map(methodsOut.map((m) => [m.key, m]));
  const steps = [];
  const visited = new Set();
  function narrate(key, depth, via) {
    const m = methodByKey.get(key);
    if (!m || visited.has(key)) return;
    visited.add(key);
    steps.push({ depth, kind: 'enter', via: via || null, text: `${via ? '' : '▶ '}Entered ${m.className}.${m.method}()${m.silent ? '  (no log lines — reasoned from the code)' : ''}`, ref: { key, line: m.line }, status: m.status });
    (function walkNodes(nodes, d) {
      for (const n of nodes) {
        const st = n.status;
        if (n.type === 'if' || n.type === 'switch') {
          if (st === 'not-reached' || st === 'unknown' && !n.branches?.some((b) => b.status === 'taken')) {
            if (st === 'unknown') steps.push({ depth: d, kind: 'unknown', text: `? Could not determine outcome of ${n.type === 'if' ? `if (${n.branches[0].cond})` : `switch (${n.expr})`}`, ref: { key, line: n.line } });
            continue;
          }
          const brs = n.type === 'if' ? n.branches : n.cases;
          const taken = brs.find((b) => b.status === 'taken');
          if (!taken && !brs.some((b) => b.status === 'not-taken')) {
            steps.push({ depth: d, kind: 'unknown', text: `? ${n.type === 'if' ? `Condition (${n.branches[0].cond})` : `switch (${n.expr})`} — outcome unknown`, reason: 'no log line or stack frame inside its branches', ref: { key, line: n.line } });
            continue;
          }
          if (n.outcome === 'all conditions false' && n.type === 'if') {
            brs.forEach((b) => steps.push({ depth: d, kind: 'decision', text: `◇ Condition (${b.cond}) was FALSE`, reason: b.reason, ref: { key, line: b.line }, status: 'not-taken' }));
            continue;
          }
          if (n.type === 'if') {
            brs.forEach((b) => {
              if (b.kind === 'else') return;
              if (b.status === 'taken') steps.push({ depth: d, kind: 'decision', text: `◆ Condition (${b.cond}) was TRUE`, reason: b.reason, ref: { key, line: b.line }, status: 'taken' });
              else if (b.status === 'not-taken') steps.push({ depth: d, kind: 'decision', text: `◇ Condition (${b.cond}) was FALSE`, reason: b.reason, ref: { key, line: b.line }, status: 'not-taken' });
            });
            if (taken?.kind === 'else') steps.push({ depth: d, kind: 'decision', text: '◆ Took the else-branch', reason: taken.reason, ref: { key, line: taken.line }, status: 'taken' });
          } else if (taken) steps.push({ depth: d, kind: 'decision', text: `◆ switch (${n.expr}) → ${taken.label}`, reason: taken.reason, ref: { key, line: taken.line }, status: 'taken' });
          if (taken) walkNodes(taken.body, d + 1);
          continue;
        }
        if (n.type === 'loop') {
          if (n.status === 'not-reached') continue;
          if (n.bodyStatus === 'not-taken') steps.push({ depth: d, kind: 'loop', text: `↻ Loop ${n.kind}(${n.cond}) — body never executed`, reason: n.reason, ref: { key, line: n.line } });
          else if (n.bodyStatus === 'taken') { steps.push({ depth: d, kind: 'loop', text: `↻ Loop ${n.kind}(${n.cond})${n.iterations ? ` — ${n.iterations} iteration(s) seen in logs` : ''}`, ref: { key, line: n.line } }); walkNodes(n.body, d + 1); }
          continue;
        }
        if (n.type === 'try') {
          if (n.status === 'not-reached') continue;
          steps.push({ depth: d, kind: 'try', text: 'try {', ref: { key, line: n.line } });
          walkNodes(n.body, d + 1);
          for (const c of n.catches) if (c.status === 'taken') { steps.push({ depth: d, kind: 'catch', text: `⚠ Exception caught by catch (${c.types.join(' | ')} ${c.var})`, reason: c.reason, ref: { key, line: c.line }, status: 'taken' }); walkNodes(c.body, d + 1); }
          if (n.finally) { steps.push({ depth: d, kind: 'try', text: 'finally {', ref: { key, line: n.finally.line } }); walkNodes(n.finally.body, d + 1); }
          continue;
        }
        if (n.type === 'block') { walkNodes(n.children, d); continue; }
        // simple statements
        for (const ev of n.evidence || []) if (ev.kind === 'log') { const e = sel[ev.entry]; steps.push({ depth: d, kind: 'log', text: e.message, level: e.level, ts: e.ts, entry: e.i, ref: { key, line: ev.line } }); }
        const kids = ['executed', 'inferred', 'failed'].includes(n.status) ? (involved.get(key)?.children || []).filter((c) => c.callNodeId === n.id && methodByKey.has(c.key) && !visited.has(c.key)) : [];
        if (kids.length) {
          steps.push({ depth: d, kind: 'call', text: `→ ${n.text.length > 110 ? n.text.slice(0, 107) + '…' : n.text}`, ref: { key, line: n.line } });
          for (const c of kids) narrate(c.key, d + 1, key);
        }
        if (n.status === 'failed') {
          const ex = n.exception;
          steps.push({ depth: d, kind: 'fail', text: n.failedHere ? `✖ FAILED here: ${n.text}` : `✖ Exception propagated through: ${n.text}`, detail: ex && ex.type ? `${ex.type}${ex.message ? ': ' + ex.message : ''}` : n.reason || null, ref: { key, line: n.line }, status: 'failed' });
        }
        if (n.type === 'return' && (n.status === 'executed' || n.status === 'inferred')) steps.push({ depth: d, kind: 'return', text: `↩ ${n.text}`, ref: { key, line: n.line } });
        if (n.type === 'throw' && n.status === 'executed') steps.push({ depth: d, kind: 'fail', text: `✖ ${n.text}`, ref: { key, line: n.line }, status: 'failed' });
      }
    })(m.nodes, depth + 1);
    if (m.skipped.length) steps.push({ depth: depth + 1, kind: 'skipped', text: `⏭ Not executed after the failure: ${m.skipped.slice(0, 6).map((s) => s.text.length > 60 ? s.text.slice(0, 57) + '…' : s.text).join('  ·  ')}${m.skipped.length > 6 ? `  (+${m.skipped.length - 6} more)` : ''}`, ref: { key, line: m.skipped[0].line } });
  }
  // order: whatever logged first comes first (filters → main flow → exception handlers)
  const treeTime = (t) => { let m = Infinity; (function w(n) { const ev = evidence.get(n.key) || []; for (const e of ev) if (e.entry != null) m = Math.min(m, e.entry); n.children.forEach(w); })(t); return m; };
  trees.sort((a, b) => treeTime(a) - treeTime(b));
  for (const t of trees) {
    const label = t.detached ? (t.stereotype === 'filter' ? 'Servlet filter (wraps the request)' : t.stereotype === 'advice' ? 'Exception handler (@ControllerAdvice)' : t.stereotype === 'listener' ? 'Message listener' : 'Also executed') : `Main flow${entryInfo ? ': ' + entryInfo.label : ''}`;
    steps.push({ depth: 0, kind: 'section', text: `${label} — ${t.className}.${t.method}()`, main: !t.detached });
    narrate(t.key, 0, null);
  }

  /* ---------- assemble ---------- */
  const t0 = parseTs(sel[0]?.ts); const t1 = parseTs(sel[sel.length - 1]?.ts);
  const strip = (n) => ({ key: n.key, cls: n.cls, className: n.className, method: n.method, line: n.line, file: n.file, stereotype: n.stereotype, detached: !!n.detached, silent: !!n.silent, callLine: n.callLine, status: methodByKey.get(n.key)?.status, children: n.children.map(strip) });
  Object.assign(result, {
    selected: sel.length,
    from: sel[0]?.ts || null, to: sel[sel.length - 1]?.ts || null, durationMs: t0 != null && t1 != null ? t1 - t0 : null,
    threads: [...new Set(sel.map((e) => e.thread).filter(Boolean))],
    entryPoint: entryInfo,
    outcome,
    callTree: trees.map(strip),
    methods: methodsOut,
    steps,
    entries: sel.map((e) => ({ i: e.i, lineNo: e.lineNo, ts: e.ts, level: e.level, thread: e.thread, logger: e.logger, message: e.message, extra: e.extra.slice(0, 80), mdc: e.mdc, match: e.match || null, exception: e.exception ? { type: e.exception.type, message: e.exception.message, chain: e.exception.chain.map((c) => ({ type: c.type, message: c.message, frames: (c.projectFrames || []).slice(0, 30), totalFrames: c.frames.length, inferredThrow: c.inferredThrow || null })) } : null })),
    unmatched: sel.filter((e) => !e.match || e.match.confidence === 'class-only').map((e) => e.i),
    stats: { matched: sel.filter((e) => e.match && e.match.confidence !== 'class-only').length, methods: methodsOut.length, decisions: steps.filter((s) => s.kind === 'decision').length },
  });
  try { result.diagnosis = diagnose({ code, report, sel, outcome, methods: methodsOut, trees, steps, entryInfo }); } catch (err) { result.diagnosis = { status: outcome.status, error: 'Diagnosis failed: ' + err.message }; }
  result.entries.forEach((e) => { e.values = sel[e.i].values || null; });
  return result;
}

/* ------------------------------------------------------------------ */
/* control-flow annotation                                             */
/* ------------------------------------------------------------------ */
/*
 * Statuses: executed (direct evidence) · inferred (must have run: later code ran) ·
 *           failed · taken / not-taken (branches) · not-reached · unknown
 */
function annotateMethod(me, evs, ctx) {
  const ev = evs.slice().sort((a, b) => a.line - b.line);
  const has = (from, to, kinds) => ev.some((e) => e.line >= from && e.line <= to && (!kinds || kinds.includes(e.kind)));
  const evIn = (from, to) => ev.filter((e) => e.line >= from && e.line <= to);
  const aborts = ev.filter((e) => e.kind === 'throw' || e.kind === 'call');
  const methodHasEvidence = ev.length > 0 || !!ctx.assumeRuns;
  const fillMessage = (th) => {
    const res = [];
    if (th.regex) try { res.push(new RegExp(th.regex, 's')); } catch { /* ignore */ }
    res.push(...(ctx.excTemplates?.get(th.exception) || []));
    for (const re of res) for (const e of ctx.sel) { const m = re.exec(e.message || ''); if (m) return m[0].trim(); }
    return th.regex ? th.template : null;
  };
  // method completes normally when the exception did not propagate out of it
  const completes = !ctx.propagates;
  const skipped = [];
  const out = { key: me.key, cls: me.t.fqn, className: me.t.name, method: me.m.name, signature: `${me.m.name}(${me.m.params.map((p) => `${p.typeInfo.name} ${p.name}`).join(', ')})`, line: me.m.line, endLine: me.m.endLine, file: me.t.file, stereotype: me.t.stereotype, annotations: me.m.annotations.map((a) => '@' + a.name), nodes: [], skipped, status: 'executed' };
  if (!me.cfg) return out;
  const clone = (nodes) => JSON.parse(JSON.stringify(nodes));
  const nodes = clone(me.cfg.nodes);

  const state = { aborted: false, returned: false, uncertain: false, failSeen: false };

  function markAll(list, status, reason) {
    for (const n of list || []) {
      n.status = status; if (reason && !n.reason) n.reason = reason;
      if (status === 'not-reached' && reason === 'after the failure point' && (n.type === 'stmt' || n.type === 'return' || n.type === 'throw') && (n.text || '').trim()) skipped.push({ text: n.text, line: n.line });
      if (n.type === 'if') n.branches.forEach((b) => { b.status = status === 'not-reached' ? 'not-reached' : status; markAll(b.body, status, reason); });
      else if (n.type === 'switch') n.cases.forEach((c) => { c.status = status; markAll(c.body, status, reason); });
      else if (n.type === 'loop') { n.bodyStatus = status; markAll(n.body, status, reason); }
      else if (n.type === 'try') { markAll(n.body, status, reason); n.catches.forEach((c) => { c.status = status; markAll(c.body, status, reason); }); if (n.finally) markAll(n.finally.body, status, reason); }
      else if (n.type === 'block') markAll(n.children, status, reason);
    }
  }
  const topLevelLog = (body) => {
    for (const n of body) {
      if (n.type !== 'stmt' && n.type !== 'return' && n.type !== 'throw') return null;
      const l = (n.logs || []).find((x) => ctx.enabled(me.t.fqn, x.level));
      if (l) return l;
      if (n.type !== 'stmt') return null;
    }
    return null;
  };
  const exitsEarly = (body) => body.some((n) => n.type === 'return' || n.type === 'throw');

  /** passes(n, continues): execution known to move past node n */
  function block(list, scopeEnd, continues) {
    for (let idx = 0; idx < list.length; idx++) {
      const n = list[idx];
      if (state.aborted || state.returned) { markAll([n], 'not-reached', state.aborted ? 'after the failure point' : 'method already returned'); continue; }
      const end = n.endLine;
      const later = has(end + 1, scopeEnd) || continues; // something after n (in this scope) ran
      const evHere = evIn(n.line, end);
      n.evidence = evHere.filter((e) => e.kind === 'log' || e.kind === 'callee').map((e) => ({ kind: e.kind, entry: e.entry, line: e.line, callee: e.callee }));
      n.calleeKeys = [...new Set(evHere.filter((e) => e.kind === 'callee').map((e) => e.callee))];
      if (n.type === 'block') { block(n.children, end, later); n.status = 'executed'; continue; }
      if (n.type === 'if' || n.type === 'switch') { decide(n, later); continue; }
      if (n.type === 'loop') { loop(n, later); continue; }
      if (n.type === 'try') { tryNode(n, later, scopeEnd, continues); continue; }
      // simple statement
      const abortHere = aborts.filter((a) => a.line >= n.line && a.line <= end);
      if (abortHere.length && !n.caughtLocally) {
        n.status = 'failed';
        n.failedHere = abortHere.some((a) => a.kind === 'throw');
        const a0 = abortHere.find((a) => a.kind === 'throw') || abortHere[0];
        n.exception = { type: a0.exception, message: a0.exceptionMessage || null };
        n.reason = n.failedHere ? 'exception thrown here (stack trace)' : abortHere.every((a) => a.inferred) ? 'the called method threw and nothing caught it' : 'exception propagated from the called method (stack trace)';
        state.aborted = true; state.failSeen = true; state.exception = n.exception;
        continue;
      }
      if (evHere.length) n.status = 'executed';
      else if (later && !state.uncertain) { n.status = 'inferred'; n.reason = 'code after this statement ran'; }
      else if (completes && methodHasEvidence && !state.uncertain) { n.status = 'inferred'; n.reason = 'method completed normally'; }
      else n.status = 'unknown';
      if (n.type === 'return' && (n.status === 'executed' || (n.status === 'inferred' && !later))) state.returned = true;
      if (n.type === 'throw' && (n.status === 'executed' || n.status === 'inferred')) {
        // a reached `throw` ends the method even without a stack trace in the logs
        const th = (n.throws || [])[0];
        n.status = 'failed'; n.failedHere = true; n.reason = 'this throw statement was reached (no stack trace logged)';
        n.exception = { type: th ? th.exception : 'Exception', message: th ? fillMessage(th) : null, inferred: true };
        state.aborted = true; state.failSeen = true; state.exception = n.exception;
      }
      if (n.status === 'failed' && !state.exception) state.exception = n.exception;
    }
  }

  function decide(n, later) {
    const brs = n.type === 'if' ? n.branches : n.cases;
    const hasElse = n.type === 'if' ? brs.some((b) => b.kind === 'else') : brs.some((c) => /^default\b/.test(c.label));
    const withEv = brs.filter((b) => has(b.line, b.endLine) && b.body.length);
    n.status = 'executed';
    if (withEv.length) {
      const taken = withEv[0];
      for (const b of brs) {
        if (b === taken) { b.status = 'taken'; b.reason = 'log lines / stack frames inside this branch'; }
        else { b.status = 'not-taken'; b.reason = 'another branch ran'; markAll(b.body, 'not-taken'); }
      }
      runBranch(taken, later);
      return;
    }
    // nothing observed inside any branch → reason about it
    const reached = later || ctx.propagates === false;
    let possible = [];
    for (const b of brs) {
      const lg = topLevelLog(b.body);
      if (lg && reached) { b.status = 'not-taken'; b.reason = `its log "${lg.template.slice(0, 60)}" (${lg.level}) does not appear in the logs`; markAll(b.body, 'not-taken'); continue; }
      if (exitsEarly(b.body) && later && n.type === 'if') { b.status = 'not-taken'; b.reason = 'this branch returns/throws, but execution continued after it'; markAll(b.body, 'not-taken'); continue; }
      possible.push(b);
    }
    if (n.type === 'if' && !hasElse && possible.length === 0) { n.outcome = 'all conditions false'; return; }
    if (possible.length === 1 && (hasElse || n.type === 'switch' && hasElse)) {
      const b = possible[0]; b.status = 'taken'; b.reason = 'all other branches were ruled out'; runBranch(b, later); return;
    }
    if (possible.length === 1 && n.type === 'if' && !hasElse && possible[0].body.length === 0) return;
    // undetermined
    for (const b of possible) { b.status = 'unknown'; markAll(b.body, 'unknown'); if (exitsEarly(b.body)) state.uncertain = true; }
    n.status = later || ctx.propagates === false ? 'executed' : 'unknown';
  }

  function runBranch(b, later) {
    block(b.body, b.endLine, later && !exitsEarly(b.body));
  }

  function loop(n, later) {
    const inside = evIn(n.line, n.endLine);
    if (inside.length) {
      n.status = 'executed'; n.bodyStatus = 'taken';
      const logsByLine = new Map();
      for (const e of inside.filter((x) => x.kind === 'log')) logsByLine.set(e.line, (logsByLine.get(e.line) || 0) + 1);
      n.iterations = logsByLine.size ? Math.max(...logsByLine.values()) : null;
      // code after the loop ran → every iteration completed its body (unless it can exit early)
      block(n.body, n.endLine, later && !exitsEarly(n.body) && !n.body.some((x) => x.type === 'break' || x.type === 'continue'));
      if (!state.aborted && !state.returned) {
        // inside a loop "after" markers are unreliable; lift unknowns preceding evidence
      }
      return;
    }
    const lg = topLevelLog(n.body);
    if (later || (completes && methodHasEvidence)) {
      n.status = later ? 'inferred' : 'inferred';
      if (lg) { n.bodyStatus = 'not-taken'; n.reason = `loop body log "${lg.template.slice(0, 60)}" never appears → zero iterations`; markAll(n.body, 'not-taken'); }
      else { n.bodyStatus = 'unknown'; markAll(n.body, 'unknown'); }
    } else { n.status = 'unknown'; n.bodyStatus = 'unknown'; markAll(n.body, 'unknown'); }
  }

  function tryNode(n, later, scopeEnd, continues) {
    n.status = 'executed';
    const tryEnd = n.body.length ? n.body[n.body.length - 1].endLine : n.line;
    const catchWithEv = n.catches.find((c) => has(c.line, c.endLine));
    const before = { ...state };
    block(n.body, tryEnd, later || !!catchWithEv);
    if (state.aborted && catchWithEv) {
      // exception was caught here
      state.aborted = false;
      catchWithEv.status = 'taken'; catchWithEv.reason = 'the try block failed and this catch block logged / rethrew';
      for (const c of n.catches) if (c !== catchWithEv) { c.status = 'not-taken'; markAll(c.body, 'not-taken'); }
      block(catchWithEv.body, catchWithEv.endLine, later);
    } else if (!state.aborted && catchWithEv) {
      // catch has evidence but no visible failure in try → exception without project frame
      catchWithEv.status = 'taken'; catchWithEv.reason = 'log lines inside this catch block';
      markFirstUnknownAsFailed(n.body);
      for (const c of n.catches) if (c !== catchWithEv) { c.status = 'not-taken'; markAll(c.body, 'not-taken'); }
      block(catchWithEv.body, catchWithEv.endLine, later);
    } else if (state.aborted) {
      for (const c of n.catches) { c.status = ctx.propagates ? 'not-taken' : 'unknown'; c.reason = ctx.propagates ? 'the exception propagated out of this method' : null; markAll(c.body, c.status); }
    } else {
      for (const c of n.catches) { c.status = later || completes ? 'not-taken' : 'unknown'; c.reason = c.status === 'not-taken' ? 'no exception in the try block' : null; markAll(c.body, c.status); }
    }
    if (n.finally) { const ab = state.aborted; state.aborted = false; block(n.finally.body, n.finally.body.length ? n.finally.body[n.finally.body.length - 1].endLine : n.line, later); state.aborted = ab; n.finally.status = 'executed'; }
    void before; void scopeEnd; void continues;
  }

  function markFirstUnknownAsFailed(list) {
    for (const n of list) { if (n.status === 'unknown' || n.status === 'inferred') { n.status = 'failed'; n.reason = 'the catch block ran, so this part of the try threw (no stack trace in the logs)'; return true; } }
    return false;
  }

  block(nodes, me.m.endLine || 1e9, false);
  out.nodes = nodes;
  out.thrownOut = state.aborted ? (state.exception || { type: 'Exception' }) : null;
  out.status = state.aborted ? 'failed' : state.failSeen ? 'recovered' : ev.length ? 'executed' : 'inferred';
  out.evidenceCount = ev.filter((e) => e.kind === 'log').length;
  return out;
}

module.exports = { loadCode, trace };
