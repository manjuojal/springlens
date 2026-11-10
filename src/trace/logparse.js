'use strict';
/**
 * Log file parsing: plain-text (Spring Boot default, Logback/Log4j patterns) and JSON lines
 * (logstash-logback-encoder, ECS, Log4j JSON). Multi-line entries (stack traces) are grouped.
 */

const TS_RE = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}[.,]\d{1,9}|\d{2}-\w{3}-\d{4} \d{2}:\d{2}:\d{2}[.,]\d+)\]?/;
const LEVEL_RE = /(?:^|[\s[|])(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|SEVERE)(?=[\s\]|:]|$)/;
const LEVEL_FIRST_RE = /^\[?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|SEVERE)\]?\s/;
const FRAME_RE = /^\s*at\s+([\w$.]+)\.([\w$<>-]+)\((?:([\w$-]+\.(?:java|kt|groovy|scala)):(\d+)|([^)]*))\)/;
const EXC_RE = /^\s*(Caused by:\s*|Suppressed:\s*)?((?:[a-z][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable|Fault|Failure)[\w$]*|[A-Z][\w$]*(?:Exception|Error))(?::\s?(.*))?$/;

const LEVEL_NORM = { WARNING: 'WARN', SEVERE: 'ERROR', FATAL: 'ERROR' };

function parseLog(text) {
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const json = line.trimStart().startsWith('{') ? tryJson(line) : null;
    if (json) { cur = fromJson(json, line, i + 1); entries.push(cur); continue; }
    if (TS_RE.test(line) || LEVEL_FIRST_RE.test(line)) { cur = fromText(line, i + 1); entries.push(cur); continue; }
    if (!cur) { cur = fromText(line, i + 1); entries.push(cur); continue; }
    cur.extra.push(line);
    cur.raw += '\n' + line;
  }
  for (const e of entries) {
    e.exception = parseStack([...(e.stackText ? e.stackText.split(/\r?\n/) : []), ...e.extra], e.message);
    delete e.stackText;
    e.levelRank = rank(e.level);
  }
  return entries;
}

function tryJson(line) { try { const o = JSON.parse(line); return o && typeof o === 'object' ? o : null; } catch { return null; } }

function pick(o, keys) { for (const k of keys) { const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), o); if (v != null && v !== '') return v; } return null; }

function fromJson(o, raw, lineNo) {
  const level = String(pick(o, ['level', 'log.level', 'severity', 'levelname', 'lvl']) || '').toUpperCase();
  const mdc = {};
  for (const [k, v] of Object.entries(o.mdc || o.MDC || o.contextMap || o.context || {})) mdc[k] = String(v);
  for (const k of Object.keys(o)) if (/(trace|span|corr|request|txn|transaction|session|user|tenant)[-_.]?id$/i.test(k) || /^(traceId|spanId|correlationId|requestId|X-Request-Id)$/i.test(k)) mdc[k] = String(o[k]);
  const stack = pick(o, ['stack_trace', 'stackTrace', 'exception.stacktrace', 'error.stack_trace', 'exception', 'throwable', 'thrown.extendedStackTrace']);
  return {
    lineNo, raw, format: 'json',
    ts: String(pick(o, ['@timestamp', 'timestamp', 'time', 'ts', 'date', 'instant']) || ''),
    level: LEVEL_NORM[level] || level || 'INFO',
    thread: pick(o, ['thread_name', 'thread', 'threadName', 'process.thread.name']),
    logger: pick(o, ['logger_name', 'logger', 'loggerName', 'log.logger', 'name']),
    message: String(pick(o, ['message', 'msg', '@message', 'log']) || ''),
    mdc, extra: [], stackText: typeof stack === 'string' ? stack : stack ? JSON.stringify(stack) : null,
  };
}

function fromText(line, lineNo) {
  let rest = line;
  const tm = TS_RE.exec(rest);
  const ts = tm ? tm[1] : null;
  if (tm) rest = rest.slice(tm[0].length);
  const lm = LEVEL_RE.exec(' ' + rest.slice(0, 120));
  const level = lm ? (LEVEL_NORM[lm[1]] || lm[1]) : null;
  const mdc = {};
  const brackets = [];
  const bre = /\[([^\]]{1,200})\]/g; let b;
  // header = before message separator
  let logger = null; let message = rest; let header = rest;
  const sb = /(?:^|\s)([\w$.\-[\]]*[\w$])\s+:\s(.*)$/.exec(rest); // Spring Boot: "logger : message"
  const dash = /(?:^|\s)((?:[a-zA-Z_$][\w$]*\.)+[A-Za-z_$][\w$]*|[A-Z][\w$]+)(?::\d+)?\s+-\s(.*)$/.exec(rest); // Logback default: "logger - message"
  const sbOk = sb && /[.\w]/.test(sb[1]) && !/^\d+$/.test(sb[1]);
  if (sbOk && (!dash || sb.index <= dash.index)) { logger = sb[1].replace(/^\[|\]$/g, ''); message = sb[2]; header = rest.slice(0, sb.index + sb[0].length - sb[2].length); }
  else if (dash) { logger = dash[1]; message = dash[2]; header = rest.slice(0, dash.index + dash[0].length - dash[2].length); }
  else if (lm) { const after = rest.slice(rest.indexOf(lm[1]) + lm[1].length).replace(/^[\]\s:|-]+/, ''); message = after; header = rest.slice(0, rest.indexOf(lm[1]) + lm[1].length); }
  while ((b = bre.exec(header))) brackets.push(b[1]);
  let thread = null;
  for (const br of brackets) {
    const kv = br.split(/[,\s]+/).filter(Boolean);
    let hadKv = false;
    for (const p of kv) { const m = /^([\w.-]+)[=:](.+)$/.exec(p); if (m) { mdc[m[1]] = m[2]; hadKv = true; } }
    if (hadKv) continue;
    // Spring Boot 3 tracing: [app,traceId,spanId] / [traceId-spanId]
    const parts = br.split(',').map((x) => x.trim());
    if (parts.length >= 2 && parts.slice(1).some((x) => /^[0-9a-f]{16,32}$/i.test(x))) { mdc.traceId = parts.find((x) => /^[0-9a-f]{16,32}$/i.test(x)); continue; }
    if (!thread && /exec|thread|main|pool|task|worker|scheduling|http|nio|kafka|consumer|reactor|ForkJoin/i.test(br)) thread = br.trim();
  }
  return { lineNo, raw: line, format: 'text', ts, level: level || 'INFO', thread, logger, message: message.trim(), mdc, extra: [] };
}

function parseStack(lines, message) {
  const chain = [];
  let cur = null;
  const msgExc = message ? EXC_RE.exec(message.trim()) : null;
  for (const l of lines) {
    const f = FRAME_RE.exec(l);
    if (f) {
      if (!cur) { cur = { type: 'Unknown', message: '', frames: [] }; chain.push(cur); }
      cur.frames.push({ cls: f[1].replace(/\$\$.*$/, ''), method: f[2], file: f[3] || null, line: f[4] ? +f[4] : null, raw: l.trim() });
      continue;
    }
    const e = EXC_RE.exec(l);
    if (e) { cur = { type: e[2], message: (e[3] || '').trim(), frames: [], causedBy: !!e[1] }; chain.push(cur); continue; }
    if (cur && !cur.frames.length && !/^\s*\.\.\.\s*\d+\s*more/.test(l) && !/^\s*(at|Caused)/.test(l)) cur.message += (cur.message ? '\n' : '') + l.trim();
  }
  if (!chain.length && msgExc && /[A-Z]\w*(Exception|Error)/.test(msgExc[2])) chain.push({ type: msgExc[2], message: (msgExc[3] || '').trim(), frames: [] });
  if (!chain.length) return null;
  return { chain, type: chain[0].type, message: chain[0].message, root: chain[chain.length - 1] };
}

const RANKS = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4 };
function rank(l) { return RANKS[l] ?? 2; }

/** Find candidate correlation / trace / request ids. */
function detectIds(entries) {
  const counts = new Map();
  const add = (id, key, e) => {
    if (!id || id.length < 6 || /^\d{1,7}$/.test(id)) return;
    if (!counts.has(id)) counts.set(id, { id, key, count: 0, errors: 0, first: e.ts, last: e.ts, firstLine: e.lineNo });
    const c = counts.get(id); c.count++; c.last = e.ts || c.last; if (e.level === 'ERROR') c.errors++;
  };
  for (const e of entries) {
    const seen = new Set();
    const once = (id, key) => { if (!seen.has(id)) { seen.add(id); add(id, key, e); } };
    for (const [k, v] of Object.entries(e.mdc || {})) if (/(trace|corr|request|txn|transaction|req)[-_.]?id$|^x-request-id$/i.test(k)) once(v, k);
    const re = /\b(?:corr(?:elation)?[-_]?id|x-correlation-id|trace[-_]?id|request[-_]?id|x-request-id|req[-_]?id|txn[-_]?id|transaction[-_]?id)\b["']?\s*[=:]\s*["']?([\w-]{6,})/gi;
    let m; while ((m = re.exec(e.raw))) once(m[1], 'pattern');
    const uu = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
    while ((m = uu.exec(e.raw))) once(m[0], 'uuid');
  }
  return [...counts.values()].filter((c) => c.count >= 1).sort((a, b) => (b.errors > 0) - (a.errors > 0) || b.count - a.count).slice(0, 40);
}

function filterById(entries, id) {
  if (!id) return entries;
  const ids = String(id).split(/[\s,]+/).filter(Boolean);
  return entries.filter((e) => ids.some((x) => e.raw.includes(x) || Object.values(e.mdc || {}).includes(x)));
}

function parseTs(ts) {
  if (!ts) return null;
  let s = String(ts).replace(',', '.');
  if (/^\d{2}:\d{2}:\d{2}/.test(s)) s = '1970-01-01T' + s;
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

module.exports = { parseLog, detectIds, filterById, parseTs, rank };
