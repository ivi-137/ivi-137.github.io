/**
 * A small CPU Life-like automaton for bounded boards (the Lab, embeds in
 * posts). Toroidal, any B/S rule, with age tracking for colouring.
 */
export class Board {
  cells: Uint8Array;
  age: Uint16Array;
  private next: Uint8Array;
  birth = 1 << 3;
  survive = (1 << 2) | (1 << 3);
  gen = 0;

  w: number;
  h: number;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cells = new Uint8Array(w * h);
    this.next = new Uint8Array(w * h);
    this.age = new Uint16Array(w * h);
  }

  setRule(birth: number[], survive: number[]) {
    this.birth = birth.reduce((m, n) => m | (1 << n), 0);
    this.survive = survive.reduce((m, n) => m | (1 << n), 0);
  }

  get(x: number, y: number) {
    return this.cells[((y + this.h) % this.h) * this.w + ((x + this.w) % this.w)];
  }
  set(x: number, y: number, v: 0 | 1) {
    const i = ((y + this.h) % this.h) * this.w + ((x + this.w) % this.w);
    this.cells[i] = v;
    if (!v) this.age[i] = 0;
  }

  clear() {
    this.cells.fill(0);
    this.age.fill(0);
    this.gen = 0;
  }

  randomize(density = 0.3) {
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = Math.random() < density ? 1 : 0;
    this.age.fill(0);
    this.gen = 0;
  }

  place(cells: Array<[number, number]>, ox: number, oy: number) {
    for (const [x, y] of cells) this.set(ox + x, oy + y, 1);
  }

  step() {
    const { w, h, cells, next, age } = this;
    for (let y = 0; y < h; y++) {
      const up = ((y - 1 + h) % h) * w, mid = y * w, dn = ((y + 1) % h) * w;
      for (let x = 0; x < w; x++) {
        const l = (x - 1 + w) % w, r = (x + 1) % w;
        const n = cells[up + l] + cells[up + x] + cells[up + r] + cells[mid + l] + cells[mid + r] + cells[dn + l] + cells[dn + x] + cells[dn + r];
        const i = mid + x;
        const v = cells[i] ? (this.survive >> n) & 1 : (this.birth >> n) & 1;
        next[i] = v;
        age[i] = v ? (cells[i] ? Math.min(age[i] + 1, 999) : 0) : 0;
      }
    }
    this.cells = next;
    this.next = cells;
    this.gen++;
  }

  population() {
    let n = 0;
    for (const c of this.cells) n += c;
    return n;
  }

  /** Live cells as a pattern cropped to their bounding box. */
  crop() {
    let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++)
        if (this.cells[y * this.w + x]) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
    if (x1 < 0) return null;
    const cells: Array<[number, number]> = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (this.cells[y * this.w + x]) cells.push([x - x0, y - y0]);
    return { w: x1 - x0 + 1, h: y1 - y0 + 1, cells };
  }

  /** Draw as gapped squares, newborn acid fading to violet with age. */
  draw(ctx: CanvasRenderingContext2D, cell: number) {
    const { w, h, cells, age } = this;
    ctx.fillStyle = '#0a0a0b';
    ctx.fillRect(0, 0, w * cell, h * cell);
    const gap = cell >= 6 ? 1 : 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!cells[i]) continue;
        const a = age[i];
        ctx.fillStyle = a < 2 ? '#c6ff3d' : a < 12 ? '#9fb6ff' : '#7d8cff';
        ctx.fillRect(x * cell + gap, y * cell + gap, cell - gap * 2, cell - gap * 2);
      }
  }
}
