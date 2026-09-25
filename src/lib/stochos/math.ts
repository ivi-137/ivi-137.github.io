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

// ── more generators ─────────────────────────────────────────────────────────

/** Lorenz system (Lorenz, J. Atmos. Sci. 20, 1963), σ=10 ρ=28 β=8/3, sampled x(t) scaled to [0,1]. */
export function lorenz(n: number, dt = 0.02): number[] {
  let x = 1 + Math.random(), y = 1, z = 1;
  const xs: number[] = [];
  for (let i = 0; i < 400 + n * 3; i++) {
    const dx = 10 * (y - x), dy = x * (28 - z) - y, dz = x * y - (8 / 3) * z;
    x += dx * dt; y += dy * dt; z += dz * dt;
    if (i >= 400 && (i - 400) % 3 === 0) xs.push(x);
  }
  return xs.slice(0, n).map((v) => (v + 20) / 40);
}

/** Hénon map (Hénon, Commun. Math. Phys. 50, 1976), a=1.4 b=0.3: x for pitch, sign of y for onsets. */
export function henon(n: number): Array<[number, boolean]> {
  let x = Math.random() * 0.1, y = 0;
  for (let i = 0; i < 100; i++) [x, y] = [1 - 1.4 * x * x + y, 0.3 * x];
  return [...Array(n)].map(() => {
    [x, y] = [1 - 1.4 * x * x + y, 0.3 * x];
    return [(x + 1.3) / 2.6, y > 0];
  });
}

/** Zipf's law: rank r drawn with probability ∝ 1/r^s (Zipf 1949; Manaris et al., Computer Music Journal 29/1, 2005). */
export function zipf(n: number, ranks: number, s = 1): number[] {
  const w = [...Array(ranks).keys()].map((r) => 1 / (r + 1) ** s);
  const tot = w.reduce((a, b) => a + b, 0);
  return [...Array(n)].map(() => {
    let u = Math.random() * tot;
    for (let r = 0; r < ranks; r++) if ((u -= w[r]) <= 0) return r;
    return ranks - 1;
  });
}

/** Thue–Morse sequence t(n) = parity of the binary digit sum of n (Thue 1912; Morse 1921). */
export const thueMorse = (n: number, rot = 0) => [...Array(n).keys()].map((k) => (k + rot).toString(2).split('1').length % 2 === 0);

/** Per Nørgård's infinity series (1959): a(0)=0, a(2n) = −a(n), a(2n+1) = a(n)+1. */
export function infinitySeries(n: number): number[] {
  const a = [0];
  for (let k = 1; k < n; k++) a.push(k % 2 ? a[(k - 1) / 2] + 1 : -a[k / 2]);
  return a;
}

/** Messiaen's non-retrogradable rhythm (1944): a palindrome, the same forwards and backwards. */
export const palindrome = (g: boolean[]) => g.map((_, i) => g[Math.min(i, g.length - 1 - i)]);

/** Pitch-class multiplication M_k: pc → k·pc (mod 12). M7 maps the chromatic scale onto the circle of fifths. */
export const multiplyPc = (note: number, k: number) => note - (((note % 12) + 12) % 12) + ((k * note) % 12 + 12) % 12;

/** A random twelve-tone row and its forms P, I, R, RI (Schoenberg's method). */
export function twelveTone(): number[][] {
  const p = [...Array(12).keys()];
  for (let i = 11; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const inv = p.map((x) => (((2 * p[0] - x) % 12) + 12) % 12);
  return [p, inv, [...p].reverse(), [...inv].reverse()];
}

/**
 * Optimal mixed strategy of a 2×2 zero-sum game (von Neumann's minimax),
 * as in Xenakis's Duel (1959). Returns the row player's probability of tactic 1.
 */
export function minimax2x2(a: number, b: number, c: number, d: number): number {
  const lower = Math.max(Math.min(a, b), Math.min(c, d)), upper = Math.min(Math.max(a, c), Math.max(b, d));
  if (lower === upper) return Math.min(a, b) >= Math.min(c, d) ? 1 : 0; // saddle point: a pure strategy
  return (d - c) / (a - b - c + d);
}
