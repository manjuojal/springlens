import { h, badge, empty } from '../ui.js';
import { createGraph } from '../graph.js';

const K8S_COLORS = { Deployment: '#326ce5', StatefulSet: '#326ce5', DaemonSet: '#326ce5', Service: '#10b981', Ingress: '#f59e0b', ConfigMap: '#64748b', Secret: '#dc2626', Job: '#8b5cf6', CronJob: '#8b5cf6', HorizontalPodAutoscaler: '#06b6d4', PersistentVolumeClaim: '#a855f7' };

export function render(ctx) {
  const { report: r, el } = ctx;
  const { compose, k8s, dockerfiles } = r.infra;
  el.append(h('div.vhead', h('div', h('h2', 'Deployment'), h('p', 'How the application is packaged and run: Dockerfiles, docker-compose services and Kubernetes manifests found in the repository.'))));
  if (!compose.length && !k8s.length && !dockerfiles.length) { el.append(empty('No Dockerfile, docker-compose or Kubernetes manifests found')); return; }
  const graphs = [];

  if (compose.length) {
    const box = h('div', { style: { height: '380px', display: 'flex', flex: 'none' } });
    el.append(h('h3', { style: { margin: '4px 0 0' } }, '🐳 docker-compose'), box);
    const nodes = []; const edges = [];
    for (const c of compose) for (const s of c.services) {
      nodes.push({ data: { id: 's:' + s.name, label: `🐳 ${s.name}`, sub: `${s.image || ''}${s.ports.length ? '\n' + s.ports.join(' ') : ''}`, color: s.tech ? '#2496ed' : '#6db33f', file: c.file } , classes: s.tech && /SQL|Mongo|Redis|Maria|Oracle|Cassandra|Neo4j|Elastic/.test(s.tech) ? 'db' : '' });
      for (const d of s.dependsOn) edges.push({ data: { id: `${s.name}>${d}`, source: 's:' + s.name, target: 's:' + d, label: 'depends on' } });
    }
    graphs.push(createGraph(box, { elements: [...nodes, ...edges], layout: 'dagre-lr', title: 'compose', onSelect: (d) => d.file && ctx.open({ type: 'file', file: d.file }) }));
    el.append(h('div.grid.g3', compose.flatMap((c) => c.services.map((s) => h('div.card',
      h('div.flow-meta', h('b', s.name), s.tech ? badge(s.tech, '#2496ed') : null, s.profiles.length ? badge('profile ' + s.profiles.join(',')) : null),
      h('div.mono.small.muted', s.image || ''), s.ports.length ? h('div.small', 'ports: ', s.ports.map((p) => h('code', p + ' '))) : null,
      Object.keys(s.environment).length ? h('table.mini', Object.entries(s.environment).map(([k, v]) => h('tr', h('td.mono', k), h('td.mono.muted', /pass|secret|token/i.test(k) && v ? '••••••' : v)))) : null,
      s.volumes.length ? h('div.small.muted', 'volumes: ' + s.volumes.join(', ')) : null)))));
  }

  if (k8s.length) {
    const box = h('div', { style: { height: '440px', display: 'flex', flex: 'none' } });
    el.append(h('h3', { style: { margin: '10px 0 0' } }, '☸ Kubernetes'), box);
    const nodes = []; const edges = [];
    const id = (x) => `${x.kind}:${x.name}`;
    for (const x of k8s) {
      nodes.push({ data: { id: id(x), label: `${x.kind}\n${x.name}`, sub: x.kind === 'Service' ? `${x.serviceType} ${x.ports.join(' ')}` : x.containers.length ? x.containers.map((c) => c.image).join(', ') : x.replicas != null ? `replicas ${x.replicas}` : '', color: K8S_COLORS[x.kind] || '#64748b', file: x.file } });
    }
    const workloads = k8s.filter((x) => x.containers.length);
    for (const svc of k8s.filter((x) => x.kind === 'Service' && x.selector)) for (const w of workloads) {
      const labels = w.labels || {};
      if (Object.entries(svc.selector).every(([k, v]) => labels[k] === v) || w.name === svc.name) edges.push({ data: { id: `${id(svc)}>${id(w)}`, source: id(svc), target: id(w), label: 'selects' } });
    }
    for (const ing of k8s.filter((x) => x.kind === 'Ingress')) for (const rule of ing.rules) { const s = k8s.find((x) => x.kind === 'Service' && x.name === rule.service); if (s) edges.push({ data: { id: `${id(ing)}>${rule.path}>${id(s)}`, source: id(ing), target: id(s), label: `${rule.host} ${rule.path || ''}` } }); }
    for (const w of workloads) for (const c of w.containers) {
      for (const ef of c.envFrom) { const [kind, name] = ef.split(' '); const t = k8s.find((x) => x.kind === kind && x.name === name); if (t) edges.push({ data: { id: `${id(w)}>${id(t)}`, source: id(w), target: id(t), label: 'envFrom' }, classes: 'dashed' }); }
      for (const e of c.env) { const m = /from (secretKeyRef|configMapKeyRef)/.exec(e.value); if (m) for (const t of k8s.filter((x) => x.kind === (m[1] === 'secretKeyRef' ? 'Secret' : 'ConfigMap'))) edges.push({ data: { id: `${id(w)}>${id(t)}>${e.name}`, source: id(w), target: id(t), label: e.name }, classes: 'dashed' }); }
    }
    graphs.push(createGraph(box, { elements: [...nodes, ...edges.filter((e, i, a) => a.findIndex((x) => x.data.id === e.data.id) === i)], layout: 'dagre-lr', title: 'kubernetes', onSelect: (d) => d.file && ctx.open({ type: 'file', file: d.file }), legend: Object.entries(K8S_COLORS).filter(([k]) => k8s.some((x) => x.kind === k)) }));
    el.append(h('div.grid.g2', workloads.map((w) => h('div.card', h('div.flow-meta', h('b', `${w.kind} ${w.name}`), w.replicas != null ? badge(`replicas ${w.replicas}`) : null, h('span.muted.small.clickable', { onclick: () => ctx.open({ type: 'file', file: w.file }) }, w.file)),
      w.containers.map((c) => h('div', { style: { marginTop: '6px' } }, h('div.mono.small', `${c.name}: ${c.image}`), c.ports.length ? h('div.small', 'ports ', c.ports.join(', ')) : null, c.probes.length ? h('div.small.muted', c.probes.join(' · ')) : null,
        c.env.length ? h('table.mini', c.env.map((e) => h('tr', h('td.mono', e.name), h('td.mono.muted', e.value)))) : null))))));
  }

  if (dockerfiles.length) {
    el.append(h('div.card', h('h3', 'Dockerfiles'), dockerfiles.map((d) => h('div', { style: { marginBottom: '8px' } }, h('div.mono.clickable', { onclick: () => ctx.open({ type: 'file', file: d.file, line: 1 }) }, d.file),
      h('div.small', d.stages.map((s, i) => h('span', i ? ' → ' : '', h('code', s)))), d.expose.length ? h('div.small', 'EXPOSE ', d.expose.join(', ')) : null, d.entrypoint ? h('div.small.mono.muted', d.entrypoint) : null))));
  }
  return () => graphs.forEach((g) => g.destroy());
}
