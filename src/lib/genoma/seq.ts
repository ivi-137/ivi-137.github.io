/**
 * Operatori's sequencer, after the Elektron Digitone II: 16 tracks of up to
 * 128 steps, each with its own length and speed; note trigs (up to four notes)
 * and lock trigs; parameter locks; micro timing in 1/384ths of a bar; trig
 * conditions (chance, FILL, PRE, NEI, 1ST, A:B); retrigs with a velocity
 * curve; slides; swing; an arpeggiator and a Euclidean generator per track;
 * 128 patterns in 8 banks, chained, or strung together in song mode.
 *
 * The data (Pattern, Track, Trig) is plain JSON, edited by the panel and
 * copied to the audio thread; the Sequencer class runs there, sample by sample.
 */
import { Rng } from './fx';
import { TIDX, defaultSound } from './params';

export const TRACKS = 16;
export const STEPS = 128;
export const PAGE = 16;
export const BANKS = 8;
export const PATTERNS = BANKS * 16;
export const patName = (i: number) => `${'ABCDEFGH'[Math.floor(i / 16)]}${String((i % 16) + 1).padStart(2, '0')}`;

/** Track speed, as a multiple of sixteenth notes. */
export const SCALES = [
  { n: '1/8×', m: 0.125 },
  { n: '1/4×', m: 0.25 },
  { n: '1/2×', m: 0.5 },
  { n: '3/4×', m: 0.75 },
  { n: '1×', m: 1 },
  { n: '3/2×', m: 1.5 },
  { n: '2×', m: 2 },
];
export const SCALE_1X = 4;
/** Note lengths in steps; −1 is infinite (until the track's next note). */
export const NOTE_LENS = [0.125, 0.1875, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, -1];
export const lenName = (l: number) =>
  l < 0 ? '∞' : l === 0.125 ? '⅛' : l === 0.1875 ? '3/16' : l === 0.25 ? '¼' : l === 0.375 ? '⅜' : l === 0.5 ? '½' : l === 0.75 ? '¾' : String(l);

export const PROBS = [1, 3, 4, 6, 9, 13, 19, 25, 33, 41, 50, 59, 67, 75, 81, 87, 91, 94, 96, 98, 99];
export type CondKind = 'none' | 'prob' | 'fill' | 'nfill' | 'pre' | 'npre' | 'nei' | 'nnei' | 'first' | 'nfirst' | 'ab';
export interface Cond {
  label: string;
  kind: CondKind;
  p?: number;
  a?: number;
  b?: number;
  hint: string;
}
export const CONDS: Cond[] = [
  { label: '—', kind: 'none', hint: 'always' },
  ...PROBS.map((p) => ({ label: `${p}%`, kind: 'prob' as const, p, hint: `plays ${p}% of the time` })),
  { label: 'FILL', kind: 'fill', hint: 'only while FILL is held' },
  { label: '!FILL', kind: 'nfill', hint: 'only while FILL is not held' },
  { label: 'PRE', kind: 'pre', hint: 'if the last condition on this track was true' },
  { label: '!PRE', kind: 'npre', hint: 'if the last condition on this track was false' },
  { label: 'NEI', kind: 'nei', hint: 'if the last condition on the track before was true' },
  { label: '!NEI', kind: 'nnei', hint: 'if the last condition on the track before was false' },
  { label: '1ST', kind: 'first', hint: 'only the first time round' },
  { label: '!1ST', kind: 'nfirst', hint: 'every time but the first' },
  ...[2, 3, 4, 5, 6, 7, 8].flatMap((b) =>
    Array.from({ length: b }, (_, i) => ({ label: `${i + 1}:${b}`, kind: 'ab' as const, a: i + 1, b, hint: `on pass ${i + 1} of every ${b}` })),
  ),
];

/** Retrig rates as fractions of a whole note (1/16 is once a step), and their length in steps. */
export const RETRIG_RATES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80].map((d) => ({ n: `1/${d}`, steps: 16 / d }));
export const ARP_MODES = ['off', 'vero', 'su', 'giù', 'ciclo', 'mescola', 'caso'];
export const ARP_SPEEDS = [
  { n: '1/32', s: 0.5 },
  { n: '1/16T', s: 2 / 3 },
  { n: '1/16', s: 1 },
  { n: '1/8T', s: 4 / 3 },
  { n: '1/8', s: 2 },
  { n: '1/4', s: 4 },
];
export const EU_OPS = ['OR', 'AND', 'XOR', 'SUB'];
/** Micro timing: ±23 of the 24 parts of a step (the Elektron's ±23/384 of a bar). */
export const MICRO = 23;

export interface Trig {
  /** 1 note trig, 2 lock trig (no note, locks only) */
  k: 1 | 2;
  /** up to four MIDI notes */
  n: number[];
  v: number;
  /** length in steps, −1 infinite */
  l: number;
  /** micro timing, 24ths of a step */
  mt: number;
  /** condition, an index into CONDS */
  c: number;
  /** retrig rate index, −1 off */
  rt: number;
  /** retrig length in steps */
  rl: number;
  /** retrig velocity curve, −1..1 */
  rv: number;
  sl: 0 | 1;
  /** parameter locks: track-parameter index → value */
  lk: Record<number, number> | null;
}
export interface Arp {
  m: number;
  sp: number;
  r: number;
  nl: number;
  len: number;
  mask: number;
  ofs: number[];
}
export interface Eu {
  on: 0 | 1;
  p1: number;
  p2: number;
  r1: number;
  r2: number;
  tr: number;
  op: number;
}
export interface Track {
  len: number;
  sc: number;
  steps: (Trig | null)[];
  arp: Arp;
  eu: Eu;
  snd: number[];
}
export interface Pattern {
  name: string;
  /** 0: one length and speed for the pattern; 1: per track */
  mode: 0 | 1;
  len: number;
  sc: number;
  /** master length in sixteenths (per-track mode); 0 is infinite */
  ml: number;
  tracks: Track[];
}
export interface SongRow {
  p: number;
  r: number;
}
export interface Project {
  v: 1;
  pats: (Pattern | null)[];
  cur: number;
  song: SongRow[];
  root: number;
  scale: number;
}

export const newTrig = (note = 60, v = 100): Trig => ({ k: 1, n: [note], v, l: 1, mt: 0, c: 0, rt: -1, rl: 1, rv: 0, sl: 0, lk: null });
export const newArp = (): Arp => ({ m: 0, sp: 2, r: 1, nl: 1, len: 16, mask: 0xffff, ofs: new Array(16).fill(0) });
export const newEu = (): Eu => ({ on: 0, p1: 4, p2: 0, r1: 0, r2: 0, tr: 0, op: 0 });
export const newTrack = (machine = 0): Track => ({
  len: 16,
  sc: SCALE_1X,
  steps: new Array(STEPS).fill(null),
  arp: newArp(),
  eu: newEu(),
  snd: defaultSound(machine),
});
export function newPattern(kitFrom?: Pattern): Pattern {
  return {
    name: '',
    mode: 0,
    len: 16,
    sc: SCALE_1X,
    ml: 16,
    tracks: Array.from({ length: TRACKS }, (_, k) => {
      const t = newTrack(k < 4 ? 1 : 0);
      if (kitFrom) t.snd = [...kitFrom.tracks[k].snd];
      return t;
    }),
  };
}

/** Evenly spread p pulses over n steps, rotated by r (Bresenham's line, which gives Bjorklund's rhythms up to rotation). */
export function euclid(p: number, n: number, r = 0): boolean[] {
  const out: boolean[] = new Array(n).fill(false);
  if (n <= 0) return out;
  p = Math.max(0, Math.min(n, Math.round(p)));
  for (let i = 0; i < n; i++) out[(((i + r) % n) + n) % n] = (i * p) % n < p;
  return out;
}
/** The Euclidean mode's rhythm for a track of n steps: two generators, combined, then rotated. */
export function euclidTrack(e: Eu, n: number): boolean[] {
  const a = euclid(e.p1, n, e.r1),
    b = euclid(e.p2, n, e.r2);
  const c = a.map((x, i) => (e.op === 0 ? x || b[i] : e.op === 1 ? x && b[i] : e.op === 2 ? x !== b[i] : x && !b[i]));
  return c.map((_, i) => c[(((i - e.tr) % n) + n) % n]);
}
export const trackLen = (pat: Pattern, k: number) => Math.max(1, Math.min(STEPS, pat.mode === 0 ? pat.len : pat.tracks[k].len));
export const trackScale = (pat: Pattern, k: number) => SCALES[pat.mode === 0 ? pat.sc : pat.tracks[k].sc]?.m ?? 1;
/** When the pattern is over, in sixteenths: a chain or the song moves on then. */
export function masterLen(pat: Pattern) {
  if (pat.mode === 0) return pat.len / (SCALES[pat.sc]?.m ?? 1);
  if (pat.ml > 0) return pat.ml;
  let m = 16;
  for (let k = 0; k < TRACKS; k++) m = Math.max(m, trackLen(pat, k) / trackScale(pat, k));
  return m;
}

/** Where the sequencer sends what it plays. */
export interface SeqSink {
  /** gate in samples, −1 until the track's next note; first: a trig (not a retrig or an arp step after the first) */
  note(k: number, notes: number[], vel: number, gate: number, locks: Record<number, number> | null, slide: boolean, first: boolean): void;
  lock(k: number, locks: Record<number, number>): void;
}

const TRIG = 0,
  RETRIG = 1;
interface Ev {
  t: number;
  j: number;
  kind: number;
  v: number;
  trig: Trig;
  gate: number;
}
interface TrackRun {
  origin: number;
  j: number;
  rel: number;
  q: Ev[];
  pre: boolean;
  arpOn: boolean;
  arpSeq: number[];
  arpNext: number;
  arpEnd: number;
  arpA: number;
  arpI: number;
  arpVel: number;
  arpLk: Record<number, number> | null;
  firedNext: boolean;
  loopBase: number;
}

export class Sequencer {
  pats: (Pattern | null)[] = new Array(PATTERNS).fill(null);
  cur = 0;
  queued = -1;
  song: SongRow[] = [];
  songMode = false;
  songRow = 0;
  private songRep = 0;
  sr: number;
  sink: SeqSink;
  rng = new Rng(19);
  playing = false;
  bpm = 120;
  swing = 50;
  fill = false;
  mutes = new Uint8Array(TRACKS);
  base = 0;
  private cycleStart = 0;
  cycles = 0;
  private lastBase = -1;
  /** set on the frame a sixteenth (or a bar) begins; cleared by the next tick */
  pulse16 = false;
  pulseBar = false;
  /** the pattern index the sequencer moved to, for the panel (−1 none) */
  changed = -1;
  tr: TrackRun[];

  constructor(sr: number, sink: SeqSink) {
    this.sr = sr;
    this.sink = sink;
    this.tr = Array.from({ length: TRACKS }, () => ({
      origin: 0,
      j: -1,
      rel: 0,
      q: [],
      pre: false,
      arpOn: false,
      arpSeq: [],
      arpNext: 0,
      arpEnd: 0,
      arpA: 0,
      arpI: 0,
      arpVel: 100,
      arpLk: null,
      firedNext: false,
      loopBase: 0,
    }));
  }
  get pat(): Pattern {
    return (this.pats[this.cur] ??= newPattern());
  }
  get sps() {
    return (this.sr * 60) / (this.bpm * 4);
  }

  play() {
    this.playing = true;
    this.base = 0;
    this.cycleStart = 0;
    this.cycles = 0;
    this.lastBase = -1;
    this.songRep = 0;
    if (this.songMode && this.song.length) {
      this.songRow = Math.min(this.songRow, this.song.length - 1);
      this.cur = this.song[this.songRow].p;
    }
    for (let k = 0; k < TRACKS; k++) {
      this.tr[k].loopBase = 0;
      this.tr[k].origin = 0;
      this.tr[k].q.length = 0;
      this.tr[k].arpOn = false;
      this.restartTrack(k, 0, false);
    }
  }
  stop() {
    this.playing = false;
    for (const t of this.tr) {
      t.q.length = 0;
      t.arpOn = false;
    }
  }
  /** Change pattern at the end of this one (or at once when stopped). */
  queue(i: number) {
    if (!this.playing) {
      this.cur = i;
      this.queued = -1;
      return;
    }
    this.queued = i;
  }

  /** One frame. */
  tick() {
    this.pulse16 = this.pulseBar = false;
    if (!this.playing) return;
    this.base += 1 / this.sps;
    const bi = Math.floor(this.base);
    if (bi !== this.lastBase) {
      this.lastBase = bi;
      this.pulse16 = true;
      if (bi % 16 === 0) this.pulseBar = true;
    }
    const ml = masterLen(this.pat);
    if (this.base - this.cycleStart >= ml) this.cycleEnd(ml);
    const pat = this.pat;
    for (let k = 0; k < TRACKS; k++) {
      const t = this.tr[k];
      const m = SCALES[pat.mode === 0 ? pat.sc : pat.tracks[k].sc]?.m ?? 1;
      const rel = (this.base - t.origin) * m;
      t.rel = rel;
      const j = Math.floor(rel);
      if (j > t.j) {
        t.j = j;
        this.schedule(k, j + 1);
      }
      while (t.q.length && t.q[0].t <= rel) this.fire(k, t.q.shift()!);
      if (t.arpOn) this.arp(k, rel);
    }
  }

  /** Where a track is: its step (within its length) and the fraction of that step. */
  where(k: number) {
    const t = this.tr[k];
    const L = trackLen(this.pat, k);
    const j = Math.max(0, Math.floor(t.rel));
    return { step: j % L, frac: t.rel - Math.floor(t.rel), rel: t.rel, len: L, loop: t.loopBase + Math.floor(j / L) };
  }

  private cycleEnd(ml: number) {
    this.cycleStart += ml;
    this.cycles++;
    let next = -1;
    if (this.queued >= 0) next = this.queued;
    else if (this.songMode && this.song.length) {
      if (++this.songRep >= Math.max(1, this.song[this.songRow].r)) {
        this.songRep = 0;
        this.songRow = (this.songRow + 1) % this.song.length;
        if (this.song[this.songRow].p !== this.cur || this.song.length > 1) next = this.song[this.songRow].p;
      }
    }
    const change = next >= 0;
    if (change) {
      this.cur = next;
      this.queued = -1;
      this.cycles = 0;
      this.changed = next;
    }
    // per-pattern mode keeps the tracks aligned by itself; otherwise the master length realigns them
    if (change || this.pat.mode === 1) for (let k = 0; k < TRACKS; k++) this.restartTrack(k, this.cycleStart, !change);
  }

  private restartTrack(k: number, origin: number, keepEarly: boolean) {
    const t = this.tr[k];
    const m = trackScale(this.pat, k);
    const shift = (origin - t.origin) * m;
    const L = trackLen(this.pat, k);
    t.loopBase = keepEarly ? t.loopBase + Math.max(1, Math.ceil(shift / L - 1e-9)) : 0;
    t.q = t.q.filter((e) => e.kind !== TRIG).map((e) => ({ ...e, t: e.t - shift }));
    t.origin = origin;
    t.rel = (this.base - origin) * m;
    t.j = Math.floor(t.rel);
    if (t.arpOn) {
      t.arpNext -= shift;
      t.arpEnd -= shift;
    }
    if (!(keepEarly && t.firedNext)) this.schedule(k, 0);
    t.firedNext = false;
    if (t.j >= 0) this.schedule(k, t.j + 1);
  }

  private origin(k: number) {
    return this.tr[k].origin;
  }

  private trigAt(k: number, j: number): Trig | null {
    const pat = this.pat;
    const tr = pat.tracks[k];
    const L = trackLen(pat, k);
    const s = ((j % L) + L) % L;
    if (tr.eu.on) {
      const e = euclidTrack(tr.eu, L);
      if (!e[s]) return tr.steps[s]?.k === 2 ? tr.steps[s] : null;
      return tr.steps[s] ?? { ...newTrig(tr.snd[TIDX.note]), l: 0.5 };
    }
    return tr.steps[s];
  }

  private schedule(k: number, j: number) {
    const trig = this.trigAt(k, j);
    if (!trig) return;
    const sw = j % 2 === 1 ? (this.swing - 50) / 50 : 0;
    const t = j + sw + trig.mt / 24;
    this.push(k, { t, j, kind: TRIG, v: trig.v, trig, gate: 0 });
  }
  private push(k: number, e: Ev) {
    const q = this.tr[k].q;
    let i = q.length;
    while (i > 0 && q[i - 1].t > e.t) i--;
    q.splice(i, 0, e);
  }
  private gate(k: number, steps: number) {
    return steps < 0 ? -1 : Math.max(1, (steps * this.sps) / trackScale(this.pat, k));
  }

  /** Evaluate a condition, keeping PRE's memory. */
  cond(k: number, c: number, j: number): boolean {
    const cd = CONDS[c] ?? CONDS[0];
    const t = this.tr[k];
    const L = trackLen(this.pat, k);
    const loop = t.loopBase + Math.floor(Math.max(0, j) / L);
    let ok: boolean;
    switch (cd.kind) {
      case 'none':
        return true;
      case 'prob':
        ok = this.rng.next() * 100 < (cd.p ?? 100);
        break;
      case 'fill':
        ok = this.fill;
        break;
      case 'nfill':
        ok = !this.fill;
        break;
      case 'pre':
        return t.pre;
      case 'npre':
        return !t.pre;
      case 'nei':
        return k > 0 ? this.tr[k - 1].pre : false;
      case 'nnei':
        return k > 0 ? !this.tr[k - 1].pre : true;
      case 'first':
        ok = loop === 0;
        break;
      case 'nfirst':
        ok = loop > 0;
        break;
      case 'ab':
        ok = loop % (cd.b ?? 1) === (cd.a ?? 1) - 1;
        break;
    }
    t.pre = ok;
    return ok;
  }

  private fire(k: number, e: Ev) {
    const trig = e.trig;
    const t = this.tr[k];
    if (e.kind === RETRIG) {
      if (!this.mutes[k]) this.sink.note(k, trig.n, e.v, e.gate, trig.lk, false, false);
      return;
    }
    // a step of the next cycle, played early by micro timing: the realignment must not play it twice
    if (e.j > t.j && this.origin(k) + e.j / trackScale(this.pat, k) >= this.cycleStart + masterLen(this.pat) - 1e-9) t.firedNext = true;
    if (!this.cond(k, trig.c, e.j)) return;
    if (trig.k === 2) {
      if (trig.lk && !this.mutes[k]) this.sink.lock(k, trig.lk);
      return;
    }
    const tr = this.pat.tracks[k];
    if (tr.arp.m > 0) {
      this.startArp(k, trig, e.t);
      return;
    }
    if (!this.mutes[k]) this.sink.note(k, trig.n, trig.v, this.gate(k, trig.l), trig.lk, !!trig.sl, true);
    if (trig.rt >= 0) {
      const every = RETRIG_RATES[trig.rt]?.steps ?? 1;
      const n = Math.max(1, Math.floor(trig.rl / every + 1e-9));
      const g = this.gate(k, trig.l < 0 ? every : Math.min(trig.l, every));
      for (let i = 1; i < n; i++) {
        const v = Math.max(1, Math.min(127, Math.round(trig.v * (1 + trig.rv * (i / n)))));
        this.push(k, { t: e.t + i * every, j: e.j, kind: RETRIG, v, trig, gate: g });
      }
    }
  }

  // ── the arpeggiator ────────────────────────────────────────────────────────
  private startArp(k: number, trig: Trig, at: number) {
    const a = this.pat.tracks[k].arp;
    const t = this.tr[k];
    const base = [...trig.n];
    const up = [...base].sort((x, y) => x - y);
    const oct = (ns: number[]) => Array.from({ length: Math.max(1, a.r) }, (_, o) => ns.map((n) => n + 12 * o)).flat();
    const mode = ARP_MODES[a.m];
    let seq: number[];
    if (mode === 'vero') seq = oct(base);
    else if (mode === 'giù') seq = oct(up).reverse();
    else if (mode === 'ciclo') {
      const u = oct(up);
      seq = u.length > 2 ? [...u, ...u.slice(1, -1).reverse()] : u;
    } else seq = oct(up);
    t.arpSeq = seq;
    t.arpOn = true;
    t.arpNext = at;
    t.arpEnd = trig.l < 0 ? Infinity : at + trig.l;
    t.arpA = 0;
    t.arpI = 0;
    t.arpVel = trig.v;
    t.arpLk = trig.lk;
    if (mode === 'mescola') this.shuffle(t.arpSeq);
  }
  private shuffle(a: number[]) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
  }
  private arp(k: number, rel: number) {
    const t = this.tr[k];
    const a = this.pat.tracks[k].arp;
    if (a.m === 0) {
      t.arpOn = false;
      return;
    }
    if (rel >= t.arpEnd) {
      t.arpOn = false;
      return;
    }
    const every = ARP_SPEEDS[a.sp]?.s ?? 1;
    let guard = 8;
    while (rel >= t.arpNext && guard--) {
      const s = t.arpA % Math.max(1, a.len);
      if ((a.mask >> s) & 1 && t.arpSeq.length) {
        const mode = ARP_MODES[a.m];
        let n: number;
        if (mode === 'caso') n = t.arpSeq[Math.floor(this.rng.next() * t.arpSeq.length)];
        else {
          if (mode === 'mescola' && t.arpI > 0 && t.arpI % t.arpSeq.length === 0) this.shuffle(t.arpSeq);
          n = t.arpSeq[t.arpI % t.arpSeq.length];
        }
        t.arpI++;
        n = Math.max(0, Math.min(127, n + (a.ofs[s] ?? 0)));
        if (!this.mutes[k]) this.sink.note(k, [n], t.arpVel, this.gate(k, a.nl), t.arpLk, false, t.arpA === 0);
      }
      t.arpA++;
      t.arpNext += every;
    }
  }
}
