/**
 * Melencolia: harmony chosen by what the research says sounds sad.
 *
 * Every weight below stands for a finding:
 *   minor mode .......................... Hevner 1935; Parncutt 2014; Eerola, Friberg & Bresin 2013
 *   small melodic motion ................ Huron 2008; Huron & Davis 2012
 *   the minor third ..................... Curtis & Bharucha 2010
 *   the minor second (the cry) .......... Zeloni & Pavani 2022
 *   a bass that falls by step ........... Rosand 1979 (the lament)
 *   appoggiaturas ....................... Sloboda 1991 (the passages that bring tears)
 *   modal mixture, the subdominant,
 *   common tones ........................ Capuzzo 2004
 *
 * Five ways to choose the chords: the saddest path (dynamic programming over a
 * chord graph weighted by those findings), the diatonic and chromatic laments,
 * modal mixture, and Dürer's magic square, whose every row, column and
 * diagonal sums to 34, so every four-chord line carries the same total sadness.
 *
 * Pure code, no DOM: the audio thread runs it, and scripts/check-melancholy.mts tests it.
 */

export type Rng = () => number;
export const seeded = (seed: number): Rng => {
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

type Q = 'm' | 'M' | 'd' | 'm7' | 'M7' | 'madd9' | 'sus2' | 'm6' | '7' | 'h7';
const SHAPE: Record<Q, number[]> = {
  m: [0, 3, 7],
  M: [0, 4, 7],
  d: [0, 3, 6],
  m7: [0, 3, 7, 10],
  M7: [0, 4, 7, 11],
  madd9: [0, 3, 7, 14],
  sus2: [0, 2, 7],
  m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  h7: [0, 3, 6, 10],
};
const SUFFIX: Record<Q, string> = { m: 'm', M: '', d: '°', m7: 'm7', M7: 'maj7', madd9: 'm(add9)', sus2: 'sus2', m6: 'm6', '7': '7', h7: 'ø7' };

export interface Degree {
  /** semitones above the (minor) tonic */
  r: number;
  q: Q;
  roman: string;
  /** borrowed from another mode */
  mix?: boolean;
  sub?: boolean;
}
/** The vocabulary, relative to a minor tonic. */
export const VOCAB: Degree[] = [
  { r: 0, q: 'm', roman: 'i' },
  { r: 0, q: 'm7', roman: 'i7' },
  { r: 0, q: 'madd9', roman: 'i(add9)' },
  { r: 2, q: 'd', roman: 'ii°' },
  { r: 2, q: 'h7', roman: 'iiø7' },
  { r: 3, q: 'M', roman: 'III' },
  { r: 3, q: 'M7', roman: 'IIImaj7' },
  { r: 5, q: 'm', roman: 'iv', sub: true },
  { r: 5, q: 'm7', roman: 'iv7', sub: true },
  { r: 5, q: 'm6', roman: 'iv6', sub: true },
  { r: 5, q: 'M', roman: 'IV', mix: true, sub: true },
  { r: 7, q: 'm', roman: 'v' },
  { r: 7, q: 'M', roman: 'V' },
  { r: 7, q: '7', roman: 'V7' },
  { r: 8, q: 'M', roman: 'VI', sub: true },
  { r: 8, q: 'M7', roman: 'VImaj7', sub: true },
  { r: 10, q: 'M', roman: 'VII' },
  { r: 10, q: 'sus2', roman: 'VIIsus2' },
  { r: 1, q: 'M', roman: '♭II', mix: true },
  { r: 11, q: 'd', roman: 'vii°' },
];

export interface SadChord {
  root: number;
  pcs: number[];
  bass: number;
  q: Q;
  name: string;
  roman: string;
  /** MIDI notes: bass first, then the upper voices */
  notes: number[];
  /** an upper neighbour to lean on before the top voice resolves down (Sloboda's appoggiatura) */
  app: number | null;
  why: string[];
  /** Dürer cell 0..15, when the magic square chose it */
  cell?: number;
  sadness: number;
}

/** How sad a chord is on its own, relative to the minor tonic. */
export function intrinsic(d: Degree): number {
  const s = SHAPE[d.q];
  let v = 0;
  if (s.includes(3) && !s.includes(4)) v += 1; // minor third over the root
  // diminished chords read as tension more than sorrow: keep them for colour, not as a goal
  if (d.q === 'd') v -= 0.45;
  if (d.q === 'h7') v += 0.1;
  if (d.q === 'sus2') v += 0.3;
  if (d.q === 'm7' || d.q === 'm6' || d.q === 'madd9') v += 0.2;
  if (d.q === 'M7') v += 0.3; // bittersweet
  if (d.mix) v += 0.5; // borrowed colour
  if (d.sub) v += 0.3; // the subdominant side
  if (d.r === 0) v += 0.3;
  if (d.q === 'M' && (d.r === 7 || d.r === 3)) v -= 0.2; // bright dominants and mediants
  return v;
}

const circ = (a: number, b: number) => {
  const d = Math.abs(mod12(a) - mod12(b));
  return Math.min(d, 12 - d);
};

/** Place the upper voices near the previous ones (smallest total motion). */
export function voiceLead(pcs: number[], prev: number[] | null, center = 60): number[] {
  const upper = [...new Set(pcs.map(mod12))].slice(0, 4);
  const cands: number[][] = [];
  for (let inv = 0; inv < upper.length; inv++) {
    const order = [...upper.slice(inv), ...upper.slice(0, inv)];
    for (let base = center - 12; base <= center + 6; base++) {
      if (mod12(base) !== order[0]) continue;
      const notes = [base];
      for (let k = 1; k < order.length; k++) {
        let n = notes[k - 1] + 1;
        while (mod12(n) !== order[k]) n++;
        notes.push(n);
      }
      cands.push(notes);
    }
  }
  const cost = (ns: number[]) =>
    prev?.length ? ns.reduce((s, n) => s + Math.min(...prev.map((p) => Math.abs(p - n))), 0) : Math.abs(ns.reduce((a, b) => a + b, 0) / ns.length - center);
  return cands.sort((a, b) => cost(a) - cost(b))[0] ?? upper.map((p) => center + p);
}

export interface Transition {
  score: number;
  why: string[];
  motion: number;
}
/** How sad the move from one chord to the next is, with the reasons. */
export function transition(x: { d: Degree; bass: number; upper: number[] } | null, y: { d: Degree; bass: number; upper: number[] }): Transition {
  const why: string[] = [];
  let s = intrinsic(y.d);
  if (SHAPE[y.d.q].includes(3) && !SHAPE[y.d.q].includes(4)) why.push('minor third over the root');
  if (y.d.mix) why.push(`borrowed chord (${y.d.roman})`);
  if (!x) return { score: s, why, motion: 0 };
  if (x.d === y.d) return { score: -5, why: ['repeat'], motion: 0 };
  if (x.d.r === y.d.r) s -= 0.6; // a new colour on the same root is not a new chord
  // small voice leading: sad melodies move by small intervals
  let motion = 0,
    semis = 0,
    common = 0;
  for (const n of y.upper) {
    const m = Math.min(...x.upper.map((p) => Math.abs(p - n)));
    motion += m;
    if (m === 1) semis++;
    if (m === 0) common++;
  }
  s += 1.2 / (1 + motion / 3);
  if (semis) {
    s += 0.35 * semis;
    why.push(`${semis} voice${semis > 1 ? 's' : ''} sigh a semitone`);
  }
  if (common) {
    s += 0.25 * common;
    why.push(`${common} common tone${common > 1 ? 's' : ''}`);
  }
  const bassStep = mod12(x.bass - y.bass);
  if (bassStep === 1 || bassStep === 2) {
    s += bassStep === 1 ? 1.2 : 0.8;
    why.push(bassStep === 1 ? 'bass falls a semitone (chromatic lament)' : 'bass falls a step (lament)');
  }
  if (circ(x.d.r, y.d.r) === 3) {
    s += 0.3;
    why.push('roots a minor third apart');
  }
  if (y.d.sub) {
    s += 0.2;
    why.push('toward the subdominant');
  }
  return { score: s, why, motion };
}

/** Dürer, Melencolia I (1514): rows, columns, diagonals, quadrants and the centre all sum to 34. */
export const DURER = [16, 3, 2, 13, 5, 10, 11, 8, 9, 6, 7, 12, 4, 15, 14, 1];
export const DURER_LINES: number[][] = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [8, 9, 10, 11],
  [12, 13, 14, 15],
  [0, 4, 8, 12],
  [1, 5, 9, 13],
  [2, 6, 10, 14],
  [3, 7, 11, 15],
  [0, 5, 10, 15],
  [3, 6, 9, 12],
];

export const SAD_METHODS = [
  {
    id: 'path',
    n: 'Il cammino più triste',
    en: 'The saddest path',
    cite: 'dynamic programming over a chord graph weighted by Huron 2008, Huron & Davis 2012, Curtis & Bharucha 2010, Zeloni & Pavani 2022, Rosand 1979, Capuzzo 2004',
  },
  { id: 'lament', n: 'Lamento', en: 'Descending tetrachord', cite: 'E. Rosand, “The Descending Tetrachord: An Emblem of Lament”, The Musical Quarterly 65(3), 1979' },
  { id: 'chromatic', n: 'Lamento cromatico', en: 'Chromatic lament', cite: 'Rosand 1979: the tetrachord filled in by semitones' },
  { id: 'mixture', n: 'Miscela', en: 'Modal mixture', cite: 'G. Capuzzo, “Neo-Riemannian Theory and the Analysis of Pop-Rock Music”, Music Theory Spectrum 26(2), 2004' },
  { id: 'durer', n: 'Quadrato di Dürer', en: 'Dürer’s magic square', cite: 'A. Dürer, Melencolia I (1514): every line of the square sums to 34' },
] as const;
export type SadMethod = (typeof SAD_METHODS)[number]['id'];

const byRoman = (r: string) => VOCAB.find((d) => d.roman === r)!;
/** Chord sequences with a fixed bass, as (roman, bass semitones above tonic) pairs. */
const LAMENTS: Record<'lament' | 'chromatic', Array<Array<[string, number]>>> = {
  lament: [
    [
      ['i', 0],
      ['v', -2],
      ['iv', -4],
      ['V', -5],
    ],
    [
      ['i', 0],
      ['VII', -2],
      ['VI', -4],
      ['V', -5],
    ],
    [
      ['i(add9)', 0],
      ['v', -2],
      ['iv6', -4],
      ['V7', -5],
    ],
  ],
  chromatic: [
    [
      ['i', 0],
      ['V', -1],
      ['i7', -2],
      ['IV', -3],
      ['iv', -4],
      ['V', -5],
    ],
    [
      ['i', 0],
      ['V', -1],
      ['III', -2],
      ['IV', -3],
      ['iv6', -4],
      ['V7', -5],
    ],
  ],
};
/** Mixture: the minor subdominant inside a major frame, and aeolian cycles in minor (Capuzzo 2004). */
const MIXTURES: string[][] = [
  ['I*', 'III*', 'IV', 'iv'],
  ['i', 'VI', 'iv', 'i'],
  ['i', 'VI', 'III', 'VII'],
  ['VImaj7', 'iv7', 'i(add9)', 'V'],
  ['I*', 'iv', 'I*', 'iv6'],
];
/** Major chords on the tonic and on the major third, for the major-frame mixture phrase. */
const EXTRA: Record<string, Degree> = {
  'I*': { r: 0, q: 'M', roman: 'I', mix: true },
  'III*': { r: 4, q: 'M', roman: 'III♮', mix: true },
};

export class Melancholy {
  tonic = 9;
  method: SadMethod = 'path';
  spice = 0.3;
  /** chance of an appoggiatura on each chord */
  tears = 0.5;
  /** octave offset of the voicing */
  register = 0;
  rng: Rng;
  private queue: Array<{ d: Degree; bass: number; cell?: number }> = [];
  private prev: { d: Degree; bass: number; upper: number[] } | null = null;
  private durerLine = 0;
  private prevBass: number | null = null;
  /** chords heard lately: the path avoids them, so the sadness keeps moving */
  private recent: Degree[] = [];
  count = 0;

  constructor(seed = 1) {
    this.rng = seeded(seed);
  }

  reset() {
    this.queue = [];
    this.prev = null;
    this.prevBass = null;
    this.recent = [];
    this.durerLine = 0;
    this.count = 0;
  }

  /** The 16 chords of the key, least sad first: Dürer's numbers index this list. */
  ranked(): Degree[] {
    return [...VOCAB.filter((d) => d.roman !== 'vii°' && d.roman !== '♭II' && d.roman !== 'IIImaj7' && d.roman !== 'V7')]
      .sort((a, b) => intrinsic(a) - intrinsic(b) || a.r - b.r)
      .slice(0, 16);
  }

  /** Plan the saddest phrase of `len` chords from i back to i: a longest path, by dynamic programming. */
  private saddest(len: number) {
    const V = VOCAB;
    const bassOf = (d: Degree) => d.r;
    const node = (d: Degree, prevUpper: number[] | null) => ({ d, bass: bassOf(d), upper: voiceLead(SHAPE[d.q].map((i) => d.r + i), prevUpper) });
    const start = this.prev ?? node(V[0], null);
    // layers of (score, back-pointer, state)
    type Cell = { score: number; back: number; st: { d: Degree; bass: number; upper: number[] } };
    const stale = (d: Degree) => (this.recent.includes(d) ? 0.9 : 0);
    let layer: Cell[] = V.map((d) => {
      const st = node(d, start.upper);
      return { score: transition(start, st).score - stale(d) + this.rng() * this.spice * 2, back: -1, st };
    });
    const layers = [layer];
    for (let k = 1; k < len; k++) {
      const next: Cell[] = V.map((d) => {
        let best = -Infinity,
          bi = 0,
          bst: Cell['st'] | null = null;
        layer.forEach((c, i) => {
          const st = node(d, c.st.upper);
          let v = c.score + transition(c.st, st).score - stale(d) + this.rng() * this.spice * 2;
          // within the phrase, no chord twice
          for (let j = k - 1, b = i; j >= 0 && b >= 0; j--) {
            if (layers[j][b].st.d === d) v -= 3;
            b = layers[j][b].back;
          }
          if (k === len - 1 && d.roman !== 'i' && d.roman !== 'i(add9)' && d.roman !== 'V') v -= 4; // close on the tonic or a half cadence
          if (v > best) {
            best = v;
            bi = i;
            bst = st;
          }
        });
        return { score: best, back: bi, st: bst! };
      });
      layers.push(next);
      layer = next;
    }
    let bi = layer.reduce((b, c, i) => (c.score > layer[b].score ? i : b), 0);
    const path: Degree[] = [];
    for (let k = layers.length - 1; k >= 0; k--) {
      path.unshift(layers[k][bi].st.d);
      bi = layers[k][bi].back;
      if (bi < 0) break;
    }
    return path.map((d) => ({ d, bass: d.r }));
  }

  private refill() {
    const r = this.rng;
    switch (this.method) {
      case 'lament':
      case 'chromatic': {
        const set = LAMENTS[this.method];
        const seq = set[Math.floor(r() * set.length)];
        this.queue = seq.map(([roman, bass]) => ({ d: byRoman(roman), bass }));
        break;
      }
      case 'mixture': {
        const seq = MIXTURES[Math.floor(r() * MIXTURES.length)];
        this.queue = seq.map((roman) => {
          const d = EXTRA[roman] ?? byRoman(roman);
          return { d, bass: d.r };
        });
        break;
      }
      case 'durer': {
        const pool = this.ranked();
        const line = DURER_LINES[this.durerLine++ % DURER_LINES.length];
        this.queue = line.map((cell) => {
          const d = pool[DURER[cell] - 1];
          return { d, bass: d.r, cell };
        });
        break;
      }
      default:
        this.queue = this.saddest(4);
    }
  }

  next(): SadChord {
    if (!this.queue.length) this.refill();
    const { d, bass, cell } = this.queue.shift()!;
    const t = this.tonic;
    const center = 57 + this.register * 12;
    const pcs = SHAPE[d.q].map((i) => mod12(t + d.r + i));
    const upper = voiceLead(
      SHAPE[d.q].map((i) => t + d.r + i),
      this.prev?.upper ?? null,
      center,
    );
    // the bass: low, and moving to the nearest octave of its note, so a lament keeps falling
    const lo = 31 + this.register * 12,
      hi = 50 + this.register * 12;
    const pc = mod12(t + bass);
    let b: number;
    if (this.prevBass === null) {
      b = 36 + this.register * 12 + pc;
      if (b > 45 + this.register * 12) b -= 12;
    } else {
      const down = mod12(this.prevBass - pc);
      b = down <= 6 ? this.prevBass - down : this.prevBass + (12 - down);
      if (b < lo) b += 12;
      if (b > hi) b -= 12;
    }
    this.prevBass = b;
    const cur = { d, bass: bass, upper };
    this.recent.push(d);
    if (this.recent.length > 6) this.recent.shift();
    const tr = transition(this.prev, cur);
    this.prev = cur;
    this.count++;
    // an appoggiatura: the top voice leans on the note above, then falls to the chord tone
    let app: number | null = null;
    if (this.rng() < this.tears) {
      const top = upper[upper.length - 1];
      const scale = [0, 2, 3, 5, 7, 8, 10, 11].map((i) => mod12(t + i));
      app = top + 1;
      for (let k = 1; k <= 2; k++)
        if (scale.includes(mod12(top + k))) {
          app = top + k;
          break;
        }
    }
    const why = [...tr.why];
    if (app !== null) why.push('an appoggiatura on top (tears)');
    if (cell !== undefined) why.unshift(`Dürer ${DURER[cell]}`);
    const root = mod12(t + d.r);
    return {
      root,
      pcs,
      bass: mod12(t + bass),
      q: d.q,
      name: NAMES[root] + SUFFIX[d.q] + (mod12(t + bass) !== root ? `/${NAMES[mod12(t + bass)]}` : ''),
      roman: d.roman,
      notes: [b, ...upper],
      app,
      why,
      cell,
      sadness: tr.score,
    };
  }
}

// ── the sadness index ─────────────────────────────────────────────────────

export interface Cue {
  id: string;
  n: string;
  /** 0..1: how far this cue is toward the sad end */
  v: number;
  w: number;
  cite: string;
}
/**
 * A transparent linear model of the cues listeners hear as sad. The weights
 * are ours; their order follows Eerola, Friberg & Bresin (2013), who found
 * mode and tempo contribute most to perceived emotion.
 */
export function sadnessIndex(x: { minorShare: number; bpm: number; register: number; darkness: number; motion: number; level: number; attack: number; bend: number }) {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const cues: Cue[] = [
    { id: 'mode', n: 'modo minore', v: clamp(x.minorShare), w: 0.28, cite: 'Hevner 1935; Parncutt 2014; Eerola et al. 2013' },
    { id: 'tempo', n: 'tempo lento', v: clamp((120 - x.bpm) / 70), w: 0.24, cite: 'Post & Huron 2009; Eerola et al. 2013' },
    { id: 'register', n: 'registro basso', v: clamp(0.5 - x.register * 0.35), w: 0.12, cite: 'Huron 2008' },
    { id: 'timbre', n: 'timbro scuro', v: clamp(x.darkness), w: 0.1, cite: 'Huron, Anderson & Shanahan 2014' },
    { id: 'motion', n: 'intervalli piccoli', v: clamp(1 - x.motion / 8), w: 0.1, cite: 'Huron & Davis 2012; Curtis & Bharucha 2010' },
    { id: 'level', n: 'dinamica piano', v: clamp(1 - x.level * 1.4), w: 0.06, cite: 'Turner & Huron 2008; Juslin & Laukka 2003' },
    { id: 'attack', n: 'attacchi lenti', v: clamp(x.attack), w: 0.05, cite: 'Juslin & Laukka 2003' },
    { id: 'bend', n: 'intonazione piegata', v: clamp(x.bend), w: 0.05, cite: 'Huron, Anderson & Shanahan 2014' },
  ];
  const total = cues.reduce((s, c) => s + c.v * c.w, 0);
  return { cues, total };
}

/** Name the interval between two sung pitches, and flag the ones sad speech is made of. */
export function sadInterval(f1: number, f2: number) {
  const st = Math.round(12 * Math.log2(f2 / f1));
  const a = Math.abs(st) % 12;
  const names = ['unisono', 'seconda minore', 'seconda maggiore', 'terza minore', 'terza maggiore', 'quarta', 'tritono', 'quinta', 'sesta minore', 'sesta maggiore', 'settima minore', 'settima maggiore'];
  return { st, name: names[a], sad: a === 1 || a === 3 };
}
