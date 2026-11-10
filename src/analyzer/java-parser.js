'use strict';
/**
 * Lightweight, dependency-free Java source parser.
 *
 * It is not a full Java grammar. It understands enough structure to drive
 * Spring analysis: package/imports, type declarations (class/interface/enum/
 * record/@interface, including nested types), annotations with attributes,
 * fields, constructors, methods (with parameters and raw bodies) and line numbers.
 *
 * Strategy: string/char literals and comments are masked first so braces and
 * parentheses inside them cannot confuse the brace matcher. String literals are
 * replaced by placeholders (\u0001<n>\u0002) and restored when reading
 * annotation attributes or call arguments.
 */

const JAVA_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'synchronized', 'super', 'this',
  'throw', 'else', 'do', 'try', 'finally', 'assert', 'case', 'instanceof', 'yield',
]);
const MODIFIERS = new Set([
  'public', 'protected', 'private', 'static', 'final', 'abstract', 'native', 'synchronized',
  'transient', 'volatile', 'strictfp', 'default', 'sealed', 'non-sealed',
]);

const PH_OPEN = '\u0001';
const PH_CLOSE = '\u0002';

function mask(src) {
  const strings = [];
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
    } else if (c === '"' && d === '"' && src[i + 2] === '"') {
      // text block
      let j = i + 3; let val = '';
      while (j < n && !(src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"' && src[j - 1] !== '\\')) { val += src[j]; j++; }
      strings.push(val.replace(/^\s*\n/, ''));
      const nl = (val.match(/\n/g) || []).length;
      out += '"' + PH_OPEN + (strings.length - 1) + PH_CLOSE + '"' + '\n'.repeat(nl);
      i = j + 3;
    } else if (c === '"') {
      let j = i + 1; let val = '';
      while (j < n && src[j] !== '"' && src[j] !== '\n') {
        if (src[j] === '\\') { val += src[j] + (src[j + 1] || ''); j += 2; continue; }
        val += src[j]; j++;
      }
      strings.push(unescape(val));
      out += '"' + PH_OPEN + (strings.length - 1) + PH_CLOSE + '"';
      i = j + 1;
    } else if (c === '\'') {
      let j = i + 1;
      while (j < n && src[j] !== '\'' && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      out += '\' \'';
      i = j + 1;
    } else {
      out += c; i++;
    }
  }
  return { code: out, strings };
}

function unescape(s) {
  return s.replace(/\\(.)/g, (m, ch) => ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '\'': '\'' }[ch] ?? ch));
}

function restore(text, strings) {
  return text.replace(/"\u0001(\d+)\u0002"/g, (m, idx) => JSON.stringify(strings[+idx]));
}

function lineIndex(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0; let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

function matchClose(code, openIdx, open = '{', close = '}') {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i];
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return code.length - 1;
}

/** Split [s,e) into member segments terminated by ';' or a {...} block at depth 0. */
function segments(code, s, e) {
  const segs = [];
  let segStart = s; let paren = 0; let i = s;
  while (i < e) {
    const c = code[i];
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (paren === 0 && c === ';') {
      segs.push({ start: segStart, header: code.slice(segStart, i), bodyStart: -1, bodyEnd: -1 });
      segStart = i + 1;
    } else if (paren === 0 && c === '{') {
      const close = matchClose(code, i);
      const header = code.slice(segStart, i);
      if (hasTopLevelAssign(header)) { i = close + 1; continue; } // field initializer containing a block
      segs.push({ start: segStart, header, bodyStart: i + 1, bodyEnd: close });
      segStart = close + 1; i = close + 1; continue;
    }
    i++;
  }
  const tail = code.slice(segStart, e);
  if (tail.trim()) segs.push({ start: segStart, header: tail, bodyStart: -1, bodyEnd: -1 });
  return segs;
}

function hasTopLevelAssign(header) {
  let paren = 0;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (c === '(') paren++; else if (c === ')') paren--;
    else if (paren === 0 && c === '=' && header[i + 1] !== '=' && !'!<>='.includes(header[i - 1])) return true;
  }
  return false;
}

/** Parse leading/interleaved annotations; returns {annotations, rest, restOffset}. */
function takeAnnotations(text, strings) {
  const annotations = [];
  let rest = '';
  let i = 0;
  const parts = [];
  while (i < text.length) {
    if (text[i] === '@' && text.slice(i, i + 10) !== '@interface') {
      const m = /^@([\w.]+)\s*/.exec(text.slice(i));
      if (!m) { rest += text[i]; i++; continue; }
      let j = i + m[0].length;
      let args = null;
      if (text[j] === '(') {
        const close = matchClose(text, j, '(', ')');
        args = text.slice(j + 1, close);
        j = close + 1;
      }
      const name = m[1].split('.').pop();
      annotations.push({ name, fqn: m[1], raw: restore(args ?? '', strings), attrs: parseAnnotationArgs(args, strings) });
      parts.push(' ');
      i = j;
    } else if (text[i] === '(') {
      // parameter lists etc. are copied verbatim: their annotations belong to parameters
      const close = matchClose(text, i, '(', ')');
      rest += text.slice(i, close + 1); i = close + 1;
    } else { rest += text[i]; i++; }
  }
  return { annotations, rest: rest.replace(/\s+/g, ' ').trim() };
}

/** Parse annotation arguments into {key: value|value[]}; bare value -> key "value". */
function parseAnnotationArgs(args, strings) {
  const attrs = {};
  if (args == null) return attrs;
  const parts = splitTopLevel(args, ',');
  for (const p of parts) {
    const part = p.trim();
    if (!part) continue;
    const eq = topLevelIndexOf(part, '=');
    let key = 'value'; let val = part;
    if (eq > 0 && /^\s*\w+\s*$/.test(part.slice(0, eq))) { key = part.slice(0, eq).trim(); val = part.slice(eq + 1).trim(); }
    attrs[key] = parseAnnoValue(val, strings);
  }
  return attrs;
}

function parseAnnoValue(val, strings) {
  val = val.trim();
  if (val.startsWith('{') && val.endsWith('}')) {
    return splitTopLevel(val.slice(1, -1), ',').map((v) => parseAnnoValue(v, strings)).filter((v) => v !== '');
  }
  // string concatenations: "a" + "b" or CONSTANT + "/x"
  const pieces = splitTopLevel(val, '+').map((s) => s.trim());
  if (pieces.length > 1) return pieces.map((p) => { const v = parseAnnoValue(p, strings); return typeof v === 'string' ? v : String(v); }).join('');
  const sm = /^"\u0001(\d+)\u0002"$/.exec(val);
  if (sm) return strings[+sm[1]];
  if (val.startsWith('@')) return restore(val, strings);
  // a constant reference (Foo.BAR, BAR): kept as a marker, resolved later against the project's constants
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(val) && !/^(true|false|null)$/.test(val) && !/\.class$/.test(val) && /[A-Z]/.test(val)) return `\u0003${val}\u0004`;
  return restore(val, strings).replace(/\s+/g, ' ');
}

function splitTopLevel(text, sep) {
  const out = []; let depth = 0; let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === '}' || c === ']' || c === '>') depth = Math.max(0, depth - (text[i - 1] === '-' && c === '>' ? 0 : 1));
    if (c === sep && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function topLevelIndexOf(text, ch) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('({['.includes(c)) depth++; else if (')}]'.includes(c)) depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

function stripModifiers(text) {
  const mods = [];
  let words = text.trim() + ' ';
  for (;;) {
    const m = /^([\w-]+)\s+/.exec(words);
    if (m && MODIFIERS.has(m[1])) { mods.push(m[1]); words = words.slice(m[0].length); } else break;
  }
  return { modifiers: mods, rest: words.trim() };
}

/** Simple type name + generic argument simple names, e.g. "Map<String, List<Owner>>" -> {name:'Map', args:['String','List','Owner']} */
function typeInfo(type) {
  const t = (type || '').trim();
  const base = t.replace(/<.*$/s, '').replace(/\.\.\.$/, '').replace(/\[\]/g, '').trim().split('.').pop();
  const generic = t.includes('<') ? t.slice(t.indexOf('<') + 1, t.lastIndexOf('>')) : '';
  const args = (generic.match(/[A-Za-z_][\w.]*/g) || []).map((x) => x.split('.').pop()).filter((x) => x !== 'extends' && x !== 'super');
  return { raw: t, name: base, args, array: /\[\]/.test(t) || /\.\.\.$/.test(t) };
}

function parseParams(paramText, strings) {
  if (!paramText.trim()) return [];
  return splitTopLevel(paramText, ',').map((p) => {
    const { annotations, rest } = takeAnnotations(p, strings);
    const r = rest.replace(/^final\s+/, '').trim();
    const m = /^(.*?)\s*(\.\.\.)?\s*([\w$]+)$/s.exec(r);
    if (!m) return { name: r, type: '', typeInfo: typeInfo(''), annotations };
    const type = (m[1] + (m[2] || '')).trim();
    return { name: m[3], type, typeInfo: typeInfo(type), annotations };
  });
}

function parseTypeHeader(rest) {
  const m = /\b(class|interface|enum|record|@interface)\s+([\w$]+)\s*(<[^{]*?>)?/.exec(rest);
  if (!m) return null;
  const { modifiers } = stripModifiers(rest.slice(0, m.index) + ' ');
  const after = rest.slice(m.index + m[0].length);
  let recordComponents = '';
  let tail = after;
  if (m[1] === 'record' && after.trim().startsWith('(')) {
    const open = after.indexOf('(');
    const close = matchClose(after, open, '(', ')');
    recordComponents = after.slice(open + 1, close);
    tail = after.slice(close + 1);
  }
  const ext = /\bextends\s+(.+?)(?=\bimplements\b|\bpermits\b|$)/s.exec(tail);
  const impl = /\bimplements\s+(.+?)(?=\bpermits\b|$)/s.exec(tail);
  const split = (s) => (s ? splitTopLevel(s[1], ',').map((x) => x.trim()).filter(Boolean) : []);
  return {
    kind: m[1] === '@interface' ? 'annotation' : m[1],
    name: m[2],
    modifiers,
    extends: split(ext),
    implements: split(impl),
    recordComponents,
  };
}

function parseFile(src, file) {
  const { code, strings } = mask(src);
  const lineOf = lineIndex(code);
  const pkg = (/\bpackage\s+([\w.]+)\s*;/.exec(code) || [])[1] || '';
  const imports = [];
  const importRe = /\bimport\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;/g;
  let im;
  while ((im = importRe.exec(code))) imports.push({ static: !!im[1], name: im[2] });

  const types = [];

  function parseBody(seg, outer) {
    const { annotations, rest } = takeAnnotations(seg.header, strings);
    const th = parseTypeHeader(rest);
    if (!th) return null;
    const t = {
      ...th,
      fqn: (outer ? outer.fqn + '.' : (pkg ? pkg + '.' : '')) + th.name,
      pkg,
      outer: outer ? outer.fqn : null,
      file,
      line: lineOf(seg.start + seg.header.search(/\S/)),
      endLine: lineOf(seg.bodyEnd),
      annotations,
      fields: [],
      methods: [],
      constructors: [],
      enumConstants: [],
      nested: [],
    };
    if (th.recordComponents) {
      for (const p of parseParams(th.recordComponents, strings)) t.fields.push({ ...p, modifiers: ['private', 'final'], line: t.line, record: true });
      t.constructors.push({ params: parseParams(th.recordComponents, strings), annotations: [], line: t.line, implicit: true });
    }
    let segs = segments(code, seg.bodyStart, seg.bodyEnd);
    if (t.kind === 'enum' && segs.length) {
      // first segment (up to ';') holds constants
      const first = segs[0];
      if (first.bodyStart === -1) {
        t.enumConstants = splitTopLevel(first.header, ',').map((x) => takeAnnotations(x, strings).rest.replace(/\(.*$/s, '').trim()).filter((x) => /^\w+$/.test(x));
        segs = segs.slice(1);
      } else {
        const consts = splitTopLevel(code.slice(seg.bodyStart, seg.bodyEnd).split(';')[0], ',');
        t.enumConstants = consts.map((x) => x.replace(/[({].*$/s, '').trim()).filter((x) => /^\w+$/.test(x));
      }
    }
    for (const s of segs) parseMember(s, t);
    return t;
  }

  function parseMember(s, t) {
    if (!s.header.trim()) return;
    const { annotations, rest } = takeAnnotations(s.header, strings);
    const line = lineOf(s.start + Math.max(0, s.header.search(/\S/)));
    if (s.bodyStart !== -1 && /\b(class|interface|enum|record|@interface)\s+[\w$]+/.test(rest) && !/\(\s*\)\s*$/.test(rest.split(/\b(class|interface|enum|record)\b/)[0])) {
      const nested = parseBody(s, t);
      if (nested) { t.nested.push(nested.fqn); types.push(nested); }
      return;
    }
    if (/^(static)?$/.test(rest.trim())) return; // initializer block
    const parenIdx = topLevelParen(rest);
    if (parenIdx > -1 && !hasTopLevelAssign(rest.slice(0, parenIdx))) {
      const before = rest.slice(0, parenIdx).trim();
      const close = matchClose(rest, parenIdx, '(', ')');
      const paramText = rest.slice(parenIdx + 1, close);
      const afterParams = rest.slice(close + 1);
      const nm = /([\w$]+)$/.exec(before);
      if (!nm) return;
      const name = nm[1];
      const { modifiers, rest: typePart } = stripModifiers(before.slice(0, nm.index) + ' ');
      const returnType = typePart.replace(/^<[^>]*>\s*/, '').trim();
      const params = parseParams(paramText, strings);
      const throwsM = /\bthrows\s+(.+)$/.exec(afterParams);
      const body = s.bodyStart !== -1 ? code.slice(s.bodyStart, s.bodyEnd) : null;
      const member = {
        name,
        modifiers,
        annotations,
        params,
        line,
        endLine: s.bodyEnd !== -1 ? lineOf(s.bodyEnd) : line,
        throws: throwsM ? throwsM[1].split(',').map((x) => x.trim()) : [],
        body,
        bodyLine: s.bodyStart !== -1 ? lineOf(s.bodyStart) : line,
      };
      if (!returnType && name === t.name) t.constructors.push(member);
      else if (returnType || t.kind === 'annotation') t.methods.push({ ...member, returnType, returnTypeInfo: typeInfo(returnType) });
      return;
    }
    // field(s)
    const decl = rest.split(/=(?!=)/)[0].trim();
    const { modifiers, rest: d } = stripModifiers(decl + ' ');
    const fm = /^(.*?)\s+([\w$]+)\s*(\[\])?\s*$/s.exec(d.trim());
    if (!fm) return;
    const initializer = rest.includes('=') ? restore(rest.slice(rest.search(/=(?!=)/) + 1).trim(), strings) : null;
    const type = fm[1].trim();
    if (!type || /[(){}]/.test(type)) return;
    t.fields.push({ name: fm[2], type, typeInfo: typeInfo(type), modifiers, annotations, line, initializer });
  }

  const topSegs = segments(code, 0, code.length);
  for (const s of topSegs) {
    if (s.bodyStart === -1) continue;
    const t = parseBody(s, null);
    if (t) types.push(t);
  }
  return { file, pkg, imports, types, strings, restore: (txt) => restore(txt, strings) };
}

function topLevelParen(text) {
  let angle = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<') angle++; else if (c === '>') angle--;
    else if (c === '(' && angle <= 0) return i;
  }
  return -1;
}

/**
 * Extract call expressions from a (masked) method body in source order.
 * Returns [{receiver: 'repo'|'this'|null|'Foo', chain: 'a.b', method, args, offset}]
 */
function extractCalls(body, strings) {
  if (!body) return [];
  const calls = [];
  const re = /(?:\b((?:this\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*\(\s*\))?(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*)?\b([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    const method = m[2];
    if (JAVA_KEYWORDS.has(method)) continue;
    const before = body.slice(Math.max(0, m.index - 4), m.index);
    if (/new\s*$/.test(before) && !m[1]) continue; // constructor call
    const openIdx = m.index + m[0].length - 1;
    const close = matchClose(body, openIdx, '(', ')');
    const args = body.slice(openIdx + 1, close);
    let receiver = m[1] ? m[1].replace(/\s+/g, '') : null;
    const chained = !receiver && /\.\s*$/.test(body.slice(Math.max(0, m.index - 3), m.index));
    if (receiver) receiver = receiver.replace(/^this\./, '');
    // if receiver is a chain like a.b.c take first identifier, keep full chain for context
    calls.push({
      receiver: receiver ? receiver.split('.')[0].replace(/\(\)$/, '') : null,
      chain: receiver,
      chained,
      method,
      args: restore(args, strings).replace(/\s+/g, ' ').trim(),
      stringArgs: (args.match(/"\u0001(\d+)\u0002"/g) || []).map((x) => strings[+x.replace(/\D/g, '')]),
      offset: m.index,
    });
  }
  return calls;
}

/** Local variable declarations in a body: name -> type */
function extractLocals(body) {
  const locals = {};
  if (!body) return locals;
  const re = /\b([A-Z][\w$]*(?:<[^;=(){}]*>)?(?:\[\])?)\s+([a-z_$][\w$]*)\s*(?:=|;|:)/g;
  let m;
  while ((m = re.exec(body))) locals[m[2]] = typeInfo(m[1]);
  const varRe = /\bvar\s+([a-z_$][\w$]*)\s*=\s*(?:new\s+([A-Z][\w$]*)|([a-z_$][\w$]*)\s*\.)/g;
  while ((m = varRe.exec(body))) if (m[2]) locals[m[1]] = typeInfo(m[2]);
  return locals;
}

module.exports = { parseFile, extractCalls, extractLocals, typeInfo, mask };
