# Spring Lens

Spring Lens reads a Spring Boot project from a local folder and generates interactive diagrams showing how the application works. It covers the whole lifecycle, from startup and its connections to every request flow. It is similar in spirit to gitdiagram.com, but built for Spring.

It works by static analysis only. You don't need to build or run the target app, and no JVM is required.

## Run

You don't need to install anything except [Node.js](https://nodejs.org) 18 or newer. There's no `npm install` step and no internet access is needed, because all libraries are bundled in `vendor/`.

- **Windows:** double-click `start.bat`. It opens your browser automatically.
- **macOS / Linux:** run `./start.sh`.
- **Any OS:** run `npm start`, then open http://localhost:7070.

Command-line use:

```bash
node bin/spring-lens.js serve --port 7070 --open
node bin/spring-lens.js analyze path/to/project --out report.json   # CLI summary / JSON
```

To share Spring Lens, copy or zip the folder **without** `data/`. That folder holds your own analyses.

Enter a local project folder on the home page, such as `D:\code\order-service`. Each analysis is stored in `data/analyses/` and listed on `/browse`.

## Offline and privacy

Spring Lens runs fully offline and makes no outbound connections.

- It only reads local folders. Git, GitHub and other URLs are rejected. To analyze a remote repo, clone it yourself and enter the local path.
- The server listens on `127.0.0.1` only and rejects requests whose `Host` header isn't localhost. This blocks DNS-rebinding attacks from websites open in your browser.
- A Content-Security-Policy makes the browser block any request to an origin other than the local server. All JavaScript libraries are served from the bundled `vendor/` folder, with no CDNs, fonts or analytics.
- Analyses are stored only in `data/` (git-ignored). Delete that folder to clear everything.

No step uses the network, not even setup: there is no `npm install`.

The repo includes a demo project at `samples/order-service`. It uses Kafka, Feign, WebClient, Redis, JPA, Security/OAuth2, events, `@Scheduled`, an OpenAPI YAML spec and docker-compose.

## Views

| View | What it shows |
|---|---|
| **Overview** | Stats, a clickable system diagram, findings (required env vars, hard-coded secrets, spec drift, bean cycles) and the tech stack |
| **Architecture** | The bean dependency-injection graph with DB, cache, broker and external API nodes. It can group beans by package and toggle entities and config classes |
| **Startup flow** | An animated timeline: `main()`, environment and profiles, auto-configuration from starters, `@Configuration`/`@Bean`, connections and migrations, web server and security, then runners, listeners and schedulers. It also has a bootstrap sequence diagram |
| **Request flows** | A sequence diagram, call graph and call tree for every endpoint, Kafka/Rabbit/JMS listener, `@Scheduled` job, runner and event listener. The trace runs through services and interfaces to repositories (including `@Query`), Feign, WebClient/RestTemplate, Kafka sends and Spring events (`@Async`/`@TransactionalEventListener`) |
| **APIs** | An endpoint table, an API path map, OpenAPI/Swagger YAML specs compared against the code (missing or undocumented operations), outbound clients and a `.http` export |
| **Configuration** | Effective properties per profile as a tree, with the file and line of each value and the class that reads it. Also a profile diff matrix, environment variables and a sample `.env` |
| **Connections** | Datasources (JDBC URL parsed), Redis, Kafka, RabbitMQ, Mongo, mail, OAuth2 issuers, Eureka/Config Server and external URLs, per profile. It shows implied defaults (such as embedded H2) and the matching docker-compose services |
| **Data model** | An ER diagram of entities, their relations and inherited `@MappedSuperclass` fields, plus the repositories that manage them |
| **Messaging & jobs** | The publisher → topic/event → consumer topology, plus scheduled jobs (with plain-language crons), `@Async` methods and caching |
| **Deployment** | docker-compose services, the Kubernetes Ingress → Service → Deployment → ConfigMap/Secret graph, and Dockerfiles |
| **Classes & beans** | A searchable list of all types. Click any node anywhere to open a details drawer with the source code |

## Log trace and root-cause diagnosis

Open **Log trace** in a project. Paste a log or open a log file, then enter a correlation, trace or request ID. **Find IDs** lists the IDs found in the log, with ERROR counts. You can also run it from the command line:

```bash
node bin/spring-lens.js trace samples/order-service --log samples/order-service/logs/order-service.log --id c0ffee42-9b1e-4d0a-8c5f-1a2b3c4d5e6f
```

What it does:

1. **Parses the log.** It reads Spring Boot default, Logback and Log4j text patterns, as well as JSON logs (logstash, ECS), including multi-line stack traces. It keeps the lines containing the ID.
2. **Maps each log line to its code statement.** It matches `log.info("Order {} saved…")` templates and `logger` names, and maps each stack frame to its file and line. It also extracts runtime values from the placeholders (`orderId = 1001`).
3. **Parses each method involved into a control-flow tree** (if/else, switch, loops, try/catch/finally, return, throw), then decides for each part whether it ran:
   - **Branch taken**: a log line or stack frame appears inside it.
   - **Branch not taken**: its log statement would have printed at an enabled level but is missing, or it returns or throws but execution continued after it.
   - **Loop iterations**: counted from repeated log lines.
   - **Catch block ran**: the try body failed and the catch logged or rethrew.
   - **Failure point and skipped code**: where the exception happened and the statements after it that never ran.
   - **Silent callees**: methods that printed nothing are still checked using the logs that are missing.
4. **Diagnosis**:
   - a one-sentence summary
   - the root-cause line and why it failed, with plain-English explanations for HTTP statuses, NullPointerException, DB constraints, empty Optionals, timeouts, validation and business-rule throws, plus the condition that led to the throw
   - how the error travelled: thrown, caught, logged, wrapped (warns if the original cause is lost), propagated, `@Transactional` rollback, `@ControllerAdvice`, HTTP status
   - side effects already done (DB writes, remote calls, messages), and whether they were rolled back
   - what to check next

The sample includes a payment-declined trace, a successful order and a blocked customer. Regenerate it with `node samples/order-service/logs/generate-sample-log.js`. Log contents are processed in memory only and never stored.

## Limits

- Only Java sources are parsed. Kotlin files are detected but not analyzed.
- The analysis is heuristic static analysis. Beans created reflectively or by conditions that depend on runtime state may be missed.
- Call tracing follows injected beans. Lambdas and streams are traced only when the call receiver is a known field, parameter or local variable.
