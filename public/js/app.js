import { h, $, toast, download } from './ui.js';
import { openRef, closeDrawer } from './drawer.js';

const VIEWS = [
  ['overview', 'Overview', '◎', () => import('./views/overview.js')],
  ['architecture', 'Architecture', '⬡', () => import('./views/architecture.js')],
  ['startup', 'Startup flow', '▶', () => import('./views/startup.js')],
  ['flows', 'Request flows', '⇢', () => import('./views/flows.js')],
  ['trace', 'Log trace', '🔍', () => import('./views/trace.js')],
  ['apis', 'APIs', '⌁', () => import('./views/apis.js')],
  ['config', 'Configuration', '⚙', () => import('./views/config.js')],
  ['connections', 'Connections', '⇄', () => import('./views/connections.js')],
  ['data', 'Data model', '▤', () => import('./views/data.js')],
  ['messaging', 'Messaging & jobs', '✉', () => import('./views/messaging.js')],
  ['infra', 'Deployment', '☁', () => import('./views/infra.js')],
  ['classes', 'Classes & beans', '☰', () => import('./views/classes.js')],
];

const state = { report: null, cleanup: null };
export const api = {
  async get(url) { const r = await fetch(url); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; },
  async post(url, body) { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; },
  async del(url) { const r = await fetch(url, { method: 'DELETE' }); return r.json(); },
};

export function navigate(url, replace = false) {
  if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
  route();
}
window.addEventListener('popstate', route);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.ctrlKey && !e.metaKey && e.button === 0) { e.preventDefault(); navigate(a.getAttribute('href')); }
});

/* theme */
const savedTheme = (() => { try { return localStorage.getItem('sl-theme'); } catch { return null; } })();
document.documentElement.dataset.theme = savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
$('#theme').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('sl-theme', t); } catch { /* ignore */ }
  route();
});

async function route() {
  if (state.cleanup) { try { state.cleanup(); } catch { /* ignore */ } state.cleanup = null; }
  closeDrawer();
  const path = location.pathname;
  const m = /^\/p\/([\w-]+)(?:\/([\w-]+))?/.exec(path);
  const app = $('#app');
  if (!m) {
    state.report = null;
    setHeader(null);
    const mod = await import('./views/home.js');
    app.className = 'home';
    app.replaceChildren();
    mod.render({ el: app, api, navigate, params: new URLSearchParams(location.search) });
    return;
  }
  const [, id, view = 'overview'] = m;
  if (!state.report || state.report.id !== id) {
    app.className = 'loading';
    app.replaceChildren(h('div.spinner'), h('div.muted', 'Loading analysis…'));
    try { state.report = await api.get(`/api/projects/${id}`); } catch (e) { app.replaceChildren(h('div.error', e.message), h('a', { href: '/', 'data-link': true }, '← Back')); return; }
  }
  const report = state.report;
  setHeader(report);
  const def = VIEWS.find((v) => v[0] === view) || VIEWS[0];
  const nav = h('nav.sidenav', VIEWS.map(([key, label, icon]) => h('a' + (key === def[0] ? '.active' : ''), { href: `/p/${id}/${key}`, 'data-link': true }, h('span.ni', icon), h('span', label), count(report, key))));
  const main = h('main.view');
  app.className = 'project';
  app.replaceChildren(nav, main);
  document.title = `${report.name} · ${def[1]} — Spring Lens`;
  const mod = await def[3]();
  const ctx = {
    report, el: main, api, navigate, params: new URLSearchParams(location.search),
    go: (v, params) => navigate(`/p/${id}/${v}${params ? '?' + new URLSearchParams(params) : ''}`),
    open: (ref) => openRef(report, ref, ctx),
    setParam: (k, v) => { const p = new URLSearchParams(location.search); if (v == null) p.delete(k); else p.set(k, v); history.replaceState(null, '', `${location.pathname}${p.toString() ? '?' + p : ''}`); },
  };
  try { state.cleanup = (await mod.render(ctx)) || null; } catch (e) { console.error(e); main.append(h('div.error', 'View failed: ' + e.message)); }
}

function count(r, key) {
  const n = { architecture: r.classes.filter((c) => c.isBean).length, flows: r.flows.length, apis: r.endpoints.length, config: r.config.files.length, connections: r.config.connections.length, data: r.entities.length, messaging: r.listeners.length + r.scheduled.length + r.messaging.publishers.length, infra: r.infra.compose.length + r.infra.k8s.length + r.infra.dockerfiles.length, classes: r.classes.length }[key];
  return n ? h('span.cnt', n) : null;
}

function setHeader(report) {
  const box = $('#project-head');
  box.replaceChildren();
  if (!report) return;
  const src = report.source;
  box.append(
    h('span.sep', '/'),
    h('a.pname', { href: `/p/${report.id}/overview`, 'data-link': true }, report.name),
    h('span.src', { title: src.path || '' }, src.path || ''),
    h('span.muted.small', `analyzed ${new Date(report.analyzedAt).toLocaleString()}`),
    h('button.ghost', { title: 'Re-read the sources and regenerate diagrams', onclick: async (e) => {
      e.target.disabled = true; e.target.textContent = 'Re-analyzing…';
      try { await api.post(`/api/projects/${report.id}/refresh`); state.report = null; toast('Diagrams regenerated', 'ok'); route(); } catch (err) { toast(err.message, 'err'); e.target.disabled = false; e.target.textContent = '↻ Refresh'; }
    } }, '↻ Refresh'),
    h('button.ghost', { title: 'Download the raw analysis as JSON', onclick: () => download(`${report.id}.json`, JSON.stringify(report, null, 1)) }, '⇩ JSON'),
  );
}

route();
