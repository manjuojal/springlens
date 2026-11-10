#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const { createServer } = require('../src/server');
const { analyzeProject } = require('../src/analyzer');

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('-') ? args.shift() : 'serve';
const flag = (name, def) => { const i = args.indexOf('--' + name); if (i === -1) return def; const v = args[i + 1]; args.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : true; };

if (cmd === 'serve') {
  const port = Number(flag('port', process.env.PORT || 7070));
  const open = flag('open', false);
  const dataDir = flag('data', process.env.SPRING_LENS_DATA || path.join(__dirname, '..', 'data'));
  // Bind to loopback by default: the server can serve project source files.
  // Use --host 0.0.0.0 only if you deliberately want other machines to reach it.
  const host = flag('host', process.env.HOST || '127.0.0.1');
  // Extra Host names accepted besides localhost (needed together with --host 0.0.0.0), e.g. --allow-host 192.168.0.10
  const allow = flag('allow-host', '');
  const extraHosts = typeof allow === 'string' ? allow.split(',').map((s) => s.trim()).filter(Boolean) : [];
  createServer({ dataDir, extraHosts }).listen(port, host, () => {
    const url = `http://localhost:${port}`;
    console.log(`Spring Lens running at ${url}${host !== '127.0.0.1' ? `  (listening on ${host} - reachable from other machines)` : ''}`);
    if (open) {
      const { exec } = require('child_process');
      exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`);
    }
  });
} else if (cmd === 'analyze') {
  const out = flag('out', null);
  const includeTests = !!flag('tests', false);
  const target = args[0];
  if (!target) { console.error('Usage: spring-lens analyze <project-dir> [--out report.json] [--tests]'); process.exit(1); }
  const r = analyzeProject(path.resolve(target), { includeTests });
  if (out) fs.writeFileSync(out, JSON.stringify(r, null, 1));
  const c = r.summary.counts;
  console.log(`${r.name}  (Spring Boot ${r.summary.springBootVersion || '?'}, Java ${r.summary.javaVersion || '?'}, ${r.summary.buildTool})`);
  console.log(`  ${c.classes} classes · ${c.beans} beans · ${c.endpoints} endpoints · ${c.entities} entities · ${c.connections} connections · ${r.flows.length} flows  [${r.durationMs} ms]`);
  for (const e of r.endpoints) console.log(`  ${e.method.padEnd(6)} ${e.path}  →  ${e.controllerName}.${e.handler}()`);
  for (const cn of r.config.connections) console.log(`  ⇄ ${cn.name} [${cn.tech}] ${cn.url || ''}  (${cn.profiles.join(', ')})`);
  for (const w of r.warnings) console.log(`  ! ${w}`);
  if (out) console.log(`Report written to ${out}`);
} else if (cmd === 'trace') {
  const { loadCode, trace } = require('../src/trace/tracer');
  const logFile = flag('log', null);
  const id = flag('id', null);
  const out = flag('json', null);
  const target = args[0];
  if (!target || !logFile) { console.error('Usage: spring-lens trace <project-dir> --log app.log [--id <correlation-id>] [--json trace.json]'); process.exit(1); }
  const root = path.resolve(target);
  const report = analyzeProject(root, {});
  const r = trace(loadCode(root), report, fs.readFileSync(logFile, 'utf8'), typeof id === 'string' ? id : null);
  if (out) fs.writeFileSync(out, JSON.stringify(r, null, 1));
  if (r.error || !r.correlationId) {
    if (r.error) console.log(r.error);
    console.log('Correlation / trace ids found in the log:');
    for (const c of r.candidates || []) console.log(`  ${c.id.padEnd(40)} ${String(c.count).padStart(4)} lines${c.errors ? `  ${c.errors} ERROR` : ''}  ${c.first || ''}`);
    if (!r.correlationId) process.exit(0);
  }
  const o = r.outcome;
  console.log(`\nTrace ${r.correlationId}: ${r.selected} log lines, ${r.durationMs != null ? r.durationMs + ' ms' : ''}  entry: ${r.entryPoint ? r.entryPoint.label : '?'}`);
  if (o.status === 'failed') {
    const e = o.error;
    console.log(`RESULT: FAILED  ${e.rootType || e.type || ''}${e.rootMessage || e.exceptionMessage ? ': ' + (e.rootMessage || e.exceptionMessage) : ''}`);
    if (e.at) console.log(`        at ${e.at.className}.${e.at.method}() ${e.at.file}:${e.at.line}${e.statement ? '\n        ' + e.statement : ''}`);
  } else console.log(`RESULT: ${o.status.toUpperCase()}`);
  console.log('\nWalkthrough:');
  for (const s of r.steps) {
    const pad = '  '.repeat(s.depth + 1);
    const loc = s.ref ? `  (${(r.methods.find((m) => m.key === s.ref.key) || {}).className || ''}:${s.ref.line})` : '';
    const txt = s.kind === 'log' ? `📝 [${s.level}] ${s.text}` : s.text;
    console.log(`${pad}${txt}${s.kind === 'log' ? '' : loc}${s.reason ? `   — ${s.reason}` : ''}${s.detail ? `\n${pad}   ${s.detail}` : ''}`);
  }
  if (r.unmatched.length) console.log(`\n${r.unmatched.length} log line(s) could not be mapped to code.`);
} else {
  console.log('Usage:\n  spring-lens serve [--port 7070] [--open] [--data ./data] [--host 127.0.0.1]\n  spring-lens analyze <project-dir> [--out report.json] [--tests]\n  spring-lens trace <project-dir> --log app.log [--id <correlation-id>] [--json trace.json]');
}
