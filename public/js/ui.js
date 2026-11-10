// Shared UI helpers
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny hyperscript: h('div.card#id', {onclick}, children...) */
export function h(tag, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { children.unshift(attrs); attrs = {}; }
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) for (const part of m[2].match(/[.#][\w-]+/g)) { if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1); }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sv == null) continue; if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
export const short = (fqn) => String(fqn || '').split('.').pop();

export const STEREO = {
  application: { color: '#6db33f', label: 'Application', icon: '🚀' },
  controller: { color: '#3b82f6', label: 'Controller', icon: '🌐' },
  advice: { color: '#e11d48', label: 'Controller advice', icon: '🛟' },
  service: { color: '#10b981', label: 'Service', icon: '⚙️' },
  component: { color: '#06b6d4', label: 'Component', icon: '🧩' },
  repository: { color: '#f59e0b', label: 'Repository', icon: '🗄️' },
  entity: { color: '#8b5cf6', label: 'Entity', icon: '📦' },
  configuration: { color: '#64748b', label: 'Configuration', icon: '🛠️' },
  properties: { color: '#94a3b8', label: 'Config properties', icon: '📝' },
  security: { color: '#dc2626', label: 'Security', icon: '🔐' },
  filter: { color: '#ef4444', label: 'Filter', icon: '🧱' },
  interceptor: { color: '#f43f5e', label: 'Interceptor', icon: '🪝' },
  aspect: { color: '#d946ef', label: 'Aspect', icon: '✂️' },
  client: { color: '#ec4899', label: 'HTTP client', icon: '📡' },
  listener: { color: '#f97316', label: 'Listener', icon: '📥' },
  scheduler: { color: '#fb923c', label: 'Scheduler', icon: '⏰' },
  model: { color: '#a1a1aa', label: 'Model / DTO', icon: '📄' },
  exception: { color: '#a1a1aa', label: 'Exception', icon: '⚠️' },
  annotation: { color: '#a1a1aa', label: 'Annotation', icon: '@' },
  other: { color: '#a1a1aa', label: 'Other', icon: '·' },
  infra: { color: '#0ea5e9', label: 'Infrastructure', icon: '🔌' },
};
export const CONN = {
  database: { color: '#0ea5e9', icon: '🛢️', label: 'Database' },
  cache: { color: '#ef4444', icon: '⚡', label: 'Cache' },
  broker: { color: '#f97316', icon: '📨', label: 'Message broker' },
  search: { color: '#eab308', icon: '🔎', label: 'Search' },
  mail: { color: '#14b8a6', icon: '✉️', label: 'Mail' },
  discovery: { color: '#22c55e', icon: '🧭', label: 'Discovery' },
  config: { color: '#64748b', icon: '🧾', label: 'Config server' },
  auth: { color: '#dc2626', icon: '🔑', label: 'Identity provider' },
  vault: { color: '#334155', icon: '🔒', label: 'Secrets' },
  http: { color: '#ec4899', icon: '🌍', label: 'External API' },
};
export const METHOD_COLORS = { GET: '#10b981', POST: '#3b82f6', PUT: '#f59e0b', PATCH: '#a855f7', DELETE: '#ef4444', ANY: '#64748b', HEAD: '#64748b', OPTIONS: '#64748b' };

export const badge = (text, color, cls = '') => h('span.badge' + (cls ? '.' + cls : ''), { style: color ? { '--c': color } : null }, text);
export const stereoBadge = (s) => badge(STEREO[s]?.label || s, STEREO[s]?.color);
export const methodBadge = (m) => h('span.method', { style: { '--c': METHOD_COLORS[m] || '#64748b' } }, m);

export function toast(msg, kind = 'info', ms = 3500) {
  let box = $('#toasts');
  if (!box) { box = h('div#toasts'); document.body.append(box); }
  const t = h('div.toast.' + kind, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

export function isDark() { return document.documentElement.dataset.theme === 'dark'; }
export function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

export function debounce(fn, ms = 200) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

export function empty(msg, hint) { return h('div.empty', h('div.empty-icon', '∅'), h('div', msg), hint ? h('div.muted', hint) : null); }

export function download(name, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
}

/** Segmented tabs: returns element; onChange(key) */
export function tabs(items, active, onChange) {
  const el = h('div.seg');
  for (const [key, label] of items) {
    const b = h('button' + (key === active ? '.active' : ''), { onclick: () => { $$('button', el).forEach((x) => x.classList.remove('active')); b.classList.add('active'); onChange(key); } }, label);
    el.append(b);
  }
  return el;
}

/** Minimal Java/YAML/properties syntax highlighter (returns HTML). */
export function highlight(code, lang) {
  const e = esc(code);
  if (lang === 'java') {
    return e.replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(&quot;(?:[^&\n]|&(?!quot;))*?&quot;)|(@[A-Za-z_][\w.]*)|\b(public|private|protected|static|final|abstract|class|interface|enum|record|extends|implements|return|new|if|else|for|while|try|catch|finally|throw|throws|import|package|void|this|super|null|true|false|var|switch|case|default|break|continue|instanceof|synchronized|volatile|transient)\b|\b([A-Z][\w]*)\b/g,
      (m, com, str, ann, kw, type) => com ? `<span class="t-com">${com}</span>` : str ? `<span class="t-str">${str}</span>` : ann ? `<span class="t-ann">${ann}</span>` : kw ? `<span class="t-kw">${kw}</span>` : type ? `<span class="t-type">${type}</span>` : m);
  }
  if (lang === 'yaml' || lang === 'properties') {
    return e.replace(/^(\s*#.*)$|^(\s*-?\s*)([\w.\-[\]"']+)(\s*[:=])(.*)$/gm, (m, com, ind, key, sep, val) => com ? `<span class="t-com">${com}</span>` : `${ind}<span class="t-key">${key}</span>${sep}<span class="t-val">${val.replace(/(\$\{[^}]*\})/g, '<span class="t-ph">$1</span>')}</span>`);
  }
  return e;
}
export function langOf(file) { return /\.java$/.test(file) ? 'java' : /\.ya?ml$/.test(file) ? 'yaml' : /\.properties$/.test(file) ? 'properties' : 'text'; }
