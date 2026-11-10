'use strict';
const yaml = require('../../vendor/js-yaml/js-yaml.js');

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'];

function loadAll(text) {
  try { return yaml.loadAll(text, null, { json: true }).filter((d) => d && typeof d === 'object'); } catch { return null; }
}

/** OpenAPI / Swagger specification (YAML or JSON). */
function parseOpenApi(text, file) {
  let doc;
  try { doc = file.endsWith('.json') ? JSON.parse(text) : yaml.load(text, { json: true }); } catch { return null; }
  if (!doc || typeof doc !== 'object' || !(doc.openapi || doc.swagger) || !doc.paths) return null;
  const basePath = doc.basePath || '';
  const servers = (doc.servers || []).map((s) => s.url);
  const operations = [];
  for (const [path, item] of Object.entries(doc.paths || {})) {
    if (!item || typeof item !== 'object') continue;
    for (const m of HTTP_METHODS) {
      const op = item[m];
      if (!op) continue;
      const params = [...(item.parameters || []), ...(op.parameters || [])].map((p) => (p.$ref ? { ref: p.$ref.split('/').pop() } : { name: p.name, in: p.in, required: !!p.required, type: p.schema?.type || p.type || refName(p.schema) }));
      const body = op.requestBody?.content ? Object.entries(op.requestBody.content).map(([ct, c]) => ({ contentType: ct, schema: refName(c.schema) })) : (op.parameters || []).filter((p) => p.in === 'body').map((p) => ({ contentType: 'application/json', schema: refName(p.schema) }));
      const responses = Object.entries(op.responses || {}).map(([code, r]) => ({ code, description: r?.description || '', schema: r?.content ? refName(Object.values(r.content)[0]?.schema) : refName(r?.schema) }));
      operations.push({ method: m.toUpperCase(), path: (basePath + path).replace(/\/+/g, '/'), operationId: op.operationId || null, summary: op.summary || op.description?.split('\n')[0] || null, tags: op.tags || [], params, requestBody: body, responses, security: op.security ? op.security.map((s) => Object.keys(s).join('+')) : null, deprecated: !!op.deprecated });
    }
  }
  const schemas = doc.components?.schemas || doc.definitions || {};
  return {
    file, version: doc.openapi || doc.swagger, title: doc.info?.title || file, apiVersion: doc.info?.version || null, description: doc.info?.description || null, servers,
    operations, schemas: Object.entries(schemas).map(([name, s]) => ({ name, type: s?.type || (s?.allOf ? 'allOf' : s?.oneOf ? 'oneOf' : 'object'), properties: Object.entries(s?.properties || {}).map(([pn, ps]) => ({ name: pn, type: ps?.type ? (ps.type === 'array' ? `${refName(ps.items) || ps.items?.type}[]` : ps.type) : refName(ps), required: (s.required || []).includes(pn) })), refs: [...new Set(JSON.stringify(s || {}).match(/#\/(components\/schemas|definitions)\/[\w.-]+/g) || [])].map((r) => r.split('/').pop()).filter((r) => r !== name) })),
    securitySchemes: Object.entries(doc.components?.securitySchemes || doc.securityDefinitions || {}).map(([n, s]) => ({ name: n, type: s.type, scheme: s.scheme || s.flow || null })),
  };
}

function refName(schema) {
  if (!schema) return null;
  if (schema.$ref) return schema.$ref.split('/').pop();
  if (schema.type === 'array' && schema.items) return (refName(schema.items) || schema.items.type) + '[]';
  return schema.type || null;
}

function parseCompose(text, file) {
  const docs = loadAll(text);
  const doc = docs && docs[0];
  if (!doc || !doc.services) return null;
  const services = Object.entries(doc.services).map(([name, s]) => ({
    name, image: s.image || (s.build ? `build: ${typeof s.build === 'string' ? s.build : s.build.context || '.'}` : null),
    ports: (s.ports || []).map(String), environment: normalizeEnv(s.environment), dependsOn: Array.isArray(s.depends_on) ? s.depends_on : Object.keys(s.depends_on || {}),
    volumes: (s.volumes || []).map((v) => (typeof v === 'string' ? v : `${v.source}:${v.target}`)), command: s.command ? String(s.command) : null, profiles: s.profiles || [], healthcheck: !!s.healthcheck,
    tech: guessTech(s.image || name),
  }));
  return { file, services };
}

function normalizeEnv(env) {
  if (!env) return {};
  if (Array.isArray(env)) return Object.fromEntries(env.map((e) => { const i = String(e).indexOf('='); return i === -1 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)]; }));
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v == null ? '' : String(v)]));
}

function guessTech(image) {
  const i = String(image || '').toLowerCase();
  const table = [['postgres', 'PostgreSQL'], ['mysql', 'MySQL'], ['mariadb', 'MariaDB'], ['mongo', 'MongoDB'], ['redis', 'Redis'], ['kafka', 'Kafka'], ['zookeeper', 'ZooKeeper'], ['rabbitmq', 'RabbitMQ'], ['elasticsearch', 'Elasticsearch'], ['opensearch', 'OpenSearch'], ['keycloak', 'Keycloak'], ['zipkin', 'Zipkin'], ['jaeger', 'Jaeger'], ['prometheus', 'Prometheus'], ['grafana', 'Grafana'], ['nginx', 'Nginx'], ['mssql', 'SQL Server'], ['oracle', 'Oracle'], ['localstack', 'LocalStack'], ['minio', 'MinIO'], ['vault', 'Vault'], ['consul', 'Consul'], ['eureka', 'Eureka'], ['mailhog', 'MailHog'], ['mailpit', 'Mailpit'], ['cassandra', 'Cassandra'], ['neo4j', 'Neo4j'], ['activemq', 'ActiveMQ'], ['artemis', 'Artemis']];
  for (const [k, v] of table) if (i.includes(k)) return v;
  return null;
}

function parseK8s(text, file) {
  const docs = loadAll(text);
  if (!docs) return [];
  return docs.filter((d) => d.kind && d.apiVersion).map((d) => {
    const spec = d.spec || {};
    const podSpec = spec.template?.spec || spec.jobTemplate?.spec?.template?.spec || null;
    return {
      file, kind: d.kind, name: d.metadata?.name || '?', namespace: d.metadata?.namespace || null,
      replicas: spec.replicas ?? null,
      containers: (podSpec?.containers || []).map((c) => ({ name: c.name, image: c.image, ports: (c.ports || []).map((p) => p.containerPort), env: (c.env || []).map((e) => ({ name: e.name, value: e.value ?? (e.valueFrom ? `from ${Object.keys(e.valueFrom)[0]}` : '') })), envFrom: (c.envFrom || []).map((e) => (e.configMapRef ? `ConfigMap ${e.configMapRef.name}` : e.secretRef ? `Secret ${e.secretRef.name}` : '?')), probes: ['livenessProbe', 'readinessProbe', 'startupProbe'].filter((p) => c[p]).map((p) => `${p.replace('Probe', '')}: ${c[p].httpGet ? c[p].httpGet.path + ':' + c[p].httpGet.port : c[p].tcpSocket ? 'tcp ' + c[p].tcpSocket.port : 'exec'}`), resources: c.resources || null })),
      selector: spec.selector?.matchLabels || spec.selector || null, labels: d.metadata?.labels || {},
      ports: d.kind === 'Service' ? (spec.ports || []).map((p) => `${p.port}→${p.targetPort ?? p.port}`) : [], serviceType: d.kind === 'Service' ? spec.type || 'ClusterIP' : null,
      rules: d.kind === 'Ingress' ? (spec.rules || []).flatMap((r) => (r.http?.paths || []).map((p) => ({ host: r.host || '*', path: p.path, service: p.backend?.service?.name || p.backend?.serviceName, port: p.backend?.service?.port?.number || p.backend?.servicePort }))) : [],
      data: d.kind === 'ConfigMap' ? Object.keys(d.data || {}) : d.kind === 'Secret' ? Object.keys(d.data || d.stringData || {}) : [],
    };
  });
}

function parseDockerfile(text, file) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const stages = []; const expose = []; let entry = null; const env = [];
  for (const l of lines) {
    const [ins, ...rest] = l.split(/\s+/); const arg = rest.join(' ');
    const I = ins.toUpperCase();
    if (I === 'FROM') stages.push(arg);
    else if (I === 'EXPOSE') expose.push(...rest);
    else if (I === 'ENTRYPOINT' || I === 'CMD') entry = arg;
    else if (I === 'ENV') env.push(arg);
  }
  return { file, stages, expose, entrypoint: entry, env };
}

module.exports = { parseOpenApi, parseCompose, parseK8s, parseDockerfile, guessTech };
