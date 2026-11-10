'use strict';
/**
 * Reconstructs the Spring Boot startup sequence as ordered phases, each with
 * items that reference classes, config files or connections.
 */
function buildStartup(r) {
  const { model, config, build, infra, files } = r;
  const phases = [];
  const cls = (id, extra = {}) => ({ type: 'class', id, ...extra });
  const art = new Set(build.dependencies.filter((d) => d.scope !== 'test').map((d) => d.artifact));
  const app = model.classes.find((c) => c.stereotype === 'application');

  // 1. bootstrap
  const appType = app && model.byFqn.get(app.id);
  const main = appType && appType.methods.find((m) => m.name === 'main');
  const mainBody = main ? appType._file.restore(main.body || '') : '';
  const customizations = [];
  for (const [re, label] of [[/setBannerMode\(([^)]*)\)/, 'Banner mode: $1'], [/setWebApplicationType\(([^)]*)\)/, 'Web application type: $1'], [/setAdditionalProfiles\(([^)]*)\)/, 'Additional profiles: $1'], [/\.profiles\(([^)]*)\)/, 'Profiles: $1'], [/addListeners\(([^)]*)\)/, 'Listeners: $1'], [/addInitializers\(([^)]*)\)/, 'Initializers: $1'], [/setLazyInitialization\(true\)/, 'Lazy initialization enabled'], [/SpringApplicationBuilder/, 'Uses SpringApplicationBuilder']]) {
    const m = re.exec(mainBody); if (m) customizations.push(label.replace('$1', (m[1] || '').replace(/"/g, '')));
  }
  phases.push({
    id: 'bootstrap', title: 'JVM start & SpringApplication.run()', icon: 'rocket',
    description: app ? `${app.name}.main() boots the application. @SpringBootApplication = @Configuration + @EnableAutoConfiguration + @ComponentScan("${app.pkg}").` : 'No @SpringBootApplication class found (library or non-Boot project).',
    items: [
      ...(app ? [{ label: `${app.name}.main()`, detail: mainBody.replace(/\s+/g, ' ').trim().slice(0, 160), ref: cls(app.id, { line: main?.line }) }] : []),
      ...(app ? app.annotations.filter((a) => a.name !== 'SpringBootApplication').map((a) => ({ label: `@${a.name}`, detail: a.raw || '', ref: cls(app.id) })) : []),
      ...customizations.map((c) => ({ label: c, ref: app ? cls(app.id) : null })),
      ...(build.javaVersion ? [{ label: `Java ${build.javaVersion}`, detail: `Spring Boot ${build.springBootVersion || '?'}`, ref: { type: 'file', file: build.file } }] : []),
    ],
  });

  // 2. environment
  const cfgFiles = [...new Set(config.files.map((f) => f.file))];
  phases.push({
    id: 'environment', title: 'Prepare Environment: properties & profiles', icon: 'sliders',
    description: `Loads ${cfgFiles.length} config file(s). Active profiles: ${config.activeProfiles.length ? config.activeProfiles.join(', ') : 'none set (default)'}; available: ${config.profiles.join(', ')}.`,
    items: [
      ...config.files.map((f) => ({ label: `${f.file.split('/').pop()}${f.profile !== 'default' ? ` [profile: ${f.profile}]` : ''}`, detail: `${f.props.length} properties${f.error ? ' — PARSE ERROR: ' + f.error : ''}`, ref: { type: 'file', file: f.file, line: 1 } })),
      ...config.envVars.slice(0, 40).map((e) => ({ label: `env ${e.name}`, detail: e.default != null ? `default: ${e.default}` : 'REQUIRED (no default)', warn: e.default == null, ref: { type: 'file', file: e.usedBy[0].file, line: e.usedBy[0].line } })),
      ...model.classes.filter((c) => c.stereotype === 'properties').map((c) => ({ label: `@ConfigurationProperties ${c.name}`, detail: (c.annotations.find((a) => a.name === 'ConfigurationProperties') || {}).raw, ref: cls(c.id) })),
      ...model.enables.filter((e) => e.annotation === 'PropertySource' || e.annotation === 'ConfigurationPropertiesScan').map((e) => ({ label: `@${e.annotation}`, detail: e.raw, ref: cls(e.class) })),
    ],
  });

  // 3. auto-configuration
  const autoItems = build.dependencies.filter((d) => d.info && d.scope !== 'test').map((d) => ({ label: d.info.name, detail: d.info.desc, sub: `${d.group}:${d.artifact}${d.version ? ':' + d.version : ''}`, ref: { type: 'dependency', id: d.artifact } }));
  phases.push({ id: 'autoconfig', title: 'Auto-configuration (from starters on the classpath)', icon: 'puzzle', description: `${build.dependencies.length} dependencies; ${autoItems.length} contribute auto-configuration.`, items: autoItems });

  // 4. component scan & configuration
  const configs = model.classes.filter((c) => ['configuration', 'security', 'application'].includes(c.stereotype));
  phases.push({
    id: 'beans', title: 'Component scan & bean creation', icon: 'boxes',
    description: `${model.classes.filter((c) => c.isBean).length} beans from component scan, ${model.beanDefs.length} @Bean factory methods in ${configs.filter((c) => c.stereotype !== 'application').length} configuration classes. Dependencies are injected while beans are created.`,
    items: [
      ...model.enables.filter((e) => /^Enable/.test(e.annotation)).map((e) => ({ label: `@${e.annotation}`, detail: `on ${e.className}${e.raw ? ' (' + e.raw + ')' : ''}`, ref: cls(e.class) })),
      ...model.beanDefs.map((b) => ({ label: `@Bean ${b.name}: ${b.typeName}`, detail: `${b.config.split('.').pop()}.${b.method}()${b.params.length ? ' ← ' + b.params.map((p) => p.type).join(', ') : ''}${b.conditions.length ? '  ' + b.conditions.join(' ') : ''}`, ref: cls(b.config, { line: b.line }) })),
      ...countBy(model.classes.filter((c) => c.isBean), 'stereotype').map(([k, n]) => ({ label: `${n} × ${k}`, detail: model.classes.filter((c) => c.isBean && c.stereotype === k).map((c) => c.name).slice(0, 12).join(', '), ref: { type: 'layer', id: k } })),
      ...model.profilesInCode.map((p) => ({ label: `@Profile(${p.profiles.join(', ')})`, detail: `${p.className}${p.member ? '.' + p.member + '()' : ''} only created for these profiles`, ref: cls(p.class) })),
    ],
  });

  // 5. connections
  const migrations = files.filter((f) => /db\/migration\/.+\.sql$/i.test(f));
  const changelogs = files.filter((f) => /db\/changelog/i.test(f));
  const sqlInit = files.filter((f) => /(^|\/)(schema|data)(-[\w]+)?\.sql$/.test(f) && !/\/test\//.test(f));
  phases.push({
    id: 'connections', title: 'Infrastructure connections', icon: 'plug',
    description: `${config.connections.length} external system(s) configured. Connection pools/clients are created now; most connect lazily on first use.`,
    items: [
      ...config.connections.map((c) => ({ label: `${c.name} (${c.tech})`, detail: `${c.url || ''}${c.profiles.length > 1 || c.profiles[0] !== 'default' ? '  profiles: ' + c.profiles.join(', ') : ''}${c.implied ? '  (implied default)' : ''}`, ref: { type: 'connection', id: c.id } })),
      ...(art.has('flyway-core') || migrations.length ? [{ label: `Flyway migrations (${migrations.length} scripts)`, detail: migrations.slice(-4).map((f) => f.split('/').pop()).join(', '), ref: migrations[0] ? { type: 'file', file: migrations[0] } : null }] : []),
      ...(art.has('liquibase-core') || changelogs.length ? [{ label: `Liquibase changelogs (${changelogs.length})`, detail: changelogs.slice(0, 4).join(', '), ref: changelogs[0] ? { type: 'file', file: changelogs[0] } : null }] : []),
      ...sqlInit.map((f) => ({ label: `SQL init: ${f.split('/').pop()}`, detail: f, ref: { type: 'file', file: f } })),
      ...(model.entities.length ? [{ label: `JPA/Data: ${model.entities.length} entities, ${model.classes.filter((c) => c.stereotype === 'repository').length} repositories`, detail: `ddl-auto: ${val(config, 'spring.jpa.hibernate.ddl-auto') || 'default'}`, ref: { type: 'view', id: 'data' } }] : []),
    ],
  });

  // 6. web layer
  const web = art.has('spring-boot-starter-webflux') ? 'Netty (WebFlux)' : art.has('spring-boot-starter-web') ? (art.has('spring-boot-starter-undertow') ? 'Undertow' : art.has('spring-boot-starter-jetty') ? 'Jetty' : 'Tomcat') : null;
  const filters = model.classes.filter((c) => c.stereotype === 'filter');
  const interceptors = model.classes.filter((c) => c.stereotype === 'interceptor');
  phases.push({
    id: 'web', title: 'Web layer & security', icon: 'globe',
    description: web ? `Embedded ${web} listens on port ${config.server.port}${config.server.contextPath ? ' with context path ' + config.server.contextPath : ''}. ${model.endpoints.length} endpoints mapped.` : 'No embedded web server starter detected.',
    items: [
      ...(web ? [{ label: `${web} :${config.server.port}${config.server.contextPath}`, detail: config.server.ssl ? 'HTTPS enabled' : 'HTTP', ref: { type: 'view', id: 'apis' } }] : []),
      ...model.security.configs.map((s) => ({ label: `SecurityFilterChain ${s.className}.${s.method}()`, detail: model.security.features.join(' · '), ref: cls(s.class, { line: s.line }) })),
      ...filters.map((f) => ({ label: `Filter ${f.name}`, detail: f.extends.concat(f.implements).join(', '), ref: cls(f.id) })),
      ...model.interceptorRegs.map((i) => ({ label: `Interceptor ${i.interceptor}`, detail: `paths: ${i.paths}`, ref: interceptors.find((x) => x.name === i.interceptor) ? cls(interceptors.find((x) => x.name === i.interceptor).id) : null })),
      ...model.classes.filter((c) => c.stereotype === 'advice').map((c) => ({ label: `@ControllerAdvice ${c.name}`, detail: model.exceptionHandlers.filter((h) => h.class === c.id).map((h) => h.exceptions.join('/')).join(', '), ref: cls(c.id) })),
      ...countBy(model.endpoints, 'controllerName').map(([k, n]) => ({ label: `${k}: ${n} endpoint(s)`, detail: model.endpoints.filter((e) => e.controllerName === k).slice(0, 5).map((e) => `${e.method} ${e.path}`).join(', '), ref: cls(model.endpoints.find((e) => e.controllerName === k).controller) })),
      ...(art.has('spring-boot-starter-actuator') ? [{ label: `Actuator ${config.server.actuatorBasePath}`, detail: `exposed: ${config.server.actuatorExposure || 'health (default)'}${config.server.managementPort ? ' on port ' + config.server.managementPort : ''}` }] : []),
      ...([...art].some((a) => /springdoc/.test(a)) ? [{ label: 'Swagger UI /swagger-ui.html', detail: 'OpenAPI JSON at /v3/api-docs' }] : []),
    ],
  });

  // 7. runners & background
  phases.push({
    id: 'runners', title: 'Post-start: runners, listeners & schedulers', icon: 'play',
    description: 'After the context refreshes: @PostConstruct hooks ran during bean init; runners execute; message listener containers and schedulers start.',
    items: [
      ...model.postConstructs.map((p) => ({ label: `@PostConstruct ${p.className}.${p.method}()`, ref: cls(p.class, { line: p.line }) })),
      ...model.runners.map((x) => ({ label: `${x.kind} ${x.className}.${x.method}()`, ref: cls(x.class, { line: x.line }), flow: `runner:${x.class}#${x.method}` })),
      ...model.eventListeners.filter((e) => /Application(Ready|Started|Context|Refreshed)|ContextRefreshed/.test(e.event || '')).map((e) => ({ label: `on ${e.event}: ${e.className}.${e.method}()`, ref: cls(e.class, { line: e.line }), flow: `event:${e.class}#${e.method}` })),
      ...model.listeners.map((l) => ({ label: `${l.tech} listener ${l.className}.${l.method}()`, detail: `${l.destinations.join(', ')}${l.group ? ' (group ' + l.group + ')' : ''}`, ref: cls(l.class, { line: l.line }), flow: `listener:${l.class}#${l.method}` })),
      ...model.scheduled.map((s) => ({ label: `@Scheduled ${s.className}.${s.method}()`, detail: s.cron ? `cron: ${s.cron}` : s.fixedRate ? `fixedRate: ${s.fixedRate}` : `fixedDelay: ${s.fixedDelay}`, ref: cls(s.class, { line: s.line }), flow: `scheduled:${s.class}#${s.method}` })),
    ],
  });

  phases.push({
    id: 'ready', title: 'ApplicationReadyEvent — serving traffic', icon: 'check',
    description: web ? `Started ${config.server.applicationName || build.artifactId || app?.name || 'application'} → http${config.server.ssl ? 's' : ''}://localhost:${config.server.port}${config.server.contextPath || '/'}` : 'Context refreshed and ready.',
    items: infra.compose.flatMap((c) => c.services).map((s) => ({ label: `compose: ${s.name}`, detail: `${s.image || ''} ${s.ports.join(' ')}`, ref: { type: 'view', id: 'infra' } })),
  });
  return phases;
}

function countBy(list, key) {
  const m = new Map();
  for (const x of list) m.set(x[key], (m.get(x[key]) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function val(config, key) { return config.effective.default.find((p) => p.key === key)?.resolved; }

module.exports = { buildStartup };
