'use strict';
const { extractCalls, extractLocals } = require('./java-parser');

const MAX_DEPTH = 8;
const HTTP_VERB = /\b(get|post|put|patch|delete|head|options|exchange|getForObject|getForEntity|postForObject|postForEntity|postForLocation|patchForObject|retrieve)\b/i;
const FLOW_ANNOS = /^(Transactional|Cacheable|CachePut|CacheEvict|Async|PreAuthorize|PostAuthorize|Secured|RolesAllowed|Retryable|CircuitBreaker|RateLimiter|Bulkhead|TimeLimiter|Timed|Validated|Lock|Modifying|Query|SendTo|Recover)$/;

function buildFlows(model) {
  const { byFqn, resolve, resolveBeans, INFRA_TYPES, eventListeners } = model;
  const globalPublishers = [];
  const globalHttpCalls = [];

  function findMethod(t, name, argc) {
    const chain = [t];
    const seen = new Set([t.fqn]);
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i];
      const cands = c.methods.filter((m) => m.name === name);
      const m = cands.find((x) => x.params.length === argc && x.body) || cands.find((x) => x.body) || cands[0];
      if (m) return { t: c, m };
      for (const s of [...c.extends, ...c.implements]) { const r = resolve(s, c); if (r && !seen.has(r.fqn)) { seen.add(r.fqn); chain.push(r); } }
    }
    return null;
  }

  function constantValue(t, ident) {
    if (!ident) return null;
    const parts = ident.split('.');
    const owner = parts.length > 1 ? resolve(parts[parts.length - 2], t) : t;
    const name = parts[parts.length - 1];
    const f = owner && owner.fields.find((x) => x.name === name);
    if (f && f.initializer) { const m = /^"(.*)"$/.exec(f.initializer.trim()); if (m) return m[1]; }
    // @Value("${app.topic}") String topic;  -> "${app.topic}" (resolved against config later)
    const v = f && f.annotations.find((a) => a.name === 'Value');
    if (v && typeof v.attrs.value === 'string') return v.attrs.value;
    return null;
  }

  function argc(args) {
    if (!args.trim()) return 0;
    let depth = 0; let n = 1;
    for (const c of args) { if ('({[<'.includes(c)) depth++; else if (')}]>'.includes(c)) depth--; else if (c === ',' && depth === 0) n++; }
    return n;
  }

  function flowAnnos(m) { return m.annotations.filter((a) => FLOW_ANNOS.test(a.name)).map((a) => '@' + a.name + (a.raw ? `(${a.raw.length > 80 ? a.raw.slice(0, 77) + '…' : a.raw})` : '')); }

  function trace(t, m, depth, stack) {
    const node = {
      class: t.fqn, className: t.name, stereotype: t.stereotype, method: m.name, line: m.line, file: t.file,
      signature: `${m.name}(${m.params.map((p) => p.typeInfo.name + ' ' + p.name).join(', ')})`,
      returnType: m.returnType || '', annotations: flowAnnos(m).concat(t.annotations.filter((a) => a.name === 'Transactional').map(() => '@Transactional (class)')), children: [],
    };
    if (!m.body || depth >= MAX_DEPTH) { if (m.body) node.truncated = true; return node; }
    const key = `${t.fqn}#${m.name}`;
    if (stack.has(key)) { node.recursive = true; return node; }
    stack.add(key);

    const vars = {};
    for (const f of t.fields) vars[f.name] = f.typeInfo;
    for (const p of m.params) vars[p.name] = p.typeInfo;
    Object.assign(vars, extractLocals(m.body));
    const restored = t._file.restore(m.body);
    const calls = extractCalls(m.body, t._file.strings);

    let last = null;
    for (const c of calls) {
      let child = null;
      if (c.chained) continue;
      if (!c.receiver) {
        // call to a method of the same class (or a parent class)
        if (c.method === m.name && depth > 0) continue;
        const found = findMethod(t, c.method, argc(c.args));
        if (found && found.m !== m && found.m.body) { child = trace(found.t, found.m, depth + 1, stack); child.self = true; }
      } else {
        let ti = vars[c.receiver];
        let staticCall = false;
        if (!ti && /^[A-Z]/.test(c.receiver)) { ti = { name: c.receiver, args: [] }; staticCall = true; }
        if (!ti) continue;
        const infra = INFRA_TYPES[ti.name] || (ti.name === 'Builder' && /webClient|restClient/i.test(c.receiver) ? INFRA_TYPES.WebClient : null);
        if (infra) {
          child = infraCall(t, m, c, infra, restored, ti);
        } else {
          const targets = staticCall ? [resolve(ti.name, t)].filter(Boolean).map((x) => ({ fqn: x.fqn })) : resolveBeans(ti.name, t, ti.args || []);
          const target = targets.find((x) => x.fqn) && byFqn.get(targets.find((x) => x.fqn).fqn);
          if (!target || target.fqn === t.fqn) { if (target && target.fqn === t.fqn) { const f = findMethod(t, c.method, argc(c.args)); if (f && f.m !== m && f.m.body) { child = trace(f.t, f.m, depth + 1, stack); child.self = true; } } }
          else if (!target.isBean && !staticCall && target.stereotype !== 'repository' && target.stereotype !== 'client') continue;
          else if (staticCall && !target.isBean) continue;
          else if (target.stereotype === 'repository') {
            const f = findMethod(target, c.method, argc(c.args));
            const query = f && f.m.annotations.find((a) => a.name === 'Query');
            const cls = model.classById.get(target.fqn);
            child = { kind: 'repository', class: target.fqn, className: target.name, stereotype: 'repository', method: c.method, signature: `${c.method}(${c.args.length > 60 ? '…' : c.args})`, entity: cls?.entity || null, query: query ? (query.attrs.value || query.raw) : null, native: query ? query.attrs.nativeQuery === 'true' : false, derived: !f || !f.m.body ? !query && /^(find|read|get|query|search|stream|count|exists|delete|remove)\w*By/.test(c.method) : false, inherited: !f, operation: repoOperation(c.method), line: f ? f.m.line : target.line, file: f ? f.t.file : target.file, annotations: f ? flowAnnos(f.m) : [], children: [] };
            if (f && f.m.body) { const sub = trace(f.t, f.m, depth + 1, stack); child = { ...sub, kind: 'repository', entity: cls?.entity || null }; }
          } else if (target.stereotype === 'client') {
            const f = findMethod(target, c.method, argc(c.args));
            const cl = model.clients.find((x) => x.id === target.fqn);
            const op = cl && cl.operations.find((o) => o.name === c.method);
            child = { kind: 'http-client', class: target.fqn, className: target.name, stereotype: 'client', method: c.method, signature: `${c.method}(…)`, service: cl ? (cl.serviceName || cl.url) : null, url: cl?.url || null, httpMethod: op?.method || null, path: op?.path || null, line: f ? f.m.line : target.line, file: target.file, children: [] };
            globalHttpCalls.push({ from: t.fqn, fromName: t.name, method: m.name, tech: 'Feign', target: child.service, httpMethod: child.httpMethod, url: child.path });
          } else {
            const f = findMethod(target, c.method, argc(c.args));
            if (!f) continue;
            if (f.m.body) child = trace(f.t, f.m, depth + 1, stack);
            else child = { class: target.fqn, className: target.name, stereotype: target.stereotype, method: c.method, signature: c.method + '(…)', line: f.m.line, file: f.t.file, annotations: flowAnnos(f.m), children: [] };
            if (targets.length > 1) child.alternatives = targets.map((x) => x.fqn).filter(Boolean);
            if (targets[0]?.via) child.via = targets[0].via;
            if (f.m.annotations.some((a) => a.name === 'Async')) child.async = true;
          }
        }
      }
      if (!child) continue;
      child.callLine = (m.bodyLine || m.line) + (m.body.slice(0, c.offset).match(/\n/g) || []).length;
      const sig = `${child.className}.${child.method}.${child.kind || ''}.${child.destination || ''}`;
      if (last === sig) { const prev = node.children[node.children.length - 1]; prev.repeat = (prev.repeat || 1) + 1; continue; }
      last = sig;
      node.children.push(child);
    }
    stack.delete(key);
    return node;
  }

  function infraCall(t, m, c, infra, restored, ti) {
    const stmt = sliceStatement(m.body, c.offset);
    const stmtRestored = t._file.restore(stmt);
    const strs = (stmtRestored.match(/"((?:[^"\\]|\\.)*)"/g) || []).map((s) => s.slice(1, -1));
    const base = { kind: infra.kind, tech: infra.tech, class: null, className: infra.tech, stereotype: 'infra', method: c.method, receiver: c.receiver, from: t.fqn, line: m.line, file: t.file, children: [] };
    if (infra.kind === 'http') {
      const verb = HTTP_VERB.exec(stmt);
      const uriCall = /\.uri\(\s*"([^"]*)"/.exec(stmtRestored);
      base.httpMethod = verb ? normalizeVerb(verb[1], stmtRestored) : null;
      base.url = uriCall ? uriCall[1] : strs[0] || (/\.uri\(\s*([\w.]+)/.exec(stmtRestored) || [])[1] || null;
      if (base.url && /^[A-Z_]+$/.test(base.url)) base.url = constantValue(t, base.url) || base.url;
      base.signature = `${base.httpMethod || 'HTTP'} ${base.url || '…'}`;
      globalHttpCalls.push({ from: t.fqn, fromName: t.name, method: m.name, tech: infra.tech, httpMethod: base.httpMethod, url: base.url, receiver: c.receiver });
    } else if (infra.kind === 'publish') {
      if (!/^(send|sendDefault|convertAndSend|convertSendAndReceive|publish|sendAndReceive|send\w*)$/.test(c.method)) return null;
      const first = c.args.split(',')[0].trim();
      base.destination = c.stringArgs[0] || constantValue(t, first) || first || null;
      if (infra.tech === 'RabbitMQ' && c.stringArgs.length > 1) { base.exchange = c.stringArgs[0]; base.routingKey = c.stringArgs[1]; base.destination = `${c.stringArgs[0]} / ${c.stringArgs[1]}`; }
      base.signature = `${c.method} → ${base.destination}`;
      globalPublishers.push({ class: t.fqn, className: t.name, method: m.name, tech: infra.tech, destination: base.destination, line: m.line });
    } else if (infra.kind === 'event') {
      if (!/publishEvent/.test(c.method)) return null;
      const evt = (/new\s+(\w+)/.exec(c.args) || [])[1] || (/^(\w+)$/.test(c.args.trim()) ? null : null);
      const local = evt ? null : extractLocals(m.body)[c.args.trim()];
      const eventType = evt || local?.name || c.args.trim();
      base.event = eventType;
      base.signature = `publishEvent(${eventType})`;
      for (const el of eventListeners.filter((e) => e.event && (e.event === eventType || e.event.endsWith('.' + eventType)))) {
        const lt = byFqn.get(el.class);
        const lm = lt && lt.methods.find((x) => x.name === el.method);
        if (lm) { const sub = trace(lt, lm, 7, new Set()); sub.event = true; sub.async = el.async; sub.transactionalPhase = el.transactional ? (el.phase || 'AFTER_COMMIT') : null; base.children.push(sub); }
      }
      globalPublishers.push({ class: t.fqn, className: t.name, method: m.name, tech: 'Spring Events', destination: eventType, line: m.line });
    } else if (infra.kind === 'cache') {
      base.key = c.stringArgs[0] || null;
      base.signature = `${c.receiver}.${c.method}(${c.args.length > 40 ? '…' : c.args})`;
    } else if (infra.kind === 'db') {
      base.query = strs.find((s) => /\b(select|insert|update|delete|merge|with)\b/i.test(s)) || null;
      // SQL held in a variable: String sql = "insert into student(...) values(" + ... + ")"; template.update(sql)
      const argVar = (/^\s*([a-zA-Z_$][\w$]*)\s*(,|$)/.exec(c.args) || [])[1];
      if (!base.query && argVar) {
        const asg = new RegExp(`\\b${argVar}\\s*=\\s*([\\s\\S]*?);`).exec(restored);
        if (asg) { const lits = (asg[1].match(/"((?:[^"\\]|\\.)*)"/g) || []).map((x) => x.slice(1, -1)); const q = lits.join('…'); if (/\b(select|insert|update|delete|merge|with|call)\b/i.test(q)) base.query = q; }
      }
      if (base.query) {
        const tm = /\b(?:from|into|update|join)\s+([\w.]+)/i.exec(base.query);
        base.table = tm ? tm[1] : null;
        base.operation = (/^\s*(\w+)/.exec(base.query) || [])[1]?.toUpperCase() || null;
      }
      base.signature = `${c.method}(${base.query ? '"' + (base.query.length > 50 ? base.query.slice(0, 47) + '…' : base.query) + '"' : '…'})`;
    } else {
      base.signature = `${c.method}(…)`;
    }
    return base;
  }

  function sliceStatement(body, offset) {
    let start = offset; while (start > 0 && !';{}'.includes(body[start - 1])) start--;
    let end = offset; let depth = 0;
    for (; end < body.length; end++) {
      const ch = body[end];
      if (ch === '(' || ch === '{') depth++; else if (ch === ')' || ch === '}') { depth--; if (depth < 0) break; } else if (ch === ';' && depth <= 0) break;
    }
    return body.slice(start, end);
  }

  function normalizeVerb(v, stmt) {
    const l = v.toLowerCase();
    if (l.startsWith('getfor') || l === 'get') return 'GET';
    if (l.startsWith('postfor') || l === 'post') return 'POST';
    if (l.startsWith('patchfor') || l === 'patch') return 'PATCH';
    if (['put', 'delete', 'head', 'options'].includes(l)) return l.toUpperCase();
    if (l === 'exchange') { const hm = /HttpMethod\.(\w+)/.exec(stmt); return hm ? hm[1] : 'EXCHANGE'; }
    if (l === 'retrieve') return null;
    return v.toUpperCase();
  }

  function repoOperation(name) {
    if (/^(save|saveAll|saveAndFlush|insert|persist|merge|update)/.test(name)) return 'write';
    if (/^(delete|remove)/.test(name)) return 'delete';
    if (/^count/.test(name)) return 'count';
    if (/^exists/.test(name)) return 'exists';
    return 'read';
  }

  /* ---------------- entry points ---------------- */
  const entries = [];
  const add = (kind, id, label, group, classFqn, methodName, extra = {}) => {
    const t = byFqn.get(classFqn);
    if (!t) return;
    const found = findMethod(t, methodName, extra.argc ?? -1);
    if (!found) return;
    const tree = trace(found.t, found.m, 0, new Set());
    entries.push({ kind, id, label, group, ...extra, tree, stats: stats(tree) });
  };
  for (const e of model.endpoints) add('http', e.id, `${e.method} ${e.path}`, e.controllerName, e.controller, e.handler, { method: e.method, path: e.path, endpoint: e.id, argc: e.params.length });
  for (const l of model.listeners) add('listener', `listener:${l.class}#${l.method}`, `${l.tech} ${l.destinations.join(', ')}`, l.className, l.class, l.method, { tech: l.tech, destinations: l.destinations });
  for (const s of model.scheduled) add('scheduled', `scheduled:${s.class}#${s.method}`, `${s.className}.${s.method}() — ${s.cron ? 'cron ' + s.cron : s.fixedRate ? 'every ' + s.fixedRate + 'ms' : s.fixedDelay ? 'delay ' + s.fixedDelay + 'ms' : ''}`, s.className, s.class, s.method, { schedule: s });
  for (const r of model.runners) add('runner', `runner:${r.class}#${r.method}`, `${r.kind}: ${r.className}.${r.method}()`, r.className, r.class, r.method, {});
  for (const ev of model.eventListeners) add('event', `event:${ev.class}#${ev.method}`, `on ${ev.event || 'event'} → ${ev.className}.${ev.method}()`, ev.className, ev.class, ev.method, { event: ev.event });

  return { entries, publishers: dedupe(globalPublishers), httpCalls: dedupe(globalHttpCalls) };
}

function stats(tree) {
  const s = { depth: 0, calls: 0, repositories: new Set(), external: 0, publishes: 0, entities: new Set() };
  (function walk(n, d) {
    s.depth = Math.max(s.depth, d);
    for (const c of n.children || []) {
      s.calls++;
      if (c.kind === 'repository') { s.repositories.add(c.className); if (c.entity) s.entities.add(c.entity.split('.').pop()); }
      if (c.kind === 'http' || c.kind === 'http-client') s.external++;
      if (c.kind === 'publish' || c.kind === 'event') s.publishes++;
      walk(c, d + 1);
    }
  })(tree, 0);
  return { depth: s.depth, calls: s.calls, repositories: [...s.repositories], external: s.external, publishes: s.publishes, entities: [...s.entities] };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

module.exports = { buildFlows };
