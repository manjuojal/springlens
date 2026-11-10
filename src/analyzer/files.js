'use strict';
const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'target', 'build', 'out', 'bin', '.gradle', '.idea', '.vscode', '.mvn',
  'dist', '.settings', '__pycache__', '.next', 'vendor', 'coverage', '.cache',
]);

/** Recursively list files of interest. Returns paths relative to root using '/' separators. */
function listFiles(root, { maxFiles = 20000 } = {}) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < maxFiles) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(r);
      } else if (e.isFile()) out.push(r);
    }
  }
  return out.sort();
}

function read(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; }
}

function classify(rel) {
  const lower = rel.toLowerCase();
  const base = lower.split('/').pop();
  const isTest = /(^|\/)src\/(test|it|integration-?test)\//.test(lower);
  return {
    isTest,
    java: lower.endsWith('.java'),
    kotlin: lower.endsWith('.kt'),
    pom: base === 'pom.xml',
    gradle: base === 'build.gradle' || base === 'build.gradle.kts',
    springConfig: /^(application|bootstrap)([-.][\w-]+)?\.(ya?ml|properties)$/.test(base),
    yaml: /\.(ya?ml)$/.test(base),
    json: base.endsWith('.json'),
    dockerfile: base === 'dockerfile' || base.startsWith('dockerfile.') || base.endsWith('.dockerfile'),
    compose: /^(docker-)?compose([-.][\w-]+)?\.ya?ml$/.test(base),
    sql: base.endsWith('.sql'),
    migration: /db\/migration|db\/changelog|liquibase|flyway/.test(lower),
  };
}

module.exports = { listFiles, read, classify };
