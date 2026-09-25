/**
 * Attrattore: ten more chaotic systems, drawn in the plane instead of as a
 * 3-D flow. Maps (May, Hénon, Ikeda, Chirikov), a forced oscillator seen
 * stroboscopically (Duffing–Ueda), mechanics (the double pendulum, three
 * bodies), a billiard (Bunimovich) and two lattices (Wolfram's rule 30,
 * Kaneko's coupled maps). Each emits events u ∈ [0,1] that pick chords, and a
 * lead point in [−1,1]² that the swarm chases.
 */
import type { SwarmParams } from './chaos';

export type Pt = [number, number];
export type Map2 = (x: number, y: number) => Pt;
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface Sys2 {
  name: string;
  kind: string;
  param: { label: string; min: number; max: number; def: number; step: number };
  /** steps per frame for each unit of the speed control */
  rate: number;
  /** stretch to the whole box instead of keeping the aspect ratio */
  wide: boolean;
  events: number;
  reset(k: number): void;
  step(n: number): number[];
  lead(): Pt;
  draw(g: CanvasRenderingContext2D, m: Map2, box: Box): void;
}

const ACID = '198,255,61', VERM = '255,75,31', COBALT = '125,140,255', PAPER = '236,229,211';
const HUES = [ACID, VERM, COBALT, PAPER, '255,200,61', '61,220,255', '255,120,200', '150,255,170'];
const TAU = Math.PI * 2;
const wrap = (x: number) => ((x % TAU) + TAU) % TAU;

/** An event value, normalised within its recent range (as the flows do at their sections). */
class Norm {
  xs: number[] = [];
  push(v: number) {
    this.xs.push(v);
    if (this.xs.length > 64) this.xs.shift();
    const lo = Math.min(...this.xs), hi = Math.max(...this.xs);
    return hi > lo ? (v - lo) / (hi - lo) : 0.5;
  }
}
/** Raw points in a ring buffer, with a tag (orbit, colour). */
class Ring {
  a: Float32Array;
  max: number;
  n = 0;
  i = 0;
  constructor(max: number) {
    this.max = max;
    this.a = new Float32Array(max * 3);
  }
  add(x: number, y: number, tag = 0) {
    const j = this.i * 3;
    this.a[j] = x;
    this.a[j + 1] = y;
    this.a[j + 2] = tag;
    this.i = (this.i + 1) % this.max;
    this.n = Math.min(this.n + 1, this.max);
  }
  clear() {
    this.n = this.i = 0;
  }
  /** k-th point, oldest first */
  at(k: number): Pt {
    const j = ((this.i - this.n + k + this.max) % this.max) * 3;
    return [this.a[j], this.a[j + 1]];
  }
}
/** Bounds that grow to hold everything seen; maps raw coordinates into [−0.95, 0.95]. */
class Fit {
  lo: Pt = [Infinity, Infinity];
  hi: Pt = [-Infinity, -Infinity];
  iso: boolean;
  constructor(iso: boolean) {
    this.iso = iso;
  }
  see(x: number, y: number) {
    this.lo = [Math.min(this.lo[0], x), Math.min(this.lo[1], y)];
    this.hi = [Math.max(this.hi[0], x), Math.max(this.hi[1], y)];
  }
  clear() {
    this.lo = [Infinity, Infinity];
    this.hi = [-Infinity, -Infinity];
  }
  n = (x: number, y: number): Pt => {
    let w = this.hi[0] - this.lo[0] || 1, h = this.hi[1] - this.lo[1] || 1;
    if (this.iso) w = h = Math.max(w, h);
    const cx = (this.lo[0] + this.hi[0]) / 2, cy = (this.lo[1] + this.hi[1]) / 2;
    return [((x - cx) / w) * 1.9, ((y - cy) / h) * 1.9];
  };
}
/** A spacetime diagram: one row per generation, the newest at the bottom. */
class Spacetime {
  N: number;
  R: number;
  cv: HTMLCanvasElement | null = null;
  pending: Uint8ClampedArray<ArrayBuffer>[] = [];
  constructor(N: number, R: number) {
    this.N = N;
    this.R = R;
  }
  push(row: Uint8ClampedArray<ArrayBuffer>) {
    this.pending.push(row);
    if (this.pending.length > this.R) this.pending.shift();
  }
  clear() {
    this.pending = [];
    this.cv?.getContext('2d')!.clearRect(0, 0, this.N, this.R);
  }
  draw(g: CanvasRenderingContext2D, b: Box) {
    if (!this.cv) Object.assign((this.cv = document.createElement('canvas')), { width: this.N, height: this.R });
    const c = this.cv.getContext('2d')!, k = this.pending.length;
    if (k) {
      c.drawImage(this.cv, 0, -k);
      this.pending.forEach((row, j) => c.putImageData(new ImageData(row, this.N, 1), 0, this.R - k + j));
      this.pending = [];
    }
    g.imageSmoothingEnabled = false;
    g.drawImage(this.cv, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    g.imageSmoothingEnabled = true;
  }
}

// ── drawing helpers ─────────────────────────────────────────────────────────
type F = (x: number, y: number) => Pt;
const dots = (g: CanvasRenderingContext2D, r: Ring, m: Map2, f: F, rgb: string | string[], a = 0.5, s = 1.3) => {
  const cols = typeof rgb === 'string' ? [rgb] : rgb;
  cols.forEach((c, t) => {
    g.fillStyle = `rgba(${c},${a})`;
    for (let k = 0; k < r.n; k++) {
      if (cols.length > 1 && r.a[k * 3 + 2] !== t) continue;
      const q = f(r.a[k * 3], r.a[k * 3 + 1]), [x, y] = m(q[0], q[1]);
      g.fillRect(x, y, s, s);
    }
  });
};
const trail = (g: CanvasRenderingContext2D, r: Ring, m: Map2, f: F, rgb: string, w = 1.2, head?: Pt) => {
  const B = 6;
  g.lineWidth = w;
  for (let b = 0; b < B; b++) {
    const k0 = Math.max(0, Math.floor((r.n * b) / B) - 1), k1 = Math.floor((r.n * (b + 1)) / B);
    g.strokeStyle = `rgba(${rgb},${0.08 + 0.8 * ((b + 1) / B) ** 2})`;
    g.beginPath();
    for (let k = k0; k < k1; k++) {
      const q = f(...r.at(k)), [x, y] = m(q[0], q[1]);
      k === k0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    if (head && b === B - 1) g.lineTo(...m(...f(...head)));
    g.stroke();
  }
  g.lineWidth = 1;
};
const dot = (g: CanvasRenderingContext2D, [x, y]: Pt, rgb: string, r = 3.5) => {
  g.fillStyle = `rgb(${rgb})`;
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
};
const id: F = (x, y) => [x, y];

// ── the systems ──────────────────────────────────────────────────────────────

/** May, "Simple mathematical models with very complicated dynamics", Nature 261 (1976). */
function logistic(): Sys2 {
  const R0 = 2.8, R1 = 4, nm = new Norm(), orbit: number[] = [];
  const X = (rr: number) => ((rr - R0) / (R1 - R0)) * 1.9 - 0.95;
  let r = 3.7, x = 0.4, img: HTMLCanvasElement | null = null, sig = '';
  const s: Sys2 = {
    name: 'Logistic map (May 1976)', kind: 'bifurcation diagram · cobweb', param: { label: 'r', min: R0, max: R1, def: 3.7, step: 0.001 }, rate: 0.25, wide: true, events: 0,
    reset: (k) => void (r = k),
    step(n) {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        x = r * x * (1 - x);
        if (!(x > 0 && x < 1)) x = 0.4;
        orbit.push(x);
        if (orbit.length > 48) orbit.shift();
        out.push(nm.push(x));
        s.events++;
      }
      return out;
    },
    lead: () => [X(r), x * 1.9 - 0.95],
    draw(g, m, box) {
      const key = `${box.x0},${box.y0},${box.x1},${box.y1},${g.canvas.width}`;
      if (sig !== key) {
        sig = key;
        img = Object.assign(document.createElement('canvas'), { width: g.canvas.width, height: g.canvas.height });
        const h = img.getContext('2d')!;
        h.setTransform(g.getTransform());
        h.fillStyle = `rgba(${ACID},0.3)`;
        for (let c = 0; c <= 360; c++) {
          const rr = R0 + ((R1 - R0) * c) / 360;
          let v = 0.5;
          for (let i = 0; i < 300; i++) v = rr * v * (1 - v);
          for (let i = 0; i < 70; i++) (v = rr * v * (1 - v)), h.fillRect(...m(X(rr), v * 1.9 - 0.95), 1.1, 1.1);
        }
      }
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(img!, 0, 0);
      g.restore();
      const [cx] = m(X(r), 0);
      g.strokeStyle = `rgba(${VERM},0.6)`;
      g.beginPath();
      g.moveTo(cx, box.y0);
      g.lineTo(cx, box.y1);
      g.stroke();
      g.fillStyle = `rgb(${PAPER})`;
      for (const v of orbit) g.fillRect(...m(X(r), v * 1.9 - 0.95), 4, 2);
      // cobweb inset: the staircase of x → r x (1 − x)
      const S = Math.min(150, (box.y1 - box.y0) * 0.36), ox = box.x0 + 6, oy = box.y0 + 6;
      const P = (a: number, b: number): Pt => [ox + a * S, oy + S - b * S];
      g.fillStyle = 'rgba(7,8,10,0.88)';
      g.fillRect(ox, oy, S, S);
      g.strokeStyle = `rgba(${PAPER},0.35)`;
      g.strokeRect(ox, oy, S, S);
      g.beginPath();
      g.moveTo(...P(0, 0));
      g.lineTo(...P(1, 1));
      g.stroke();
      g.strokeStyle = `rgba(${ACID},0.85)`;
      g.beginPath();
      for (let i = 0; i <= 40; i++) (i ? g.lineTo : g.moveTo).call(g, ...P(i / 40, (r * i * (40 - i)) / 1600));
      g.stroke();
      const o = orbit.slice(-24);
      g.strokeStyle = `rgba(${VERM},0.85)`;
      g.beginPath();
      g.moveTo(...P(o[0] ?? 0, o[0] ?? 0));
      for (let i = 1; i < o.length; i++) g.lineTo(...P(o[i - 1], o[i])), g.lineTo(...P(o[i], o[i]));
      g.stroke();
    },
  };
  return s;
}

/** Hénon, "A two-dimensional mapping with a strange attractor", Comm. Math. Phys. 50 (1976). */
function henon(): Sys2 {
  const nm = new Norm(), pts = new Ring(9000), N: F = (u, v) => [u / 1.4, v / 0.42];
  let a = 1.4, x = 0.1, y = 0.1;
  const s: Sys2 = {
    name: 'Hénon map (1976)', kind: 'stretch and fold · point cloud', param: { label: 'a', min: 1, max: 1.42, def: 1.4, step: 0.001 }, rate: 2, wide: true, events: 0,
    reset(k) {
      a = k;
      x = y = 0.1;
      pts.clear();
    },
    step(n) {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const nx = 1 - a * x * x + y;
        y = 0.3 * x;
        x = nx;
        if (!Number.isFinite(x) || Math.abs(x) > 10) x = y = 0.1;
        pts.add(x, y);
        out.push(nm.push(x));
        s.events++;
      }
      return out;
    },
    lead: () => N(x, y),
    draw(g, m) {
      dots(g, pts, m, N, ACID, 0.55);
      dot(g, m(...N(x, y)), VERM);
    },
  };
  return s;
}

/** Ikeda, "Multiple-valued stationary state… of the light transmitted by a ring cavity", Opt. Commun. 30 (1979). */
function ikeda(): Sys2 {
  const nm = new Norm(), pts = new Ring(9000), fit = new Fit(true);
  let u = 0.9, x = 0, y = 0;
  const it = () => {
    const t = 0.4 - 6 / (1 + x * x + y * y);
    [x, y] = [1 + u * (x * Math.cos(t) - y * Math.sin(t)), u * (x * Math.sin(t) + y * Math.cos(t))];
  };
  const s: Sys2 = {
    name: 'Ikeda map (1979)', kind: 'laser ring cavity · spiral cloud', param: { label: 'u', min: 0.6, max: 0.95, def: 0.9, step: 0.001 }, rate: 2, wide: false, events: 0,
    reset(k) {
      u = k;
      x = y = 0.1;
      pts.clear();
      fit.clear();
      for (let i = 0; i < 400; i++) it(), i > 100 && fit.see(x, y);
    },
    step(n) {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        it();
        pts.add(x, y);
        fit.see(x, y);
        out.push(nm.push(x));
        s.events++;
      }
      return out;
    },
    lead: () => fit.n(x, y),
    draw(g, m) {
      dots(g, pts, m, fit.n, ACID, 0.5);
      dot(g, m(...fit.n(x, y)), VERM);
    },
  };
  return s;
}

/** Chirikov, "A universal instability of many-dimensional oscillator systems", Phys. Rep. 52 (1979). */
function standard(): Sys2 {
  const M = 28, th = new Float64Array(M), pp = new Float64Array(M), pts = new Ring(18000), nm = new Norm();
  const N: F = (t, p) => [t / Math.PI - 1, p / Math.PI - 1];
  let K = 1.1;
  const s: Sys2 = {
    name: 'Standard map (Chirikov 1979)', kind: 'kicked rotor · islands in a chaotic sea', param: { label: 'K', min: 0.2, max: 3, def: 1.1, step: 0.01 }, rate: 1, wide: false, events: 0,
    reset(k) {
      K = k;
      for (let i = 0; i < M; i++) (th[i] = wrap(0.3 + i * 2.39996)), (pp[i] = (TAU * (i + 0.5)) / M);
      pts.clear();
    },
    step(n) {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < M; j++) {
          pp[j] = wrap(pp[j] + K * Math.sin(th[j]));
          th[j] = wrap(th[j] + pp[j]);
          pts.add(th[j], pp[j], j % HUES.length);
        }
        out.push(nm.push(pp[0]));
        s.events++;
      }
      return out;
    },
    lead: () => N(th[0], pp[0]),
    draw(g, m) {
      dots(g, pts, m, N, HUES, 0.5, 1.2);
      dot(g, m(...N(th[0], pp[0])), PAPER);
    },
  };
  return s;
}

/** Ueda, "Randomly transitional phenomena in the system governed by Duffing's equation", J. Stat. Phys. 20 (1979). */
function duffing(): Sys2 {
  const SUB = 96, dt = TAU / SUB, strobe = new Ring(6000), path = new Ring(700), fit = new Fit(false), nm = new Norm();
  let B = 7.5, x = 3, v = 0, ph = 0;
  const f = (x: number, v: number, t: number): Pt => [v, -0.05 * v - x ** 3 + B * Math.cos(t)];
  /** one RK4 substep; true when a forcing period completes (the stroboscopic section) */
  const adv = () => {
    const t = ph * dt;
    const k1 = f(x, v, t), k2 = f(x + (dt / 2) * k1[0], v + (dt / 2) * k1[1], t + dt / 2);
    const k3 = f(x + (dt / 2) * k2[0], v + (dt / 2) * k2[1], t + dt / 2), k4 = f(x + dt * k3[0], v + dt * k3[1], t + dt);
    x += (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    v += (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    ph = (ph + 1) % SUB;
    return ph === 0;
  };
  const s: Sys2 = {
    name: 'Duffing–Ueda oscillator (1979)', kind: 'forced, seen once per period · stroboscopic section', param: { label: 'B', min: 5, max: 12, def: 7.5, step: 0.01 }, rate: 6, wide: true, events: 0,
    reset(k) {
      B = k;
      x = 3;
      v = ph = 0;
      strobe.clear();
      path.clear();
      fit.clear();
      for (let i = 0; i < SUB * 220; i++) if (adv() && i > SUB * 40) strobe.add(x, v);
      for (let i = 0; i < SUB * 4; i++) adv(), fit.see(x, v);
    },
    step(n) {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const hit = adv();
        path.add(x, v);
        fit.see(x, v);
        if (hit) strobe.add(x, v), out.push(nm.push(x)), s.events++;
      }
      return out;
    },
    lead: () => fit.n(x, v),
    draw(g, m) {
      trail(g, path, m, fit.n, COBALT, 1, [x, v]);
      dots(g, strobe, m, fit.n, ACID, 0.75, 1.6);
      dot(g, m(...fit.n(x, v)), VERM);
    },
  };
  return s;
}

/** The double pendulum, with a ghost started 10⁻⁷ rad away: sensitive dependence made visible. */
function pendulum(): Sys2 {
  const G = 9.81, dt = 0.004, tip = new Ring(1400), gtip = new Ring(1400), nm = new Norm(), N: F = (x, y) => [x / 2.1, y / 2.1];
  let A = [0, 0, 0, 0], B = [0, 0, 0, 0], lastW = 0;
  const der = ([t1, t2, w1, w2]: number[]) => {
    const d = t1 - t2, den = 3 - Math.cos(2 * d);
    return [w1, w2, (-3 * G * Math.sin(t1) - G * Math.sin(t1 - 2 * t2) - 2 * Math.sin(d) * (w2 * w2 + w1 * w1 * Math.cos(d))) / den, (2 * Math.sin(d) * (2 * w1 * w1 + 2 * G * Math.cos(t1) + w2 * w2 * Math.cos(d))) / den];
  };
  const rk = (s: number[]) => {
    const k1 = der(s), k2 = der(s.map((v, i) => v + (dt / 2) * k1[i])), k3 = der(s.map((v, i) => v + (dt / 2) * k2[i])), k4 = der(s.map((v, i) => v + dt * k3[i]));
    return s.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  };
  const ends = (s: number[]) => {
    const x1 = Math.sin(s[0]), y1 = -Math.cos(s[0]);
    return [x1, y1, x1 + Math.sin(s[1]), y1 - Math.cos(s[1])];
  };
  const s: Sys2 = {
    name: 'Double pendulum', kind: 'mechanics · a ghost 10⁻⁷ rad away diverges', param: { label: 'θ₀°', min: 20, max: 179, def: 125, step: 1 }, rate: 0.6, wide: false, events: 0,
    reset(k) {
      const a = (k * Math.PI) / 180;
      A = [a, a, 0, 0];
      B = [a + 1e-7, a, 0, 0];
      tip.clear();
      gtip.clear();
      lastW = 0;
    },
    step(n) {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        A = rk(A);
        B = rk(B);
        const e = ends(A), f = ends(B);
        tip.add(e[2], e[3]);
        gtip.add(f[2], f[3]);
        if ((lastW > 0 && A[2] <= 0) || (lastW < 0 && A[2] >= 0)) out.push(nm.push(wrap(A[1]))), s.events++;
        lastW = A[2];
      }
      return out;
    },
    lead: () => N(ends(A)[2], ends(A)[3]),
    draw(g, m) {
      trail(g, gtip, m, N, VERM, 1);
      trail(g, tip, m, N, ACID, 1.2);
      for (const [st, rgb, w] of [[B, `rgba(${VERM},0.5)`, 1.5], [A, `rgb(${PAPER})`, 2.5]] as Array<[number[], string, number]>) {
        const e = ends(st), o = m(0, 0), p1 = m(...N(e[0], e[1])), p2 = m(...N(e[2], e[3]));
        g.strokeStyle = rgb;
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(...o);
        g.lineTo(...p1);
        g.lineTo(...p2);
        g.stroke();
        g.lineWidth = 1;
        dot(g, p1, st === A ? PAPER : VERM, 4);
        dot(g, p2, st === A ? ACID : VERM, 5);
      }
      dot(g, m(0, 0), PAPER, 2.5);
    },
  };
  return s;
}

/** Three equal masses on the Chenciner–Montgomery figure eight (Annals of Math. 152, 2000), nudged by ε. */
function threebody(): Sys2 {
  const dt = 0.0015, tr = [new Ring(900), new Ring(900), new Ring(900)], nm = new Norm(), N: F = (x, y) => [x / 1.25, y / 1.25];
  const X = new Float64Array(6), V = new Float64Array(6);
  let eps = 0.12;
  const kick = (h: number) => {
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        if (i === j) continue;
        const dx = X[2 * j] - X[2 * i], dy = X[2 * j + 1] - X[2 * i + 1], r3 = (dx * dx + dy * dy + 1e-4) ** 1.5;
        V[2 * i] += (h * dx) / r3;
        V[2 * i + 1] += (h * dy) / r3;
      }
  };
  const s: Sys2 = {
    name: 'Three-body problem (Poincaré 1890)', kind: 'celestial mechanics · figure eight, nudged', param: { label: 'ε', min: 0, max: 0.4, def: 0.12, step: 0.005 }, rate: 3, wide: false, events: 0,
    reset(k) {
      eps = k;
      const v3 = [-0.93240737 * (1 + eps), -0.86473146 * (1 + eps)];
      X.set([-0.97000436, 0.24308753 + eps * 0.1 + (Math.random() - 0.5) * 1e-4, 0.97000436, -0.24308753, 0, 0]);
      V.set([-v3[0] / 2, -v3[1] / 2, -v3[0] / 2, -v3[1] / 2, v3[0], v3[1]]);
      tr.forEach((r) => r.clear());
    },
    step(n) {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const y0 = X[1];
        kick(dt / 2); // leapfrog: kick, drift, kick (symplectic)
        for (let j = 0; j < 6; j++) X[j] += V[j] * dt;
        kick(dt / 2);
        if (y0 < 0 && X[1] >= 0) out.push(nm.push(X[0])), s.events++;
        for (let b = 0; b < 3; b++) tr[b].add(X[2 * b], X[2 * b + 1]);
        if (X.some((q) => Math.abs(q) > 3.5 || !Number.isFinite(q))) s.reset(eps);
      }
      return out;
    },
    lead: () => N(X[0], X[1]),
    draw(g, m) {
      [ACID, VERM, COBALT].forEach((c, b) => {
        trail(g, tr[b], m, N, c, 1.3);
        dot(g, m(...N(X[2 * b], X[2 * b + 1])), c, 5);
      });
    },
  };
  return s;
}

/** Bunimovich, "On the ergodic properties of nowhere dispersing billiards", Comm. Math. Phys. 65 (1979). */
function stadium(): Sys2 {
  const dt = 0.01, nm = new Norm();
  type Ball = { x: number; y: number; vx: number; vy: number; hits: Ring };
  const balls: Ball[] = [];
  let a = 1;
  const N: F = (x, y) => [x / (a + 1.1), y / (a + 1.1)];
  const inside = (x: number, y: number) => (Math.abs(x) <= a ? Math.abs(y) <= 1 : (Math.abs(x) - a) ** 2 + y * y <= 1);
  const move = (b: Ball) => {
    const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt;
    if (inside(nx, ny)) return (b.x = nx), (b.y = ny), false;
    let ex = 0, ey = Math.sign(ny);
    if (Math.abs(nx) > a) {
      (ex = nx - Math.sign(nx) * a), (ey = ny);
      const l = Math.hypot(ex, ey);
      (ex /= l), (ey /= l);
    }
    const d = b.vx * ex + b.vy * ey;
    b.vx -= 2 * d * ex;
    b.vy -= 2 * d * ey;
    b.hits.add(b.x, b.y);
    return true;
  };
  const s: Sys2 = {
    name: 'Stadium billiard (Bunimovich 1979)', kind: 'a billiard · a circle when the straights vanish', param: { label: 'a', min: 0, max: 1.6, def: 1, step: 0.01 }, rate: 1.5, wide: false, events: 0,
    reset(k) {
      a = k;
      balls.length = 0;
      for (const e of [0, 1e-7]) balls.push({ x: 0.1, y: 0.2, vx: Math.cos(0.7 + e), vy: Math.sin(0.7 + e), hits: new Ring(50) });
    },
    step(n) {
      const out: number[] = [];
      for (let i = 0; i < n; i++) for (const b of balls) if (move(b) && b === balls[0]) out.push(nm.push(Math.atan2(b.y, b.x))), s.events++;
      return out;
    },
    lead: () => N(balls[0].x, balls[0].y),
    draw(g, m) {
      g.strokeStyle = `rgba(${PAPER},0.6)`;
      g.beginPath();
      for (let i = 0; i <= 96; i++) {
        const t = (i / 96) * TAU + Math.PI / 2, cx = Math.cos(t) < 0 ? -a : a;
        const q = m(...N(cx + Math.cos(t), Math.sin(t)));
        i ? g.lineTo(...q) : g.moveTo(...q);
      }
      g.closePath();
      g.stroke();
      balls.forEach((b, i) => {
        trail(g, b.hits, m, N, i ? VERM : ACID, i ? 1 : 1.4, [b.x, b.y]);
        dot(g, m(...N(b.x, b.y)), i ? VERM : ACID, 4);
      });
    },
  };
  return s;
}

/** Wolfram, "Statistical mechanics of cellular automata", Rev. Mod. Phys. 55 (1983): rule 30 and its 255 siblings. */
function rule30(): Sys2 {
  const N = 181, st = new Spacetime(N, 140);
  let rule = 30, cells = new Uint8Array(N), acc = 0, u = 0.5, dens = 0;
  const gen = () => {
    const nx = new Uint8Array(N), row = new Uint8ClampedArray(N * 4);
    for (let i = 0; i < N; i++) {
      nx[i] = (rule >> ((cells[(i - 1 + N) % N] << 2) | (cells[i] << 1) | cells[(i + 1) % N])) & 1;
      row.set(nx[i] ? [198, 255, 61, 255] : [12, 14, 16, 255], i * 4);
    }
    cells = nx;
    st.push(row);
    let b = 0;
    for (let j = -4; j < 4; j++) b = (b << 1) | cells[(N >> 1) + j];
    u = b / 255; // the centre column: the random generator Wolfram used in Mathematica
    dens = cells.reduce((a, v) => a + v, 0) / N;
  };
  const s: Sys2 = {
    name: 'Rule 30 (Wolfram 1983)', kind: 'elementary cellular automaton · spacetime', param: { label: 'rule', min: 0, max: 255, def: 30, step: 1 }, rate: 1, wide: true, events: 0,
    reset(k) {
      rule = Math.round(k);
      cells = new Uint8Array(N);
      cells[N >> 1] = 1;
      acc = 0;
      st.clear();
    },
    step(n) {
      const out: number[] = [];
      for (acc += n; acc >= 8; acc -= 8) gen(), out.push(u), s.events++;
      return out;
    },
    lead: () => [dens * 1.9 - 0.95, u * 1.9 - 0.95],
    draw(g, _m, box) {
      st.draw(g, box);
      const cx = (box.x0 + box.x1) / 2;
      g.fillStyle = `rgba(${VERM},0.9)`;
      g.fillRect(cx - 12, box.y1 + 2, 24, 3);
    },
  };
  return s;
}

/** Kaneko, "Period-doubling of kink-antikink patterns…", Prog. Theor. Phys. 72 (1984): coupled logistic lattice. */
function kaneko(): Sys2 {
  const N = 181, st = new Spacetime(N, 140), nm = new Norm(), eps = 0.3;
  let a = 1.75, x = new Float64Array(N), acc = 0;
  const gen = () => {
    const fx = x.map((v) => 1 - a * v * v), nx = new Float64Array(N), row = new Uint8ClampedArray(N * 4);
    for (let i = 0; i < N; i++) {
      nx[i] = (1 - eps) * fx[i] + (eps / 2) * (fx[(i - 1 + N) % N] + fx[(i + 1) % N]);
      const v = nx[i], c = v >= 0 ? [198, 255, 61] : [255, 75, 31], t = Math.abs(v);
      row.set([12 + (c[0] - 12) * t, 14 + (c[1] - 14) * t, 16 + (c[2] - 16) * t, 255], i * 4);
    }
    x = nx;
    st.push(row);
  };
  const s: Sys2 = {
    name: 'Coupled map lattice (Kaneko 1984)', kind: 'spatiotemporal chaos · spacetime', param: { label: 'a', min: 1.3, max: 2, def: 1.75, step: 0.005 }, rate: 1, wide: true, events: 0,
    reset(k) {
      a = k;
      x = x.map(() => Math.random() * 2 - 1);
      acc = 0;
      st.clear();
    },
    step(n) {
      const out: number[] = [];
      for (acc += n; acc >= 8; acc -= 8) gen(), out.push(nm.push(x[N >> 1])), s.events++;
      return out;
    },
    lead: () => [x[N >> 1] * 0.95, x[(N >> 1) + 12] * 0.95],
    draw(g, _m, box) {
      st.draw(g, box);
    },
  };
  return s;
}

export const SYS2: Record<string, () => Sys2> = { logistic, henon, ikeda, standard, duffing, pendulum, threebody, stadium, rule30, kaneko };

/** Reynolds boids in the plane: they chase the moving state, carried by its velocity. */
export class Swarm2 {
  pos: Pt[] = [];
  vel: Pt[] = [];
  seed(n: number, a: Pt) {
    while (this.pos.length < n) this.pos.push([a[0] + (Math.random() - 0.5) * 0.4, a[1] + (Math.random() - 0.5) * 0.4]), this.vel.push([0, 0]);
    this.pos.length = this.vel.length = n;
  }
  update(p: SwarmParams, lead: Pt, lv: Pt, dt = 1 / 60) {
    const n = this.pos.length;
    if (!n) return;
    const c: Pt = [0, 0], av: Pt = [0, 0];
    for (let i = 0; i < n; i++) for (let d = 0; d < 2; d++) (c[d] += this.pos[i][d] / n), (av[d] += this.vel[i][d] / n);
    for (let i = 0; i < n; i++) {
      const q = this.pos[i], v = this.vel[i], sep: Pt = [0, 0];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dx = q[0] - this.pos[j][0], dy = q[1] - this.pos[j][1], d2 = dx * dx + dy * dy;
        if (d2 < 0.01 && d2 > 1e-8) (sep[0] += dx / d2), (sep[1] += dy / d2);
      }
      for (let d = 0; d < 2; d++)
        v[d] += (p.coupling * (lv[d] - v[d]) * 1.5 + p.cohesion * (c[d] - q[d]) * 2 + p.alignment * (av[d] - v[d]) + p.separation * sep[d] * 0.04 + (0.3 + p.coupling) * (lead[d] - q[d]) * 3) * dt;
      const sp = Math.hypot(v[0], v[1]);
      if (sp > 3) (v[0] *= 3 / sp), (v[1] *= 3 / sp);
      for (let d = 0; d < 2; d++) q[d] = Math.max(-1.3, Math.min(1.3, q[d] + v[d] * dt));
    }
  }
}
