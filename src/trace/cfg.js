'use strict';
/**
 * Control-flow structure of a Java method body + index of log / throw statements.
 *
 * Works on the *masked* body produced by java-parser (string literals replaced by
 * placeholders, comments blanked) so braces/parens inside strings can't confuse us.
 *
 * Node shapes (offsets are relative to the method body):
 *   { type:'stmt'|'return'|'throw'|'break'|'continue', text, line, endLine, calls, logs, throws }
 *   { type:'block', children }
 *   { type:'if', branches:[{kind:'if'|'elseif'|'else', cond, line, body:[...]}] }
 *   { type:'loop', kind:'for'|'foreach'|'while'|'do', cond, line, body:[...] }
 *   { type:'try', resources, body:[...], catches:[{types, var, line, body}], finally:[...]|null }
 *   { type:'switch', expr, line, cases:[{label, line, body}] }
 */
const { extractCalls } = require('../analyzer/java-parser');

let nodeSeq = 0;

function buildCfg(method, file) {
  if (!method.body) return null;
  const s = method.body;
  const strings = file.strings;
  const base = method.bodyLine || method.line;
  const nl = [];
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') nl.push(i);
  const lineAt = (off) => { let lo = 0; let hi = nl.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < off) lo = mid + 1; else hi = mid; } return base + lo; };
  const restore = (txt) => file.restore(txt);
  const clean = (txt) => restore(txt).replace(/\s+/g, ' ').trim();

  function skipWs(i, end) { while (i < end && /\s/.test(s[i])) i++; return i; }
  function wordAt(i) { const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i, i + 40)); return m ? m[0] : null; }
  function match(i, open, close) {
    let d = 0;
    for (let j = i; j < s.length; j++) { if (s[j] === open) d++; else if (s[j] === close) { d--; if (d === 0) return j; } }
    return s.length - 1;
  }
  function stmtEnd(i, end) {
    let p = 0; let b = 0; let k = 0;
    for (let j = i; j < end; j++) {
      const c = s[j];
      if (c === '(') p++; else if (c === ')') p--;
      else if (c === '{') b++; else if (c === '}') { b--; if (b < 0) return j; }
      else if (c === '[') k++; else if (c === ']') k--;
      else if (c === ';' && p <= 0 && b <= 0 && k <= 0) return j;
    }
    return end;
  }

  function seq(i, end) {
    const out = [];
    for (;;) {
      i = skipWs(i, end);
      if (i >= end) break;
      const r = stmt(i, end);
      if (r.node) out.push(r.node);
      if (r.next <= i) i++; else i = r.next;
    }
    return out;
  }
  function bodyOf(i, end) {
    i = skipWs(i, end);
    const r = stmt(i, end);
    const body = !r.node ? [] : r.node.type === 'block' ? r.node.children : [r.node];
    return { body, next: r.next, start: i };
  }
  const mk = (o, start, endOff) => ({ id: ++nodeSeq, ...o, line: lineAt(start), endLine: lineAt(Math.max(start, endOff)) });

  function stmt(i, end) {
    if (s[i] === ';') return { node: null, next: i + 1 };
    if (s[i] === '{') { const c = match(i, '{', '}'); return { node: mk({ type: 'block', children: seq(i + 1, c) }, i, c), next: c + 1 }; }
    const w = wordAt(i);
    // label:
    if (w && !['default', 'case'].includes(w)) { const after = skipWs(i + w.length, end); if (s[after] === ':' && s[after + 1] !== ':') return { node: null, next: after + 1 }; }
    if (w === 'if') {
      const branches = [];
      let j = i; let kind = 'if';
      for (;;) {
        const p = s.indexOf('(', j); const pc = match(p, '(', ')');
        const b = bodyOf(pc + 1, end);
        branches.push({ kind, cond: clean(s.slice(p + 1, pc)), line: lineAt(j), endLine: lineAt(b.next - 1), body: b.body });
        let k = skipWs(b.next, end);
        if (wordAt(k) === 'else') {
          k = skipWs(k + 4, end);
          if (wordAt(k) === 'if') { j = k; kind = 'elseif'; continue; }
          const eb = bodyOf(k, end);
          branches.push({ kind: 'else', cond: null, line: lineAt(k), endLine: lineAt(eb.next - 1), body: eb.body });
          return { node: mk({ type: 'if', branches }, i, eb.next - 1), next: eb.next };
        }
        return { node: mk({ type: 'if', branches }, i, b.next - 1), next: b.next };
      }
    }
    if (w === 'for' || w === 'while') {
      const p = s.indexOf('(', i); const pc = match(p, '(', ')');
      const cond = clean(s.slice(p + 1, pc));
      const b = bodyOf(pc + 1, end);
      return { node: mk({ type: 'loop', kind: w === 'for' && /:/.test(cond) && !/;/.test(cond) ? 'foreach' : w, cond, body: b.body }, i, b.next - 1), next: b.next };
    }
    if (w === 'do') {
      const b = bodyOf(i + 2, end);
      let k = skipWs(b.next, end);
      let cond = '';
      if (wordAt(k) === 'while') { const p = s.indexOf('(', k); const pc = match(p, '(', ')'); cond = clean(s.slice(p + 1, pc)); k = stmtEnd(pc, end) + 1; }
      return { node: mk({ type: 'loop', kind: 'do', cond, body: b.body }, i, k - 1), next: k };
    }
    if (w === 'synchronized' && s[skipWs(i + 12, end)] === '(') {
      const p = s.indexOf('(', i); const pc = match(p, '(', ')');
      return stmt(skipWs(pc + 1, end), end);
    }
    if (w === 'try') {
      let k = skipWs(i + 3, end);
      let resources = null;
      if (s[k] === '(') { const pc = match(k, '(', ')'); resources = clean(s.slice(k + 1, pc)); k = skipWs(pc + 1, end); }
      const bc = match(k, '{', '}');
      const body = seq(k + 1, bc);
      k = skipWs(bc + 1, end);
      const catches = []; let fin = null;
      while (wordAt(k) === 'catch') {
        const p = s.indexOf('(', k); const pc = match(p, '(', ')');
        const decl = clean(s.slice(p + 1, pc)).replace(/^final\s+/, '');
        const m = /^(.*?)\s+([\w$]+)$/.exec(decl);
        const cb = skipWs(pc + 1, end); const cc = match(cb, '{', '}');
        catches.push({ types: m ? m[1].split('|').map((x) => x.trim().split('.').pop()) : [decl], var: m ? m[2] : null, line: lineAt(k), endLine: lineAt(cc), body: seq(cb + 1, cc) });
        k = skipWs(cc + 1, end);
      }
      let last = k - 1;
      if (wordAt(k) === 'finally') { const fb = skipWs(k + 7, end); const fc = match(fb, '{', '}'); fin = { line: lineAt(k), body: seq(fb + 1, fc) }; last = fc; k = fc + 1; }
      return { node: mk({ type: 'try', resources, body, catches, finally: fin }, i, last), next: k };
    }
    if (w === 'switch' && s[skipWs(i + 6, end)] === '(') {
      const p = s.indexOf('(', i); const pc = match(p, '(', ')');
      const bo = skipWs(pc + 1, end);
      if (s[bo] === '{') {
        const bc = match(bo, '{', '}');
        return { node: mk({ type: 'switch', expr: clean(s.slice(p + 1, pc)), cases: parseCases(bo + 1, bc) }, i, bc), next: bc + 1 };
      }
    }
    // simple statements
    const e = stmtEnd(i, end);
    const raw = s.slice(i, e);
    const type = w === 'return' ? 'return' : w === 'throw' ? 'throw' : w === 'break' ? 'break' : w === 'continue' ? 'continue' : w === 'yield' ? 'return' : 'stmt';
    const node = mk({ type, text: clean(raw) }, i, e);
    node.calls = extractCalls(raw, strings).filter((c) => !c.chained || true).map((c) => ({ receiver: c.receiver, method: c.method, chained: c.chained, line: lineAt(i + c.offset) }));
    node.logs = findLogs(raw, i);
    node.throws = findThrows(raw, type === 'throw');
    return { node, next: e + 1 };
  }

  function parseCases(i, end) {
    const cases = [];
    let k = skipWs(i, end);
    while (k < end) {
      const w = wordAt(k);
      if (w !== 'case' && w !== 'default') { const r = stmt(k, end); if (cases.length && r.node) cases[cases.length - 1].body.push(r.node); k = skipWs(Math.max(r.next, k + 1), end); continue; }
      // find ':' or '->' ending the label at depth 0
      let j = k + w.length; let p = 0; let arrow = false;
      for (; j < end; j++) {
        const c = s[j];
        if (c === '(') p++; else if (c === ')') p--;
        else if (p === 0 && c === '-' && s[j + 1] === '>') { arrow = true; break; }
        else if (p === 0 && c === ':' && s[j + 1] !== ':' && s[j - 1] !== ':') break;
      }
      const label = clean(s.slice(k, j));
      const kase = { label, line: lineAt(k), body: [] };
      cases.push(kase);
      k = skipWs(j + (arrow ? 2 : 1), end);
      if (arrow) { const r = stmt(k, end); if (r.node) kase.body.push(...(r.node.type === 'block' ? r.node.children : [r.node])); k = skipWs(r.next, end); continue; }
      while (k < end && !['case', 'default'].includes(wordAt(k))) { const r = stmt(k, end); if (r.node) kase.body.push(r.node); k = skipWs(Math.max(r.next, k + 1), end); }
    }
    for (const c of cases) c.endLine = c.body.length ? c.body[c.body.length - 1].endLine : c.line;
    return cases;
  }

  /* ---- log statements ---- */
  function findLogs(raw, off) {
    const out = [];
    const re = /\b([A-Za-z_$][\w$]*)\s*\.\s*(trace|debug|info|warn|error|fatal)\s*\(/g;
    let m;
    while ((m = re.exec(raw))) {
      if (!/^(log|logger|LOG|LOGGER|Log|Logger|LOGGING|logging|_log|\w*[Ll]og(ger)?|\w*LOG(GER)?)$/.test(m[1])) continue;
      const open = m.index + m[0].length - 1;
      const close = matchIn(raw, open);
      const args = splitArgs(raw.slice(open + 1, close));
      out.push(logInfo(m[2].toUpperCase(), args, lineAt(off + m.index)));
    }
    const so = /\bSystem\s*\.\s*(out|err)\s*\.\s*print(ln|f)?\s*\(/g;
    while ((m = so.exec(raw))) {
      const open = m.index + m[0].length - 1;
      out.push(logInfo(m[1] === 'err' ? 'ERROR' : 'INFO', splitArgs(raw.slice(open + 1, matchIn(raw, open))), lineAt(off + m.index), true));
    }
    return out;
  }
  function logInfo(level, args, line, stdout) {
    const tpl = templateOf(args[0] || '');
    const last = (args[args.length - 1] || '').trim();
    const withThrowable = args.length > 1 && /^(e|ex|exc|exception|t|th|throwable|err|error|cause|\w+Exception)$/.test(last);
    // expressions bound to the {} placeholders (only for plain SLF4J templates)
    const argExprs = tpl.pure ? args.slice(1, withThrowable && tpl.holes < args.length - 1 ? -1 : undefined).map((a) => clean(a)) : null;
    return { level: level === 'FATAL' ? 'ERROR' : level, line, template: tpl.display, regex: tpl.regex, literalLen: tpl.literalLen, argCount: Math.max(0, args.length - 1), argExprs, withThrowable, stdout: !!stdout };
  }
  function findThrows(raw, isThrow) {
    const out = [];
    const re = /\bnew\s+([A-Z][\w$.]*(?:Exception|Error|Throwable|Fault|Failure)[\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(raw))) {
      const open = m.index + m[0].length - 1;
      const args = splitArgs(raw.slice(open + 1, matchIn(raw, open)));
      const tpl = args.length ? templateOf(args[0]) : { display: '', regex: null, literalLen: 0 };
      out.push({ exception: m[1].split('.').pop(), direct: isThrow && raw.trim().startsWith('throw'), lazy: /->\s*new\s/.test(raw.slice(Math.max(0, m.index - 6), m.index + 4)) || /orElseThrow|Supplier/.test(raw), template: tpl.display, regex: tpl.regex, literalLen: tpl.literalLen });
    }
    if (isThrow && !out.length) out.push({ exception: raw.replace(/^\s*throw\s+/, '').trim().split(/[\s.(;]/)[0], direct: true, rethrow: true, template: '', regex: null, literalLen: 0 });
    return out;
  }
  function templateOf(arg) {
    // String.format("...", ..) / "...".formatted(..)
    let a = arg.trim();
    const fm = /^String\s*\.\s*format\s*\(\s*([\s\S]*)\)$/.exec(a);
    let printf = false;
    if (fm) { a = splitArgs(fm[1])[0] || ''; printf = true; }
    const fd = /^("\u0001\d+\u0002")\s*\.\s*formatted\s*\(/.exec(a);
    if (fd) { a = fd[1]; printf = true; }
    const pieces = splitTop(a, '+');
    const parts = []; let display = ''; let literalLen = 0;
    for (const piece of pieces) {
      const pm = /^\s*"\u0001(\d+)\u0002"\s*$/.exec(piece);
      if (pm) {
        const lit = strings[+pm[1]];
        const segs = lit.split(printf ? /%[-#+ 0,(]*\d*(?:\.\d+)?[a-zA-Z%]/ : /\{\}/);
        segs.forEach((seg, idx) => { if (idx > 0) parts.push(null); if (seg) { parts.push(seg); literalLen += seg.replace(/\s/g, '').length; } });
        display += printf ? lit.replace(/%[-#+ 0,(]*\d*(?:\.\d+)?[a-zA-Z]/g, '{}') : lit;
      } else { parts.push(null); display += '{' + clean(piece).slice(0, 30) + '}'; }
    }
    const merged = [];
    for (const p of parts) { if (p === null && merged[merged.length - 1] === null) continue; merged.push(p); }
    const body = merged.map((p) => (p === null ? '([\\s\\S]*?)' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
    const pure = pieces.length === 1 && /^\s*"\u0001\d+\u0002"\s*$/.test(pieces[0]) && !printf;
    const holes = parts.filter((p) => p === null).length;
    return { display, regex: literalLen ? body : null, literalLen, pure, holes: pure ? (display.match(/\{\}/g) || []).length : holes };
  }

  const nodes = seq(0, s.length);
  return { nodes, line: method.line, endLine: method.endLine };
}

/* helpers on arbitrary strings */
function matchIn(t, i) { let d = 0; for (let j = i; j < t.length; j++) { if (t[j] === '(') d++; else if (t[j] === ')') { d--; if (d === 0) return j; } } return t.length; }
function splitTop(t, sep) { const out = []; let d = 0; let cur = ''; for (const c of t) { if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; if (c === sep && d === 0) { out.push(cur); cur = ''; } else cur += c; } if (cur.trim()) out.push(cur); return out; }
function splitArgs(t) { return splitTop(t, ','); }

/** Flatten all nodes of a cfg (depth-first) with parent chain. */
function walk(nodes, fn, parents = []) {
  for (const n of nodes || []) {
    fn(n, parents);
    const kids = childBlocks(n);
    for (const k of kids) walk(k.body, fn, [...parents, { node: n, branch: k }]);
  }
}
function childBlocks(n) {
  if (n.type === 'block') return [{ body: n.children, kind: 'block' }];
  if (n.type === 'if') return n.branches;
  if (n.type === 'loop') return [{ body: n.body, kind: 'loop' }];
  if (n.type === 'try') return [{ body: n.body, kind: 'try' }, ...n.catches.map((c) => ({ ...c, kind: 'catch' })), ...(n.finally ? [{ ...n.finally, kind: 'finally' }] : [])];
  if (n.type === 'switch') return n.cases.map((c) => ({ ...c, kind: 'case' }));
  return [];
}

module.exports = { buildCfg, walk, childBlocks };
