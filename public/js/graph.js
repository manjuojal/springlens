import { h, cssVar, isDark, download, debounce } from './ui.js';

let registered = false;
function ensure() {
  if (!registered && window.cytoscape && window.cytoscapeDagre) { window.cytoscape.use(window.cytoscapeDagre); registered = true; }
}

const LAYOUTS = {
  'dagre-lr': { name: 'dagre', rankDir: 'LR', nodeSep: 18, rankSep: 90, edgeSep: 8, animate: false },
  'dagre-tb': { name: 'dagre', rankDir: 'TB', nodeSep: 24, rankSep: 70, edgeSep: 8, animate: false },
  cose: { name: 'cose', animate: false, nodeRepulsion: 9000, idealEdgeLength: 90, padding: 30, nestingFactor: 0.9 },
  concentric: { name: 'concentric', minNodeSpacing: 30, animate: false, concentric: (n) => n.data('rank') ?? n.degree(), levelWidth: () => 1 },
  breadthfirst: { name: 'breadthfirst', directed: true, spacingFactor: 1.1, animate: false },
};

export function style() {
  const fg = cssVar('--fg'); const muted = cssVar('--muted'); const bg = cssVar('--panel'); const edge = cssVar('--edge');
  return [
    { selector: 'node', style: {
      shape: 'round-rectangle', 'background-color': 'data(color)', 'background-opacity': isDark() ? 0.22 : 0.12, 'border-color': 'data(color)', 'border-width': 1.5,
      label: 'data(label)', color: fg, 'font-size': 11, 'font-family': 'Inter, Segoe UI, system-ui, sans-serif', 'text-valign': 'center', 'text-halign': 'center',
      'text-wrap': 'wrap', 'text-max-width': 170, width: 'label', height: 'label', padding: '10px', 'min-zoomed-font-size': 6,
    } },
    { selector: 'node[sub]', style: { label: (n) => `${n.data('label')}\n${n.data('sub')}`, 'font-size': 10.5 } },
    { selector: 'node[shape]', style: { shape: 'data(shape)' } },
    { selector: 'node.db', style: { shape: 'barrel', 'background-opacity': isDark() ? 0.35 : 0.18, 'font-weight': 600 } },
    { selector: 'node.ext', style: { shape: 'cut-rectangle', 'border-style': 'dashed' } },
    { selector: 'node.topic', style: { shape: 'tag', 'font-style': 'italic' } },
    { selector: 'node.hub', style: { 'font-weight': 700, 'font-size': 13, 'border-width': 2.5, 'background-opacity': isDark() ? 0.35 : 0.2 } },
    { selector: 'node.dim-node', style: { 'border-style': 'dotted' } },
    { selector: ':parent', style: { 'text-valign': 'top', 'text-halign': 'center', 'background-opacity': 0.04, 'border-width': 1, 'border-style': 'dashed', 'border-color': muted, padding: '18px', 'font-weight': 600, color: muted, shape: 'round-rectangle', 'text-margin-y': -4 } },
    { selector: 'edge', style: {
      width: 1.4, 'line-color': edge, 'target-arrow-color': edge, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.9, 'curve-style': 'bezier',
      label: 'data(label)', 'font-size': 9, color: muted, 'text-background-color': bg, 'text-background-opacity': 0.85, 'text-background-padding': 2, 'text-rotation': 'autorotate', 'min-zoomed-font-size': 8,
    } },
    { selector: 'edge[color]', style: { 'line-color': 'data(color)', 'target-arrow-color': 'data(color)' } },
    { selector: 'edge.dashed', style: { 'line-style': 'dashed' } },
    { selector: 'edge.dotted', style: { 'line-style': 'dotted' } },
    { selector: 'edge.async', style: { 'line-style': 'dashed', 'target-arrow-shape': 'vee' } },
    { selector: 'edge.inherit', style: { 'target-arrow-shape': 'triangle-backcurve', 'target-arrow-fill': 'hollow', 'line-style': 'dashed' } },
    { selector: '.faded', style: { opacity: 0.12 } },
    { selector: 'node.hl', style: { 'border-width': 3, 'background-opacity': isDark() ? 0.45 : 0.3 } },
    { selector: 'edge.hl', style: { width: 2.6, 'z-index': 10 } },
    { selector: 'node:selected', style: { 'border-width': 3.5, 'border-color': cssVar('--accent') } },
    { selector: 'node.match', style: { 'border-width': 4, 'border-color': cssVar('--accent'), 'background-opacity': 0.5 } },
  ];
}

/**
 * Create an interactive graph.
 * opts: { elements, layout, onSelect(node data), toolbar: true, layouts: [keys], filters: [{key,label,checked}], onFilter, title, legend: [[label,color]] }
 */
export function createGraph(container, opts) {
  ensure();
  container.classList.add('graph-wrap');
  const canvas = h('div.graph-canvas');
  const toolbar = h('div.graph-toolbar');
  const legend = opts.legend ? h('div.graph-legend', opts.legend.map(([l, c]) => h('span', h('i', { style: { background: c } }), l))) : null;
  container.append(toolbar, canvas);
  if (legend) container.append(legend);
  let layoutKey = opts.layout || 'dagre-lr';

  const cy = window.cytoscape({ container: canvas, elements: opts.elements, style: style(), wheelSensitivity: 0.25, minZoom: 0.05, maxZoom: 3, boxSelectionEnabled: false });
  const run = (fit = true) => {
    const l = cy.layout({ ...LAYOUTS[layoutKey], fit, padding: 40, ...(opts.layoutOptions || {}) });
    // small graphs would otherwise be blown up to fill the canvas
    l.one('layoutstop', () => { if (cy.zoom() > 1.15) { cy.zoom(1.15); cy.center(); } });
    l.run();
  };
  run();

  // interactions
  cy.on('mouseover', 'node', (e) => {
    const n = e.target; if (n.isParent()) return;
    const nb = n.closedNeighborhood();
    cy.elements().not(nb).not(n.ancestors()).addClass('faded');
    nb.addClass('hl');
  });
  cy.on('mouseout', 'node', () => cy.elements().removeClass('faded hl'));
  cy.on('tap', 'node', (e) => { if (!e.target.isParent() && opts.onSelect) opts.onSelect(e.target.data(), e.target); });
  cy.on('tap', 'edge', (e) => { if (opts.onEdge) opts.onEdge(e.target.data()); });
  cy.on('dbltap', 'node', (e) => { const nb = e.target.closedNeighborhood(); cy.animate({ fit: { eles: nb, padding: 60 }, duration: 350 }); });

  // toolbar
  const search = h('input.search', { placeholder: 'Find node…', type: 'search' });
  search.addEventListener('input', debounce(() => {
    cy.nodes().removeClass('match');
    const q = search.value.trim().toLowerCase();
    if (!q) return;
    const m = cy.nodes().filter((n) => !n.isParent() && String(n.data('label')).toLowerCase().includes(q));
    m.addClass('match');
    if (m.length) cy.animate({ fit: { eles: m, padding: 80 }, duration: 300 });
  }, 250));
  const layoutSel = h('select', { title: 'Layout', onchange: (e) => { layoutKey = e.target.value; run(); } },
    (opts.layouts || ['dagre-lr', 'dagre-tb', 'cose', 'concentric']).map((k) => h('option', { value: k, selected: k === layoutKey }, { 'dagre-lr': 'Layered →', 'dagre-tb': 'Layered ↓', cose: 'Force / grouped', concentric: 'Concentric', breadthfirst: 'Tree' }[k])));
  toolbar.append(
    search, layoutSel,
    ...(opts.filters || []).map((f) => h('label.chk', h('input', { type: 'checkbox', checked: f.checked, onchange: (e) => opts.onFilter && opts.onFilter(f.key, e.target.checked) }), f.label)),
    h('span.spacer'),
    h('button.icon', { title: 'Zoom in', onclick: () => cy.zoom({ level: cy.zoom() * 1.25, renderedPosition: { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 } }) }, '+'),
    h('button.icon', { title: 'Zoom out', onclick: () => cy.zoom({ level: cy.zoom() / 1.25, renderedPosition: { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 } }) }, '−'),
    h('button.icon', { title: 'Fit', onclick: () => cy.animate({ fit: { padding: 30 }, duration: 300 }) }, '⤢'),
    h('button.icon', { title: 'Re-run layout', onclick: () => run() }, '↻'),
    h('button.icon', { title: 'Export PNG', onclick: () => download((opts.title || 'diagram') + '.png', dataUrlToBlob(cy.png({ full: true, scale: 2, bg: cssVar('--bg') }))) }, '⇩'),
  );

  const ro = new ResizeObserver(debounce(() => cy.resize(), 100));
  ro.observe(canvas);

  return {
    cy,
    relayout: run,
    setElements(els) { cy.elements().remove(); cy.add(els); run(); },
    focus(id) { const n = cy.getElementById(id); if (n.nonempty()) { cy.elements().unselect(); n.select(); cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 1), duration: 300 }); } },
    destroy() { ro.disconnect(); cy.destroy(); },
  };
}

function dataUrlToBlob(url) {
  const [meta, b64] = url.split(',');
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: meta.split(':')[1].split(';')[0] });
}

/* ---------------- Mermaid ---------------- */
let mermaidTheme = null;
let seq = 0;
export async function renderMermaid(container, code, { onReady, minScale = 0 } = {}) {
  container._minScale = minScale;
  const m = window.mermaid;
  const theme = isDark() ? 'dark' : 'default';
  if (mermaidTheme !== theme) {
    m.initialize({ startOnLoad: false, theme, securityLevel: 'loose', fontFamily: 'Inter, Segoe UI, system-ui, sans-serif', sequence: { useMaxWidth: false, mirrorActors: false, showSequenceNumbers: true, noteMargin: 8, messageFontSize: 13, actorFontSize: 13 }, er: { useMaxWidth: false, layoutDirection: 'LR' }, flowchart: { useMaxWidth: false, htmlLabels: true, curve: 'basis' }, maxTextSize: 500000, maxEdges: 2000 });
    mermaidTheme = theme;
  }
  try {
    const { svg, bindFunctions } = await m.render('mmd' + (++seq), code);
    container.innerHTML = svg;
    bindFunctions?.(container);
    const svgEl = container.querySelector('svg');
    if (svgEl) enablePanZoom(container, svgEl);
    onReady?.(svgEl);
  } catch (e) {
    container.innerHTML = '';
    container.append(h('div.error', 'Diagram could not be rendered: ' + (e.message || e)), h('pre.code', code));
  }
}

/** Wheel-zoom + drag-pan on an SVG inside a scroll container. */
function enablePanZoom(container, svg) {
  container.classList.add('pz');
  const vb = svg.viewBox.baseVal;
  const w = vb && vb.width ? vb.width : svg.getBBox().width;
  const hgt = vb && vb.height ? vb.height : svg.getBBox().height;
  svg.style.maxWidth = 'none'; svg.removeAttribute('height'); svg.setAttribute('width', w); svg.setAttribute('height', hgt);
  svg.style.transformOrigin = '0 0';
  // one state object per container; listeners are attached only once even when the
  // diagram is re-rendered (e.g. after expanding a box)
  const firstTime = !container._pz;
  const st = container._pz || (container._pz = { scale: 1, x: 0, y: 0, drag: null, moved: false });
  Object.assign(st, { svg, w, hgt });
  const apply = () => { st.svg.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.scale})`; };
  const fit = () => {
    const fitW = (container.clientWidth - 20) / st.w; const fitH = (container.clientHeight - 20) / st.hgt;
    // tall diagrams (long sequences) fit to width and scroll; others fit entirely
    const s = Math.max(container._minScale || 0, Math.min(1.2, fitW, st.hgt / st.w > 1.6 ? Math.max(fitH, 0.55) : fitH));
    st.scale = s; st.x = Math.max(10, (container.clientWidth - st.w * s) / 2); st.y = Math.max(10, (container.clientHeight - st.hgt * s) / 2); apply();
  };
  container._fit = fit;
  container._zoom = (f) => { const cx = container.clientWidth / 2; const cyy = container.clientHeight / 2; const ns = Math.min(4, Math.max(0.1, st.scale * f)); st.x = cx - (cx - st.x) * (ns / st.scale); st.y = cyy - (cyy - st.y) * (ns / st.scale); st.scale = ns; apply(); };
  if (firstTime) {
    container.addEventListener('wheel', (e) => {
      if (!st.svg) return;
      if (!e.ctrlKey && !e.metaKey) { st.y -= e.deltaY; st.x -= e.deltaX; apply(); e.preventDefault(); return; }
      e.preventDefault();
      const r = container.getBoundingClientRect(); const mx = e.clientX - r.left; const my = e.clientY - r.top;
      const ns = Math.min(4, Math.max(0.1, st.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      st.x = mx - (mx - st.x) * (ns / st.scale); st.y = my - (my - st.y) * (ns / st.scale); st.scale = ns; apply();
    }, { passive: false });
    container.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; st.drag = { sx: e.clientX, sy: e.clientY, x: st.x, y: st.y }; st.moved = false; });
    window.addEventListener('pointermove', (e) => {
      if (!st.drag) return;
      const dx = e.clientX - st.drag.sx; const dy = e.clientY - st.drag.sy;
      if (!st.moved && Math.abs(dx) + Math.abs(dy) < 5) return; // small jitter is still a click
      st.moved = true; container.classList.add('dragging');
      st.x = st.drag.x + dx; st.y = st.drag.y + dy; apply();
    });
    window.addEventListener('pointerup', () => { st.drag = null; container.classList.remove('dragging'); });
    // a drag must not trigger the click handler of the box under the pointer
    container.addEventListener('click', (e) => { if (st.moved) { e.stopPropagation(); e.preventDefault(); st.moved = false; } }, true);
  }
  if (container._keepView && !firstTime) apply(); else requestAnimationFrame(fit);
}

export function mermaidToolbar(container, name) {
  return h('div.graph-toolbar.mini',
    h('span.muted', 'Scroll to pan · Ctrl+scroll to zoom · drag to move'), h('span.spacer'),
    h('button.icon', { title: 'Zoom in', onclick: () => container._zoom?.(1.25) }, '+'),
    h('button.icon', { title: 'Zoom out', onclick: () => container._zoom?.(0.8) }, '−'),
    h('button.icon', { title: 'Fit', onclick: () => container._fit?.() }, '⤢'),
    h('button.icon', { title: 'Download SVG', onclick: () => { const s = container.querySelector('svg'); if (s) { const c = s.cloneNode(true); c.style.transform = ''; download(name + '.svg', new XMLSerializer().serializeToString(c), 'image/svg+xml'); } } }, '⇩'),
  );
}

export const mmd = {
  /** Escape text for mermaid labels/messages */
  text: (s) => String(s ?? '').replace(/[;#]/g, ' ').replace(/</g, '‹').replace(/>/g, '›').replace(/"/g, '\'').replace(/[\r\n]+/g, ' '),
  id: (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_'),
};
