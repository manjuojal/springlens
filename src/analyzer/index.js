'use strict';
const path = require('path');
const { listFiles, read, classify } = require('./files');
const { parseFile } = require('./java-parser');
const { parsePom, parseGradle, mergeBuilds } = require('./build');
const { parseConfigFile, analyzeConfig, resolveValue } = require('./config');
const { buildModel } = require('./spring');
const { buildFlows } = require('./flows');
const { parseOpenApi, parseCompose, parseK8s, parseDockerfile } = require('./infra');
const { buildStartup } = require('./startup');

/**
 * Analyze a Spring project directory and return a JSON-serializable report.
 * @param {string} root absolute path to the project
 * @param {{includeTests?: boolean, name?: string, source?: object}} opts
 */
function analyzeProject(root, opts = {}) {
  const t0 = Date.now();
  const files = listFiles(root);
  const warnings = [];

  /* build */
  const builds = [];
  for (const f of files) {
    const c = classify(f);
    if (c.pom) try { builds.push(parsePom(read(root, f), f)); } catch (e) { warnings.push(`${f}: ${e.message}`); }
    else if (c.gradle) try { builds.push(parseGradle(read(root, f), f)); } catch (e) { warnings.push(`${f}: ${e.message}`); }
  }
  const build = mergeBuilds(builds);

  /* java */
  const parsed = [];
  let javaFiles = 0; let kotlinFiles = 0; let loc = 0;
  for (const f of files) {
    const c = classify(f);
    if (c.kotlin && !c.isTest) kotlinFiles++;
    if (!c.java || (c.isTest && !opts.includeTests)) continue;
    javaFiles++;
    const src = read(root, f);
    loc += src.split('\n').length;
    try { parsed.push(parseFile(src, f)); } catch (e) { warnings.push(`${f}: parse error ${e.message}`); }
  }
  if (kotlinFiles && !javaFiles) warnings.push(`Found ${kotlinFiles} Kotlin files - Kotlin sources are not analyzed yet (Java only).`);
  const model = buildModel(parsed);

  /* config */
  const cfgDocs = [];
  for (const f of files) {
    const c = classify(f);
    if (!c.springConfig || c.isTest) continue;
    // Spring reads config from classpath resources, ./config/ or the working directory
    if (f.includes('/') && !/(^|\/)(resources|config)\//.test(f)) continue;
    try { cfgDocs.push(...parseConfigFile(read(root, f), f)); } catch (e) { warnings.push(`${f}: ${e.message}`); }
  }
  const config = analyzeConfig(cfgDocs, build.dependencies);

  /* infra / openapi */
  const infra = { compose: [], k8s: [], dockerfiles: [], openapi: [] };
  for (const f of files) {
    const c = classify(f);
    if (c.isTest) continue;
    if (c.compose) { const x = safe(() => parseCompose(read(root, f), f)); if (x) infra.compose.push(x); continue; }
    if (c.dockerfile) { infra.dockerfiles.push(parseDockerfile(read(root, f), f)); continue; }
    if ((c.yaml || c.json) && !c.springConfig) {
      const text = read(root, f);
      if (text.length > 3_000_000) continue;
      if (/^\s*["']?(openapi|swagger)["']?\s*:/m.test(text)) { const o = safe(() => parseOpenApi(text, f)); if (o) { infra.openapi.push(o); continue; } }
      if (c.yaml && /^\s*apiVersion\s*:/m.test(text) && /^\s*kind\s*:/m.test(text)) { const k = safe(() => parseK8s(text, f)); if (k && k.length) infra.k8s.push(...k); }
    }
  }

  /* flows */
  const flows = buildFlows(model);

  /* API reconciliation: code endpoints vs OpenAPI spec */
  const norm = (p) => p.replace(/\{[^}]+\}/g, '{}').replace(/\/$/, '') || '/';
  const specOps = infra.openapi.flatMap((o) => o.operations.map((op) => ({ ...op, spec: o.file })));
  const ctxPath = config.server.contextPath || '';
  for (const e of model.endpoints) {
    const m = specOps.find((op) => op.method === e.method && (norm(op.path) === norm(e.path) || norm(ctxPath + op.path) === norm(e.path) || norm(op.path) === norm(ctxPath + e.path)));
    e.inSpec = m ? { file: m.spec, operationId: m.operationId, summary: m.summary } : null;
    if (m && !e.summary) e.summary = m.summary;
  }
  for (const spec of infra.openapi) for (const op of spec.operations) op.implemented = model.endpoints.some((e) => e.method === op.method && (norm(op.path) === norm(e.path) || norm(ctxPath + op.path) === norm(e.path) || norm(op.path) === norm(ctxPath + e.path)));

  /* resolve ${placeholders} in code-level values against the default profile */
  const props = new Map(config.effective.default.map((p) => [p.key, p.resolved]));
  const res = (v) => (typeof v === 'string' && v.includes('${') ? resolveValue(v, (k) => props.get(k)) : v);
  for (const l of model.listeners) { l.destinationsRaw = l.destinations; l.destinations = l.destinations.map(res); if (l.group) l.group = res(l.group); }
  for (const s of model.scheduled) for (const k of ['cron', 'fixedRate', 'fixedDelay', 'initialDelay']) if (s[k]) { s[k + 'Raw'] = s[k]; s[k] = res(s[k]); }
  for (const c of model.clients) { c.urlRaw = c.url; c.url = res(c.url); c.serviceName = res(c.serviceName); }
  for (const p of flows.publishers) { p.destinationRaw = p.destination; p.destination = res(p.destination); }

  /* link programmatic HTTP clients (WebClient/RestTemplate beans) to configured endpoints */
  const httpConns = config.connections.filter((c) => c.type === 'http');
  const connForBean = (b) => {
    const keys = [];
    for (const p of b.params) {
      const cls = p.target && model.classById.get(p.target);
      const cp = cls && cls.annotations.find((a) => a.name === 'ConfigurationProperties');
      if (cp) keys.push(String(cp.raw).replace(/^(prefix|value)\s*=\s*/, '').replace(/"/g, ''));
    }
    const t = model.types.find((x) => x.fqn === b.config);
    const m = t && t.methods.find((x) => x.name === b.method);
    if (m) { const body = t._file.restore(m.body || '') + JSON.stringify(m.params.map((p) => p.annotations.map((a) => a.attrs))); for (const k of body.match(/\$\{([^}:]+)/g) || []) keys.push(k.slice(2)); }
    return httpConns.find((c) => keys.some((k) => c.id.startsWith(k) || c.keyProp.startsWith(k) || k.startsWith(c.id))) || null;
  };
  const httpBeans = model.beanDefs.filter((b) => /^(WebClient|RestTemplate|RestClient)$/.test(b.typeName)).map((b) => ({ ...b, conn: connForBean(b) }));
  for (const c of model.classes) for (const i of c.infra.filter((x) => x.kind === 'http')) {
    const cands = httpBeans.filter((b) => b.typeName === i.type);
    const b = cands.length === 1 ? cands[0] : cands.find((x) => x.name === i.field);
    if (b && b.conn) { i.connection = b.conn.id; i.baseUrl = b.conn.url; }
  }
  const linkHttp = (n) => {
    if (n.kind === 'http' && n.from) {
      const cls = model.classById.get(n.from);
      const i = cls && cls.infra.find((x) => x.field === n.receiver && x.connection);
      if (i) { n.connection = i.connection; n.baseUrl = i.baseUrl; n.service = httpConns.find((c) => c.id === i.connection)?.name; }
    }
    if (n.kind === 'http-client' && n.url) { n.urlRaw = n.url; n.url = res(n.url); n.service = res(n.service); }
    if (n.kind === 'publish' && n.destination) n.destination = res(n.destination);
    (n.children || []).forEach(linkHttp);
  };
  for (const f of flows.entries) { linkHttp(f.tree); if (f.destinations) f.destinations = f.destinations.map(res); if (f.label) f.label = res(f.label); }
  for (const h of flows.httpCalls) {
    const cls = model.classById.get(h.from);
    const i = cls && cls.infra.find((x) => x.field === h.receiver && x.connection);
    if (i) { h.connection = i.connection; h.baseUrl = i.baseUrl; }
    if (h.url) h.url = res(h.url); if (h.target) h.target = res(h.target);
  }

  /* data stores per repository */
  const primaryDb = config.connections.find((c) => c.type === 'database' && !/mongo/i.test(c.tech));
  const mongo = config.connections.find((c) => /mongo/i.test(c.tech));
  const redis = config.connections.find((c) => c.tech === 'Redis');
  for (const c of model.classes.filter((x) => x.stereotype === 'repository')) {
    const base = c.repoBase || '';
    c.dataStore = /Mongo/.test(base) ? mongo?.id : /Redis|KeyValue/.test(base) ? redis?.id : (primaryDb?.id || null);
  }

  const appClass = model.classes.find((c) => c.stereotype === 'application');
  const name = opts.name || config.server.applicationName || build.name || build.artifactId || path.basename(root);
  const report = {
    schema: 1,
    name,
    root,
    source: opts.source || { type: 'local', path: root },
    analyzedAt: new Date().toISOString(),
    durationMs: 0,
    warnings,
    summary: {
      basePackage: appClass ? appClass.pkg : commonPrefix(model.classes.map((c) => c.pkg)),
      application: appClass ? appClass.id : null,
      springBootVersion: build.springBootVersion, javaVersion: build.javaVersion, buildTool: build.tool,
      javaFiles, kotlinFiles, linesOfCode: loc, files: files.length,
      counts: {
        classes: model.classes.length,
        beans: model.classes.filter((c) => c.isBean).length + model.beanDefs.filter((b) => !b.target).length,
        controllers: model.classes.filter((c) => c.stereotype === 'controller').length,
        services: model.classes.filter((c) => c.stereotype === 'service').length,
        repositories: model.classes.filter((c) => c.stereotype === 'repository').length,
        entities: model.entities.length,
        endpoints: model.endpoints.length,
        configurations: model.classes.filter((c) => c.stereotype === 'configuration').length,
        connections: config.connections.length,
        listeners: model.listeners.length,
        scheduled: model.scheduled.length,
        specs: infra.openapi.length,
      },
    },
    build,
    classes: model.classes,
    beanDefs: model.beanDefs,
    endpoints: model.endpoints,
    clients: model.clients,
    listeners: model.listeners,
    scheduled: model.scheduled,
    eventListeners: model.eventListeners,
    runners: model.runners,
    postConstructs: model.postConstructs,
    asyncMethods: model.asyncMethods,
    exceptionHandlers: model.exceptionHandlers,
    aspects: model.aspects,
    caches: model.caches,
    entities: model.entities,
    propertyUsages: model.propertyUsages,
    profilesInCode: model.profilesInCode,
    security: model.security,
    interceptors: model.interceptorRegs,
    enables: model.enables,
    config,
    infra,
    flows: flows.entries,
    messaging: { listeners: model.listeners, publishers: flows.publishers },
    httpCalls: flows.httpCalls,
  };
  report.startup = buildStartup({ model, config, build, infra, files });
  report.durationMs = Date.now() - t0;
  return report;
}

function safe(fn) { try { return fn(); } catch { return null; } }
function commonPrefix(list) {
  if (!list.length) return '';
  const parts = list.map((p) => p.split('.'));
  const out = [];
  for (let i = 0; ; i++) { const v = parts[0][i]; if (v === undefined || parts.some((p) => p[i] !== v)) break; out.push(v); }
  return out.join('.');
}

module.exports = { analyzeProject };
