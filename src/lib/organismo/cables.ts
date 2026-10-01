/**
 * The patch bay. Every pin on the panel is a button; a cable is a pair of pin ids. Drag from one pin to another, or
 * click one and then the other, to clip them together. Click the middle of a cable to take it off, double-click a pin
 * to clear it. The cables are drawn as sagging lines over the panel, and brighten with the voltage they carry.
 *
 * Which pins share a net is all the engine needs, so this knows nothing about sound: it keeps a list of pairs.
 */
import { PIN_INDEX, type Cable } from './params';

/** One colour per cable, cycled, so a tangle can still be read. */
const INKS = ['#e0452b', '#2f45ff', '#1f8a3a', '#d89a12', '#8a3fd0', '#d2308a', '#0f8f98', '#5a3b21'];

const NS = 'http://www.w3.org/2000/svg';

interface Pt {
  x: number;
  y: number;
}

/** Split a cubic Bezier at t0 and t1 and return the control points of the piece in between. */
function slice(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t0: number, t1: number): [Pt, Pt, Pt, Pt] {
  const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const split = (a: Pt, b: Pt, c: Pt, d: Pt, t: number) => {
    const ab = lerp(a, b, t);
    const bc = lerp(b, c, t);
    const cd = lerp(c, d, t);
    const abc = lerp(ab, bc, t);
    const bcd = lerp(bc, cd, t);
    const m = lerp(abc, bcd, t);
    return { left: [a, ab, abc, m] as [Pt, Pt, Pt, Pt], right: [m, bcd, cd, d] as [Pt, Pt, Pt, Pt] };
  };
  const right = split(p0, p1, p2, p3, t0).right;
  const piece = split(right[0], right[1], right[2], right[3], (t1 - t0) / (1 - t0)).left;
  return piece;
}

export class Cables {
  cables: Cable[] = [];
  private pins = new Map<string, HTMLElement>();
  private svg: SVGSVGElement;
  private board: HTMLElement;
  private armed: string | null = null;
  private drag: { from: string; x: number; y: number; moved: boolean } | null = null;
  private temp: SVGPathElement;
  private hover = -1;
  private vals: number[] = [];
  onChange: (c: Cable[]) => void = () => {};

  constructor(board: HTMLElement, svg: SVGSVGElement) {
    this.board = board;
    this.svg = svg;
    this.temp = document.createElementNS(NS, 'path');
    this.temp.setAttribute('class', 'cable cable--temp');
    board.querySelectorAll<HTMLElement>('[data-pin]').forEach((el) => this.bindPin(el));
    new ResizeObserver(() => this.draw()).observe(board);
    addEventListener('resize', () => this.draw());
    document.fonts?.ready.then(() => this.draw());
  }

  private bindPin(el: HTMLElement) {
    const id = el.dataset.pin!;
    this.pins.set(id, el);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      this.drag = { from: id, x: e.clientX, y: e.clientY, moved: false };
    });
    el.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.from !== id) return;
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) d.moved = true;
      if (d.moved) this.preview(id, e.clientX, e.clientY);
    });
    el.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      this.temp.remove();
      if (!d || d.from !== id) return;
      if (d.moved) {
        const to = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-pin]')?.dataset.pin;
        if (to && to !== id) this.add(id, to);
        this.setArmed(null);
      } else this.click(id);
    });
    el.addEventListener('pointercancel', () => {
      this.drag = null;
      this.temp.remove();
    });
    el.addEventListener('dblclick', () => this.clearPin(id));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.click(id);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.clearPin(id);
      }
    });
  }

  // ── making and breaking cables ──
  private click(id: string) {
    if (this.armed === null) this.setArmed(id);
    else if (this.armed === id) this.setArmed(null);
    else {
      this.add(this.armed, id);
      this.setArmed(null);
    }
  }
  private setArmed(id: string | null) {
    if (this.armed) this.pins.get(this.armed)?.classList.remove('is-armed');
    this.armed = id;
    if (id) this.pins.get(id)?.classList.add('is-armed');
  }
  add(a: string, b: string, silent = false) {
    if (a === b || PIN_INDEX[a] === undefined || PIN_INDEX[b] === undefined) return;
    if (this.cables.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) return;
    this.cables.push([a, b]);
    this.draw();
    if (!silent) this.onChange(this.cables);
  }
  remove(i: number) {
    this.cables.splice(i, 1);
    this.hover = -1;
    this.draw();
    this.onChange(this.cables);
  }
  clearPin(id: string) {
    const before = this.cables.length;
    this.cables = this.cables.filter(([a, b]) => a !== id && b !== id);
    if (this.cables.length !== before) {
      this.draw();
      this.onChange(this.cables);
    }
  }
  clear() {
    this.cables = [];
    this.setArmed(null);
    this.draw();
    this.onChange(this.cables);
  }
  /** Replace every cable at once, as a preset or a link does. */
  set(c: Cable[]) {
    this.cables = c.filter(([a, b]) => PIN_INDEX[a] !== undefined && PIN_INDEX[b] !== undefined && a !== b).map(([a, b]) => [a, b] as Cable);
    this.setArmed(null);
    this.draw();
  }
  has(id: string) {
    return this.cables.some(([a, b]) => a === id || b === id);
  }

  // ── drawing ──
  private center(el: HTMLElement): Pt {
    const r = el.getBoundingClientRect();
    const b = this.board.getBoundingClientRect();
    return { x: r.left + r.width / 2 - b.left, y: r.top + r.height / 2 - b.top };
  }

  private curve(a: Pt, b: Pt): [Pt, Pt, Pt, Pt] {
    // a cable hangs: it sags below the straight line, more for a longer cable
    const sag = 22 + Math.hypot(b.x - a.x, b.y - a.y) * 0.12;
    return [a, { x: a.x, y: a.y + sag }, { x: b.x, y: b.y + sag }, b];
  }
  private d(c: [Pt, Pt, Pt, Pt]) {
    return `M${c[0].x.toFixed(1)} ${c[0].y.toFixed(1)} C${c[1].x.toFixed(1)} ${c[1].y.toFixed(1)} ${c[2].x.toFixed(1)} ${c[2].y.toFixed(1)} ${c[3].x.toFixed(1)} ${c[3].y.toFixed(1)}`;
  }

  private preview(from: string, cx: number, cy: number) {
    const el = this.pins.get(from);
    if (!el) return;
    const b = this.board.getBoundingClientRect();
    const a = this.center(el);
    const to = { x: cx - b.left, y: cy - b.top };
    this.temp.setAttribute('d', this.d(this.curve(a, to)));
    if (!this.temp.parentNode) this.svg.append(this.temp);
  }

  draw() {
    const w = this.board.scrollWidth;
    const h = this.board.scrollHeight;
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svg.setAttribute('width', String(w));
    this.svg.setAttribute('height', String(h));
    this.svg.replaceChildren();
    this.cables.forEach(([a, b], i) => {
      const ea = this.pins.get(a);
      const eb = this.pins.get(b);
      if (!ea || !eb) return;
      const c = this.curve(this.center(ea), this.center(eb));
      const ink = INKS[i % INKS.length];
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `cable-group${this.hover === i ? ' is-hover' : ''}`);
      g.style.setProperty('--ink-c', ink);
      const v = Math.max(this.vals[PIN_INDEX[a]] ?? 0, this.vals[PIN_INDEX[b]] ?? 0);
      g.style.setProperty('--v', v.toFixed(2));
      const shadow = document.createElementNS(NS, 'path');
      shadow.setAttribute('class', 'cable cable--shadow');
      shadow.setAttribute('d', this.d(c));
      const line = document.createElementNS(NS, 'path');
      line.setAttribute('class', 'cable');
      line.setAttribute('d', this.d(c));
      const hit = document.createElementNS(NS, 'path');
      hit.setAttribute('class', 'cable cable--hit');
      hit.setAttribute('d', this.d(slice(c[0], c[1], c[2], c[3], 0.22, 0.78)));
      hit.addEventListener('pointerenter', () => {
        this.hover = i;
        g.classList.add('is-hover');
      });
      hit.addEventListener('pointerleave', () => {
        this.hover = -1;
        g.classList.remove('is-hover');
      });
      hit.addEventListener('click', () => this.remove(i));
      const title = document.createElementNS(NS, 'title');
      title.textContent = `${a} → ${b}: click to take it off`;
      hit.append(title);
      g.append(shadow, line, hit);
      // the clips: a rounded body at each end, on the pin
      for (const p of [c[0], c[3]]) {
        const clip = document.createElementNS(NS, 'rect');
        clip.setAttribute('class', 'cable-clip');
        clip.setAttribute('x', (p.x - 5).toFixed(1));
        clip.setAttribute('y', (p.y - 5).toFixed(1));
        clip.setAttribute('width', '10');
        clip.setAttribute('height', '16');
        clip.setAttribute('rx', '3');
        g.append(clip);
      }
      this.svg.append(g);
    });
    if (this.temp.parentNode) this.svg.append(this.temp);
  }

  /** The voltage on every pin, 0 to 1: pins glow, and cables brighten with the signal they carry. */
  light(values: number[]) {
    this.vals = values;
    let any = false;
    this.pins.forEach((el, id) => {
      const v = values[PIN_INDEX[id]] ?? 0;
      const s = v.toFixed(2);
      if (el.dataset.v !== s) {
        el.dataset.v = s;
        el.style.setProperty('--v', s);
        any = true;
      }
    });
    if (any) {
      const groups = this.svg.querySelectorAll<SVGGElement>('.cable-group');
      this.cables.forEach(([a, b], i) => {
        const v = Math.max(values[PIN_INDEX[a]] ?? 0, values[PIN_INDEX[b]] ?? 0);
        groups[i]?.style.setProperty('--v', v.toFixed(2));
      });
    }
  }
}
