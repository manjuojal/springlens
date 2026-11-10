'use strict';
const { extractCalls, typeInfo } = require('./java-parser');

const MAPPING_ANNOS = { RequestMapping: null, GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH', HttpExchange: null, GetExchange: 'GET', PostExchange: 'POST', PutExchange: 'PUT', DeleteExchange: 'DELETE', PatchExchange: 'PATCH' };
const REPO_BASE = /^(Jpa|Crud|ListCrud|PagingAndSorting|ListPagingAndSorting|Mongo|ReactiveMongo|ReactiveCrud|ReactiveSorting|R2dbc|Elasticsearch|ReactiveElasticsearch|Cassandra|ReactiveCassandra|Neo4j|ReactiveNeo4j|Couchbase|Redis|KeyValue|Revision|QuerydslPredicateExecutor|JpaSpecificationExecutor)?Repository$|^(JpaSpecificationExecutor|QuerydslPredicateExecutor|CrudRepository)$/;
const INFRA_TYPES = {
  RestTemplate: { kind: 'http', tech: 'RestTemplate' }, WebClient: { kind: 'http', tech: 'WebClient' }, RestClient: { kind: 'http', tech: 'RestClient' },
  'WebClient.Builder': { kind: 'http', tech: 'WebClient' }, OkHttpClient: { kind: 'http', tech: 'OkHttp' }, HttpClient: { kind: 'http', tech: 'HttpClient' },
  KafkaTemplate: { kind: 'publish', tech: 'Kafka' }, ReactiveKafkaProducerTemplate: { kind: 'publish', tech: 'Kafka' }, StreamBridge: { kind: 'publish', tech: 'Cloud Stream' },
  RabbitTemplate: { kind: 'publish', tech: 'RabbitMQ' }, AmqpTemplate: { kind: 'publish', tech: 'RabbitMQ' }, JmsTemplate: { kind: 'publish', tech: 'JMS' }, SqsTemplate: { kind: 'publish', tech: 'SQS' }, SnsTemplate: { kind: 'publish', tech: 'SNS' },
  RedisTemplate: { kind: 'cache', tech: 'Redis' }, StringRedisTemplate: { kind: 'cache', tech: 'Redis' }, ReactiveRedisTemplate: { kind: 'cache', tech: 'Redis' }, CacheManager: { kind: 'cache', tech: 'Cache' }, RedissonClient: { kind: 'cache', tech: 'Redis' },
  JdbcTemplate: { kind: 'db', tech: 'JDBC' }, NamedParameterJdbcTemplate: { kind: 'db', tech: 'JDBC' }, JdbcClient: { kind: 'db', tech: 'JDBC' }, EntityManager: { kind: 'db', tech: 'JPA' }, MongoTemplate: { kind: 'db', tech: 'MongoDB' }, ReactiveMongoTemplate: { kind: 'db', tech: 'MongoDB' }, R2dbcEntityTemplate: { kind: 'db', tech: 'R2DBC' }, DatabaseClient: { kind: 'db', tech: 'R2DBC' }, ElasticsearchOperations: { kind: 'db', tech: 'Elasticsearch' }, DSLContext: { kind: 'db', tech: 'jOOQ' }, SqlSession: { kind: 'db', tech: 'MyBatis' },
  ApplicationEventPublisher: { kind: 'event', tech: 'Spring Events' },
  JavaMailSender: { kind: 'mail', tech: 'SMTP' }, MailSender: { kind: 'mail', tech: 'SMTP' },
  S3Client: { kind: 'storage', tech: 'AWS S3' }, AmazonS3: { kind: 'storage', tech: 'AWS S3' }, S3Template: { kind: 'storage', tech: 'AWS S3' },
};

const has = (t, ...names) => t.annotations.some((a) => names.includes(a.name));
const anno = (t, name) => t.annotations.find((a) => a.name === name);
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));

function joinPath(a, b) {
  const p = ('/' + (a || '') + '/' + (b || '')).replace(/\/+/g, '/');
  return p.length > 1 ? p.replace(/\/$/, '') : p;
}

function buildModel(parsedFiles) {
  /* ---------------- index types ---------------- */
  const types = [];
  for (const pf of parsedFiles) for (const t of pf.types) { t._file = pf; types.push(t); }
  const byFqn = new Map(types.map((t) => [t.fqn, t]));
  const byName = new Map();
  for (const t of types) { if (!byName.has(t.name)) byName.set(t.name, []); byName.get(t.name).push(t); }

  function resolve(name, from) {
    if (!name) return null;
    const simple = name.replace(/<.*$/s, '').trim().split('.').pop();
    const cands = byName.get(simple);
    if (!cands) return null;
    if (cands.length === 1) return cands[0];
    if (from) {
      const imp = from._file.imports.find((i) => i.name.endsWith('.' + simple));
      if (imp) { const c = byFqn.get(imp.name); if (c) return c; }
      const same = cands.find((c) => c.pkg === from.pkg);
      if (same) return same;
    }
    return cands[0];
  }

  /* --------------- constants ---------------------
     static final String constants (incl. interface constants and nested constant holders) so that
     @FeignClient(name = Constants.BASE) or @PostMapping(Constants.API + Constants.PATH) resolve
     to real values. */
  const WELL_KNOWN = {
    'MediaType.APPLICATION_JSON_VALUE': 'application/json', 'MediaType.APPLICATION_XML_VALUE': 'application/xml', 'MediaType.TEXT_PLAIN_VALUE': 'text/plain',
    'MediaType.APPLICATION_FORM_URLENCODED_VALUE': 'application/x-www-form-urlencoded', 'MediaType.MULTIPART_FORM_DATA_VALUE': 'multipart/form-data', 'MediaType.ALL_VALUE': '*/*',
    'MediaType.TEXT_HTML_VALUE': 'text/html', 'MediaType.APPLICATION_OCTET_STREAM_VALUE': 'application/octet-stream', 'MediaType.APPLICATION_PDF_VALUE': 'application/pdf',
  };
  const constCache = new Map();
  function constantValue(expr, ctxType, depth = 0) {
    if (depth > 8) return null;
    const e = expr.trim();
    if (WELL_KNOWN[e] || WELL_KNOWN[e.split('.').slice(-2).join('.')]) return WELL_KNOWN[e] || WELL_KNOWN[e.split('.').slice(-2).join('.')];
    const key = (ctxType ? ctxType.fqn : '') + '|' + e;
    if (constCache.has(key)) return constCache.get(key);
    constCache.set(key, null); // cycle guard
    const parts = e.split('.');
    const field = parts.pop();
    const owners = [];
    if (parts.length) {
      const owner = resolve(parts[parts.length - 1], ctxType);
      if (owner) owners.push(owner);
      else for (const t of byName.get(parts[parts.length - 1]) || []) owners.push(t);
    } else if (ctxType) {
      // bare name: own class, outer classes, super types, then static imports
      for (let t = ctxType; t; t = t.outer ? byFqn.get(t.outer) : null) { owners.push(t); owners.push(...allSupersSafe(t)); }
      for (const imp of ctxType._file.imports.filter((i) => i.static && i.name.endsWith('.' + field))) { const o = byFqn.get(imp.name.slice(0, -field.length - 1)); if (o) owners.push(o); }
      for (const imp of ctxType._file.imports.filter((i) => i.static && i.name.endsWith('.*'))) { const o = byFqn.get(imp.name.slice(0, -2)); if (o) owners.push(o); }
    }
    let val = null;
    for (const o of owners) {
      const f = o.fields.find((x) => x.name === field && x.initializer != null);
      if (f) { val = evalStringExpr(f.initializer, o, depth + 1); if (val != null) break; }
    }
    constCache.set(key, val);
    return val;
  }
  function evalStringExpr(text, ctxType, depth) {
    const pieces = splitPlus(text);
    let out = '';
    for (const p of pieces) {
      const s = p.trim();
      if (/^"(?:[^"\\]|\\.)*"$/.test(s)) { try { out += JSON.parse(s); } catch { out += s.slice(1, -1); } continue; }
      if (/^-?\d+(\.\d+)?[LlDdFf]?$/.test(s)) { out += s.replace(/[LlDdFf]$/, ''); continue; }
      if (/^[A-Za-z_$][\w$.]*$/.test(s)) { const v = constantValue(s, ctxType, depth); if (v == null) return null; out += v; continue; }
      return null;
    }
    return out;
  }
  function splitPlus(text) { const out = []; let d = 0; let cur = ''; let inStr = false; for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === '"' && text[i - 1] !== '\\') inStr = !inStr; if (!inStr) { if ('({['.includes(c)) d++; else if (')}]'.includes(c)) d--; } if (c === '+' && d === 0 && !inStr) { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; }
  function allSupersSafe(t, seen = new Set()) {
    const out = [];
    for (const s of [...t.extends, ...t.implements]) { const r = resolve(s, t); if (r && !seen.has(r.fqn)) { seen.add(r.fqn); out.push(r, ...allSupersSafe(r, seen)); } }
    return out;
  }
  const MARK = /\u0003([^\u0004]+)\u0004/g;
  const resolveMarks = (v, t) => {
    if (typeof v === 'string') return v.includes('\u0003') ? v.replace(MARK, (m, expr) => { const c = constantValue(expr, t); return c != null ? c : expr; }) : v;
    if (Array.isArray(v)) return v.map((x) => resolveMarks(x, t));
    return v;
  };
  const fixAnnos = (annos, t) => { for (const a of annos || []) for (const k of Object.keys(a.attrs)) a.attrs[k] = resolveMarks(a.attrs[k], t); };
  for (const t of types) {
    fixAnnos(t.annotations, t);
    for (const f of t.fields) fixAnnos(f.annotations, t);
    for (const m of [...t.methods, ...t.constructors]) { fixAnnos(m.annotations, t); for (const p of m.params) fixAnnos(p.annotations, t); }
  }

  /* --------------- hierarchy ------------------- */
  const implementors = new Map(); // fqn(interface/superclass) -> [fqn]
  for (const t of types) {
    for (const s of [...t.extends, ...t.implements]) {
      const r = resolve(s, t);
      if (r) { if (!implementors.has(r.fqn)) implementors.set(r.fqn, []); implementors.get(r.fqn).push(t.fqn); }
    }
  }
  function allSupers(t, seen = new Set()) {
    const out = [];
    for (const s of [...t.extends, ...t.implements]) {
      const r = resolve(s, t);
      if (r && !seen.has(r.fqn)) { seen.add(r.fqn); out.push(r, ...allSupers(r, seen)); }
    }
    return out;
  }
  const superNames = (t) => [...t.extends, ...t.implements].map((s) => s.replace(/<.*$/s, '').split('.').pop());
  const allSuperNames = (t) => [...superNames(t), ...allSupers(t).flatMap(superNames)];

  /* --------------- stereotypes ----------------- */
  function stereotype(t) {
    const sup = allSuperNames(t);
    if (has(t, 'SpringBootApplication')) return 'application';
    if (has(t, 'RestController')) return 'controller';
    if (has(t, 'Controller')) return 'controller';
    if (has(t, 'RestControllerAdvice', 'ControllerAdvice')) return 'advice';
    if (has(t, 'FeignClient', 'HttpExchange')) return 'client';
    if (has(t, 'Repository', 'RepositoryRestResource')) return 'repository';
    if (t.kind === 'interface' && sup.some((s) => REPO_BASE.test(s))) return 'repository';
    if (has(t, 'Mapper') && t._file.imports.some((i) => /ibatis/.test(i.name))) return 'repository';
    if (has(t, 'Entity', 'Document', 'Embeddable', 'MappedSuperclass', 'Node', 'RedisHash') || (has(t, 'Table') && t._file.imports.some((i) => /persistence|relational/.test(i.name)))) return 'entity';
    if (has(t, 'Aspect')) return 'aspect';
    if (has(t, 'EnableWebSecurity', 'EnableWebFluxSecurity', 'EnableMethodSecurity', 'EnableGlobalMethodSecurity')) return 'security';
    if (has(t, 'ConfigurationProperties')) return 'properties';
    if (has(t, 'Configuration', 'AutoConfiguration', 'SpringBootConfiguration', 'TestConfiguration')) return 'configuration';
    if (sup.some((s) => /^(OncePerRequestFilter|GenericFilterBean|Filter|WebFilter|AbstractGatewayFilterFactory|GlobalFilter)$/.test(s))) return 'filter';
    if (sup.some((s) => /^(HandlerInterceptor|AsyncHandlerInterceptor|WebRequestInterceptor|ClientHttpRequestInterceptor|RequestInterceptor)$/.test(s))) return 'interceptor';
    if (has(t, 'Service')) return 'service';
    if (has(t, 'Component', 'Named')) {
      if (t.methods.some((m) => has(m, 'KafkaListener', 'RabbitListener', 'JmsListener', 'SqsListener', 'StreamListener'))) return 'listener';
      if (t.methods.some((m) => has(m, 'Scheduled'))) return 'scheduler';
      return 'component';
    }
    if (t.methods.some((m) => has(m, 'KafkaListener', 'RabbitListener', 'JmsListener', 'SqsListener'))) return 'listener';
    if (/\b(dto|model|domain|payload|request|response|vo|entity|entities)\b/i.test(t.pkg.replace(/\./g, ' ')) || /(Dto|DTO|Request|Response|Payload|VO|Command|Event)$/.test(t.name)) return 'model';
    if (t.kind === 'enum') return 'model';
    if (t.kind === 'annotation') return 'annotation';
    if (/Exception$/.test(t.name)) return 'exception';
    return 'other';
  }
  const LAYER = { application: 'bootstrap', controller: 'web', advice: 'web', client: 'integration', repository: 'data', entity: 'domain', aspect: 'cross-cutting', security: 'cross-cutting', filter: 'cross-cutting', interceptor: 'cross-cutting', properties: 'config', configuration: 'config', service: 'service', component: 'service', listener: 'messaging', scheduler: 'messaging', model: 'model', exception: 'model', annotation: 'model', other: 'model' };
  const BEAN_STEREOTYPES = new Set(['application', 'controller', 'advice', 'client', 'repository', 'aspect', 'security', 'properties', 'configuration', 'filter', 'interceptor', 'service', 'component', 'listener', 'scheduler']);

  for (const t of types) {
    t.stereotype = stereotype(t);
    t.layer = LAYER[t.stereotype];
    if ((t.stereotype === 'filter' || t.stereotype === 'interceptor') && !has(t, 'Component', 'Configuration', 'Service')) t.registeredManually = true;
    t.isBean = BEAN_STEREOTYPES.has(t.stereotype) && !(t.registeredManually);
  }

  /* --------------- @Bean definitions ------------- */
  const beanDefs = [];
  for (const t of types) for (const m of t.methods) {
    if (!has(m, 'Bean')) continue;
    const ba = anno(m, 'Bean');
    const names = asList(ba.attrs.name || ba.attrs.value);
    const rt = m.returnTypeInfo;
    const target = resolve(rt.name, t);
    beanDefs.push({
      id: `${t.fqn}#${m.name}`, name: names[0] || m.name, config: t.fqn, method: m.name, type: m.returnType, typeName: rt.name, target: target ? target.fqn : null,
      params: m.params.map((p) => ({ name: p.name, type: p.type, target: resolve(p.typeInfo.name, t)?.fqn || null, qualifier: str(p.annotations.find((a) => a.name === 'Qualifier')?.attrs.value) || null })),
      conditions: m.annotations.filter((a) => /^(Conditional|Profile|Primary|Lazy|Scope|Order|DependsOn)/.test(a.name)).map((a) => `@${a.name}${a.raw ? '(' + a.raw + ')' : ''}`),
      line: m.line, file: t.file,
    });
    if (target && !target.isBean) { target.isBean = true; target.registeredBy = `${t.name}.${m.name}()`; }
  }
  // filters/interceptors registered in config
  for (const t of types) if (t.registeredManually) {
    const ref = types.find((o) => o.stereotype === 'configuration' && o.methods.some((m) => m.body && new RegExp(`\\b${t.name}\\b`).test(m.body)));
    if (ref) { t.isBean = true; t.registeredBy = ref.name; }
  }

  /* --------------- injection points ------------- */
  const lombokCtor = (t) => has(t, 'RequiredArgsConstructor', 'AllArgsConstructor', 'Data', 'Value');
  for (const t of types) {
    const deps = [];
    const add = (name, ti, via, line, annos = []) => {
      if (!ti || !ti.name || /^[a-z]/.test(ti.name)) return;
      deps.push({ name, type: ti.raw, typeName: ti.name, typeArgs: ti.args, via, line, qualifier: str(annos.find((a) => a.name === 'Qualifier')?.attrs.value) || null, value: str(annos.find((a) => a.name === 'Value')?.attrs.value) || null });
    };
    if (t.isBean || t.stereotype !== 'model') {
      const ctors = t.constructors.filter((c) => !c.implicit || t.kind === 'record');
      const injectCtor = ctors.find((c) => has(c, 'Autowired', 'Inject')) || (ctors.length === 1 ? ctors[0] : null);
      if (injectCtor) for (const p of injectCtor.params) add(p.name, p.typeInfo, 'constructor', injectCtor.line, p.annotations);
      for (const f of t.fields) {
        if (has(f, 'Autowired', 'Inject', 'Resource', 'MockBean')) add(f.name, f.typeInfo, 'field', f.line, f.annotations);
        else if (!injectCtor && lombokCtor(t) && f.modifiers.includes('final') && !f.modifiers.includes('static') && f.initializer == null) add(f.name, f.typeInfo, 'constructor (Lombok)', f.line, f.annotations);
        else if (has(f, 'Value')) add(f.name, f.typeInfo, 'value', f.line, f.annotations);
      }
      for (const m of t.methods) if (has(m, 'Autowired', 'Inject') && m.params.length) for (const p of m.params) add(p.name, p.typeInfo, 'setter', m.line, p.annotations);
    }
    t.injections = deps;
  }

  /** Resolve a dependency type to project beans (interfaces -> implementations). */
  function resolveBeans(typeName, from, typeArgs = []) {
    let tn = typeName;
    if (/^(List|Set|Collection|Map|Optional|ObjectProvider|Provider|Lazy)$/.test(tn) && typeArgs.length) tn = typeArgs[typeArgs.length - 1];
    const r = resolve(tn, from);
    if (!r) {
      const viaBean = beanDefs.filter((b) => b.typeName === tn);
      return viaBean.length ? viaBean.map((b) => ({ fqn: null, bean: b })) : [];
    }
    if (r.kind === 'interface' || has(r, 'MappedSuperclass') || r.modifiers.includes('abstract')) {
      const impls = (implementors.get(r.fqn) || []).map((f) => byFqn.get(f)).filter((x) => x && x.isBean);
      if (impls.length && r.stereotype !== 'repository' && r.stereotype !== 'client') return impls.map((i) => ({ fqn: i.fqn, via: r.name }));
    }
    return [{ fqn: r.fqn }];
  }

  /* --------------- class output ------------------ */
  const classes = types.map((t) => {
    const repoBase = t.stereotype === 'repository' ? [...t.extends].map((s) => typeInfo(s)).find((ti) => REPO_BASE.test(ti.name)) : null;
    const entity = repoBase && repoBase.args.length ? resolve(repoBase.args[0], t) : null;
    const deps = [];
    for (const d of t.injections) {
      if (d.via === 'value') continue;
      for (const r of resolveBeans(d.typeName, t, d.typeArgs)) if (r.fqn && r.fqn !== t.fqn) deps.push({ target: r.fqn, field: d.name, via: d.via, through: r.via || null, line: d.line });
    }
    const infra = t.injections.filter((d) => INFRA_TYPES[d.typeName]).map((d) => ({ field: d.name, type: d.typeName, ...INFRA_TYPES[d.typeName] }));
    // infrastructure fields created by hand, e.g. `JdbcTemplate template; … template = new JdbcTemplate(dataSource)`
    for (const f of t.fields) {
      if (f.modifiers.includes('static') || !INFRA_TYPES[f.typeInfo.name] || infra.some((i) => i.field === f.name)) continue;
      infra.push({ field: f.name, type: f.typeInfo.name, ...INFRA_TYPES[f.typeInfo.name], manual: true });
    }
    return {
      id: t.fqn, name: t.name, pkg: t.pkg, kind: t.kind, file: t.file, line: t.line, endLine: t.endLine, outer: t.outer,
      stereotype: t.stereotype, layer: t.layer, isBean: !!t.isBean, registeredBy: t.registeredBy || null,
      annotations: t.annotations.map((a) => ({ name: a.name, raw: a.raw })),
      modifiers: t.modifiers,
      extends: t.extends, implements: t.implements,
      supers: [...t.extends, ...t.implements].map((s) => resolve(s, t)?.fqn).filter(Boolean),
      fields: t.fields.map((f) => ({ name: f.name, type: f.type, line: f.line, modifiers: f.modifiers, annotations: f.annotations.map((a) => '@' + a.name + (a.raw ? `(${a.raw})` : '')) })),
      methods: t.methods.map((m) => ({ name: m.name, returnType: m.returnType, line: m.line, endLine: m.endLine, params: m.params.map((p) => ({ name: p.name, type: p.type, annotations: p.annotations.map((a) => '@' + a.name) })), annotations: m.annotations.map((a) => '@' + a.name + (a.raw ? `(${a.raw})` : '')), modifiers: m.modifiers })),
      enumConstants: t.enumConstants,
      deps, infra, injections: t.injections.map(({ typeArgs, ...rest }) => rest),
      entity: entity ? entity.fqn : (repoBase && repoBase.args[0]) || null,
      idType: repoBase && repoBase.args[1] || null,
      repoBase: repoBase ? repoBase.name : null,
      implementors: implementors.get(t.fqn) || [],
    };
  });
  const classById = new Map(classes.map((c) => [c.id, c]));

  /* --------------- endpoints --------------------- */
  const endpoints = [];
  function mappingOf(annos) {
    for (const a of annos) if (a.name in MAPPING_ANNOS) {
      const paths = asList(a.attrs.path ?? a.attrs.value ?? a.attrs.url).map(String);
      let methods = MAPPING_ANNOS[a.name] ? [MAPPING_ANNOS[a.name]] : asList(a.attrs.method).map((x) => String(x).replace(/^.*\./, ''));
      return { anno: a.name, paths: paths.length ? paths : [''], methods, produces: str(a.attrs.produces) || null, consumes: str(a.attrs.consumes) || null, params: str(a.attrs.params) || null, headers: str(a.attrs.headers) || null };
    }
    return null;
  }
  const securityAnno = (annos) => annos.filter((a) => /^(PreAuthorize|PostAuthorize|Secured|RolesAllowed|PermitAll|DenyAll)$/.test(a.name)).map((a) => `@${a.name}${a.raw ? '(' + a.raw + ')' : ''}`);

  for (const t of types.filter((x) => x.stereotype === 'controller' || (x.kind === 'interface' && x.stereotype !== 'client' && has(x, 'RequestMapping')))) {
    if (t.kind === 'interface' && t.stereotype !== 'controller') continue; // interfaces are handled through implementors
    const chain = [t, ...allSupers(t)];
    const classMapping = chain.map((c) => mappingOf(c.annotations)).find(Boolean);
    const basePaths = classMapping ? classMapping.paths : [''];
    const isRest = has(t, 'RestController') || chain.some((c) => has(c, 'ResponseBody'));
    const seen = new Set();
    for (const c of chain) for (const m of c.methods) {
      const mp = mappingOf(m.annotations);
      if (!mp) continue;
      const sig = m.name + '/' + m.params.length;
      if (seen.has(sig)) continue; seen.add(sig);
      const impl = t.methods.find((x) => x.name === m.name && x.params.length === m.params.length) || m;
      const params = m.params.map((p, i) => {
        const pa = p.annotations.find((a) => /^(PathVariable|RequestParam|RequestBody|RequestHeader|CookieValue|ModelAttribute|RequestPart|MatrixVariable|AuthenticationPrincipal)$/.test(a.name));
        const implParam = impl.params[i] || p;
        const kindName = pa ? pa.name : (/^(Model|BindingResult|HttpServletRequest|HttpServletResponse|Pageable|Principal|Authentication|RedirectAttributes|ServerWebExchange|Locale|HttpSession|SessionStatus|WebRequest|Errors|UriComponentsBuilder)$/.test(p.typeInfo.name) ? 'framework' : 'ModelAttribute');
        return { name: implParam.name, type: p.type, kind: kindName, binding: pa ? str(pa.attrs.value ?? pa.attrs.name) || p.name : null, required: pa && pa.attrs.required !== undefined ? pa.attrs.required !== 'false' : !(pa && pa.attrs.defaultValue), validated: [...p.annotations, ...implParam.annotations].some((a) => a.name === 'Valid' || a.name === 'Validated') };
      });
      const responseStatus = [...m.annotations, ...impl.annotations].find((a) => a.name === 'ResponseStatus');
      const httpMethods = mp.methods.length ? mp.methods : (classMapping?.methods.length ? classMapping.methods : ['ANY']);
      for (const bp of basePaths) for (const p of mp.paths) for (const hm of httpMethods) {
        const path = joinPath(bp, p);
        endpoints.push({
          id: `${hm} ${path} ${t.name}.${impl.name}`,
          method: hm, path, controller: t.fqn, controllerName: t.name, handler: impl.name, declaredIn: c.fqn !== t.fqn ? c.fqn : null,
          returnType: impl.returnType || m.returnType, rest: isRest || [...impl.annotations, ...m.annotations].some((a) => a.name === 'ResponseBody') || /ResponseEntity|Mono|Flux/.test(impl.returnType || ''),
          view: !isRest && /^String$|ModelAndView/.test(impl.returnType || '') ? true : false,
          params, produces: mp.produces || classMapping?.produces || null, consumes: mp.consumes || classMapping?.consumes || null,
          status: responseStatus ? str(responseStatus.attrs.value ?? responseStatus.attrs.code).replace(/^.*\./, '') : null,
          security: [...securityAnno(t.annotations), ...securityAnno(impl.annotations), ...securityAnno(m.annotations)],
          summary: str([...m.annotations, ...impl.annotations].find((a) => a.name === 'Operation')?.attrs.summary) || null,
          deprecated: [...m.annotations, ...impl.annotations].some((a) => a.name === 'Deprecated'),
          file: t.file, line: impl.line, source: 'annotation',
        });
      }
    }
  }
  // functional endpoints (RouterFunction)
  for (const t of types) for (const m of t.methods) {
    if (!m.body || !/RouterFunction/.test(m.returnType || '')) continue;
    const body = t._file.restore(m.body);
    const nest = /\.(?:path|nest)\(\s*(?:path\()?\s*"([^"]+)"/.exec(body);
    const re = /\b(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]*)"\s*(?:,\s*(?:[\w.]+\s*,\s*)?(\w+)::(\w+))?/g; let r;
    while ((r = re.exec(body))) {
      const handler = r[3] ? m.params.find((p) => p.name === r[3]) || t.fields.find((f) => f.name === r[3]) : null;
      const target = handler ? resolve(handler.typeInfo.name, t) : null;
      const path = joinPath(nest && !r[2].startsWith(nest[1]) ? nest[1] : '', r[2]);
      endpoints.push({ id: `${r[1]} ${path} ${target ? target.name : t.name}.${r[4] || m.name}`, method: r[1], path, controller: target ? target.fqn : t.fqn, controllerName: target ? target.name : t.name, handler: r[4] || m.name, returnType: 'Mono<ServerResponse>', rest: true, params: [], security: [], file: t.file, line: m.line, source: 'router-function' });
    }
  }
  endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  /* --------------- outbound clients -------------- */
  const clients = [];
  for (const t of types.filter((x) => x.stereotype === 'client')) {
    const fa = anno(t, 'FeignClient') || anno(t, 'HttpExchange');
    const cm = mappingOf(t.annotations.filter((a) => a.name !== 'FeignClient'));
    clients.push({
      id: t.fqn, name: t.name, serviceName: str(fa?.attrs.name ?? fa?.attrs.value ?? fa?.attrs.contextId) || null, url: str(fa?.attrs.url) || null, path: str(fa?.attrs.path) || null,
      fallback: str(fa?.attrs.fallback || fa?.attrs.fallbackFactory) || null, configuration: str(fa?.attrs.configuration) || null,
      operations: t.methods.map((m) => { const mp = mappingOf(m.annotations); return mp ? { method: mp.methods[0] || 'GET', path: joinPath(str(fa?.attrs.path) || cm?.paths[0] || '', mp.paths[0]), name: m.name, returnType: m.returnType } : null; }).filter(Boolean),
      file: t.file, line: t.line,
    });
  }

  /* --------------- messaging / async ------------- */
  const listeners = []; const scheduled = []; const eventListeners = []; const runners = []; const postConstructs = []; const asyncMethods = []; const exceptionHandlers = []; const aspects = []; const caches = []; const transactional = [];
  for (const t of types) {
    for (const m of t.methods) {
      const at = (n) => m.annotations.find((a) => a.name === n);
      const k = at('KafkaListener'); const r = at('RabbitListener'); const j = at('JmsListener'); const s = at('SqsListener'); const sl = at('StreamListener');
      if (k) listeners.push({ tech: 'Kafka', class: t.fqn, className: t.name, method: m.name, destinations: asList(k.attrs.topics ?? k.attrs.value ?? k.attrs.topicPattern).map(String), group: str(k.attrs.groupId) || null, id: str(k.attrs.id) || null, concurrency: str(k.attrs.concurrency) || null, payload: m.params[0]?.type || null, line: m.line, file: t.file });
      if (r) listeners.push({ tech: 'RabbitMQ', class: t.fqn, className: t.name, method: m.name, destinations: asList(r.attrs.queues ?? r.attrs.value ?? r.attrs.bindings).map(String), group: null, payload: m.params[0]?.type || null, line: m.line, file: t.file });
      if (j) listeners.push({ tech: 'JMS', class: t.fqn, className: t.name, method: m.name, destinations: asList(j.attrs.destination).map(String), group: str(j.attrs.subscription) || null, payload: m.params[0]?.type || null, line: m.line, file: t.file });
      if (s) listeners.push({ tech: 'SQS', class: t.fqn, className: t.name, method: m.name, destinations: asList(s.attrs.value ?? s.attrs.queueNames).map(String), payload: m.params[0]?.type || null, line: m.line, file: t.file });
      if (sl) listeners.push({ tech: 'Cloud Stream', class: t.fqn, className: t.name, method: m.name, destinations: asList(sl.attrs.value).map(String), payload: m.params[0]?.type || null, line: m.line, file: t.file });
      if (has(m, 'Bean') && /^(Consumer|Function|Supplier)$/.test(m.returnTypeInfo.name)) listeners.push({ tech: 'Cloud Stream', functional: m.returnTypeInfo.name, class: t.fqn, className: t.name, method: m.name, destinations: [`${m.name}-${m.returnTypeInfo.name === 'Supplier' ? 'out' : 'in'}-0`], payload: m.returnTypeInfo.args[0] || null, line: m.line, file: t.file });
      const sc = at('Scheduled');
      if (sc) scheduled.push({ class: t.fqn, className: t.name, method: m.name, cron: str(sc.attrs.cron) || null, fixedRate: str(sc.attrs.fixedRate ?? sc.attrs.fixedRateString) || null, fixedDelay: str(sc.attrs.fixedDelay ?? sc.attrs.fixedDelayString) || null, initialDelay: str(sc.attrs.initialDelay ?? sc.attrs.initialDelayString) || null, zone: str(sc.attrs.zone) || null, line: m.line, file: t.file });
      const el = at('EventListener') || at('TransactionalEventListener');
      if (el) eventListeners.push({ class: t.fqn, className: t.name, method: m.name, event: str(el.attrs.value ?? el.attrs.classes).replace(/\.class/g, '') || m.params[0]?.typeInfo.name || null, transactional: el.name === 'TransactionalEventListener', phase: str(el.attrs.phase) || null, condition: str(el.attrs.condition) || null, async: !!at('Async'), line: m.line, file: t.file });
      if (at('PostConstruct')) postConstructs.push({ class: t.fqn, className: t.name, method: m.name, line: m.line, file: t.file });
      if (at('Async')) asyncMethods.push({ class: t.fqn, className: t.name, method: m.name, executor: str(at('Async').attrs.value) || null, line: m.line });
      const eh = at('ExceptionHandler');
      if (eh) exceptionHandlers.push({ class: t.fqn, className: t.name, method: m.name, exceptions: asList(eh.attrs.value).map((x) => String(x).replace(/\.class/g, '')).concat(eh.attrs.value ? [] : m.params.filter((p) => /Exception|Throwable|Error$/.test(p.typeInfo.name)).map((p) => p.typeInfo.name)), status: str(at('ResponseStatus')?.attrs.value ?? at('ResponseStatus')?.attrs.code).replace(/^.*\./, '') || null, global: t.stereotype === 'advice', line: m.line, file: t.file });
      for (const n of ['Around', 'Before', 'After', 'AfterReturning', 'AfterThrowing']) { const a = at(n); if (a) aspects.push({ class: t.fqn, className: t.name, method: m.name, advice: n, pointcut: str(a.attrs.value ?? a.attrs.pointcut), line: m.line }); }
      for (const n of ['Cacheable', 'CachePut', 'CacheEvict', 'Caching']) { const a = at(n); if (a) caches.push({ class: t.fqn, className: t.name, method: m.name, op: n, cache: str(a.attrs.value ?? a.attrs.cacheNames) || null, key: str(a.attrs.key) || null, line: m.line }); }
      if (at('Transactional')) transactional.push({ class: t.fqn, method: m.name, attrs: at('Transactional').raw });
      if (has(m, 'Bean') && /^(CommandLineRunner|ApplicationRunner)$/.test(m.returnTypeInfo.name)) runners.push({ class: t.fqn, className: t.name, method: m.name, kind: m.returnTypeInfo.name, line: m.line, file: t.file });
    }
    const sup = superNames(t);
    if (sup.some((s) => /^(CommandLineRunner|ApplicationRunner)$/.test(s))) runners.push({ class: t.fqn, className: t.name, method: 'run', kind: sup.find((s) => /Runner$/.test(s)), line: t.line, file: t.file, order: str(anno(t, 'Order')?.attrs.value) || null });
    const al = [...t.implements].map(typeInfo).find((ti) => ti.name === 'ApplicationListener');
    if (al) eventListeners.push({ class: t.fqn, className: t.name, method: 'onApplicationEvent', event: al.args[0] || null, line: t.line, file: t.file });
    if (has(t, 'Transactional')) transactional.push({ class: t.fqn, method: '*', attrs: anno(t, 'Transactional').raw });
  }

  /* --------------- entities ---------------------- */
  const entities = [];
  for (const t of types.filter((x) => x.stereotype === 'entity' && !has(x, 'MappedSuperclass'))) {
    const chain = [t, ...allSupers(t).filter((s) => has(s, 'MappedSuperclass', 'Entity'))];
    const fields = [];
    for (const c of chain.slice().reverse()) for (const f of c.fields) {
      if (f.modifiers.includes('static') || has(f, 'Transient')) continue;
      const rel = f.annotations.find((a) => /^(OneToOne|OneToMany|ManyToOne|ManyToMany|DBRef|DocumentReference|Relationship)$/.test(a.name));
      const col = f.annotations.find((a) => a.name === 'Column' || a.name === 'JoinColumn' || a.name === 'Field');
      const target = rel ? (f.typeInfo.args.length ? f.typeInfo.args[f.typeInfo.args.length - 1] : f.typeInfo.name) : null;
      const targetCls = target ? resolve(target, c) : null;
      const embedded = !rel && (has(f, 'Embedded', 'EmbeddedId') || (resolve(f.typeInfo.name, c) && has(resolve(f.typeInfo.name, c), 'Embeddable')));
      fields.push({
        name: f.name, type: f.type, typeName: f.typeInfo.name, inherited: c !== t ? c.name : null,
        id: has(f, 'Id', 'EmbeddedId'), generated: f.annotations.find((a) => a.name === 'GeneratedValue')?.raw || (has(f, 'GeneratedValue') ? 'AUTO' : null),
        column: col ? str(col.attrs.name) || null : null, nullable: col ? col.attrs.nullable !== 'false' : !has(f, 'NotNull', 'NotBlank', 'NonNull'), unique: col ? col.attrs.unique === 'true' : false, length: col ? str(col.attrs.length) || null : null,
        enum: has(f, 'Enumerated'), version: has(f, 'Version'), embedded,
        relation: rel ? { type: rel.name, target: targetCls ? targetCls.fqn : target, targetName: target, mappedBy: str(rel.attrs.mappedBy) || null, cascade: str(rel.attrs.cascade) || null, fetch: str(rel.attrs.fetch).replace(/^.*\./, '') || null, joinColumn: str(f.annotations.find((a) => a.name === 'JoinColumn')?.attrs.name) || null, joinTable: str(f.annotations.find((a) => a.name === 'JoinTable')?.attrs.name) || null } : null,
        validation: f.annotations.filter((a) => /^(NotNull|NotBlank|NotEmpty|Size|Min|Max|Email|Pattern|Past|Future|Positive|Digits)$/.test(a.name)).map((a) => '@' + a.name + (a.raw ? `(${a.raw})` : '')),
        line: f.line, file: c.file,
      });
    }
    const tbl = anno(t, 'Table') || anno(t, 'Document');
    entities.push({ id: t.fqn, name: t.name, kind: has(t, 'Document') ? 'document' : has(t, 'Embeddable') ? 'embeddable' : has(t, 'RedisHash') ? 'redis-hash' : 'table', table: str(tbl?.attrs.name ?? tbl?.attrs.value ?? tbl?.attrs.collection) || t.name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(), parent: t.extends[0] || null, fields, file: t.file, line: t.line, repositories: classes.filter((c) => c.entity === t.fqn).map((c) => c.id) });
  }

  /* --------------- tables referenced in SQL -------
     JDBC / native SQL strings in method bodies and @Query(nativeQuery = true). Useful for projects
     that use JdbcTemplate, stored procedures or plain JDBC instead of JPA entities. */
  const sqlTables = new Map();
  const SQL_START = /^\s*(select|insert|update|delete|merge|with|call|exec)\b/i;
  const addSql = (sql, t, member, line, native) => {
    const op = (SQL_START.exec(sql) || [])[1]?.toUpperCase() || 'SQL';
    const re = /\b(from|join|into|update|table)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/gi; let m;
    while ((m = re.exec(sql))) {
      const name = m[2];
      if (/^(select|set|where|values|dual|lateral|unnest)$/i.test(name)) continue;
      const key = name.toLowerCase();
      if (!sqlTables.has(key)) sqlTables.set(key, { table: name, ops: new Set(), usedBy: [] });
      const e = sqlTables.get(key);
      e.ops.add(op === 'WITH' ? 'SELECT' : op);
      if (!e.usedBy.some((u) => u.class === t.fqn && u.member === member)) e.usedBy.push({ class: t.fqn, className: t.name, member, line, native, sample: sql.slice(0, 160) });
    }
  };
  for (const t of types) {
    for (const m of t.methods) {
      const q = m.annotations.find((a) => a.name === 'Query');
      if (q && String(q.attrs.nativeQuery) === 'true' && typeof q.attrs.value === 'string') addSql(q.attrs.value, t, m.name, m.line, true);
      if (!m.body) continue;
      const lits = (m.body.match(/"\u0001(\d+)\u0002"/g) || []).map((x) => t._file.strings[+x.replace(/\D/g, '')]);
      // also join adjacent literals of one concatenated statement ("select * " + "from x")
      for (const s of lits) if (SQL_START.test(s) && /\b(from|into|update|table|values|set)\b/i.test(s)) addSql(s, t, m.name, m.line, false);
    }
    // SQL kept in constants: static final String FIND_ALL = "select * from student";
    for (const f of t.fields) {
      if (!f.initializer) continue;
      const s = (f.initializer.match(/"((?:[^"\\]|\\.)*)"/g) || []).map((x) => { try { return JSON.parse(x); } catch { return x.slice(1, -1); } }).join(' ');
      if (SQL_START.test(s)) addSql(s, t, f.name, f.line, false);
    }
  }

  /* --------------- property usages --------------- */
  const propertyUsages = [];
  const pushUse = (key, cls, member, kind, line, def) => { if (key) propertyUsages.push({ key, class: cls.fqn, className: cls.name, member, kind, line, default: def ?? null }); };
  const fromExpr = (expr) => {
    const out = []; const re = /\$\{([^}:]+)(?::([^}]*))?\}/g; let m;
    while ((m = re.exec(expr || ''))) out.push([m[1], m[2]]);
    return out;
  };
  for (const t of types) {
    const cp = anno(t, 'ConfigurationProperties');
    if (cp) pushUse(str(cp.attrs.prefix ?? cp.attrs.value) + '.*', t, null, 'ConfigurationProperties', t.line);
    const cop = anno(t, 'ConditionalOnProperty');
    if (cop) for (const n of asList(cop.attrs.name ?? cop.attrs.value)) pushUse((cop.attrs.prefix ? cop.attrs.prefix + '.' : '') + n, t, null, 'ConditionalOnProperty', t.line, cop.attrs.havingValue);
    const ps = anno(t, 'PropertySource');
    if (ps) pushUse(str(ps.attrs.value), t, null, 'PropertySource', t.line);
    const members = [...t.fields.map((f) => ({ name: f.name, annotations: f.annotations, line: f.line })), ...t.methods.map((m) => ({ name: m.name + '()', annotations: m.annotations, line: m.line, params: m.params, body: m.body })), ...t.constructors.map((c) => ({ name: '<init>', annotations: c.annotations, line: c.line, params: c.params }))];
    for (const m of members) {
      for (const a of m.annotations) {
        if (a.name === 'Value') for (const [k, d] of fromExpr(str(a.attrs.value))) pushUse(k, t, m.name, '@Value', m.line, d);
        if (a.name === 'ConfigurationProperties') pushUse(str(a.attrs.prefix ?? a.attrs.value) + '.*', t, m.name, 'ConfigurationProperties', m.line);
        if (a.name === 'ConditionalOnProperty') for (const n of asList(a.attrs.name ?? a.attrs.value)) pushUse((a.attrs.prefix ? a.attrs.prefix + '.' : '') + n, t, m.name, 'ConditionalOnProperty', m.line, a.attrs.havingValue);
        if (a.name === 'Scheduled') for (const v of Object.values(a.attrs)) for (const [k, d] of fromExpr(str(v))) pushUse(k, t, m.name, '@Scheduled', m.line, d);
        if (/Listener$/.test(a.name)) for (const v of Object.values(a.attrs)) for (const [k, d] of fromExpr(str(v))) pushUse(k, t, m.name, '@' + a.name, m.line, d);
      }
      for (const p of m.params || []) for (const a of p.annotations) if (a.name === 'Value') for (const [k, d] of fromExpr(str(a.attrs.value))) pushUse(k, t, m.name + ' param ' + p.name, '@Value', m.line, d);
      if (m.body) for (const c of extractCalls(m.body, t._file.strings)) if (/^(getProperty|getRequiredProperty|containsProperty)$/.test(c.method) && c.stringArgs[0]) pushUse(c.stringArgs[0], t, m.name, 'Environment.' + c.method, m.line);
    }
    for (const a of t.annotations) for (const v of Object.values(a.attrs)) for (const [k, d] of fromExpr(str(v))) if (a.name !== 'Value') pushUse(k, t, null, '@' + a.name, t.line, d);
  }

  /* --------------- conditions / profiles ---------- */
  const profilesInCode = [];
  for (const t of types) {
    const p = anno(t, 'Profile');
    if (p) profilesInCode.push({ class: t.fqn, className: t.name, member: null, profiles: asList(p.attrs.value).map(String) });
    for (const m of t.methods) { const pm = m.annotations.find((a) => a.name === 'Profile'); if (pm) profilesInCode.push({ class: t.fqn, className: t.name, member: m.name, profiles: asList(pm.attrs.value).map(String) }); }
  }

  /* --------------- security ---------------------- */
  const security = { configs: [], rules: [], filters: [], features: [] };
  for (const t of types) for (const m of t.methods) {
    if (!m.body || !/SecurityFilterChain|SecurityWebFilterChain/.test(m.returnType || '')) continue;
    const body = t._file.restore(m.body).replace(/\s+/g, ' ');
    security.configs.push({ class: t.fqn, className: t.name, method: m.name, line: m.line, file: t.file, order: str(m.annotations.find((a) => a.name === 'Order')?.attrs.value) || null, securityMatcher: (/securityMatcher\(([^)]*)\)/.exec(body) || [])[1] || null });
    const re = /(requestMatchers|antMatchers|mvcMatchers|pathMatchers|regexMatchers)\s*\(([^)]*)\)\s*\.\s*(permitAll|authenticated|hasRole|hasAnyRole|hasAuthority|hasAnyAuthority|denyAll|anonymous|fullyAuthenticated|access)\s*\(([^)]*)\)/g; let r;
    while ((r = re.exec(body))) {
      const args = r[2].split(',').map((x) => x.trim());
      const method = args.find((x) => /HttpMethod\./.test(x));
      security.rules.push({ chain: `${t.name}.${m.name}`, method: method ? method.replace(/.*\./, '') : null, patterns: args.filter((x) => /^"/.test(x)).map((x) => x.replace(/"/g, '')), rule: r[3], args: r[4].replace(/"/g, '') });
    }
    const any = /anyRequest\(\)\s*\.\s*(\w+)\s*\(([^)]*)\)/.exec(body);
    if (any) security.rules.push({ chain: `${t.name}.${m.name}`, method: null, patterns: ['/**'], rule: any[1], args: any[2].replace(/"/g, ''), anyRequest: true });
    const feats = [['oauth2ResourceServer', 'OAuth2 resource server (JWT/opaque token)'], ['oauth2Login', 'OAuth2 login'], ['formLogin', 'Form login'], ['httpBasic', 'HTTP Basic'], ['csrf\\s*\\(\\s*\\w*\\s*->\\s*\\w+\\s*\\.\\s*disable|csrf\\(\\)\\.disable|csrf\\(AbstractHttpConfigurer::disable', 'CSRF disabled'], ['SessionCreationPolicy\\.STATELESS', 'Stateless sessions'], ['cors', 'CORS configured'], ['addFilterBefore|addFilterAfter|addFilterAt', 'Custom filters in chain'], ['logout', 'Logout handling'], ['rememberMe', 'Remember-me']];
    for (const [re2, label] of feats) if (new RegExp(re2).test(body)) security.features.push(label);
    const fre = /addFilter(Before|After|At)\s*\(\s*(?:new\s+)?(\w+)[^,]*,\s*(\w+)\.class/g; let f;
    while ((f = fre.exec(body))) security.filters.push({ filter: f[2], position: f[1].toLowerCase(), relativeTo: f[3] });
  }
  security.features = [...new Set(security.features)];

  /* --------------- interceptors registered ------- */
  const interceptorRegs = [];
  for (const t of types) for (const m of t.methods) {
    if (m.name !== 'addInterceptors' || !m.body) continue;
    const body = t._file.restore(m.body);
    const re = /addInterceptor\(\s*(?:new\s+)?(\w+)\s*(?:\([^)]*\))?[^)]*\)\s*(?:\.\s*addPathPatterns\(([^)]*)\))?/g; let r;
    while ((r = re.exec(body))) interceptorRegs.push({ config: t.name, interceptor: r[1], paths: r[2] ? r[2].replace(/"/g, '') : '/**' });
  }

  /* --------------- enable annotations ------------- */
  const enables = [];
  for (const t of types) for (const a of t.annotations) if (/^(Enable\w+|EntityScan|ComponentScan|Import|ImportResource|ImportRuntimeHints|ConfigurationPropertiesScan|OpenAPIDefinition)$/.test(a.name)) enables.push({ class: t.fqn, className: t.name, annotation: a.name, raw: a.raw });

  return {
    types, byFqn, resolve, resolveBeans, implementors, classById,
    classes, beanDefs, endpoints, clients, listeners, scheduled, eventListeners, runners, postConstructs, asyncMethods, exceptionHandlers, aspects, caches, transactional, entities, propertyUsages, profilesInCode, security, interceptorRegs, enables,
    sqlTables: [...sqlTables.values()].map((x) => ({ ...x, ops: [...x.ops] })).sort((a, b) => a.table.localeCompare(b.table)),
    INFRA_TYPES,
  };
}

module.exports = { buildModel, joinPath };
