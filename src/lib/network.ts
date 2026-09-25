import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from 'd3-force';
import type { GraphData } from './graph';
import { go } from './ui/nav';

type N = GraphData['nodes'][number] & SimulationNodeDatum;
type L = { source: N; target: N; kind: GraphData['links'][number]['kind'] };

const SVG = 'http://www.w3.org/2000/svg';
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

export function mountNetwork() {
  const root = document.querySelector<HTMLElement>('[data-network]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  const data = JSON.parse(document.getElementById('network-data')!.textContent!) as GraphData;
  const svg = root.querySelector<SVGSVGElement>('[data-network-svg]')!;
  const hover = root.querySelector<HTMLElement>('[data-network-hover]')!;
  const stage = root.querySelector<HTMLElement>('[data-network-stage]')!;
  let { width, height } = stage.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const nodes: N[] = data.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links: L[] = data.links.map((l) => ({ source: byId.get(l.source)!, target: byId.get(l.target)!, kind: l.kind }));
  const radius = (n: N) => (n.kind === 'post' ? 16 : n.kind === 'class' ? 26 : 5 + n.weight * 2.5);

  const gLinks = el('g', { class: 'net-links' });
  const gNodes = el('g', { class: 'net-nodes' });
  svg.replaceChildren(gLinks, gNodes);

  const lineEls = links.map((l) => {
    const line = el('line', { class: `net-link net-link--${l.kind}` });
    gLinks.append(line);
    return line;
  });

  const nodeEls = nodes.map((n) => {
    const g = el('g', { class: `net-node net-node--${n.kind}${n.cls ? ` net-node--${n.cls.toLowerCase()}` : ''}`, tabindex: n.url ? 0 : -1 });
    if (n.url) g.setAttribute('role', 'link');
    g.setAttribute('aria-label', n.label);
    const r = radius(n);
    if (n.kind === 'post') g.append(el('rect', { x: -r, y: -r * 0.7, width: r * 2, height: r * 1.4, transform: `rotate(${(n.label.length % 7) - 3})` }));
    else g.append(el('circle', { r }));
    const t = el('text', { y: n.kind === 'class' ? 5 : r + 14, 'text-anchor': 'middle' });
    t.textContent = n.kind === 'post' ? (n.label.length > 28 ? n.label.slice(0, 26) + '…' : n.label) : n.label;
    g.append(t);
    gNodes.append(g);
    return g;
  });

  const neighbours = new Map<N, Set<N>>(nodes.map((n) => [n, new Set([n])]));
  links.forEach((l) => (neighbours.get(l.source)!.add(l.target), neighbours.get(l.target)!.add(l.source)));

  const focus = (n: N | null) => {
    const set = n ? neighbours.get(n)! : null;
    nodeEls.forEach((g, i) => g.classList.toggle('is-dim', !!set && !set.has(nodes[i])));
    lineEls.forEach((line, i) => line.classList.toggle('is-lit', !!n && (links[i].source === n || links[i].target === n)));
    hover.textContent = n ? `${n.kind} · ${n.label}${n.kind === 'concept' ? ` · in ${n.weight} transmission${n.weight > 1 ? 's' : ''}` : ''}` : '';
  };

  const sim = forceSimulation(nodes)
    .force('link', forceLink<N, L>(links).distance((l) => (l.kind === 'class' ? 120 : l.kind === 'cite' ? 90 : 70)).strength(0.6))
    .force('charge', forceManyBody().strength((n) => ((n as N).kind === 'class' ? -600 : -260)))
    .force('center', forceCenter(width / 2, height / 2))
    .force('collide', forceCollide<N>((n) => radius(n) + 18))
    .on('tick', render);
  function render() {
      for (const n of nodes) {
        n.x = Math.max(30, Math.min(width - 30, n.x!));
        n.y = Math.max(30, Math.min(height - 30, n.y!));
      }
      links.forEach((l, i) => {
        const e = lineEls[i];
        e.setAttribute('x1', String(l.source.x));
        e.setAttribute('y1', String(l.source.y));
        e.setAttribute('x2', String(l.target.x));
        e.setAttribute('y2', String(l.target.y));
      });
      nodes.forEach((n, i) => nodeEls[i].setAttribute('transform', `translate(${n.x},${n.y})`));
  }

  // drag + click (a click is a drag that didn't move)
  nodes.forEach((n, i) => {
    const g = nodeEls[i];
    let start: { x: number; y: number } | null = null;
    let moved = false;
    const toSvg = (e: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * width, y: ((e.clientY - r.top) / r.height) * height };
    };
    g.addEventListener('pointerdown', (e) => {
      start = toSvg(e);
      moved = false;
      g.setPointerCapture(e.pointerId);
      sim.alphaTarget(0.25).restart();
      n.fx = n.x;
      n.fy = n.y;
    });
    g.addEventListener('pointermove', (e) => {
      if (!start) return;
      const p = toSvg(e);
      if (Math.hypot(p.x - start.x, p.y - start.y) > 3) moved = true;
      n.fx = p.x;
      n.fy = p.y;
    });
    g.addEventListener('pointerup', () => {
      start = null;
      sim.alphaTarget(0);
      n.fx = n.fy = null;
      if (!moved && n.url) go(n.url);
    });
    g.addEventListener('pointerenter', () => focus(n));
    g.addEventListener('pointerleave', () => focus(null));
    g.addEventListener('focus', () => focus(n));
    g.addEventListener('blur', () => focus(null));
    g.addEventListener('keydown', (e) => e.key === 'Enter' && n.url && go(n.url));
  });

  const ro = new ResizeObserver(() => {
    ({ width, height } = stage.getBoundingClientRect());
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    sim.force('center', forceCenter(width / 2, height / 2)).alpha(0.3).restart();
  });
  ro.observe(stage);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) sim.stop(), sim.tick(300), render();
  document.addEventListener('astro:before-swap', () => (sim.stop(), ro.disconnect()), { once: true });
}
