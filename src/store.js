'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.analysesDir = path.join(dir, 'analyses');
    fs.mkdirSync(this.analysesDir, { recursive: true });
    this.indexFile = path.join(dir, 'index.json');
  }

  idFor(name, source) {
    const key = source.type === 'local' ? source.path.toLowerCase() : `${source.url}#${source.branch || ''}#${source.subdir || ''}`;
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
    return `${slug}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)}`;
  }

  index() {
    try { return JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { return []; }
  }

  save(report) {
    const id = report.id || this.idFor(report.name, report.source);
    report.id = id;
    fs.writeFileSync(path.join(this.analysesDir, id + '.json'), JSON.stringify(report));
    const idx = this.index().filter((x) => x.id !== id);
    idx.unshift({
      id, name: report.name, source: report.source, analyzedAt: report.analyzedAt,
      basePackage: report.summary.basePackage, springBootVersion: report.summary.springBootVersion, javaVersion: report.summary.javaVersion,
      counts: report.summary.counts, description: report.build.description || null,
      tech: [...new Set(report.config.connections.map((c) => c.tech))].slice(0, 8),
    });
    fs.writeFileSync(this.indexFile, JSON.stringify(idx, null, 1));
    return id;
  }

  get(id) {
    if (!/^[\w-]+$/.test(id)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.analysesDir, id + '.json'), 'utf8')); } catch { return null; }
  }

  remove(id) {
    if (!/^[\w-]+$/.test(id)) return;
    fs.rmSync(path.join(this.analysesDir, id + '.json'), { force: true });
    fs.writeFileSync(this.indexFile, JSON.stringify(this.index().filter((x) => x.id !== id), null, 1));
  }
}

module.exports = { Store };
