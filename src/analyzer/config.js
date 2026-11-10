'use strict';
const yaml = require('js-yaml');

const SECRET_RE = /(password|passwd|secret|token|api[-_]?key|private[-_]?key|credential|client-secret)/i;

/* ----------------------------- parsing ----------------------------- */

function profileFromFilename(file) {
  const base = file.split('/').pop();
  const m = /^(?:application|bootstrap)-([\w-]+)\.(ya?ml|properties)$/.exec(base);
  return m ? m[1] : 'default';
}

function parseProperties(text, file) {
  const docs = [];
  let cur = { props: [], profile: profileFromFilename(file) };
  docs.push(cur);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const lineNo = i + 1;
    if (/^\s*#---\s*$/.test(line) || /^\s*!---\s*$/.test(line)) { cur = { props: [], profile: profileFromFilename(file) }; docs.push(cur); continue; }
    if (/^\s*[#!]/.test(line) || !line.trim()) continue;
    while (/\\$/.test(line) && i + 1 < lines.length) { line = line.slice(0, -1) + lines[++i].trim(); }
    const m = /^\s*([^=:\s]+(?:\\ [^=:\s]*)*)\s*[=:]?\s*(.*)$/.exec(line);
    if (!m) continue;
    cur.props.push({ key: m[1].trim(), value: m[2].trim(), line: lineNo });
  }
  return docs;
}

function flatten(obj, prefix, out) {
  if (obj === null || obj === undefined) { out.push([prefix, '']); return; }
  if (Array.isArray(obj)) {
    if (obj.every((x) => typeof x !== 'object' || x === null)) { out.push([prefix, obj.join(',')]); return; }
    obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return;
  }
  if (typeof obj === 'object' && !(obj instanceof Date)) {
    const keys = Object.keys(obj);
    if (!keys.length) { out.push([prefix, '{}']); return; }
    for (const k of keys) {
      const key = /[.\s]/.test(k) && prefix ? `${prefix}[${k}]` : (prefix ? `${prefix}.${k}` : k);
      flatten(obj[k], key, out);
    }
    return;
  }
  out.push([prefix, obj instanceof Date ? obj.toISOString().slice(0, 10) : String(obj)]);
}

function parseYaml(text, file) {
  const docs = [];
  const rawDocs = text.split(/^---\s*$/m);
  let lineOffset = 0;
  for (const raw of rawDocs) {
    let data;
    try { data = yaml.load(raw, { json: true }); } catch (e) { docs.push({ props: [], profile: profileFromFilename(file), error: e.message }); lineOffset += raw.split('\n').length - 1; continue; }
    const pairs = [];
    if (data && typeof data === 'object') flatten(data, '', pairs);
    const rawLines = raw.split('\n');
    const lineOf = makeYamlLineFinder(rawLines);
    docs.push({ props: pairs.map(([key, value]) => ({ key, value, line: lineOffset + lineOf(key) })), profile: profileFromFilename(file) });
    lineOffset += rawLines.length - 1;
  }
  return docs;
}

function makeYamlLineFinder(lines) {
  const memo = new Map();
  function find(segs) {
    if (!segs.length) return { line: 0, indent: -1 };
    const k = segs.join('\u0000');
    if (memo.has(k)) return memo.get(k);
    const parent = find(segs.slice(0, -1));
    const seg = segs[segs.length - 1];
    let res = parent;
    if (!/^\[\d+\]$/.test(seg)) {
      const name = seg.replace(/^\[|\]$/g, '');
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^(\\s*)(?:-\\s+)?["']?${esc}["']?\\s*:`);
      for (let i = parent.line; i < lines.length; i++) {
        const m = re.exec(lines[i]);
        if (m && m[1].length > parent.indent) { res = { line: i + 1, indent: m[1].length }; break; }
      }
    }
    memo.set(k, res);
    return res;
  }
  return (key) => {
    const segs = key.split(/\.(?![^[]*\])|(?=\[)/).filter(Boolean);
    return find(segs).line || 1;
  };
}

function parseConfigFile(text, file) {
  const docs = /\.properties$/i.test(file) ? parseProperties(text, file) : parseYaml(text, file);
  return docs.map((d, idx) => {
    const act = d.props.find((p) => p.key === 'spring.config.activate.on-profile' || p.key === 'spring.profiles');
    return { file, index: idx, profile: act ? act.value : d.profile, activation: act ? act.key : null, props: d.props, error: d.error };
  }).filter((d) => d.props.length || d.error);
}

/* ------------------------- placeholders --------------------------- */

/** Parse "${A:${B:default}}" style placeholders. */
function placeholders(value) {
  const out = [];
  if (typeof value !== 'string') return out;
  let i = 0;
  while ((i = value.indexOf('${', i)) !== -1) {
    let depth = 0; let j = i;
    for (; j < value.length; j++) {
      if (value[j] === '{') depth++;
      else if (value[j] === '}') { depth--; if (depth === 0) break; }
    }
    const inner = value.slice(i + 2, j);
    const colon = inner.indexOf(':');
    out.push({ raw: value.slice(i, j + 1), name: colon === -1 ? inner : inner.slice(0, colon), default: colon === -1 ? null : inner.slice(colon + 1) });
    i = j + 1;
  }
  return out;
}

function resolveValue(value, lookup, depth = 0) {
  if (typeof value !== 'string' || depth > 8) return value;
  let out = value;
  for (const p of placeholders(value)) {
    const v = lookup(p.name);
    const rep = v !== undefined ? resolveValue(v, lookup, depth + 1) : (p.default !== null ? resolveValue(p.default, lookup, depth + 1) : p.raw);
    out = out.replace(p.raw, rep);
  }
  return out;
}

function maskSecret(key, value) {
  if (!SECRET_RE.test(key) || !value) return value;
  if (/^\$\{/.test(value)) return value;
  return '••••••';
}

/* ------------------------ connections ----------------------------- */

function parseJdbc(url) {
  if (!url) return null;
  const u = url.replace(/^jdbc:/, '');
  const m = /^(\w+)(?::(\w+))?:(?:\/\/)?([^/:;?]*)?(?::(\d+))?(?:[/:;]([^?;]*))?/.exec(u);
  if (!m) return { vendor: 'jdbc' };
  const vendor = m[1];
  if (vendor === 'h2') {
    const mode = /^h2:(mem|file|tcp)/.exec(u);
    return { vendor: 'h2', mode: mode ? mode[1] : 'mem', database: u.split(/[:;/]/).filter(Boolean).slice(-1)[0] };
  }
  if (vendor === 'sqlserver') {
    const db = /databaseName=([^;]+)/i.exec(u);
    return { vendor, host: m[3], port: m[4], database: db ? db[1] : null };
  }
  if (vendor === 'oracle') {
    const om = /@(?:\/\/)?([^:/]+)(?::(\d+))?[:/](\w+)/.exec(u);
    return { vendor, host: om?.[1], port: om?.[2], database: om?.[3] };
  }
  return { vendor, host: m[3] || null, port: m[4] || null, database: (m[5] || '').split('/').pop() || null };
}

function parseUri(uri) {
  try {
    const u = new URL(uri);
    return { scheme: u.protocol.replace(':', ''), host: u.hostname, port: u.port || null, database: u.pathname.replace(/^\//, '') || null };
  } catch { return null; }
}

const VENDOR_LABEL = {
  mysql: 'MySQL', postgresql: 'PostgreSQL', mariadb: 'MariaDB', h2: 'H2', oracle: 'Oracle', sqlserver: 'SQL Server',
  hsqldb: 'HSQLDB', derby: 'Derby', db2: 'DB2', sqlite: 'SQLite', tc: 'Testcontainers', mongodb: 'MongoDB', 'mongodb+srv': 'MongoDB',
  r2dbc: 'R2DBC', redis: 'Redis', rediss: 'Redis',
};

const CONNECTION_RULES = [
  { type: 'database', match: /^spring\.datasource\.url$/, group: 'spring.datasource', name: 'Primary DataSource', related: [/^spring\.datasource\./, /^spring\.jpa\./, /^spring\.sql\.init\./, /^spring\.flyway\./, /^spring\.liquibase\./] },
  { type: 'database', match: /^spring\.datasource\.([\w-]+)\.(jdbc-)?url$/, groupFn: (k) => k.replace(/\.(jdbc-)?url$/, ''), nameFn: (k) => `DataSource "${k.split('.')[2]}"` },
  { type: 'database', match: /^spring\.r2dbc\.url$/, group: 'spring.r2dbc', name: 'R2DBC connection' },
  { type: 'database', match: /^spring\.data\.mongodb\.(uri|host|database)$/, group: 'spring.data.mongodb', name: 'MongoDB', tech: 'MongoDB' },
  { type: 'database', match: /^spring\.cassandra\.(contact-points|keyspace-name)$/, group: 'spring.cassandra', name: 'Cassandra', tech: 'Cassandra' },
  { type: 'database', match: /^spring\.neo4j\.uri$/, group: 'spring.neo4j', name: 'Neo4j', tech: 'Neo4j' },
  { type: 'cache', match: /^spring\.(data\.)?redis\.(host|url|port|cluster\.nodes|sentinel\.master)$/, groupFn: (k) => (k.startsWith('spring.data.') ? 'spring.data.redis' : 'spring.redis'), name: 'Redis', tech: 'Redis' },
  { type: 'broker', match: /^spring\.kafka\.bootstrap-servers$|^spring\.kafka\.(consumer|producer)\.bootstrap-servers$/, group: 'spring.kafka', name: 'Kafka', tech: 'Kafka' },
  { type: 'broker', match: /^spring\.cloud\.stream\.kafka\.binder\.brokers$/, group: 'spring.cloud.stream', name: 'Kafka (Cloud Stream)', tech: 'Kafka' },
  { type: 'broker', match: /^spring\.rabbitmq\.(host|addresses|virtual-host)$/, group: 'spring.rabbitmq', name: 'RabbitMQ', tech: 'RabbitMQ' },
  { type: 'broker', match: /^spring\.activemq\.broker-url$/, group: 'spring.activemq', name: 'ActiveMQ', tech: 'ActiveMQ' },
  { type: 'broker', match: /^spring\.artemis\.(broker-url|host)$/, group: 'spring.artemis', name: 'Artemis', tech: 'ActiveMQ Artemis' },
  { type: 'search', match: /^spring\.elasticsearch\.uris$/, group: 'spring.elasticsearch', name: 'Elasticsearch', tech: 'Elasticsearch' },
  { type: 'mail', match: /^spring\.mail\.host$/, group: 'spring.mail', name: 'SMTP server', tech: 'SMTP' },
  { type: 'discovery', match: /^eureka\.client\.service-url\./, group: 'eureka', name: 'Eureka registry', tech: 'Eureka' },
  { type: 'discovery', match: /^spring\.cloud\.consul\.host$/, group: 'spring.cloud.consul', name: 'Consul', tech: 'Consul' },
  { type: 'config', match: /^spring\.cloud\.config\.uri$/, group: 'spring.cloud.config', name: 'Config Server', tech: 'Spring Cloud Config' },
  { type: 'config', match: /^spring\.config\.import$/, valueMatch: /configserver:|consul:|vault:|aws-/, group: 'spring.config.import', name: 'External config import', tech: 'Config import' },
  { type: 'auth', match: /^spring\.security\.oauth2\.resourceserver\.jwt\.(issuer-uri|jwk-set-uri)$/, group: 'spring.security.oauth2.resourceserver', name: 'OAuth2 issuer (resource server)', tech: 'OAuth2 / OIDC' },
  { type: 'auth', match: /^spring\.security\.oauth2\.client\.provider\.([\w-]+)\.(issuer-uri|token-uri)$/, groupFn: (k) => k.split('.').slice(0, 6).join('.'), nameFn: (k) => `OAuth2 provider "${k.split('.')[5]}"`, tech: 'OAuth2 / OIDC' },
  { type: 'vault', match: /^spring\.cloud\.vault\.(host|uri)$/, group: 'spring.cloud.vault', name: 'Vault', tech: 'HashiCorp Vault' },
];

const NON_CONNECTION_URL_KEYS = /^(spring\.(datasource|r2dbc|data|kafka|rabbitmq|elasticsearch|security|cloud|mail|redis|activemq|artemis|neo4j|cassandra)|eureka|logging|management\.(zipkin|tracing|otlp)\.|info\.|springdoc\.)/;

/**
 * Detect connections in one set of resolved properties.
 * props: Map key -> {value, resolved, file, line}
 */
function detectConnections(props) {
  const found = new Map();
  const keys = [...props.keys()];
  for (const key of keys) {
    const p = props.get(key);
    for (const rule of CONNECTION_RULES) {
      if (!rule.match.test(key)) continue;
      if (rule.valueMatch && !rule.valueMatch.test(p.resolved)) continue;
      const group = rule.group || rule.groupFn(key);
      if (!found.has(group)) found.set(group, { group, type: rule.type, name: rule.name || rule.nameFn(key), tech: rule.tech || null, keyProp: key, related: rule.related || [new RegExp('^' + group.replace(/[.[\]]/g, '\\$&') + '\\.')] });
      break;
    }
  }
  // generic external HTTP endpoints in custom properties
  for (const key of keys) {
    const p = props.get(key);
    if (NON_CONNECTION_URL_KEYS.test(key)) continue;
    if (!/^(https?|grpc|wss?|ftp|sftp|amqps?|tcp):\/\//i.test(p.resolved || '')) continue;
    const group = key.replace(/\.(base-?url|url|uri|endpoint|host|address)$/i, '') || key;
    if (!found.has(group)) found.set(group, { group, type: 'http', name: humanize(group), tech: /^grpc/i.test(p.resolved) ? 'gRPC' : 'HTTP', keyProp: key, related: [new RegExp('^' + group.replace(/[.[\]]/g, '\\$&') + '(\\.|$)')] });
  }
  const result = [];
  for (const c of found.values()) {
    const related = {};
    for (const k of keys) if (c.related.some((r) => r.test(k)) || k === c.keyProp) {
      const p = props.get(k);
      related[k] = { value: maskSecret(k, p.value), resolved: maskSecret(k, p.resolved), file: p.file, line: p.line };
    }
    let main = props.get(c.keyProp)?.resolved || '';
    let endpoint = null; let tech = c.tech;
    if (/\.host$/.test(c.keyProp) && main && !main.includes(':')) {
      const port = props.get(c.group + '.port')?.resolved;
      main = `${main}${port ? ':' + port : ''}`;
    }
    if (c.type === 'database' && /^jdbc:|^r2dbc:/.test(main)) {
      const j = parseJdbc(main.replace(/^r2dbc:(pool:)?/, 'jdbc:'));
      endpoint = j; tech = VENDOR_LABEL[j?.vendor] || j?.vendor || 'JDBC';
    } else if (/:\/\//.test(main)) {
      const u = parseUri(main.split(',')[0]);
      endpoint = u; if (!tech && u) tech = VENDOR_LABEL[u.scheme] || u.scheme;
    } else if (main) {
      const host = props.get(c.group + '.host')?.resolved || main.split(',')[0];
      const port = props.get(c.group + '.port')?.resolved || (/:(\d+)$/.exec(host) || [])[1] || null;
      endpoint = { host: host.replace(/:\d+$/, ''), port };
    }
    const username = Object.entries(related).find(([k]) => /\.(username|user)$/.test(k));
    result.push({ id: c.group, type: c.type, name: c.name, tech: tech || c.type, keyProp: c.keyProp, url: maskSecret(c.keyProp, main), endpoint, username: username ? username[1].resolved : null, props: related });
  }
  return result;
}

function humanize(key) {
  const parts = key.replace(/\[|\]/g, '.').split('.').filter(Boolean);
  const pick = parts.filter((x) => !/^(app|application|services?|clients?|external|api|config|integration|endpoints?)$/i.test(x));
  return (pick.length ? pick : parts).slice(-2).join(' ').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ------------------------ orchestration ---------------------------- */

/**
 * docs: output of parseConfigFile across all config files.
 * Returns profiles, per-profile effective property sets, env vars, connections.
 */
function analyzeConfig(docs, deps) {
  const profileSet = new Set(['default']);
  for (const d of docs) for (const p of String(d.profile).split(/[,|&!() ]+/).filter(Boolean)) profileSet.add(p);
  const defaults = docs.filter((d) => d.profile === 'default');
  const activeProp = defaults.flatMap((d) => d.props).find((p) => p.key === 'spring.profiles.active');
  const active = activeProp ? activeProp.value.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const includeProp = defaults.flatMap((d) => d.props).find((p) => p.key === 'spring.profiles.include' || p.key.startsWith('spring.profiles.group'));
  for (const p of active) profileSet.add(p.replace(/^\$\{[^:]*:?|\}$/g, '') || p);

  const isBootstrap = (f) => /(^|\/)bootstrap[-.]/.test(f);
  const orderDocs = (list) => list.slice().sort((a, b) => (isBootstrap(b.file) - isBootstrap(a.file)) || a.file.localeCompare(b.file));

  function effective(profile) {
    const map = new Map();
    const layers = orderDocs(defaults).concat(profile === 'default' ? [] : orderDocs(docs.filter((d) => d.profile !== 'default' && String(d.profile).split(/[,|& ]+/).includes(profile))));
    for (const d of layers) for (const p of d.props) map.set(p.key, { value: p.value, file: d.file, line: p.line, profile: d.profile, overrides: map.has(p.key) ? map.get(p.key) : null });
    const lookup = (k) => map.get(k)?.value;
    for (const [, v] of map) v.resolved = resolveValue(v.value, lookup);
    return map;
  }

  const profiles = [...profileSet];
  const effectiveByProfile = {};
  for (const p of profiles) effectiveByProfile[p] = effective(p);

  // environment variables / placeholders that point outside the property files
  const env = new Map();
  for (const d of docs) for (const p of d.props) for (const ph of placeholders(p.value)) {
    const known = effectiveByProfile.default.has(ph.name) || docs.some((x) => x.props.some((y) => y.key === ph.name));
    if (known) continue;
    if (!env.has(ph.name)) env.set(ph.name, { name: ph.name, default: ph.default, usedBy: [] });
    env.get(ph.name).usedBy.push({ key: p.key, file: d.file, line: p.line, profile: d.profile });
  }

  // connections per profile, merged by id
  const connections = new Map();
  for (const profile of profiles) {
    for (const c of detectConnections(effectiveByProfile[profile])) {
      if (!connections.has(c.id)) connections.set(c.id, { id: c.id, type: c.type, name: c.name, keyProp: c.keyProp, variants: {} });
      connections.get(c.id).variants[profile] = c;
    }
  }
  // collapse identical variants: keep 'default' + only profiles that differ
  const conns = [];
  for (const c of connections.values()) {
    const base = c.variants.default ? JSON.stringify(c.variants.default.url) : null;
    for (const [p, v] of Object.entries(c.variants)) if (p !== 'default' && JSON.stringify(v.url) === base && JSON.stringify(v.props) === JSON.stringify(c.variants.default.props)) delete c.variants[p];
    const primary = c.variants.default || Object.values(c.variants)[0];
    conns.push({ ...c, tech: primary.tech, url: primary.url, endpoint: primary.endpoint, props: primary.props, profiles: Object.keys(c.variants) });
  }

  // implied connections from dependencies (no explicit configuration)
  const art = new Set((deps || []).filter((d) => d.scope !== 'test').map((d) => d.artifact));
  const hasDb = conns.some((c) => c.type === 'database' && c.variants.default);
  if (!hasDb && (art.has('spring-boot-starter-data-jpa') || art.has('spring-boot-starter-jdbc'))) {
    const embedded = ['h2', 'hsqldb', 'derby'].find((a) => art.has(a));
    if (embedded) conns.push({ id: 'embedded-db', type: 'database', name: 'Embedded DataSource', tech: VENDOR_LABEL[embedded] || embedded, url: `jdbc:${embedded}:mem:<generated>`, endpoint: { vendor: embedded, mode: 'mem' }, props: {}, profiles: ['default'], implied: true, note: `No spring.datasource.url in default profile - Spring Boot auto-configures an in-memory ${VENDOR_LABEL[embedded]} database.` });
  }
  if (!conns.some((c) => c.tech === 'Redis') && art.has('spring-boot-starter-data-redis')) conns.push({ id: 'redis-default', type: 'cache', name: 'Redis', tech: 'Redis', url: 'redis://localhost:6379', endpoint: { host: 'localhost', port: '6379' }, props: {}, profiles: ['default'], implied: true, note: 'Spring Boot default Redis connection (localhost:6379).' });
  if (!conns.some((c) => c.tech === 'Kafka') && (art.has('spring-kafka'))) conns.push({ id: 'kafka-default', type: 'broker', name: 'Kafka', tech: 'Kafka', url: 'localhost:9092', endpoint: { host: 'localhost', port: '9092' }, props: {}, profiles: ['default'], implied: true, note: 'Spring Boot default Kafka bootstrap server (localhost:9092).' });
  if (!conns.some((c) => c.tech === 'RabbitMQ') && art.has('spring-boot-starter-amqp')) conns.push({ id: 'rabbit-default', type: 'broker', name: 'RabbitMQ', tech: 'RabbitMQ', url: 'amqp://localhost:5672', endpoint: { host: 'localhost', port: '5672' }, props: {}, profiles: ['default'], implied: true, note: 'Spring Boot default RabbitMQ connection (localhost:5672).' });
  if (!conns.some((c) => c.tech === 'MongoDB') && art.has('spring-boot-starter-data-mongodb')) conns.push({ id: 'mongo-default', type: 'database', name: 'MongoDB', tech: 'MongoDB', url: 'mongodb://localhost:27017/test', endpoint: { host: 'localhost', port: '27017', database: 'test' }, props: {}, profiles: ['default'], implied: true, note: 'Spring Boot default MongoDB connection.' });

  const get = (k, profile = 'default') => effectiveByProfile[profile].get(k)?.resolved;
  const server = {
    port: get('server.port') || '8080',
    contextPath: get('server.servlet.context-path') || get('spring.webflux.base-path') || '',
    ssl: get('server.ssl.enabled') === 'true' || !!get('server.ssl.key-store'),
    applicationName: get('spring.application.name') || null,
    actuatorExposure: get('management.endpoints.web.exposure.include') || null,
    actuatorBasePath: get('management.endpoints.web.base-path') || '/actuator',
    managementPort: get('management.server.port') || null,
  };

  // Serializable property listing per document
  const files = docs.map((d) => ({
    file: d.file, profile: d.profile, index: d.index, error: d.error || null,
    props: d.props.map((p) => ({ key: p.key, value: maskSecret(p.key, p.value), line: p.line, secret: SECRET_RE.test(p.key), placeholders: placeholders(p.value).map((x) => x.name) })),
  }));
  const effectiveOut = {};
  for (const p of profiles) {
    effectiveOut[p] = [...effectiveByProfile[p].entries()].map(([key, v]) => ({ key, value: maskSecret(key, v.value), resolved: maskSecret(key, v.resolved), file: v.file, line: v.line, from: v.profile, overridden: !!v.overrides })).sort((a, b) => a.key.localeCompare(b.key));
  }
  return { profiles, activeProfiles: active, includeProfiles: includeProp ? includeProp.value : null, files, effective: effectiveOut, envVars: [...env.values()], connections: conns, server };
}

module.exports = { parseConfigFile, analyzeConfig, placeholders, resolveValue, parseJdbc, maskSecret };
