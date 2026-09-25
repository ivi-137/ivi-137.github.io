/**
 * Armonia: composition rules from the theory literature, as code.
 *
 * Fifteen chord generators and seven melodic tools. Each one implements a
 * published rule set, cited in `cite`, rather than a loose impression of it:
 *
 *   Piston 1941/1987      table of usual root progressions → Markov chain
 *   Rameau 1722           basse fondamentale: roots fall by fifths (or thirds)
 *   Rohrmeier 2011        phrase-structure grammar: TR → DR T, DR → SR D, …
 *   Cohn 1996, 1998       P, L, R; hexatonic (PL) and octatonic (PR) cycles
 *   Tymoczko 2006         efficient voice leading between nearby chords
 *   Lerdahl 2001          tonal pitch space: δ(x→y) = i + j + k, a tension arc
 *   Demsey 1991           Coltrane's major-third cycles (Giant Steps)
 *   Levy 1985             negative harmony: reflection through the I–V axis
 *   Persichetti 1961      quartal harmony, diatonic planing
 *   Messiaen 1944         modes of limited transposition
 *   Grisey 1975           spectral chords from a harmonic series
 *   Partch 1949/1974      otonal and utonal hexads from the tonality diamond
 *   Plomp & Levelt 1965,  sensory dissonance of the synth's own partials
 *   Sethares 1993
 *
 * Melody: Krumhansl–Kessler key-finding, Fux first-species counterpoint by
 * dynamic programming, von Hippel & Huron's tessitura model, Voss & Clarke's
 * 1/f melodies, Schoenberg's row forms, Pachet's Continuator, Levy's mirror.
 *
 * Pure functions, no DOM, no imports: `scripts/check-harmony.mts` tests the
 * theory against textbook facts.
 */

export type Rng = () => number;
export const mulberry = (seed: number): Rng => {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export const mod12 = (n: number) => ((n % 12) + 12) % 12;
const pick = <T>(rng: Rng, xs: T[]) => xs[Math.floor(rng() * xs.length)];
function weighted<T>(rng: Rng, items: Array<[T, number]>): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [x, w] of items) if ((r -= w) <= 0) return x;
  return items[items.length - 1][0];
}

// ── chords ───────────────────────────────────────────────────────────────

export type Quality = 'M' | 'm' | 'd' | 'A' | 'M7' | '7' | 'm7' | 'h7' | 'd7' | 'sus4' | 'sus2' | 'add9' | '6' | 'm6' | '7b9' | 'q' | 'x';
export const SHAPES: Record<Exclude<Quality, 'q' | 'x'>, number[]> = {
  M: [0, 4, 7],
  m: [0, 3, 7],
  d: [0, 3, 6],
  A: [0, 4, 8],
  M7: [0, 4, 7, 11],
  '7': [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  h7: [0, 3, 6, 10],
  d7: [0, 3, 6, 9],
  sus4: [0, 5, 7],
  sus2: [0, 2, 7],
  add9: [0, 4, 7, 14],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '7b9': [0, 4, 7, 10, 13],
};
const SUFFIX: Record<Quality, string> = {
  M: '',
  m: 'm',
  d: '°',
  A: '+',
  M7: 'maj7',
  '7': '7',
  m7: 'm7',
  h7: 'ø7',
  d7: '°7',
  sus4: 'sus4',
  sus2: 'sus2',
  add9: 'add9',
  '6': '6',
  m6: 'm6',
  '7b9': '7♭9',
  q: '',
  x: '',
};

export interface Chord {
  root: number; // pitch class
  quality: Quality;
  /** chord tones as pitch classes, root first */
  pcs: number[];
  /** exact frequencies (just intonation / spectral): the choir plays these instead of 12-TET */
  hz?: number[];
  name: string;
  roman?: string;
  /** what the rule did to get here: "L", "δ = 7", "TR → DR T" … */
  how?: string;
}

export function chord(root: number, quality: Exclude<Quality, 'q' | 'x'>, how?: string): Chord {
  root = mod12(root);
  return { root, quality, pcs: SHAPES[quality].map((i) => mod12(root + i)), name: NAMES[root] + SUFFIX[quality], how };
}

/** Identify a pitch-class set as a named chord (root + quality) when it is one. */
export function identify(pcs: number[]): { root: number; quality: Quality } | null {
  const set = [...new Set(pcs.map(mod12))];
  const order: Array<Exclude<Quality, 'q' | 'x'>> = ['M', 'm', 'd', 'A', '7', 'M7', 'm7', 'h7', 'd7', 'sus4', '6', 'm6', 'add9', '7b9', 'sus2'];
  for (const q of order) {
    const shape = SHAPES[q].map(mod12);
    if (shape.length !== set.length) continue;
    for (const r of set) if (shape.every((i) => set.includes(mod12(r + i)))) return { root: r, quality: q };
  }
  return null;
}

export function fromPcs(pcs: number[], how?: string): Chord {
  const id = identify(pcs);
  if (id && id.quality !== 'q' && id.quality !== 'x') return { ...chord(id.root, id.quality), pcs: pcs.map(mod12), how };
  return { root: mod12(pcs[0]), quality: 'x', pcs: pcs.map(mod12), name: pcs.map((p) => NAMES[mod12(p)]).join(' '), how };
}

const ROMAN = ['I', '♭II', 'II', '♭III', 'III', 'IV', '♯IV', 'V', '♭VI', 'VI', '♭VII', 'VII'];
export function roman(c: Chord, tonic: number) {
  const r = ROMAN[mod12(c.root - tonic)];
  const lower = c.quality === 'm' || c.quality === 'd' || c.quality === 'm7' || c.quality === 'h7' || c.quality === 'd7' || c.quality === 'm6';
  return (lower ? r.toLowerCase() : r) + (c.quality === 'M' || c.quality === 'm' ? '' : SUFFIX[c.quality].replace(/^m(?!aj)/, ''));
}

// ── keys and diatonic chords ─────────────────────────────────────────────────

export interface Key {
  tonic: number;
  minor: boolean;
}
export const MAJOR = [0, 2, 4, 5, 7, 9, 11];
/** Minor with the raised seventh for V and vii° (harmonic minor), as in common-practice harmony. */
export const MINOR = [0, 2, 3, 5, 7, 8, 11];
export const NATURAL_MINOR = [0, 2, 3, 5, 7, 8, 10];
export const scaleOf = (k: Key) => (k.minor ? MINOR : MAJOR).map((i) => mod12(k.tonic + i));

/** Triad on scale degree 1..7 (stacked diatonic thirds). */
export function diatonic(k: Key, deg: number, seventh = false): Chord {
  // in minor, only V and vii° borrow the raised seventh; III, VI and the rest stay natural
  const sc = k.minor ? (deg === 5 || deg === 7 ? MINOR : NATURAL_MINOR) : MAJOR;
  const d = deg - 1;
  const at = (n: number) => sc[(d + n) % 7] + 12 * Math.floor((d + n) / 7);
  const iv = [0, 2, 4, ...(seventh ? [6] : [])].map((n) => at(n) - at(0));
  let q: Exclude<Quality, 'q' | 'x'> = 'x' as never;
  const key = iv.join(',');
  for (const [name, shape] of Object.entries(SHAPES)) if (shape.join(',') === key) q = name as typeof q;
  if ((q as string) === 'x') q = seventh ? '7' : 'M';
  const c = chord(k.tonic + sc[d], q);
  c.roman = roman(c, k.tonic);
  return c;
}

// ── neo-Riemannian transformations (Cohn 1998) ─────────────────────────────────

export type PLR = 'P' | 'L' | 'R';
/** P: parallel, L: leading-tone exchange, R: relative. Each is an involution on the 24 triads. */
export function plr(c: Chord, t: PLR): Chord {
  const maj = c.quality !== 'm';
  const r = c.root;
  if (t === 'P') return chord(r, maj ? 'm' : 'M', 'P');
  if (t === 'R') return maj ? chord(r + 9, 'm', 'R') : chord(r + 3, 'M', 'R');
  return maj ? chord(r + 4, 'm', 'L') : chord(r + 8, 'M', 'L');
}
const asTriad = (c: Chord | null, k: Key): Chord => {
  if (c && (c.quality === 'M' || c.quality === 'm')) return c;
  if (c) {
    const third = c.pcs.includes(mod12(c.root + 3)) && !c.pcs.includes(mod12(c.root + 4));
    return chord(c.root, third ? 'm' : 'M');
  }
  return chord(k.tonic, k.minor ? 'm' : 'M');
};

// ── voice-leading distance (Tymoczko 2006) ───────────────────────────────────

const circ = (a: number, b: number) => {
  const d = Math.abs(mod12(a) - mod12(b));
  return Math.min(d, 12 - d);
};
function perms(n: number): number[][] {
  if (n === 1) return [[0]];
  const out: number[][] = [];
  for (const p of perms(n - 1)) for (let i = 0; i < n; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  return out;
}
const PERMS = [[], [[0]], perms(2), perms(3), perms(4), perms(5), perms(6)];
/**
 * The smallest total semitone motion that takes chord A to chord B, as pitch
 * classes: each voice moves to one note of B, every note of B is reached, and a
 * smaller chord may double one of its notes (Tymoczko's "voice leading between
 * multisets").
 */
export function vlDistance(a: number[], b: number[]): number {
  const A = [...new Set(a.map(mod12))],
    B = [...new Set(b.map(mod12))];
  const n = Math.max(A.length, B.length);
  if (n > 6) return 99;
  const pads = (xs: number[]): number[][] => {
    if (xs.length === n) return [xs];
    const out: number[][] = [];
    for (const x of xs) for (const rest of pads([...xs, x])) out.push(rest);
    return out;
  };
  let best = Infinity;
  for (const a2 of pads(A))
    for (const b2 of pads(B))
      for (const p of PERMS[n]) {
        let s = 0;
        for (let i = 0; i < n && s < best; i++) s += circ(a2[i], b2[p[i]]);
        if (s < best) best = s;
      }
  return best;
}

// ── Lerdahl's tonal pitch space ────────────────────────────────────────────

/**
 * δ(x → y) = i + j + k (Lerdahl 2001, ch. 2): i = steps between the two
 * regions on the circle of fifths; j = steps between the chord roots on the
 * diatonic circle of fifths of y's region; k = pitch classes of y's basic
 * space (levels a root, b fifth, c triad, d scale) that are not in x's.
 */
export function tpsDistance(x: Chord, xKey: Key, y: Chord, yKey: Key): number {
  const fifths = (a: number, b: number) => {
    const d = mod12((b - a) * 7);
    return Math.min(d, 12 - d);
  };
  const i = fifths(xKey.tonic + (xKey.minor ? 3 : 0), yKey.tonic + (yKey.minor ? 3 : 0));
  const sc = scaleOf(yKey);
  // diatonic circle of fifths: scale degrees ordered by fifths (4 scale steps)
  const di = (pc: number) => sc.indexOf(mod12(pc));
  let j: number;
  if (di(x.root) >= 0 && di(y.root) >= 0) {
    let a = di(x.root),
      steps = 0;
    const target = di(y.root);
    while (a !== target && steps < 7) {
      a = (a + 4) % 7;
      steps++;
    }
    j = Math.min(steps, 7 - steps);
  } else j = fifths(x.root, y.root);
  const space = (c: Chord, k: Key) => [[c.root], [c.root, mod12(c.root + 7)], c.pcs.slice(0, 3), scaleOf(k)];
  const sx = space(x, xKey),
    sy = space(y, yKey);
  let k = 0;
  for (let l = 0; l < 4; l++) for (const pc of new Set(sy[l])) if (!sx[l].includes(pc)) k++;
  return i + j + k;
}

// ── sensory dissonance (Plomp & Levelt 1965, parametrised by Sethares 1993) ─────

/** Dissonance of two sine partials: Sethares' fit to the Plomp–Levelt curve. */
export function pairDissonance(f1: number, f2: number, a1: number, a2: number) {
  const lo = Math.min(f1, f2),
    df = Math.abs(f2 - f1);
  const s = 0.24 / (0.0207 * lo + 18.96);
  return Math.min(a1, a2) * (Math.exp(-3.51 * s * df) - Math.exp(-5.75 * s * df));
}
/** Total dissonance of a chord of harmonic tones (partials 1..n, amplitude 0.88^k). */
export function dissonance(freqs: number[], partials = 6) {
  const ps: Array<[number, number]> = [];
  for (const f of freqs) for (let k = 1; k <= partials; k++) ps.push([f * k, 0.88 ** (k - 1)]);
  let d = 0;
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) d += pairDissonance(ps[i][0], ps[j][0], ps[i][1], ps[j][1]);
  return d;
}
export const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

// ── the methods ────────────────────────────────────────────────────────────

export interface HarmCtx {
  key: Key;
  prev: Chord | null;
  /** position in the phrase, 0..len-1 */
  i: number;
  len: number;
  rng: Rng;
  /** 0..1: how adventurous (less common moves, higher partials, more tension) */
  spice: number;
  /** per-method memory that survives between calls */
  memo: Record<string, any>;
}

export interface Method {
  id: string;
  name: string;
  en: string;
  cite: string;
  blurb: string;
  next(c: HarmCtx): Chord;
}

/** Piston's Table of Usual Root Progressions (Harmony, 5th ed., 1987, rev. DeVoto). */
export const PISTON: Record<number, { often: number[]; some: number[]; less: number[] }> = {
  1: { often: [4, 5], some: [6], less: [2, 3] },
  2: { often: [5], some: [6], less: [1, 3, 4] },
  3: { often: [6], some: [4], less: [2, 5] },
  4: { often: [5], some: [1, 2], less: [3, 6] },
  5: { often: [1], some: [4, 6], less: [2, 3] },
  6: { often: [2, 5], some: [3, 4], less: [1] },
  7: { often: [3], some: [1], less: [] },
};
/** Transition probabilities: "often" shares 0.6, "sometimes" 0.3, "less often" 0.1; spice moves weight to the rarer moves. */
export function pistonRow(deg: number, spice = 0): Array<[number, number]> {
  const row = PISTON[deg];
  const w = { often: 0.6 - 0.3 * spice, some: 0.3, less: 0.1 + 0.3 * spice };
  if (!row.less.length) {
    w.some += w.less;
    w.less = 0;
  }
  const out: Array<[number, number]> = [];
  for (const g of ['often', 'some', 'less'] as const) for (const d of row[g]) out.push([d, w[g] / row[g].length]);
  return out;
}
const degreeOf = (c: Chord | null, k: Key) => {
  if (!c) return 0;
  const i = scaleOf(k).indexOf(c.root);
  return i + 1;
};

function pistonNext(c: HarmCtx): Chord {
  let deg = degreeOf(c.prev, c.key);
  if (c.i === 0 || deg === 0) deg = 0;
  const next = deg === 0 ? 1 : weighted(c.rng, pistonRow(deg, c.spice));
  const ch = diatonic(c.key, next, c.spice > 0.6 && c.rng() < c.spice - 0.4);
  ch.how = deg ? `${ROMAN_D[deg]} → ${ROMAN_D[next]}` : 'I';
  return ch;
}
const ROMAN_D = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** Mirror a pitch class through Levy's axis: halfway between the tonic and the dominant's third. */
export const negate = (pc: number, tonic: number) => mod12(2 * tonic + 7 - pc);

function rohrmeierPhrase(c: HarmCtx, len: number): Chord[] {
  const { rng, key, spice } = c;
  type Sym = 'TR' | 'DR' | 'SR' | 'T' | 'D' | 'S';
  const tree: string[] = [];
  const expand = (s: Sym, budget: number): Sym[] => {
    if (s === 'T' || s === 'D' || s === 'S') return [s];
    const leaf = (s[0] as 'T' | 'D' | 'S') as Sym;
    if (budget <= 1) return [leaf];
    if (s === 'TR') {
      // TR → DR T (a cadence), or TR → TR TR (prolongation)
      if (rng() < 0.7) {
        tree.push('TR → DR T');
        return [...expand('DR', budget - 1), 'T'];
      }
      tree.push('TR → TR TR');
      const a = Math.max(1, Math.floor(budget / 2));
      return [...expand('TR', a), ...expand('TR', budget - a)];
    }
    if (s === 'DR') {
      if (rng() < 0.75) {
        tree.push('DR → SR D');
        return [...expand('SR', budget - 1), 'D'];
      }
      tree.push('DR → DR DR');
      const a = Math.max(1, Math.floor(budget / 2));
      return [...expand('DR', a), ...expand('DR', budget - a)];
    }
    // SR → SR SR, or the plain function
    if (budget >= 2 && rng() < 0.35) {
      tree.push('SR → SR SR');
      return [...expand('SR', 1), ...expand('SR', budget - 1)];
    }
    return ['S'];
  };
  // phrase → TR, beginning on a tonic
  const funcs = ['T' as Sym, ...expand('TR', len - 1)];
  // functions → scale degrees (Rohrmeier's degree level: T ∈ {I, vi}, S ∈ {IV, ii}, D ∈ {V, vii°})
  const real: Record<string, Array<[number, number]>> = {
    T: [
      [1, 0.8],
      [6, 0.2],
    ],
    S: [
      [4, 0.55],
      [2, 0.45],
    ],
    D: [
      [5, 0.85],
      [7, 0.15],
    ],
  };
  const chords: Chord[] = [];
  funcs.forEach((f, n) => {
    const last = n === funcs.length - 1;
    const deg = n === 0 || last ? (f === 'T' ? 1 : weighted(rng, real[f])) : weighted(rng, real[f]);
    const seventh = f === 'D' && rng() < 0.5;
    let ch = diatonic(key, deg, seventh);
    ch.how = `${f} · ${tree[n % Math.max(1, tree.length)] ?? 'phrase → TR'}`;
    // applied dominants: X → D(X) X
    if (!last && n > 0 && deg !== 1 && deg !== 7 && rng() < spice * 0.6 && chords.length < len - 1) {
      const sec = chord(ch.root + 7, '7', `D(${ch.roman}) · X → D(X) X`);
      sec.roman = `V7/${ch.roman}`;
      chords.push(sec);
    }
    chords.push(ch);
  });
  return chords.slice(0, Math.max(len, 2));
}

const COLTRANE = (t: number): Chord[] => {
  // Giant Steps' substitution for ii–V–I: ii7 | V7/♭VI ♭VImaj7 | V7/III IIImaj7 | V7 Imaj7
  const seq: Array<[number, Exclude<Quality, 'q' | 'x'>, string]> = [
    [2, 'm7', 'ii7'],
    [3, '7', 'V7/♭VI'],
    [8, 'M7', '♭VImaj7'],
    [11, '7', 'V7/III'],
    [4, 'M7', 'IIImaj7'],
    [7, '7', 'V7'],
    [0, 'M7', 'Imaj7'],
  ];
  return seq.map(([i, q, r]) => ({ ...chord(t + i, q, 'major-third axis'), roman: r }));
};

/** Messiaen's modes 2 and 3 as pitch-class sets, with the interval each repeats at. */
export const MESSIAEN = {
  2: { set: [0, 1, 3, 4, 6, 7, 9, 10], period: 3 },
  3: { set: [0, 2, 3, 4, 6, 7, 8, 10, 11], period: 4 },
};

export const METHODS: Method[] = [
  {
    id: 'piston',
    name: 'Funzioni',
    en: 'Functional Markov chain',
    cite: 'W. Piston, Harmony (1941; 5th ed. rev. M. DeVoto, 1987): Table of Usual Root Progressions',
    blurb: 'Each chord chooses its successor from Piston’s table: “V is followed by I, sometimes IV or VI, less often II or III.”',
    next: pistonNext,
  },
  {
    id: 'rameau',
    name: 'Basso fondamentale',
    en: 'Fundamental bass',
    cite: 'J.-Ph. Rameau, Traité de l’harmonie (1722)',
    blurb: 'The roots fall by fifths, the motion Rameau held to be the most natural, and occasionally by thirds.',
    next(c) {
      if (c.i === 0 || !c.prev) return { ...diatonic(c.key, 1), how: 'I' };
      const d = degreeOf(c.prev, c.key) || 1;
      const third = c.rng() < c.spice * 0.45;
      const nd = ((d - 1 + (third ? 5 : 3)) % 7) + 1; // down a third = up a sixth; down a fifth = up a fourth
      const ch = diatonic(c.key, nd, c.spice > 0.5 && c.rng() < 0.4);
      ch.how = third ? 'root ↓ 3rd' : 'root ↓ 5th';
      return ch;
    },
  },
  {
    id: 'rohrmeier',
    name: 'Sintassi generativa',
    en: 'Generative syntax',
    cite: 'M. Rohrmeier, “Towards a generative syntax of tonal harmony”, J. Mathematics and Music 5(1), 2011, 35–53',
    blurb: 'A whole phrase is derived from a tree: phrase → TR, TR → DR T, DR → SR D, with applied dominants X → D(X) X.',
    next(c) {
      const m = c.memo;
      if (!m.phrase?.length || c.i === 0) m.phrase = rohrmeierPhrase(c, Math.max(4, c.len));
      return m.phrase.shift();
    },
  },
  {
    id: 'plr',
    name: 'Passeggiata PLR',
    en: 'Neo-Riemannian walk',
    cite: 'R. Cohn, “Introduction to Neo-Riemannian Theory”, J. Music Theory 42(2), 1998, 167–180',
    blurb: 'Every move keeps two common tones and slides the third by a semitone (P, L) or a tone (R).',
    next(c) {
      const t = asTriad(c.prev, c.key);
      if (c.i === 0 && !c.prev) return { ...t, how: 'start' };
      const last = c.memo.last as PLR | undefined;
      const moves: PLR[] = (['P', 'L', 'R'] as PLR[]).filter((m) => m !== last || c.rng() < 0.15);
      const m1 = pick(c.rng, moves);
      let ch = plr(t, m1);
      if (c.rng() < c.spice * 0.5) {
        const m2 = pick(c.rng, (['P', 'L', 'R'] as PLR[]).filter((m) => m !== m1));
        ch = plr(ch, m2);
        ch.how = m1 + m2;
      }
      c.memo.last = m1;
      return ch;
    },
  },
  {
    id: 'hexatonic',
    name: 'Ciclo esatonico',
    en: 'Hexatonic cycle (PL)',
    cite: 'R. Cohn, “Maximally Smooth Cycles, Hexatonic Systems…”, Music Analysis 15(1), 1996, 9–40',
    blurb: 'P and L in alternation: six triads, one semitone of motion each, then home. Cohn’s maximally smooth cycle.',
    next(c) {
      const t = asTriad(c.prev, c.key);
      if (!c.prev) return { ...t, how: 'start' };
      const m: PLR = t.quality === 'M' ? 'P' : 'L';
      return plr(t, m);
    },
  },
  {
    id: 'octatonic',
    name: 'Ciclo ottatonico',
    en: 'Octatonic cycle (PR)',
    cite: 'R. Cohn, J. Music Theory 42(2), 1998; after Riemann’s Schritt/Wechsel',
    blurb: 'P and R in alternation: eight triads drawn from one octatonic scale, falling by minor thirds.',
    next(c) {
      const t = asTriad(c.prev, c.key);
      if (!c.prev) return { ...t, how: 'start' };
      return plr(t, t.quality === 'M' ? 'P' : 'R');
    },
  },
  {
    id: 'tymoczko',
    name: 'Condotta parsimoniosa',
    en: 'Efficient voice leading',
    cite: 'D. Tymoczko, “The Geometry of Musical Chords”, Science 313(5783), 2006, 72–74',
    blurb: 'Any chord may follow, as long as the voices move as little as possible: the short line segments of chord space.',
    next(c) {
      const from = c.prev ?? chord(c.key.tonic, c.key.minor ? 'm' : 'M');
      if (!c.prev) return { ...from, how: 'start' };
      const cands: Chord[] = [];
      const qs: Array<Exclude<Quality, 'q' | 'x'>> = c.spice > 0.35 ? ['M', 'm', '7', 'm7', 'M7', 'h7', 'd7', 'A'] : ['M', 'm', '7', 'm7'];
      for (let r = 0; r < 12; r++) for (const q of qs) cands.push(chord(r, q));
      const maxD = 2 + Math.round(c.spice * 3);
      const scored = cands
        .map((ch) => [ch, vlDistance(from.pcs, ch.pcs)] as const)
        .filter(([ch, d]) => d > 0 && d <= maxD && ch.name !== from.name);
      const ch = weighted(
        c.rng,
        scored.map(([ch, d]) => [ch, Math.exp(-d / (0.6 + c.spice))] as [Chord, number]),
      );
      return { ...ch, how: `Σ|Δ| = ${vlDistance(from.pcs, ch.pcs)}` };
    },
  },
  {
    id: 'lerdahl',
    name: 'Arco di tensione',
    en: 'Tonal pitch space arc',
    cite: 'F. Lerdahl, Tonal Pitch Space (OUP, 2001); Lerdahl & Krumhansl, Music Perception 24(4), 2007',
    blurb: 'Each chord is chosen so its distance δ from the tonic traces a rise and fall of tension across the phrase.',
    next(c) {
      const home = c.key;
      const tonic = diatonic(home, 1);
      const pos = c.len > 1 ? c.i / (c.len - 1) : 0;
      if (c.i === 0 || pos >= 1) return { ...tonic, how: 'δ = 0' };
      const regions: Key[] = [home, { tonic: mod12(home.tonic + 7), minor: home.minor }, { tonic: mod12(home.tonic + 5), minor: home.minor }, { tonic: mod12(home.tonic + (home.minor ? 3 : 9)), minor: !home.minor }];
      const target = Math.sin(Math.PI * pos) * (7 + c.spice * 9);
      const cands: Array<[Chord, number]> = [];
      for (const k of regions)
        for (let d = 1; d <= 7; d++) {
          const ch = diatonic(k, d);
          if (ch.quality === 'A') continue;
          const delta = tpsDistance(tonic, home, ch, k);
          if (c.prev && ch.name === c.prev.name) continue;
          cands.push([{ ...ch, roman: roman(ch, home.tonic), how: `δ = ${delta}` }, -Math.abs(delta - target) * 1.4]);
        }
      cands.sort((a, b) => b[1] - a[1]);
      return weighted(
        c.rng,
        cands.slice(0, 4).map(([ch, s]) => [ch, Math.exp(s)] as [Chord, number]),
      );
    },
  },
  {
    id: 'coltrane',
    name: 'Passi da gigante',
    en: 'Coltrane changes',
    cite: 'D. Demsey, “Chromatic Third Relations in the Music of John Coltrane”, Annual Review of Jazz Studies 5, 1991',
    blurb: 'Three tonal centres a major third apart, each reached through its own dominant, as in “Giant Steps” (1959).',
    next(c) {
      const m = c.memo;
      if (!m.cycle?.length || c.i === 0) {
        const axis = c.spice > 0.6 && c.rng() < 0.5 ? pick(c.rng, [4, 8]) : 0;
        m.cycle = COLTRANE(c.key.tonic + axis);
      }
      return m.cycle.shift();
    },
  },
  {
    id: 'negative',
    name: 'Armonia negativa',
    en: 'Negative harmony',
    cite: 'E. Levy, A Theory of Harmony (SUNY Press, 1985)',
    blurb: 'Piston’s progressions reflected through the axis between the tonic and the dominant: C major becomes C minor, G becomes F minor.',
    next(c) {
      const m = c.memo;
      const shadow = pistonNext({ ...c, prev: m.shadow ?? null });
      m.shadow = shadow;
      const ch = fromPcs(
        shadow.pcs.map((p) => negate(p, c.key.tonic)),
        `mirror of ${shadow.roman}`,
      );
      return { ...ch, roman: ch.quality !== 'x' ? roman(ch, c.key.tonic) : undefined };
    },
  },
  {
    id: 'quartal',
    name: 'Quarte sovrapposte',
    en: 'Quartal planing',
    cite: 'V. Persichetti, Twentieth-Century Harmony (Norton, 1961), ch. 3',
    blurb: 'Chords of stacked diatonic fourths that glide in parallel, by step or by fourth.',
    next(c) {
      const sc = scaleOf(c.key);
      const prev = c.memo.deg ?? 1;
      const deg = c.i === 0 ? 1 : ((prev - 1 + weighted(c.rng, [[1, 0.35], [6, 0.35], [3, 0.2], [4, 0.1 + c.spice * 0.2]] as Array<[number, number]>)) % 7) + 1;
      c.memo.deg = deg;
      const n = c.spice > 0.5 ? 4 : 3;
      const pcs = Array.from({ length: n }, (_, k) => sc[(deg - 1 + 3 * k) % 7]);
      const ch = fromPcs(pcs, `4ths on ${ROMAN_D[deg]}`);
      return { ...ch, root: pcs[0], quality: 'q', name: `Q(${pcs.map((p) => NAMES[p]).join(' ')})` };
    },
  },
  {
    id: 'messiaen',
    name: 'Trasposizione limitata',
    en: 'Modes of limited transposition',
    cite: 'O. Messiaen, Technique de mon langage musical (Leduc, 1944)',
    blurb: 'Chords from mode 2 (octatonic) or mode 3, moving by the interval under which the mode maps onto itself.',
    next(c) {
      const mode = c.spice > 0.65 ? 3 : 2;
      const { set, period } = MESSIAEN[mode];
      const t = c.memo.t ?? 0;
      const nt = c.i === 0 ? 0 : mod12(t + period * (1 + Math.floor(c.rng() * 3)) + (c.rng() < 0.25 ? 1 : 0));
      c.memo.t = nt;
      const modeSet = set.map((p) => mod12(p + c.key.tonic + nt));
      const shapes: Array<Exclude<Quality, 'q' | 'x'>> = mode === 2 ? ['7', 'm7', 'd7', '7b9', 'M', 'm'] : ['A', 'M7', 'M', 'm'];
      const cands: Chord[] = [];
      for (const r of modeSet) for (const q of shapes) {
        const ch = chord(r, q);
        if (ch.pcs.every((p) => modeSet.includes(p))) cands.push(ch);
      }
      const ch = cands.length ? pick(c.rng, cands) : chord(c.key.tonic, 'M');
      return { ...ch, how: `mode ${mode}, T${nt}` };
    },
  },
  {
    id: 'spectral',
    name: 'Spettro armonico',
    en: 'Spectral harmony',
    cite: 'G. Grisey, Partiels (1975); T. Murail, Contemporary Music Review 24(2–3), 2005',
    blurb: 'Chords are partials of one low fundamental, tuned exactly. The next fundamental shares a partial with the last.',
    next(c) {
      const m = c.memo;
      let f0: number = m.f0 ?? midiHz(24 + c.key.tonic);
      if (c.i > 0) {
        const pivots: Array<[number, number]> = [
          [3 / 2, 1],
          [4 / 3, 1],
          [5 / 4, 0.8],
          [6 / 5, 0.6],
          [7 / 4, 0.3 + c.spice],
          [8 / 7, 0.2 + c.spice],
          [9 / 8, 0.4],
        ];
        const r = weighted(c.rng, pivots);
        f0 *= c.rng() < 0.5 ? r : 1 / r;
        while (f0 > 90) f0 /= 2;
        while (f0 < 30) f0 *= 2;
      }
      m.f0 = f0;
      const pool = c.spice < 0.4 ? [4, 5, 6, 8, 10, 12] : c.spice < 0.75 ? [4, 5, 6, 7, 9, 10, 11, 12] : [5, 7, 9, 11, 13, 15, 17, 19];
      const n = 4 + (c.spice > 0.5 ? 1 : 0);
      const parts = [...pool].sort(() => c.rng() - 0.5).slice(0, n).sort((a, b) => a - b);
      const hz = parts.map((k) => f0 * k);
      const pcs = hz.map((f) => mod12(Math.round(69 + 12 * Math.log2(f / 440))));
      const base = fromPcs(pcs);
      return { ...base, root: mod12(Math.round(69 + 12 * Math.log2(f0 / 440))), hz, name: `${f0.toFixed(1)} Hz · ${parts.join(':')}`, how: `partials ${parts.join(' ')}` };
    },
  },
  {
    id: 'partch',
    name: 'Otonale / utonale',
    en: 'Partch hexads',
    cite: 'H. Partch, Genesis of a Music (1949; 2nd ed. Da Capo, 1974)',
    blurb: 'Otonalities (1:3:5:7:9:11 over a root) and utonalities (the same ratios under it) alternate across the tonality diamond.',
    next(c) {
      const m = c.memo;
      const nexus: Array<[number, number]> = [
        [1, 1],
        [3 / 2, 1],
        [4 / 3, 1],
        [5 / 4, 0.7],
        [8 / 5, 0.7],
        [7 / 4, 0.4 + c.spice],
        [8 / 7, 0.4 + c.spice],
        [11 / 8, c.spice],
        [9 / 8, 0.5],
      ];
      const oton = c.i === 0 ? true : !m.oton;
      m.oton = oton;
      const ratio = c.i === 0 ? 1 : weighted(c.rng, nexus);
      const base = midiHz(48 + c.key.tonic) * ratio;
      const ids = c.spice > 0.5 ? [1, 3, 5, 7, 9, 11] : [1, 3, 5, 7];
      const oct = (f: number) => {
        while (f >= base * 2) f /= 2;
        while (f < base) f *= 2;
        return f;
      };
      const hz = ids.map((n) => oct(oton ? base * n : base / n)).sort((a, b) => a - b);
      const pcs = hz.map((f) => mod12(Math.round(69 + 12 * Math.log2(f / 440))));
      const ch = fromPcs(pcs);
      const label = `${oton ? 'O' : 'U'} ${ratio === 1 ? '1/1' : ratioName(ratio)}`;
      return { ...ch, hz, name: label, how: `${oton ? 'otonal' : 'utonal'} ${ids.join(':')}` };
    },
  },
  {
    id: 'sethares',
    name: 'Consonanza sensoriale',
    en: 'Sensory dissonance',
    cite: 'Plomp & Levelt, JASA 38(4), 1965, 548–560; W. Sethares, JASA 94(3), 1993, 1218–1228',
    blurb: 'Chords are ranked by how much their partials beat against each other. Spice sets the target roughness.',
    next(c) {
      const qs: Array<Exclude<Quality, 'q' | 'x'>> = ['M', 'm', 'sus4', 'sus2', '6', 'm7', 'M7', '7', 'add9', 'd'];
      const sc = scaleOf(c.key);
      const cands = sc.flatMap((r) => qs.map((q) => chord(r, q))).filter((ch) => ch.pcs.every((p) => sc.includes(p)));
      const voice = (ch: Chord) => ch.pcs.map((p, i) => midiHz(48 + mod12(p - ch.pcs[0]) + ch.pcs[0] + (i === 0 ? 0 : 0) + (i > 0 && mod12(p - ch.pcs[0]) === 0 ? 12 : 0)));
      const scored = cands.map((ch) => [ch, dissonance(voice(ch))] as const);
      const ds = scored.map(([, d]) => d);
      const lo = Math.min(...ds),
        hi = Math.max(...ds);
      const target = lo + (hi - lo) * (0.1 + c.spice * 0.8);
      const ranked = scored
        .filter(([ch]) => !c.prev || ch.name !== c.prev.name)
        .map(([ch, d]) => {
          const common = c.prev ? ch.pcs.filter((p) => c.prev!.pcs.includes(p)).length : 1;
          return [ch, d, Math.abs(d - target) / (hi - lo + 1e-9) - common * 0.05] as const;
        })
        .sort((a, b) => a[2] - b[2])
        .slice(0, 4);
      const [ch, d] = pick(c.rng, ranked as unknown as Array<readonly [Chord, number, number]>);
      return { ...ch, roman: roman(ch, c.key.tonic), how: `D = ${d.toFixed(2)}` };
    },
  },
];

function ratioName(r: number) {
  for (let d = 1; d <= 16; d++) {
    const n = Math.round(r * d);
    if (Math.abs(n / d - r) < 1e-6) return `${n}/${d}`;
  }
  return r.toFixed(3);
}

export const methodById = (id: string) => METHODS.find((m) => m.id === id) ?? METHODS[0];

// ── voicing ─────────────────────────────────────────────────────────────────

export type Voicing = 'stretta' | 'lata' | 'bassa';
/**
 * Place a chord's pitch classes as MIDI notes so that the voices move as
 * little as possible from `prev` (or sit around middle C if there is none).
 */
export function voice(ch: Chord, prev: number[] | null, style: Voicing = 'stretta', lo = 48, hi = 79): number[] {
  if (ch.hz) return ch.hz.map((f) => 69 + 12 * Math.log2(f / 440));
  const pcs = ch.pcs.slice(0, 5);
  const center = prev?.length ? prev.reduce((a, b) => a + b, 0) / prev.length : 62;
  let best: number[] = [],
    bestCost = Infinity;
  // try each inversion, then shift octaves to hug the previous voicing
  for (let inv = 0; inv < pcs.length; inv++) {
    const ordered = [...pcs.slice(inv), ...pcs.slice(0, inv)];
    for (let base = lo - 12; base <= hi; base++) {
      if (mod12(base) !== ordered[0]) continue;
      const notes = [base];
      for (let k = 1; k < ordered.length; k++) {
        let n = notes[k - 1] + 1;
        while (mod12(n) !== ordered[k]) n++;
        notes.push(n);
      }
      if (style === 'lata' && notes.length >= 3) notes[notes.length - 2] -= 12; // drop 2
      notes.sort((a, b) => a - b);
      if (notes[0] < lo - 12 || notes[notes.length - 1] > hi) continue;
      let cost: number;
      if (prev?.length) {
        cost = 0;
        for (const n of notes) cost += Math.min(...prev.map((p) => Math.abs(p - n)));
      } else cost = Math.abs(notes.reduce((a, b) => a + b, 0) / notes.length - center);
      if (cost < bestCost) {
        bestCost = cost;
        best = notes;
      }
    }
  }
  if (!best.length) best = pcs.map((p) => 60 + p);
  if (style === 'bassa') best = [36 + mod12(ch.root) + (mod12(ch.root) > 7 ? -12 : 0), ...best];
  return best;
}

// ── melody: key-finding (Krumhansl & Kessler 1982; Krumhansl 1990) ────────────

export const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
export const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function pearson(a: number[], b: number[]) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n,
    mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0,
    da = 0,
    db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
/** Krumhansl–Schmuckler: correlate the pitch-class durations with all 24 rotated key profiles. */
export function findKey(notes: Array<{ midi: number; w?: number }>): { key: Key; r: number; ranking: Array<{ key: Key; r: number }> } {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[mod12(Math.round(n.midi))] += n.w ?? 1;
  const ranking: Array<{ key: Key; r: number }> = [];
  for (let t = 0; t < 12; t++)
    for (const minor of [false, true]) {
      const prof = minor ? KK_MINOR : KK_MAJOR;
      const rot = hist.map((_, i) => prof[mod12(i - t)]);
      ranking.push({ key: { tonic: t, minor }, r: pearson(hist, rot) });
    }
  ranking.sort((a, b) => b.r - a.r);
  return { key: ranking[0].key, r: ranking[0].r, ranking };
}
export const keyName = (k: Key) => (k.minor ? NAMES[k.tonic].toLowerCase() + ' minore' : NAMES[k.tonic] + ' maggiore');

// ── melody: first-species counterpoint (Fux 1725), by dynamic programming ─────────

const CONSONANT = new Set([0, 3, 4, 7, 8, 9]); // mod 12: unison/octave, 3rds, 5th, 6ths
const PERFECT = new Set([0, 7]);
export interface CpReport {
  dissonances: number;
  parallels: number;
  hidden: number;
  badLeaps: number;
  crossings: number;
}
/** Check a two-voice first-species passage against Fux's rules. */
export function checkCounterpoint(cf: number[], cp: number[]): CpReport {
  const r: CpReport = { dissonances: 0, parallels: 0, hidden: 0, badLeaps: 0, crossings: 0 };
  for (let i = 0; i < cf.length; i++) {
    const iv = cp[i] - cf[i];
    if (iv < 0) r.crossings++;
    if (!CONSONANT.has(mod12(iv))) r.dissonances++;
    if (i > 0) {
      const pv = cp[i - 1] - cf[i - 1];
      const mCf = cf[i] - cf[i - 1],
        mCp = cp[i] - cp[i - 1];
      const perfectNow = PERFECT.has(mod12(iv));
      if (perfectNow && mod12(pv) === mod12(iv) && mCp !== 0 && mCf !== 0) r.parallels++;
      else if (perfectNow && Math.sign(mCf) === Math.sign(mCp) && mCf !== 0) r.hidden++;
      const leap = Math.abs(mCp);
      if (leap === 6 || leap === 10 || leap === 11 || leap > 12 || (mCp === -8 && true)) r.badLeaps++;
    }
  }
  return r;
}

/**
 * Write a counterpoint above a cantus firmus, first species, note against note.
 *
 * Fux's rules only ever look at two neighbouring notes, so the best line is a
 * shortest path: states are (previous note, current note), and the search
 * costs O(n·k³) for n notes and k candidate pitches. Polynomial time.
 *
 * Hard rules: consonances only; begin on a perfect consonance, end on the
 * octave or unison, approached by step; no parallel or hidden fifths and
 * octaves; no voice crossing; no melodic tritones, sevenths, descending sixths
 * or leaps beyond the octave. Soft costs: prefer steps, contrary motion and
 * imperfect consonances; recover from leaps by step in the other direction;
 * avoid repeated notes and long runs of parallel thirds or sixths.
 */
export function counterpoint(cf: number[], k: Key, rng: Rng = Math.random, scale?: number[]): number[] | null {
  const n = cf.length;
  if (n < 2) return null;
  const sc = scale ?? scaleOf(k).concat(k.minor ? [mod12(k.tonic + 10), mod12(k.tonic + 9)] : []);
  const lowest = Math.min(...cf),
    highest = Math.max(...cf);
  const cands: number[] = [];
  for (let m = lowest; m <= highest + 19; m++) if (sc.includes(mod12(m))) cands.push(m);
  const K = cands.length;
  const okH = (i: number, p: number) => {
    const iv = p - cf[i];
    if (iv < 0 || iv > 19) return false;
    if (!CONSONANT.has(mod12(iv))) return false;
    if (i === 0) return iv === 0 || iv === 7 || iv === 12 || iv === 19;
    if (i === n - 1) return iv === 0 || iv === 12;
    if (iv === 0) return false; // unison only at the ends
    return true;
  };
  const okM = (a: number, b: number) => {
    const d = b - a;
    const ad = Math.abs(d);
    return !(ad === 6 || ad === 10 || ad === 11 || ad > 12 || d === -8 || d === -9);
  };
  const noParallel = (i: number, a: number, b: number) => {
    const pv = a - cf[i - 1],
      iv = b - cf[i];
    const mCf = cf[i] - cf[i - 1],
      mCp = b - a;
    if (!PERFECT.has(mod12(iv))) return true;
    if (mod12(pv) === mod12(iv) && mCp !== 0) return false; // parallel 5ths/8ves
    if (mCf !== 0 && mCp !== 0 && Math.sign(mCf) === Math.sign(mCp)) return false; // hidden
    return true;
  };
  const noise = () => rng() * 0.9;
  // cost[i][a*K+b]: best cost ending with notes (a at i-1, b at i)
  const INF = 1e9;
  let cost = new Float64Array(K * K).fill(INF);
  const back: Int32Array[] = [];
  for (let a = 0; a < K; a++) {
    if (!okH(0, cands[a])) continue;
    for (let b = 0; b < K; b++) {
      if (!okH(1, cands[b]) || !okM(cands[a], cands[b]) || !noParallel(1, cands[a], cands[b])) continue;
      cost[a * K + b] = step(0, -1, a, b) + noise();
    }
  }
  function step(i: number, z: number, a: number, b: number) {
    // cost of moving a (at i) → b (at i+1), given z at i-1 (or -1)
    const pa = cands[a],
      pb = cands[b];
    const d = pb - pa,
      ad = Math.abs(d);
    let c = ad === 0 ? 3 : ad <= 2 ? 0 : ad <= 4 ? 1.2 : ad <= 7 ? 2.6 : 4;
    const mCf = cf[i + 1] - cf[i];
    if (mCf !== 0 && Math.sign(mCf) === Math.sign(d)) c += 0.8;
    if (mCf !== 0 && Math.sign(mCf) === -Math.sign(d)) c -= 0.3;
    const iv = mod12(pb - cf[i + 1]);
    if (PERFECT.has(iv) && i + 1 < n - 1) c += 1.2;
    if (z >= 0) {
      const prevLeap = pa - cands[z];
      if (Math.abs(prevLeap) > 4 && !(Math.sign(prevLeap) === -Math.sign(d) && ad <= 2)) c += 2.5;
      const ivPrev = mod12(pa - cf[i]);
      const ivPrev2 = mod12(cands[z] - cf[i - 1]);
      if ((iv === 3 || iv === 4) && (ivPrev === 3 || ivPrev === 4) && (ivPrev2 === 3 || ivPrev2 === 4)) c += 1.5;
      if ((iv === 8 || iv === 9) && (ivPrev === 8 || ivPrev === 9) && (ivPrev2 === 8 || ivPrev2 === 9)) c += 1.5;
    }
    return c;
  }
  for (let i = 2; i < n; i++) {
    const next = new Float64Array(K * K).fill(INF);
    const bk = new Int32Array(K * K).fill(-1);
    for (let b = 0; b < K; b++) {
      for (let a = 0; a < K; a++) {
        const cab = cost[a * K + b];
        if (cab >= INF) continue;
        for (let c2 = 0; c2 < K; c2++) {
          const pc = cands[c2];
          if (!okH(i, pc) || !okM(cands[b], pc) || !noParallel(i, cands[b], pc)) continue;
          if (i === n - 1 && Math.abs(pc - cands[b]) > 2) continue; // arrive by step
          const v = cab + step(i - 1, a, b, c2) + noise();
          const idx = b * K + c2;
          if (v < next[idx]) {
            next[idx] = v;
            bk[idx] = a;
          }
        }
      }
    }
    back.push(bk);
    cost = next;
  }
  let best = INF,
    bi = -1;
  for (let x = 0; x < K * K; x++)
    if (cost[x] < best) {
      best = cost[x];
      bi = x;
    }
  if (bi < 0) return null;
  const out = new Array<number>(n);
  let b = bi % K,
    a = Math.floor(bi / K);
  out[n - 1] = cands[b];
  out[n - 2] = cands[a];
  for (let i = n - 1; i >= 2; i--) {
    const z = back[i - 2][a * K + b];
    out[i - 2] = cands[z];
    b = a;
    a = z;
  }
  return out;
}

// ── melody: tessitura and expectation (von Hippel & Huron 2000; Huron 2006) ─────

/**
 * A melody as a random walk on scale degrees whose steps are drawn from the
 * pitch-proximity distribution, pulled back toward the middle of the range.
 * von Hippel & Huron showed that this regression to the mean is enough to
 * make skips tend to be followed by reversals; descending steps are slightly
 * favoured (step declination).
 */
export function expectancyMelody(len: number, rng: Rng, opts: { range?: number; center?: number; pull?: number } = {}): number[] {
  const range = opts.range ?? 10,
    center = opts.center ?? 4,
    pull = opts.pull ?? 0.25;
  const out = [center + Math.round((rng() - 0.5) * 4)];
  for (let i = 1; i < len; i++) {
    const cur = out[i - 1];
    const items: Array<[number, number]> = [];
    for (let d = -5; d <= 5; d++) {
      const nx = cur + d;
      if (nx < center - range / 2 || nx > center + range / 2) continue;
      let w = Math.exp(-Math.abs(d) / 1.25); // pitch proximity
      if (d === 0) w *= 0.45;
      if (d === -1 || d === -2) w *= 1.25; // step declination
      w *= Math.exp(-pull * (nx - center) ** 2); // regression toward the tessitura's mean
      items.push([nx, w]);
    }
    out.push(weighted(rng, items));
  }
  return out;
}

// ── melody: 1/f (Voss & Clarke 1978) ───────────────────────────────────────

/**
 * Voss's dice algorithm: `dice` random numbers are summed; die k is re-rolled
 * whenever bit k of a counter changes. Slow dice hold for long, fast dice
 * flicker, and the sum has a roughly 1/f spectrum, which Voss & Clarke found
 * in the pitch fluctuations of music across styles.
 */
export function vossMelody(len: number, rng: Rng, dice = 4, span = 12): number[] {
  const vals = Array.from({ length: dice }, () => rng());
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < len; i++) {
    const changed = i ^ prev;
    for (let k = 0; k < dice; k++) if (i === 0 || (changed >> k) & 1) vals[k] = rng();
    prev = i;
    const s = vals.reduce((a, b) => a + b, 0) / dice;
    out.push(Math.round(s * span) - Math.round(span / 2) + 4);
  }
  return out;
}

// ── melody: twelve-tone rows (Schoenberg) ─────────────────────────────────────

export type RowForm = 'P' | 'R' | 'I' | 'RI';
/** A random row; with `allInterval`, one whose eleven successive intervals are all different (like Berg’s Lyric Suite row). */
export function toneRow(rng: Rng, allInterval = false): number[] {
  if (!allInterval) return [...Array(12).keys()].sort(() => rng() - 0.5);
  const row = [0],
    used = new Set([0]),
    ivs = new Set<number>();
  const go = (): boolean => {
    if (row.length === 12) return true;
    const order = [...Array(11).keys()].map((i) => i + 1).sort(() => rng() - 0.5);
    for (const iv of order) {
      const nx = mod12(row[row.length - 1] + iv);
      if (used.has(nx) || ivs.has(iv)) continue;
      row.push(nx);
      used.add(nx);
      ivs.add(iv);
      if (go()) return true;
      row.pop();
      used.delete(nx);
      ivs.delete(iv);
    }
    return false;
  };
  go();
  return row;
}
export function rowForm(row: number[], form: RowForm): number[] {
  const inv = row.map((p) => mod12(2 * row[0] - p));
  if (form === 'P') return row;
  if (form === 'R') return [...row].reverse();
  if (form === 'I') return inv;
  return [...inv].reverse();
}

// ── melody: the Continuator (Pachet 2003) ─────────────────────────────────────

/**
 * A variable-order Markov model of what you play. To continue a phrase it
 * looks for the longest suffix of the phrase it has heard before, and picks
 * one of the notes that followed it; if none, it backs off to shorter
 * contexts, down to the bare note frequencies.
 */
export class Continuator {
  maxOrder: number;
  table = new Map<string, number[]>();
  alphabet: number[] = [];
  constructor(maxOrder = 4) {
    this.maxOrder = maxOrder;
  }
  learn(seq: number[]) {
    for (let i = 0; i < seq.length; i++) {
      this.alphabet.push(seq[i]);
      for (let o = 1; o <= this.maxOrder && i - o >= 0; o++) {
        const ctx = seq.slice(i - o, i).join(',');
        const list = this.table.get(ctx) ?? [];
        list.push(seq[i]);
        this.table.set(ctx, list);
      }
    }
    if (this.alphabet.length > 2000) this.alphabet.splice(0, this.alphabet.length - 2000);
  }
  /** Learn one note as it is played, in the context of the notes just before it. */
  observe(history: number[], note: number) {
    this.alphabet.push(note);
    for (let o = 1; o <= this.maxOrder && o <= history.length; o++) {
      const ctx = history.slice(history.length - o).join(',');
      const list = this.table.get(ctx) ?? [];
      list.push(note);
      this.table.set(ctx, list);
    }
    if (this.alphabet.length > 2000) this.alphabet.splice(0, this.alphabet.length - 2000);
  }
  get size() {
    return this.alphabet.length;
  }
  continue(prefix: number[], len: number, rng: Rng): { notes: number[]; orders: number[] } {
    const seq = [...prefix];
    const orders: number[] = [];
    for (let i = 0; i < len; i++) {
      let next: number | null = null,
        used = 0;
      for (let o = Math.min(this.maxOrder, seq.length); o >= 1; o--) {
        const list = this.table.get(seq.slice(seq.length - o).join(','));
        if (list?.length) {
          next = pick(rng, list);
          used = o;
          break;
        }
      }
      if (next === null) next = this.alphabet.length ? pick(rng, this.alphabet) : 60;
      seq.push(next);
      orders.push(used);
    }
    return { notes: seq.slice(prefix.length), orders };
  }
}

/** Levy's mirror for melodies: reflect MIDI notes through the axis between tonic and dominant (C4 ↔ G4). */
export const negateMidi = (m: number, tonic: number) => {
  const axis = 60 + mod12(tonic) + 3.5;
  return Math.round(2 * axis - m);
};
