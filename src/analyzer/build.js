'use strict';
/** Maven / Gradle build file analysis. */

function tag(xml, name) {
  const m = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml);
  return m ? m[1] : null;
}

function stripXmlComments(xml) { return xml.replace(/<!--[\s\S]*?-->/g, ''); }

function parsePom(xml, file) {
  xml = stripXmlComments(xml);
  const props = {};
  const pb = /<properties>([\s\S]*?)<\/properties>/.exec(xml);
  if (pb) {
    const re = /<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g; let m;
    while ((m = re.exec(pb[1]))) props[m[1]] = m[2];
  }
  const resolve = (v) => (v ? v.replace(/\$\{([^}]+)\}/g, (s, k) => props[k] ?? s) : v);
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(xml);
  const parentInfo = parent ? { groupId: tag(parent[1], 'groupId'), artifactId: tag(parent[1], 'artifactId'), version: tag(parent[1], 'version') } : null;
  const noParentXml = xml.replace(/<parent>[\s\S]*?<\/parent>/, '');
  const head = noParentXml.replace(/<dependencies>[\s\S]*<\/dependencies>/, '').replace(/<build>[\s\S]*<\/build>/, '').replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/, '').replace(/<profiles>[\s\S]*?<\/profiles>/, '');
  const deps = [];
  const depsXml = noParentXml.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '').replace(/<plugins?>[\s\S]*?<\/plugins?>/g, '');
  const dre = /<dependency>([\s\S]*?)<\/dependency>/g; let d;
  while ((d = dre.exec(depsXml))) {
    deps.push({
      group: tag(d[1], 'groupId'),
      artifact: tag(d[1], 'artifactId'),
      version: resolve(tag(d[1], 'version')),
      scope: tag(d[1], 'scope') || 'compile',
      optional: tag(d[1], 'optional') === 'true',
    });
  }
  const modules = [];
  const mb = /<modules>([\s\S]*?)<\/modules>/.exec(xml);
  if (mb) { const re = /<module>\s*([^<]+?)\s*<\/module>/g; let m; while ((m = re.exec(mb[1]))) modules.push(m[1]); }
  const plugins = [];
  const plre = /<plugin>([\s\S]*?)<\/plugin>/g; let p;
  while ((p = plre.exec(xml))) plugins.push(tag(p[1], 'artifactId'));
  let bootVersion = null;
  if (parentInfo && /spring-boot/.test(parentInfo.artifactId || '')) bootVersion = parentInfo.version;
  const bomM = /<artifactId>spring-boot-dependencies<\/artifactId>\s*<version>([^<]+)<\/version>/.exec(xml);
  if (!bootVersion && bomM) bootVersion = resolve(bomM[1]);
  if (!bootVersion && props['spring-boot.version']) bootVersion = props['spring-boot.version'];
  return {
    tool: 'maven',
    file,
    groupId: tag(head, 'groupId') || parentInfo?.groupId,
    artifactId: tag(head, 'artifactId'),
    version: resolve(tag(head, 'version')) || parentInfo?.version,
    name: tag(head, 'name'),
    description: tag(head, 'description'),
    packaging: tag(head, 'packaging') || 'jar',
    parent: parentInfo,
    springBootVersion: bootVersion,
    springCloudVersion: props['spring-cloud.version'] || null,
    javaVersion: props['java.version'] || props['maven.compiler.release'] || props['maven.compiler.source'] || null,
    properties: props,
    dependencies: deps,
    modules,
    plugins,
  };
}

function parseGradle(text, file) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const deps = [];
  const re = /\b(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor|developmentOnly|kapt|compile|runtime)\s*\(?\s*(?:platform\s*\()?\s*['"]([^'"]+)['"]/g; let m;
  while ((m = re.exec(src))) {
    const [group, artifact, version] = m[2].split(':');
    const scope = /^test/.test(m[1]) ? 'test' : /runtime/i.test(m[1]) ? 'runtime' : /compileOnly|annotationProcessor|kapt/.test(m[1]) ? 'provided' : 'compile';
    deps.push({ group, artifact, version: version || null, scope, configuration: m[1] });
  }
  const boot = /id\s*\(?\s*['"]org\.springframework\.boot['"]\s*\)?\s*version\s*['"]([^'"]+)['"]/.exec(src)
    || /org\.springframework\.boot:spring-boot-gradle-plugin:([\w.-]+)/.exec(src);
  const java = /languageVersion\s*(?:=|\.set\()\s*JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(src)
    || /sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?([\d._]+)['"]?/.exec(src);
  const group = /^\s*group\s*=\s*['"]([^'"]+)['"]/m.exec(src);
  const version = /^\s*version\s*=\s*['"]([^'"]+)['"]/m.exec(src);
  const plugins = [];
  const pre = /id\s*\(?\s*['"]([^'"]+)['"]/g; let p;
  while ((p = pre.exec(src))) plugins.push(p[1]);
  return {
    tool: 'gradle',
    file,
    groupId: group ? group[1] : null,
    artifactId: null,
    version: version ? version[1] : null,
    springBootVersion: boot ? boot[1] : null,
    javaVersion: java ? java[1].replace('_', '.') : null,
    dependencies: deps,
    modules: [],
    plugins,
  };
}

/** What each well-known starter/library contributes at startup (auto-configuration). */
const STARTER_INFO = [
  [/spring-boot-starter-web$/, 'Web MVC', 'Embedded Tomcat, DispatcherServlet, Jackson HTTP message converters'],
  [/spring-boot-starter-webflux/, 'WebFlux', 'Reactive Netty server, WebClient, reactive handler mappings'],
  [/spring-boot-starter-data-jpa/, 'Spring Data JPA', 'DataSource + HikariCP pool, Hibernate EntityManagerFactory, JPA repositories, transaction manager'],
  [/spring-boot-starter-jdbc/, 'JDBC', 'DataSource + HikariCP pool, JdbcTemplate, transaction manager'],
  [/spring-boot-starter-data-r2dbc/, 'R2DBC', 'Reactive ConnectionFactory, R2dbcEntityTemplate'],
  [/spring-boot-starter-data-mongodb/, 'MongoDB', 'MongoClient, MongoTemplate, Mongo repositories'],
  [/spring-boot-starter-data-redis/, 'Redis', 'Lettuce connection factory, RedisTemplate'],
  [/spring-boot-starter-data-elasticsearch/, 'Elasticsearch', 'Elasticsearch client, repositories'],
  [/spring-boot-starter-data-cassandra/, 'Cassandra', 'CqlSession, CassandraTemplate'],
  [/spring-boot-starter-data-rest/, 'Data REST', 'Exposes repositories as REST resources'],
  [/spring-boot-starter-security/, 'Spring Security', 'SecurityFilterChain, authentication manager, password encoder'],
  [/spring-boot-starter-oauth2-resource-server/, 'OAuth2 Resource Server', 'JWT decoder, bearer token authentication filter'],
  [/spring-boot-starter-oauth2-client/, 'OAuth2 Client', 'Client registrations, OAuth2 login flow'],
  [/spring-boot-starter-actuator/, 'Actuator', 'Health, metrics, info endpoints under /actuator'],
  [/spring-boot-starter-cache/, 'Cache', 'CacheManager (simple, Caffeine, Redis, JCache…)'],
  [/spring-boot-starter-validation/, 'Bean Validation', 'Hibernate Validator for @Valid'],
  [/spring-boot-starter-thymeleaf/, 'Thymeleaf', 'Template engine & view resolver'],
  [/spring-boot-starter-amqp/, 'RabbitMQ', 'CachingConnectionFactory, RabbitTemplate, listener containers'],
  [/spring-kafka|spring-boot-starter-kafka/, 'Kafka', 'Producer/consumer factories, KafkaTemplate, listener containers'],
  [/spring-boot-starter-mail/, 'Mail', 'JavaMailSender'],
  [/spring-boot-starter-batch/, 'Spring Batch', 'JobRepository, JobLauncher'],
  [/spring-boot-starter-quartz/, 'Quartz', 'Quartz Scheduler'],
  [/spring-boot-starter-graphql/, 'GraphQL', 'GraphQL endpoint and schema wiring'],
  [/spring-boot-starter-websocket/, 'WebSocket', 'WebSocket/STOMP message broker'],
  [/spring-boot-starter-aop/, 'AOP', 'AspectJ auto-proxying'],
  [/spring-cloud-starter-openfeign/, 'OpenFeign', 'Declarative HTTP clients for @FeignClient interfaces'],
  [/spring-cloud-starter-netflix-eureka-client/, 'Eureka Client', 'Registers with service discovery'],
  [/spring-cloud-starter-netflix-eureka-server/, 'Eureka Server', 'Service registry'],
  [/spring-cloud-starter-config/, 'Config Client', 'Loads properties from Spring Cloud Config server'],
  [/spring-cloud-config-server/, 'Config Server', 'Serves configuration to clients'],
  [/spring-cloud-starter-gateway/, 'Cloud Gateway', 'Reactive API gateway routes & filters'],
  [/spring-cloud-starter-circuitbreaker|resilience4j/, 'Resilience4j', 'Circuit breakers, retries, rate limiters'],
  [/spring-cloud-stream/, 'Cloud Stream', 'Binder-based messaging (functions bound to destinations)'],
  [/flyway-core/, 'Flyway', 'Runs DB migrations from db/migration on startup'],
  [/liquibase-core/, 'Liquibase', 'Runs DB changelogs on startup'],
  [/springdoc-openapi/, 'springdoc OpenAPI', 'Generates /v3/api-docs and Swagger UI'],
  [/springfox/, 'Springfox Swagger', 'Generates Swagger docs'],
  [/micrometer-registry-prometheus/, 'Prometheus', '/actuator/prometheus metrics scrape endpoint'],
  [/micrometer-tracing|opentelemetry/, 'Tracing', 'Distributed tracing instrumentation'],
  [/^h2$/, 'H2', 'Embedded in-memory database (default DataSource if no URL)'],
  [/^(mysql-connector-j|mysql-connector-java)$/, 'MySQL driver', 'JDBC driver for MySQL'],
  [/^postgresql$/, 'PostgreSQL driver', 'JDBC driver for PostgreSQL'],
  [/^(mariadb-java-client)$/, 'MariaDB driver', 'JDBC driver for MariaDB'],
  [/^(ojdbc\d*)$/, 'Oracle driver', 'JDBC driver for Oracle'],
  [/^mssql-jdbc$/, 'SQL Server driver', 'JDBC driver for SQL Server'],
  [/^lombok$/, 'Lombok', 'Compile-time boilerplate generation'],
  [/^mapstruct$/, 'MapStruct', 'Compile-time bean mappers'],
  [/spring-boot-devtools/, 'DevTools', 'Automatic restart & live reload in development'],
  [/spring-boot-docker-compose/, 'Docker Compose support', 'Starts compose services on startup and wires connections'],
  [/spring-boot-testcontainers/, 'Testcontainers', 'Container-backed service connections'],
  [/caffeine/, 'Caffeine', 'In-memory cache provider'],
  [/cache-api|ehcache/, 'JCache', 'JSR-107 cache provider'],
];

function describeDependency(dep) {
  for (const [re, name, desc] of STARTER_INFO) if (re.test(dep.artifact || '')) return { name, desc };
  return null;
}

function mergeBuilds(builds) {
  if (!builds.length) return { tool: 'unknown', dependencies: [], modules: [] };
  const root = builds.slice().sort((a, b) => a.file.split('/').length - b.file.split('/').length)[0];
  const seen = new Set();
  const dependencies = [];
  for (const b of builds) for (const d of b.dependencies) {
    const k = `${d.group}:${d.artifact}:${d.scope}`;
    if (seen.has(k)) continue; seen.add(k);
    dependencies.push({ ...d, module: b.file, info: describeDependency(d) });
  }
  return {
    ...root,
    springBootVersion: builds.map((b) => b.springBootVersion).find(Boolean) || null,
    javaVersion: builds.map((b) => b.javaVersion).find(Boolean) || null,
    dependencies,
    buildFiles: builds.map((b) => ({ file: b.file, tool: b.tool, artifactId: b.artifactId, modules: b.modules })),
  };
}

module.exports = { parsePom, parseGradle, mergeBuilds, describeDependency };
