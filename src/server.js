'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { analyzeProject } = require('./analyzer');
const { parseSource, materialize } = require('./source');
const { Store } = require('./store');
const { loadCode, trace } = require('./trace/tracer');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const VENDOR = {
  'cytoscape.js': 'node_modules/cytoscape/dist/cytoscape.min.js',
  'dagre.js': 'node_modules/dagre/dist/dagre.min.js',
  'cytoscape-dagre.js': 'node_modules/cytoscape-dagre/cytoscape-dagre.js',
  'mermaid.js': 'node_modules/mermaid/dist/mermaid.min.js',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// Browser-enforced guarantee that the UI can only talk to this local server:
// no scripts, fetches, images, fonts or form posts to any other origin.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function send(res, status, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(data);
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(data);
  });
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > limit) { reject(new Error(`Request too large (limit ${Math.round(limit / 1e6)} MB)`)); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}

async function runAnalysis(store, input, opts = {}) {
  const rel = typeof input === 'string' && !path.isAbsolute(input) ? path.join(ROOT, input) : null;
  if (rel && !fs.existsSync(input) && fs.existsSync(rel)) input = rel; // e.g. "samples/order-service"
  const src = parseSource(input);
  const { root, source } = await materialize(src);
  const report = analyzeProject(root, { includeTests: !!opts.includeTests, source });
  report.input = input;
  report.options = { includeTests: !!opts.includeTests };
  const id = store.save(report);
  return { id, report };
}

function createServer({ dataDir = path.join(ROOT, 'data'), extraHosts = [] } = {}) {
  const store = new Store(dataDir);
  const allowHosts = new Set(['localhost', '127.0.0.1', '::1', ...extraHosts.map((h) => h.toLowerCase())]);
  const inflight = new Map();
  const codeCache = new Map(); // project id -> {analyzedAt, code}  (parsed sources for log tracing)
  const codeFor = (r) => {
    const c = codeCache.get(r.id);
    if (c && c.analyzedAt === r.analyzedAt) return c.code;
    const code = loadCode(r.root);
    codeCache.set(r.id, { analyzedAt: r.analyzedAt, code });
    return code;
  };

  return http.createServer(async (req, res) => {
    // Reject DNS-rebinding / foreign Host headers so other websites can't read local data.
    const hostName = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!allowHosts.has(hostName)) return send(res, 403, { error: 'Forbidden host' });
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    try {
      if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/browse' || p.startsWith('/p/'))) return sendFile(res, path.join(PUBLIC, 'index.html'));
      if (req.method === 'GET' && p.startsWith('/vendor/')) { const v = VENDOR[p.slice(8)]; return v ? sendFile(res, path.join(ROOT, v)) : send(res, 404, { error: 'Not found' }); }
      if (req.method === 'GET' && p.startsWith('/static/')) {
        const f = path.resolve(PUBLIC, p.slice(8));
        if (!f.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
        return sendFile(res, f);
      }

      if (p === '/api/projects' && req.method === 'GET') {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const list = store.index().filter((x) => !q || JSON.stringify([x.name, x.basePackage, x.source?.url, x.source?.path, x.tech, x.description]).toLowerCase().includes(q));
        return send(res, 200, list);
      }
      if (p === '/api/analyze' && req.method === 'POST') {
        const body = await readBody(req);
        const key = JSON.stringify([body.source, body.branch, body.includeTests]);
        if (!inflight.has(key)) inflight.set(key, runAnalysis(store, body.source, body).finally(() => inflight.delete(key)));
        const { id, report } = await inflight.get(key);
        return send(res, 200, { id, name: report.name, durationMs: report.durationMs, warnings: report.warnings });
      }
      let m = /^\/api\/projects\/([\w-]+)$/.exec(p);
      if (m && req.method === 'GET') { const r = store.get(m[1]); return r ? send(res, 200, r) : send(res, 404, { error: 'Unknown project' }); }
      if (m && req.method === 'DELETE') { store.remove(m[1]); return send(res, 200, { ok: true }); }
      // Log tracing: the log text is processed in memory only and never written to disk.
      m = /^\/api\/projects\/([\w-]+)\/trace$/.exec(p);
      if (m && req.method === 'POST') {
        const r = store.get(m[1]);
        if (!r) return send(res, 404, { error: 'Unknown project' });
        const body = await readBody(req, 300e6);
        if (!body.log || !String(body.log).trim()) return send(res, 400, { error: 'Paste or upload a log first.' });
        const t0 = Date.now();
        const out = trace(codeFor(r), r, String(body.log), body.correlationId ? String(body.correlationId).trim() : null);
        out.tookMs = Date.now() - t0;
        return send(res, 200, out);
      }
      m = /^\/api\/projects\/([\w-]+)\/refresh$/.exec(p);
      if (m && req.method === 'POST') {
        const r = store.get(m[1]);
        if (!r) return send(res, 404, { error: 'Unknown project' });
        if (r.source.type !== 'local') return send(res, 400, { error: 'This analysis came from a Git URL; Spring Lens is offline-only now. Analyze a local folder instead.' });
        const input = r.source.path;
        const out = await runAnalysis(store, input, { ...(r.options || {}), refresh: true });
        return send(res, 200, { id: out.id, durationMs: out.report.durationMs });
      }
      m = /^\/api\/projects\/([\w-]+)\/source$/.exec(p);
      if (m && req.method === 'GET') {
        const r = store.get(m[1]);
        if (!r) return send(res, 404, { error: 'Unknown project' });
        const file = url.searchParams.get('file') || '';
        const abs = path.resolve(r.root, file);
        if (!abs.startsWith(path.resolve(r.root))) return send(res, 403, { error: 'Forbidden' });
        fs.readFile(abs, 'utf8', (err, text) => (err ? send(res, 404, { error: 'File not available (moved or deleted since analysis)' }) : send(res, 200, { file, text: text.length > 400000 ? text.slice(0, 400000) : text })));
        return;
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });
}

module.exports = { createServer, runAnalysis };
