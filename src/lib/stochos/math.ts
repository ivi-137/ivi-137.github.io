/**
 * Stochos: the mathematics. Each generator cites the text it implements.
 */
const mod = (x: number, m: number) => ((x % m) + m) % m;

// ── Sieves (Xenakis, "Sieves", Perspectives of New Music 28/1, 1990) ─────────
// Residue classes m@r (all n ≡ r mod m) combined with | (union), & (intersection), ~ (complement).
export function sieve(expr: string, n: number): boolean[] {
  let i = 0;
  const s = expr.replace(/\s+/g, '');
  const peek = () => s[i];
  const num = () => {
    const m = /^\d+/.exec(s.slice(i));
    if (!m) throw new Error(`number expected at ${i}`);
    i += m[0].length;
    return Number(m[0]);
  };
  const factor = (): ((k: number) => boolean) => {
    if (peek() === '~') return i++, ((f) => (k: number) => !f(k))(factor());
    if (peek() === '(') {
      i++;
      const e = union();
      if (s[i++] !== ')') throw new Error('missing )');
      return e;
    }
    const m = num();
    if (s[i++] !== '@') throw new Error('expected m@r');
    const r = num();
    return (k) => m > 0 && mod(k, m) === mod(r, m);
  };
  const inter = () => {
    let f = factor();
    while (peek() === '&') {
      i++;
      const a = f, b = factor();
      f = (k) => a(k) && b(k);
    }
    return f;
  };
  const union = () => {
    let f = inter();
    while (peek() === '|') {
      i++;
      const a = f, b = inter();
      f = (k) => a(k) || b(k);
    }
    return f;
  };
  const f = union();
  if (i !== s.length) throw new Error(`unexpected "${s[i]}"`);
  return [...Array(n).keys()].map(f);
}

// ── Distributions (Xenakis, Formalized Music, 1963/1971, ch. I) ─────────────
export const DISTS = ['uniform', 'gaussian', 'cauchy', 'logistic', 'exponential', 'arcsine'] as const;
export type Dist = (typeof DISTS)[number];
/** A draw centred on 0 with unit-ish scale. */
export function draw(d: Dist, r = Math.random): number {
  const u = Math.min(1 - 1e-9, Math.max(1e-9, r()));
  switch (d) {
    case 'gaussian':
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
    case 'cauchy':
      return Math.max(-8, Math.min(8, Math.tan(Math.PI * (u - 0.5)) * 0.5));
    case 'logistic':
      return Math.log(u / (1 - u)) * 0.55;
    case 'exponential':
      return -Math.log(u) - 1;
    case 'arcsine':
      return Math.sin(Math.PI * (u - 0.5)) * 1.6;
    default:
      return (u - 0.5) * 3.4;
  }
}

/** Poisson: events per bar with mean λ; onsets from exponential inter-onset times (Achorripsis). */
export function poissonOnsets(lambda: number, n: number): boolean[] {
  const out = Array(n).fill(false);
  let t = 0;
  for (;;) {
    t += -Math.log(1 - Math.random()) * (n / Math.max(0.01, lambda));
    if (t >= n) break;
    out[Math.floor(t)] = true;
  }
  return out;
}

/** Random walk with elastic (reflecting) barriers, Gaussian steps (Formalized Music; Mikka, 1971). */
export function brownian(n: number, start: number, sigma: number, lo: number, hi: number): number[] {
  let x = start;
  return [...Array(n)].map(() => {
    x += draw('gaussian') * sigma;
    while (x < lo || x > hi) x = x < lo ? 2 * lo - x : 2 * hi - x;
    return Math.round(x);
  });
}

/** Euclidean rhythm (Toussaint, Bridges 2005), Bresenham form, rotated. */
export function euclid(k: number, n: number, rot = 0): boolean[] {
  k = Math.max(0, Math.min(n, Math.round(k)));
  const b = [...Array(n).keys()].map((i) => k > 0 && Math.floor((i * k) / n) !== Math.floor(((i - 1) * k) / n));
  return b.map((_, i) => b[mod(i - rot, n)]);
}

/** Fibonacci word 1011010110110… (the Sturmian word of the golden ratio). */
export function fibonacciWord(n: number, rot = 0): boolean[] {
  const phi = (1 + Math.sqrt(5)) / 2;
  // s_k = floor((k+2)/φ) − floor((k+1)/φ): the characteristic word of slope 1/φ
  const w = [...Array(n + rot).keys()].map((k) => Math.floor((k + 2) / phi) - Math.floor((k + 1) / phi) === 1);
  return w.slice(rot, rot + n);
}

/** Logistic map x ← r·x(1−x) (May, Nature 261, 1976): order, period doubling, chaos as r → 4. */
export function logistic(n: number, r: number, x0 = 0.5): number[] {
  let x = x0;
  for (let i = 0; i < 100; i++) x = r * x * (1 - x); // discard the transient
  return [...Array(n)].map(() => (x = r * x * (1 - x)));
}

/** First-order Markov chain learnt from a sequence, then sampled (Formalized Music ch. II–III). */
export function markovRemix(seq: number[], n: number): number[] {
  if (seq.length < 2) return [...Array(n)].map(() => seq[0] ?? 60);
  const T = new Map<number, number[]>();
  seq.forEach((x, i) => {
    const y = seq[(i + 1) % seq.length];
    T.set(x, [...(T.get(x) ?? []), y]);
  });
  let x = seq[Math.floor(Math.random() * seq.length)];
  return [...Array(n)].map(() => {
    const nexts = T.get(x) ?? seq;
    return (x = nexts[Math.floor(Math.random() * nexts.length)]);
  });
}

/** Elementary cellular automaton on a ring (Wolfram numbering; Xenakis used automata in Horos, 1986). */
export function caStep(row: boolean[], rule: number): boolean[] {
  const n = row.length;
  const next = row.map((_, i) => ((rule >> ((+row[mod(i - 1, n)] << 2) | (+row[i] << 1) | +row[(i + 1) % n])) & 1) === 1);
  if (!next.some(Boolean) && n) next[Math.floor(Math.random() * n)] = true; // never let a track die
  return next;
}

// ── Nomos Alpha: the rotation group of the cube (Xenakis, 1966; Formalized Music ch. VIII) ──
// The 24 rotations permute the cube's 8 vertices; vertex (x,y,z) ∈ {0,1}³ has index 4x+2y+z.
type Perm = number[];
const idx = (x: number, y: number, z: number) => 4 * x + 2 * y + z;
const fromMap = (f: (x: number, y: number, z: number) => [number, number, number]): Perm =>
  [...Array(8).keys()].map((v) => idx(...f((v >> 2) & 1, (v >> 1) & 1, v & 1)));
const compose = (a: Perm, b: Perm): Perm => a.map((_, i) => a[b[i]]); // (a∘b)(i) = a(b(i))
const RX = fromMap((x, y, z) => [x, 1 - z, y]);
const RY = fromMap((x, y, z) => [z, y, 1 - x]);
export const CUBE_GROUP: Perm[] = (() => {
  const seen = new Map<string, Perm>();
  const q: Perm[] = [[0, 1, 2, 3, 4, 5, 6, 7]];
  while (q.length) {
    const p = q.pop()!;
    const key = p.join();
    if (seen.has(key)) continue;
    seen.set(key, p);
    q.push(compose(RX, p), compose(RY, p));
  }
  return [...seen.values()];
})();
/** Xenakis's recurrence in the group: g(n) = g(n−1) ∘ g(n−2), started from two generators. */
export function nomosSequence(len: number, a = 1, b = 2): Perm[] {
  const out = [CUBE_GROUP[a % 24], CUBE_GROUP[b % 24]];
  while (out.length < len) out.push(compose(out[out.length - 1], out[out.length - 2]));
  return out.slice(0, len);
}

/** Snap a MIDI note to the nearest point of a pitch sieve (evaluated over 0–127). */
export function snapToSieve(note: number, allowed: boolean[]): number {
  for (let d = 0; d < 12; d++) {
    if (allowed[note - d]) return note - d;
    if (allowed[note + d]) return note + d;
  }
  return note;
}
