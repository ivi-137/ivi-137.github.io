/**
 * Sigils: one-dimensional elementary cellular automata grown from a string.
 * The rule and the first row both come from a hash of the seed, so every post
 * has a unique, reproducible emblem. Time runs downward.
 */

/** Rules from Wolfram classes III and IV, plus a few striking class II ones. */
const GOOD_RULES = [18, 22, 26, 30, 41, 45, 54, 57, 60, 62, 73, 75, 86, 89, 90, 101, 105, 106, 110, 120, 122, 124, 126, 129, 135, 137, 146, 147, 149, 150, 153, 161, 165, 169, 182, 193, 195, 225];

/** Device pixels per cell, and the inked square inside it. */
const PITCH = 4;
const DOT = 3;

export function fnv1a(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function prng(seed: number) {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Sparse, centre-weighted first row: reads better than uniform noise. */
export function firstRow(seed: string, rule: number, cols: number) {
  const rnd = prng(fnv1a(seed + '#' + rule));
  const row = new Uint8Array(cols);
  for (let i = 0; i < cols; i++) row[i] = rnd() < 0.5 - Math.abs(i / cols - 0.5) * 0.6 ? 1 : 0;
  return row;
}

export function nextRow(row: Uint8Array, rule: number) {
  const cols = row.length;
  const next = new Uint8Array(cols);
  for (let i = 0; i < cols; i++) {
    const n = (row[(i - 1 + cols) % cols] << 2) | (row[i] << 1) | row[(i + 1) % cols];
    next[i] = (rule >> n) & 1;
  }
  return next;
}

/** The whole space-time diagram at once (used for build-time images). */
export function grow(seed: string, rule: number, cols: number, rows: number) {
  const out = [firstRow(seed, rule, cols)];
  while (out.length < rows) out.push(nextRow(out[out.length - 1], rule));
  return out;
}

export const ruleFor = (seed: string, pinned?: number) =>
  pinned ?? GOOD_RULES[fnv1a(seed) % GOOD_RULES.length];

export class Sigil {
  private row: Uint8Array;
  private rows: Uint8Array[] = [];
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private raf = 0;
  private last = 0;

  constructor(
    canvas: HTMLCanvasElement,
    readonly seed: string,
    readonly rule: number,
    private cols: number,
    private nrows: number,
    private ink: [number, number, number],
  ) {
    canvas.width = cols * PITCH;
    canvas.height = nrows * PITCH;
    this.ctx = canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(canvas.width, canvas.height);
    this.row = firstRow(seed, rule, cols);
    for (let r = 0; r < nrows; r++) this.push();
    this.paint();
  }

  private push() {
    const { row, rule } = this;
    this.rows.push(row.slice());
    if (this.rows.length > this.nrows) this.rows.shift();
    this.row = nextRow(row, rule);
  }

  private paint() {
    const d = this.img.data;
    const [r, g, b] = this.ink;
    d.fill(0);
    let on = 0;
    for (const row of this.rows) for (let x = 0; x < this.cols; x++) on += row[x];
    // draw whichever state is the minority, so rules with a "black sea"
    // (e.g. 137, the complement of 110) read as figures, not slabs
    const want = on > (this.rows.length * this.cols) / 2 ? 0 : 1;
    const stride = this.cols * PITCH;
    this.rows.forEach((row, y) => {
      for (let x = 0; x < this.cols; x++) {
        if (row[x] !== want) continue;
        // each cell is a DOT×DOT square on a PITCH grid: reads like print, not a slab
        for (let dy = 0; dy < DOT; dy++)
          for (let dx = 0; dx < DOT; dx++) {
            const i = ((y * PITCH + dy) * stride + x * PITCH + dx) * 4;
            d[i] = r;
            d[i + 1] = g;
            d[i + 2] = b;
            d[i + 3] = 255;
          }
      }
    });
    this.ctx.putImageData(this.img, 0, 0);
  }

  play(rowsPerSecond = 18) {
    if (this.raf) return;
    ACTIVE.add(this);
    this.last = performance.now();
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      if (now - this.last < 1000 / rowsPerSecond) return;
      this.last = now;
      this.push();
      this.paint();
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    ACTIVE.delete(this);
  }
}

const ACTIVE = new Set<Sigil>();
/** Call before a page swap so detached canvases don't keep animating. */
export const stopAllSigils = () => ACTIVE.forEach((s) => s.stop());

const INK: Record<string, [number, number, number]> = {
  ink: [22, 20, 15],
  acid: [198, 255, 61],
  paper: [236, 229, 211],
};

/** Hydrate every <canvas data-sigil> on the page. */
export function mountSigils(root: ParentNode = document) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const s = (e.target as any).__sigil as Sigil | undefined;
      if (s) e.isIntersecting ? s.play() : s.stop();
    }
  });
  root.querySelectorAll<HTMLCanvasElement>('canvas[data-sigil]').forEach((c) => {
    if ((c as any).__sigil) return;
    const { seed = '', rule, cols = '96', rows = '40', animate = 'none', ink = 'ink' } = c.dataset;
    const s = new Sigil(c, seed, ruleFor(seed, rule ? Number(rule) : undefined), +cols, +rows, INK[ink] ?? INK.ink);
    (c as any).__sigil = s;
    c.dataset.ruleUsed = String(s.rule);
    if (reduced) return;
    if (animate === 'always') io.observe(c);
    if (animate === 'hover') {
      const host = c.closest('.card') ?? c;
      host.addEventListener('pointerenter', () => s.play(24));
      host.addEventListener('pointerleave', () => s.stop());
      host.addEventListener('focusin', () => s.play(24));
      host.addEventListener('focusout', () => s.stop());
    }
  });
}
