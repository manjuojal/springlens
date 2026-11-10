'use strict';
/**
 * Root-cause diagnosis for a traced request: turns the annotated execution into an
 * explanation a person can act on — what failed, the exact line and *why*, how the error
 * travelled, the runtime values, the decisions that led there, side effects already done
 * (and whether they were rolled back), and what to check next.
 */
const { walk } = require('./cfg');
const { extractLocals } = require('../analyzer/java-parser');

const HTTP_TEXT = {
  400: 'Bad Request — the remote service rejected the request data (validation / malformed body).',
  401: 'Unauthorized — missing, expired or invalid credentials/token for the remote service.',
  402: 'Payment Required — the provider declined the payment (card declined, insufficient funds, limit, fraud check).',
  403: 'Forbidden — authenticated, but not allowed to perform this operation.',
  404: 'Not Found — the remote resource / URL does not exist (wrong id, wrong path or base URL).',
  405: 'Method Not Allowed — wrong HTTP method for that URL.',
  408: 'Request Timeout on the remote side.',
  409: 'Conflict — the resource state conflicts (duplicate, version mismatch, already processed).',
  415: 'Unsupported Media Type — wrong Content-Type.',
  422: 'Unprocessable Entity — request is well-formed but fails business validation remotely.',
  429: 'Too Many Requests — rate limit hit on the remote service.',
  500: 'Internal Server Error inside the remote service — check that service\'s logs.',
  502: 'Bad Gateway — a proxy/gateway could not reach the remote service.',
  503: 'Service Unavailable — remote service down, overloaded or in maintenance.',
  504: 'Gateway Timeout — the remote service was too slow.',
};

/* knowledge base: exception → category, explanation, checks */
const RULES = [
  { re: /(WebClientResponseException|HttpClientErrorException|HttpServerErrorException|HttpStatusCodeException|RestClientResponseException|FeignException)/, cat: 'remote-http', title: 'Remote HTTP call returned an error status' },
  { re: /(ConnectException|NoRouteToHost|UnknownHost|WebClientRequestException|ResourceAccessException|RetryableException|ConnectTimeout)/, cat: 'remote-io', title: 'Could not reach the remote service', explain: 'The network call never got a proper response: the host was unreachable, the DNS name could not be resolved, the connection was refused, or it timed out.', checks: ['Is the remote service up and reachable from this host (DNS, port, firewall, proxy)?', 'Is the configured base URL correct for this environment/profile?', 'Check connect/read timeouts and retry settings.'] },
  { re: /(SocketTimeoutException|ReadTimeoutException|TimeoutException|QueryTimeoutException)/, cat: 'timeout', title: 'Operation timed out', explain: 'The call took longer than the configured timeout.', checks: ['Check latency of the called system at that time.', 'Review the timeout configuration (and whether it is too low).', 'Look for slow queries / lock waits / GC pauses around this timestamp.'] },
  { re: /NullPointerException/, cat: 'npe', title: 'A value was null', explain: 'Code dereferenced a variable or return value that was null.', checks: ['Find where the null value came from (missing request field, empty DB column, unset config).', 'Add validation / Optional handling at the source.'] },
  { re: /(NoSuchElementException|EntityNotFoundException|EmptyResultDataAccessException|\w*NotFoundException)/, cat: 'not-found', title: 'Expected data was not found', explain: 'A lookup returned nothing (e.g. Optional.orElseThrow() on an empty result or a missing entity).', checks: ['Verify the id/key used in the lookup exists in the database of this environment.', 'Check whether the record was deleted or belongs to another tenant/profile.'] },
  { re: /(DataIntegrityViolationException|ConstraintViolationException|SQLIntegrityConstraintViolation|DuplicateKeyException)/, cat: 'db-constraint', title: 'Database constraint violated', explain: 'The database rejected the write: unique key, foreign key, NOT NULL or check constraint.', checks: ['Read the constraint name in the message to see which column/key failed.', 'Check for duplicates or missing parent rows.'] },
  { re: /(CannotGetJdbcConnection|JDBCConnectionException|CannotCreateTransaction|SQLTransientConnection|HikariPool|PSQLException.*connection|CommunicationsException)/, cat: 'db-connection', title: 'Database connection problem', explain: 'No database connection could be obtained (DB down, pool exhausted, wrong URL/credentials).', checks: ['Check DB availability and the datasource URL/credentials of the active profile.', 'Check Hikari pool size and connection leaks (pool exhausted).'] },
  { re: /(OptimisticLock|ObjectOptimisticLockingFailure|StaleObjectState|CannotAcquireLock|PessimisticLock|DeadlockLoser)/, cat: 'concurrency', title: 'Concurrent modification / locking conflict', explain: 'Another transaction changed or locked the same data at the same time.', checks: ['Look for parallel requests on the same entity around this time.', 'Consider retry on optimistic-lock failures.'] },
  { re: /(LazyInitializationException)/, cat: 'lazy', title: 'Lazy-loaded relation accessed outside a transaction', explain: 'A JPA relation was accessed after the persistence context/transaction was closed.', checks: ['Fetch the relation inside the transaction (JOIN FETCH / @EntityGraph) or map to a DTO earlier.'] },
  { re: /(HttpMessageNotReadable|JsonParseException|JsonMappingException|MismatchedInputException|InvalidFormatException)/, cat: 'bad-input', title: 'Request body could not be read', explain: 'The incoming JSON was malformed or did not match the expected type.', checks: ['Compare the client payload with the request DTO (field names, types, date formats).'] },
  { re: /(MethodArgumentNotValid|BindException|ValidationException|ConstraintViolation)/, cat: 'validation', title: 'Input validation failed', explain: 'Bean validation (@Valid/@NotNull/@Size…) rejected the input.', checks: ['See which field failed in the message and fix the caller\'s payload.'] },
  { re: /(AccessDenied|AuthenticationException|InsufficientAuthentication|BadCredentials|JwtException|InvalidBearerToken)/, cat: 'security', title: 'Security rejected the request', explain: 'Authentication or authorization failed.', checks: ['Check the token/roles of the caller and the security rules for this path.'] },
  { re: /(NumberFormatException|DateTimeParseException|ParseException|ClassCastException|ArithmeticException|ArrayIndexOutOfBounds|IndexOutOfBounds)/, cat: 'bug', title: 'Programming / data format error', explain: 'The code received data in an unexpected format or performed an invalid operation.', checks: ['Inspect the input value at the failing line (see “Values” below).'] },
  { re: /(KafkaException|TimeoutException.*kafka|RecordTooLarge|SerializationException)/, cat: 'messaging', title: 'Messaging (Kafka) failure', explain: 'Publishing or consuming a message failed.', checks: ['Check broker availability, topic existence and serializer configuration.'] },
  { re: /(RedisConnectionFailure|RedisSystemException|RedisCommandTimeout)/, cat: 'cache', title: 'Redis/cache failure', explain: 'The cache could not be reached or the command failed.', checks: ['Check Redis availability and host/port of the active profile.'] },
  { re: /(IllegalArgumentException|IllegalStateException|\w+Exception)/, cat: 'business', title: 'Rejected by application logic', explain: 'The application deliberately threw this exception because a business rule / precondition was not met.' },
];

function categorize(type, message) {
  const simple = String(type || '').split('.').pop();
  for (const r of RULES) if (r.re.test(simple) || r.re.test(String(message || '').slice(0, 200))) return { ...r, simple };
  return { cat: 'unknown', title: 'Exception', simple };
}

function diagnose({ code, report, sel, outcome, methods, trees, steps, entryInfo }) {
  const { model } = code;
  const mByKey = new Map(methods.map((m) => [m.key, m]));
  const failed = outcome.status === 'failed';
  const d = { status: outcome.status };

  /* ---------- HTTP status of the response ---------- */
  let httpStatus = null;
  for (const e of [...sel].reverse()) {
    const m = /\b(?:status|returned|completed|response)\D{0,12}\b([1-5]\d\d)\b/i.exec(e.message || '');
    if (m) { httpStatus = +m[1]; d.statusSource = `log line ${e.lineNo}`; break; }
  }
  const handlers = trees.filter((t) => t.detached && t.stereotype === 'advice').map((t) => mByKey.get(t.key)).filter(Boolean);
  for (const hm of handlers) {
    const me = code.methods.get(hm.key);
    const rs = me && me.m.annotations.find((a) => a.name === 'ResponseStatus');
    if (rs) { const v = String(rs.attrs.value ?? rs.attrs.code ?? '').replace(/^.*\./, ''); d.handlerStatus = v; if (!httpStatus) { const num = STATUS_NUM[v]; if (num) { httpStatus = num; d.statusSource = `@ResponseStatus(${v}) on ${hm.className}.${hm.method}()`; } } }
  }
  d.httpStatus = httpStatus;

  /* ---------- values from log placeholders ---------- */
  d.values = [];
  for (const e of sel) for (const v of e.values || []) d.values.push({ name: v.name, value: v.value, entry: e.i, lineNo: e.lineNo, ts: e.ts, where: e.match ? `${e.match.className}.${e.match.method}():${e.match.line}` : null, ref: e.match ? { key: e.match.key, line: e.match.line } : null });

  /* ---------- decisions ---------- */
  d.decisions = steps.filter((s) => s.kind === 'decision' || s.kind === 'unknown' || s.kind === 'loop' || s.kind === 'catch').map((s) => ({ text: s.text, reason: s.reason || null, status: s.status || s.kind, ref: s.ref }));

  /* ---------- side effects (before the failure) ---------- */
  d.sideEffects = sideEffects(code, model, methods, trees, failed);

  if (!failed) {
    const warns = sel.filter((e) => e.level === 'WARN');
    d.summary = `${entryInfo ? entryInfo.label : 'The request'} completed${httpStatus ? ` with HTTP ${httpStatus}` : ''}${warns.length ? ` with ${warns.length} warning(s)` : ' successfully'}.`;
    d.warnings = warns.map((e) => ({ text: e.message, ref: e.match ? { key: e.match.key, line: e.match.line } : null, lineNo: e.lineNo }));
    return d;
  }

  /* ---------- root cause ---------- */
  const err = outcome.error || {};
  const rootType = err.rootType || err.type || 'Error';
  const rootMsg = err.rootMessage || err.exceptionMessage || err.message || '';
  const cat = categorize(rootType, rootMsg);
  const at = err.at;
  const rc = { type: rootType, simpleType: cat.simple, message: rootMsg, category: cat.cat, title: cat.title, at, statement: err.statement || null, why: [], checks: [...(cat.checks || [])] };

  // the annotated failing node + its guards (enclosing taken branches)
  let failNode = null; let guards = [];
  const fm = at && mByKey.get(at.key);
  if (fm) {
    walk(fm.nodes, (n, parents) => {
      if (n.status === 'failed' && at.line >= n.line && at.line <= n.endLine && !failNode) { failNode = n; guards = parents; }
    });
  }
  if (cat.cat === 'remote-http') {
    const hm = /\b([1-5]\d\d)\b\s*([A-Za-z][A-Za-z ]*?)?(?:\s+from\s+(GET|POST|PUT|DELETE|PATCH)\s+(\S+))?$/.exec(rootMsg) || /status(?:Code)?[=: ]+([1-5]\d\d)/i.exec(rootMsg);
    const code3 = hm ? +hm[1] : null;
    rc.remoteStatus = code3;
    rc.remoteCall = hm && hm[3] ? `${hm[3]} ${hm[4]}` : null;
    rc.why.push(`The remote call${rc.remoteCall ? ` ${rc.remoteCall}` : ''} answered HTTP ${code3 || '?'}${hm && hm[2] ? ' ' + hm[2].trim() : ''}.`);
    if (code3 && HTTP_TEXT[code3]) rc.why.push(HTTP_TEXT[code3]);
    rc.checks.push(code3 >= 500 ? 'Check the remote service\'s logs at this timestamp (search for the same correlation id there).' : 'Inspect the request that was sent (values below) and the remote service\'s error response body.');
    if (code3 === 401 || code3 === 403) rc.checks.push('Verify the credentials/token configured for this client in the active profile.');
    if (code3 === 404) rc.checks.push('Check the base URL and path of the client configuration for this environment.');
  } else if (cat.cat === 'npe') {
    const m = /because "?(.+?)"? is null/.exec(rootMsg) || /Cannot invoke "(.+?)"/.exec(rootMsg);
    if (m) rc.why.push(/return value of/.test(rootMsg) ? `The method call ${m[1].replace(/the return value of /, '')} returned null and its result was used.` : `${m[1]} was null when the code used it.`);
    else rc.why.push('A variable or method result used on this line was null.');
  } else if (cat.cat === 'not-found' && failNode) {
    const lk = /([\w.]+\s*\([^()]*\)(?:\s*\.\s*\w+\s*\([^()]*\))*)\s*\.\s*orElseThrow/.exec(failNode.text || '');
    if (lk) rc.why.push(`The lookup ${lk[1].replace(/\s+/g, '')} returned an empty result, so orElseThrow() threw.`);
    rc.why.push(cat.explain);
  } else if (cat.explain) rc.why.push(cat.explain);
  if (rootMsg && cat.cat === 'business') rc.why.push(`Message: “${rootMsg}”.`);

  // condition that guarded the throw / failing statement
  const guardTexts = [];
  for (const p of guards) {
    const b = p.branch;
    if (p.node.type === 'if' && b.status === 'taken') guardTexts.push({ text: b.kind === 'else' ? `else-branch of if (${p.node.branches[0].cond})` : `if (${b.cond}) was TRUE`, line: b.line, reason: b.reason });
    else if (p.node.type === 'switch' && b.status === 'taken') guardTexts.push({ text: `switch (${p.node.expr}) matched ${b.label}`, line: b.line });
    else if (p.node.type === 'try' && b.kind === 'catch') guardTexts.push({ text: `inside catch (${b.types.join(' | ')} ${b.var}) — handling an earlier exception`, line: b.line });
    else if (p.node.type === 'loop') guardTexts.push({ text: `inside loop ${p.node.kind} (${p.node.cond})`, line: p.node.line });
  }
  rc.guards = guardTexts;
  if (failNode) rc.stmtLines = [failNode.line, failNode.endLine];
  const vals = d.values.filter((v) => v.ref && at && v.ref.key === at.key).slice(-4).map((v) => `${v.name}=${v.value}`).join(', ');
  for (const g of guardTexts.filter((x) => /TRUE|matched/.test(x.text))) rc.checks.push(`Check why ${g.text.replace(/ was TRUE$/, '')} held for this request${vals ? ` (logged values: ${vals})` : ''} — inspect that data in the source system / database.`);
  if (cat.cat === 'business' && !guardTexts.length) rc.checks.push('Search the code for where this exception is thrown and which input leads there (see Code path tab).');
  if (guardTexts.length && failNode && failNode.type === 'throw') rc.why.unshift(`The code threw deliberately because ${guardTexts.filter((g) => /TRUE|matched/.test(g.text)).map((g) => g.text).join(' and ') || 'the enclosing condition held'} (line ${guardTexts[guardTexts.length - 1].line}).`);

  // client/infra used at the failing line
  if (failNode && at) {
    const me = code.methods.get(at.key);
    const cls = report.classes.find((c) => c.id === at.cls);
    if (me && cls) {
      const vars = varsOf(me, model);
      for (const c of failNode.calls || []) {
        const ti = c.receiver && vars[c.receiver];
        const inf = ti && cls.infra.find((i) => i.field === c.receiver);
        if (inf) {
          const conn = inf.connection && report.config.connections.find((x) => x.id === inf.connection);
          rc.target = { via: `${inf.type} ${c.receiver}`, service: conn ? conn.name : null, baseUrl: inf.baseUrl || conn?.url || null, configKey: conn?.keyProp || null };
          break;
        }
        const tt = ti && model.resolve(ti.name, me.t);
        if (tt && (tt.stereotype === 'client' || tt.stereotype === 'repository')) {
          const fc = tt.stereotype === 'client' ? report.clients.find((x) => x.id === tt.fqn) : null;
          rc.target = { via: `${tt.name}.${c.method}()`, service: fc ? (fc.serviceName || fc.url) : tt.stereotype === 'repository' ? 'database' : null, baseUrl: fc?.url || null };
          break;
        }
      }
    }
    if (rc.target?.baseUrl) rc.checks.push(`Target configured as ${rc.target.baseUrl}${rc.target.configKey ? ` (property ${rc.target.configKey})` : ''} — confirm it is correct for this environment.`);
  }
  // values logged in the failing method shortly before
  if (at) rc.valuesBefore = d.values.filter((v) => v.ref && v.ref.key === at.key).slice(-6);
  d.rootCause = rc;

  /* ---------- how the error travelled ---------- */
  d.propagation = propagation(code, methods, trees, sel, err, mByKey, handlers, httpStatus, d);

  /* ---------- summary ---------- */
  const where = at ? `${at.className}.${at.method}() line ${at.line}` : 'an unknown location';
  const what = cat.cat === 'remote-http' ? `the call ${rc.target?.service ? `to ${rc.target.service} ` : ''}${rc.remoteCall ? `(${rc.remoteCall}) ` : ''}returned HTTP ${rc.remoteStatus || '?'}` : cat.cat === 'business' ? `${cat.simple} was thrown: “${rootMsg}”` : `${cat.title.toLowerCase()} (${cat.simple}${rootMsg ? ': ' + rootMsg.slice(0, 120) : ''})`;
  d.summary = `${entryInfo ? entryInfo.label : 'The request'} failed${httpStatus ? ` with HTTP ${httpStatus}` : ''} because ${what} at ${where}.`;
  const lost = d.propagation.find((p) => p.kind === 'replaced');
  if (lost) rc.checks.push('The original exception is not passed as cause when rethrown — keep it (new X(msg, ex)) so the real reason stays visible in logs.');
  const notRolledBack = d.sideEffects.filter((s) => s.executed && s.persistent && !s.rolledBack);
  if (notRolledBack.length) rc.checks.push(`Possible inconsistency: ${notRolledBack.length} side effect(s) happened before the failure and were NOT rolled back (${notRolledBack.map((s) => s.label).join(', ')}). Consider compensation.`);
  return d;
}

const STATUS_NUM = { BAD_REQUEST: 400, UNAUTHORIZED: 401, PAYMENT_REQUIRED: 402, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, UNPROCESSABLE_ENTITY: 422, TOO_MANY_REQUESTS: 429, INTERNAL_SERVER_ERROR: 500, BAD_GATEWAY: 502, SERVICE_UNAVAILABLE: 503, GATEWAY_TIMEOUT: 504 };

function varsOf(me, model) {
  const vars = {};
  const fields = (t, seen = new Set()) => (!t || seen.has(t.fqn) ? [] : (seen.add(t.fqn), [...t.fields, ...t.extends.flatMap((s) => fields(model.resolve(s, t), seen))]));
  for (const f of fields(me.t)) vars[f.name] = f.typeInfo;
  for (const p of me.m.params) vars[p.name] = p.typeInfo;
  Object.assign(vars, extractLocals(me.m.body));
  return vars;
}

/** Timeline of the exception: thrown → caught → logged → wrapped → propagated → handled → response. */
function propagation(code, methods, trees, sel, err, mByKey, handlers, httpStatus) {
  const out = [];
  const main = trees.find((t) => !t.detached);
  if (!main) return out;
  // path root → deepest failing method
  let path = [];
  (function f(n, acc) { const next = [...acc, n]; if (mByKey.get(n.key)?.status === 'failed' && next.length > path.length) path = next; n.children.forEach((c) => f(c, next)); })(main, []);
  for (const n of [...path].reverse()) {
    const m = mByKey.get(n.key);
    const me = code.methods.get(n.key);
    if (!m || !me) continue;
    const tx = me.m.annotations.some((a) => a.name === 'Transactional') || me.t.annotations.some((a) => a.name === 'Transactional');
    const events = [];
    walk(m.nodes, (node, parents) => {
      const inCatch = parents.find((p) => p.branch && p.branch.kind === 'catch' && p.branch.status === 'taken');
      if (node.type === 'try') for (const c of node.catches) if (c.status === 'taken') events.push({ line: c.line, kind: 'caught', text: `Caught in ${m.className}.${m.method}() by catch (${c.types.join(' | ')} ${c.var})`, ref: { key: n.key, line: c.line } });
      for (const ev of node.evidence || []) if (ev.kind === 'log' && inCatch) { const e = sel[ev.entry]; events.push({ line: ev.line + 0.1, kind: 'logged', text: `Logged [${e.level}] “${e.message}”`, ref: { key: n.key, line: ev.line } }); }
      if (node.status === 'failed') {
        if (node.failedHere && node.type === 'throw' && inCatch) {
          const v = inCatch.branch.var;
          const keeps = v && new RegExp(`\\b${v}\\b`).test(node.text.replace(/^throw\s+/, ''));
          const same = new RegExp(`^throw\\s+${v}\\s*$`).test(node.text);
          events.push({ line: node.line, kind: same ? 'rethrown' : keeps ? 'wrapped' : 'replaced', text: same ? `Rethrown unchanged (line ${node.line})` : `Wrapped into ${node.exception?.type?.split('.').pop() || 'a new exception'} and rethrown${keeps ? ' — original kept as cause' : ' — ⚠ original exception NOT kept as cause'} (line ${node.line})`, ref: { key: n.key, line: node.line } });
        } else if (node.failedHere) {
          const lines = node.endLine > node.line ? `lines ${node.line}–${node.endLine}` : `line ${node.line}`;
          events.push({ line: node.line, kind: 'thrown', text: `${node.exception?.type?.split('.').pop() || 'Exception'} thrown in ${m.className}.${m.method}() ${lines}: ${node.text.length > 120 ? node.text.slice(0, 117) + '…' : node.text}`, ref: { key: n.key, line: node.line }, detail: node.exception?.message || null });
        } else {
          events.push({ line: node.line, kind: 'propagated', text: `Not caught in ${m.className}.${m.method}() — propagated out at line ${node.line}`, ref: { key: n.key, line: node.line } });
        }
      }
    });
    events.sort((a, b) => a.line - b.line);
    out.push(...events);
    if (tx && m.status === 'failed') out.push({ kind: 'rollback', text: `@Transactional on ${m.className}.${m.method}() → transaction ROLLED BACK (database changes made in it are undone)`, ref: { key: n.key, line: m.line } });
  }
  for (const hm of handlers) {
    const me = code.methods.get(hm.key);
    const rs = me && me.m.annotations.find((a) => a.name === 'ResponseStatus');
    out.push({ kind: 'handled', text: `Handled by ${hm.className}.${hm.method}() (@ControllerAdvice)${rs ? ` → @ResponseStatus(${String(rs.attrs.value ?? rs.attrs.code).replace(/^.*\./, '')})` : ''}`, ref: { key: hm.key, line: hm.line } });
  }
  if (httpStatus) out.push({ kind: 'response', text: `Client received HTTP ${httpStatus}` });
  return out;
}

/** Writes / remote calls / messages performed before the failure, and whether they were undone. */
function sideEffects(code, model, methods, trees, failed) {
  const out = [];
  const mByKey = new Map(methods.map((m) => [m.key, m]));
  const parentOf = new Map();
  (function f(list, parent) { for (const n of list) { if (parent) parentOf.set(n.key, parent.key); f(n.children, n); } })(trees, null);
  const txFailedAbove = (key) => {
    for (let k = key; k; k = parentOf.get(k)) {
      const me = code.methods.get(k); const m = mByKey.get(k);
      if (me && m && m.status === 'failed' && (me.m.annotations.some((a) => a.name === 'Transactional') || me.t.annotations.some((a) => a.name === 'Transactional'))) return `${m.className}.${m.method}()`;
    }
    return null;
  };
  for (const m of methods) {
    const me = code.methods.get(m.key);
    if (!me) continue;
    const vars = varsOf(me, model);
    walk(m.nodes, (n) => {
      if (!n.calls || !['executed', 'inferred'].includes(n.status)) return;
      for (const c of n.calls) {
        if (c.chained || !c.receiver) continue;
        const ti = vars[c.receiver];
        if (!ti) continue;
        const t = model.resolve(ti.name, me.t);
        let kind = null; let label = null; let persistent = true;
        if (t && t.stereotype === 'repository' && /^(save|saveAll|saveAndFlush|delete\w*|update\w*|insert\w*|persist|merge|remove\w*)/.test(c.method)) { kind = 'db-write'; label = `${t.name}.${c.method}()`; }
        else if (t && t.stereotype === 'client') { kind = 'remote-call'; label = `${t.name}.${c.method}()`; }
        else if (/^(WebClient|RestTemplate|RestClient)$/.test(ti.name)) { kind = 'remote-call'; label = `${ti.name} ${c.receiver}.${c.method}()`; }
        else if (/^(KafkaTemplate|RabbitTemplate|JmsTemplate|StreamBridge|AmqpTemplate)$/.test(ti.name) && /send|publish|convert/.test(c.method)) { kind = 'message'; label = `${ti.name.replace('Template', '')} ${c.method}`; }
        else if (ti.name === 'ApplicationEventPublisher') { kind = 'event'; label = 'Spring event published'; persistent = false; }
        else if (/^(JavaMailSender|MailSender)$/.test(ti.name)) { kind = 'mail'; label = 'e-mail sent'; }
        if (!kind) continue;
        const tx = failed ? txFailedAbove(m.key) : null;
        const rolledBack = kind === 'db-write' && !!tx;
        out.push({ kind, label, statement: n.text, executed: true, certain: n.status === 'executed', persistent, rolledBack, ref: { key: m.key, line: n.line }, method: `${m.className}.${m.method}()`,
          note: kind === 'db-write' ? (rolledBack ? `undone — transaction of ${tx} rolled back` : failed ? 'committed — not inside a failed transaction' : 'committed')
            : failed ? 'already happened — NOT undone by a database rollback' : null });
      }
    });
  }
  return out;
}

module.exports = { diagnose, categorize };
