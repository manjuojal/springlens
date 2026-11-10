import { h, toast, debounce, CONN } from '../ui.js';

const EXAMPLES = [
  ['sample: order-service', 'samples/order-service'],
];

export function render({ el, api, navigate, params }) {
  const input = h('input.search', { placeholder: 'Local project folder, e.g. D:\\code\\my-service', autofocus: true, value: params.get('src') || '' });
  const tests = h('input', { type: 'checkbox' });
  const progress = h('div.progress', { style: { display: 'none' } }, h('div.spinner'), h('span.ptext', 'Reading sources…'));
  const btn = h('button.primary', { onclick: go }, 'Generate diagrams');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  async function go() {
    const source = input.value.trim();
    if (!source) { input.focus(); return; }
    btn.disabled = true; progress.style.display = 'flex';
    const steps = ['Reading local sources…', 'Parsing Java classes & annotations…', 'Reading application.yml / properties…', 'Resolving beans & dependencies…', 'Tracing request flows…', 'Building diagrams…'];
    let i = 0; const timer = setInterval(() => { progress.querySelector('.ptext').textContent = steps[Math.min(++i, steps.length - 1)]; }, 900);
    try {
      const r = await api.post('/api/analyze', { source, includeTests: tests.checked });
      if (r.warnings?.length) toast(r.warnings[0], 'info', 6000);
      navigate(`/p/${r.id}/overview`);
    } catch (e) {
      toast(e.message, 'err', 7000);
    } finally { clearInterval(timer); btn.disabled = false; progress.style.display = 'none'; }
  }

  const q = h('input.search', { type: 'search', placeholder: 'Search analyzed projects… (e.g. spring, kafka, postgres)', value: params.get('q') || '' });
  const cards = h('div.pcards');
  const load = async () => {
    const list = await api.get('/api/projects?q=' + encodeURIComponent(q.value.trim()));
    const url = new URL(location.href);
    if (q.value.trim()) url.searchParams.set('q', q.value.trim()); else url.searchParams.delete('q');
    history.replaceState(null, '', url.pathname + url.search);
    cards.replaceChildren(...(list.length ? list.map(card) : [h('div.muted', q.value ? 'No analyzed project matches.' : 'No projects analyzed yet — enter a project folder path above.')]));
  };
  q.addEventListener('input', debounce(load, 200));

  function card(p) {
    const c = p.counts || {};
    return h('a.pcard', { href: `/p/${p.id}/overview`, 'data-link': true },
      h('div.pt', p.source?.type === 'git' ? '⎇' : '📁', p.name),
      h('div.ps', p.source?.type === 'git' ? p.source.url : p.source?.path),
      p.description ? h('div.small.muted', p.description.slice(0, 140)) : null,
      h('div.pn', h('span', h('b', c.endpoints ?? 0), ' endpoints'), h('span', h('b', c.beans ?? 0), ' beans'), h('span', h('b', c.entities ?? 0), ' entities'), h('span', h('b', c.connections ?? 0), ' connections')),
      h('div.chips', p.springBootVersion ? h('span.badge', { style: { '--c': '#6db33f' } }, 'Boot ' + p.springBootVersion) : null, p.javaVersion ? h('span.badge', { style: { '--c': '#f97316' } }, 'Java ' + p.javaVersion) : null, (p.tech || []).map((t) => h('span.badge', { style: { '--c': '#0ea5e9' } }, t))),
      h('div.small.muted', 'analyzed ' + new Date(p.analyzedAt).toLocaleString()),
      h('button.icon.del', { title: 'Remove from list', onclick: async (e) => { e.preventDefault(); e.stopPropagation(); await api.del(`/api/projects/${p.id}`); load(); } }, '🗑'),
    );
  }

  const isBrowse = location.pathname === '/browse';
  el.append(
    isBrowse ? null : h('section.hero',
      h('h1', 'See how your ', h('em', 'Spring'), ' application really works'),
      h('p', 'Point Spring Lens at a Spring Boot project folder on this machine — it works fully offline. It reads the code, application.yml/properties, build files, OpenAPI specs and deployment descriptors, then generates interactive diagrams — from startup and connections to every request flow.'),
      h('div.analyze-box',
        h('div.analyze-row', input, btn),
        h('div.analyze-opts', h('label.chk', tests, 'Include test sources'), h('span', '🔒 Offline — your code never leaves this machine')),
        h('div.examples', h('span.muted', 'Try:'), EXAMPLES.map(([l, v]) => h('button', { onclick: () => { input.value = v; go(); } }, l))),
        progress,
      ),
    ),
    isBrowse ? null : h('section.features',
      feature('🏗️ Architecture', 'Beans, layers and dependency-injection graph with DB, cache, broker and external API nodes.'),
      feature('🚀 Startup flow', 'main() → environment & profiles → auto-config → beans → connections → web server → runners.'),
      feature('⇢ Request flows', 'Sequence diagrams for every endpoint, listener and scheduled job — down to repositories and HTTP calls.'),
      feature('⌁ APIs', 'Controller endpoints, OpenAPI/Swagger YAML specs, implemented-vs-spec diff, outbound Feign clients.'),
      feature('⚙ Configuration', 'Every property per profile, overrides, env variables, and which class reads each key.'),
      feature('⇄ Connections', `Datasources, Redis, Kafka, RabbitMQ, Mongo, OAuth2 issuers and external URLs with their properties.`),
    ),
    h('section.browse',
      h('div.browse-head', h('h2', isBrowse ? 'Browse analyzed projects' : 'Recent projects'), q),
      cards,
    ),
  );
  load();
  if (params.get('src') && !isBrowse) go();
}

function feature(t, d) { return h('div.feature', h('b', t), h('span', d)); }
void CONN;
