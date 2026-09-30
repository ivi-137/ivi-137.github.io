/**
 * Il nastro: a reel of splices played as genes, after the Make Noise Morphagene.
 *
 *   Vari-Speed  bipolar: stopped at noon, forward clockwise, reverse counter-clockwise;
 *               in each direction from −26 semitones (just off noon) to +12 (fully turned)
 *   Gene Size   the piece of the splice that plays: the whole splice fully CCW, a few ms fully CW
 *   Slide       where in the splice the gene starts
 *   Morph       how successive genes meet: gaps, then seamless (1/1), then overlapping up to 3/1,
 *               then, beyond, genes randomly transposed up a fifth or an octave and panned
 *   Organize    which splice plays next (the change waits for the end of the gene)
 *   S.O.S.      sound on sound: the balance of new input and old audio when recording, and
 *               how much of the reel you hear
 *   CLK         a clock input: below nine o'clock on Morph each pulse shifts to the next gene,
 *               up to 2/1 each pulse restarts the gene, above 2/1 the clock sets how fast the
 *               genes move through the splice (a time stretch, pitch left to Vari-Speed)
 *   EOSG, CV    a pulse at the end of every gene or splice; an envelope follower on the output
 */
import { Tape } from './tape';
import { Follower, Rng, clamp, fsin } from './fx';

export const DEAD = 0.03;
/** 1/1, where genes meet seamlessly: about half past eight on the dial. */
export const MORPH_SEAMLESS = 0.15;
/** Nine o'clock: below it, a clock shifts from gene to gene. */
export const MORPH_SHIFT = 0.2;
/** 2/1: above it, a clock time-stretches the splice. */
export const MORPH_STRETCH = 0.45;
/** 3/1: beyond it, genes are transposed and panned at random. */
export const MORPH_RANDOM = 0.75;
/** Recording a new splice shorter than this is discarded. */
const MIN_NEW = 0.05;

/** The Vari-Speed knob (−1..1) as a signed playback ratio. */
export function speedRatio(x: number) {
  const st = speedSemitones(x);
  return Number.isNaN(st) ? 0 : Math.sign(x) * Math.pow(2, st / 12);
}
/** Semitones for the Vari-Speed knob; NaN when stopped. 1x sits at ±0.5 (a small detent). */
export function speedSemitones(x: number) {
  const a = Math.abs(x);
  if (a < DEAD) return NaN;
  if (Math.abs(a - 0.5) < 0.012) return 0;
  const u = (a - DEAD) / (1 - DEAD),
    u1 = (0.5 - DEAD) / (1 - DEAD);
  return u < u1 ? -26 + (26 * u) / u1 : (12 * (u - u1)) / (1 - u1);
}
/** Morph as an overlap ratio: below 1, gaps; 1 seamless; up to 3. */
export function overlap(m: number) {
  if (m < MORPH_SEAMLESS) return 1 / (1 + 7 * (1 - m / MORPH_SEAMLESS));
  if (m < MORPH_RANDOM) return 1 + (2 * (m - MORPH_SEAMLESS)) / (MORPH_RANDOM - MORPH_SEAMLESS);
  return 3;
}
/** How much the genes are transposed and panned at random, 0..1. */
export const randomness = (m: number) => clamp((m - MORPH_RANDOM) / (1 - MORPH_RANDOM));
/** Gene length in samples for a splice of `splen` samples: the whole splice at 0, 4 ms at 1. */
export function geneLength(splen: number, x: number, sr: number) {
  const min = Math.min(splen, 0.004 * sr);
  return splen <= min ? splen : splen * Math.pow(min / splen, clamp(x));
}
export type ClockMode = 'shift' | 'sync' | 'stretch';
export const clockMode = (m: number): ClockMode => (m < MORPH_SHIFT ? 'shift' : m < MORPH_STRETCH ? 'sync' : 'stretch');

/** A soft knee above 0.8, so overdubs pile up without hard clipping. */
const soft = (x: number) => {
  const a = Math.abs(x);
  if (a <= 0.8) return x;
  const e = Math.exp((-2 * (a - 0.8)) / 0.2);
  return Math.sign(x) * (0.8 + 0.2 * ((1 - e) / (1 + e)));
};

interface Grain {
  on: boolean;
  pos: number;
  rate: number;
  dist: number;
  len: number;
  s0: number;
  s1: number;
  fade: number;
  gain: number;
  pan: number;
  kill: number;
  born: number;
}

export interface ReelCtl {
  /** −1..1 */
  speed: number;
  gene: number;
  slide: number;
  morph: number;
  organize: number;
  sos: number;
}

export type RecState = 0 | 1 | 2;
export const REC_OFF = 0,
  REC_DUB = 1,
  REC_NEW = 2;

export class Reel {
  tape: Tape;
  sr: number;
  rng: Rng;
  grains: Grain[];
  cur = 0;
  private orgVal = NaN;
  private pending = -1;
  playBtn = true;
  playGate = false;
  playing = false;
  private acc = 0;
  private shiftOfs = 0;
  private clockT = 1e9;
  clockPeriod = 0;
  clocked = false;
  private eosgLeft = 0;
  private env: Follower;
  spd = 0;
  private stopG = 0;
  private seen = 0;
  private seenMoves = 0;
  private t = 0;
  // recording
  rec: RecState = REC_OFF;
  recHead = 0;
  private recStart = 0;
  private recMarks: number[] = [];
  armed = 0;
  barsLeft = 0;
  /** set when the reel filled up during a recording (the worklet tells the panel) */
  full = false;
  // scrub
  scrubOn = false;
  private scrubTarget = 0;
  private scrubPos = 0;
  private scrubVel = 0;
  private scrubAmp = 0;
  private scrubS0 = 0;
  private scrubS1 = 0;
  outL = 0;
  outR = 0;
  /** the last control values, for the display */
  ctl: ReelCtl = { speed: 0.5, gene: 0, slide: 0, morph: MORPH_SEAMLESS, organize: 0, sos: 0.5 };

  constructor(sr: number, seconds?: number, seed = 7) {
    this.sr = sr;
    this.tape = new Tape(sr, seconds);
    this.rng = new Rng(seed);
    this.env = new Follower(sr, 2, 110);
    this.grains = Array.from({ length: 10 }, () => ({
      on: false,
      pos: 0,
      rate: 1,
      dist: 0,
      len: 1,
      s0: 0,
      s1: 1,
      fade: 0.1,
      gain: 1,
      pan: 0,
      kill: 1,
      born: 0,
    }));
  }

  // ── geometry ────────────────────────────────────────────────────────────
  // the current gene, filled in by geneNow() without allocating
  private g0 = 0;
  private g1 = 1;
  private gLen = 1;
  private gStart = 0;
  private gKey = { cur: -1, gene: -1, slide: -1, shift: NaN, edits: -1 };
  private geneNow(c: ReelCtl) {
    const t = this.tape,
      k = this.gKey;
    if (k.cur === this.cur && k.gene === c.gene && k.slide === c.slide && k.shift === this.shiftOfs && k.edits === t.edits) return;
    k.cur = this.cur;
    k.gene = c.gene;
    k.slide = c.slide;
    k.shift = this.shiftOfs;
    k.edits = t.edits;
    const n = t.marks.length;
    const cur = Math.max(0, Math.min(n - 1, this.cur));
    const s0 = t.marks[cur],
      s1 = cur + 1 < n ? t.marks[cur + 1] : t.len;
    const splen = Math.max(1, s1 - s0);
    this.g0 = s0;
    this.g1 = s1;
    this.gLen = geneLength(splen, c.gene, this.sr);
    this.gStart = s0 + ((((c.slide * splen + this.shiftOfs) % splen) + splen) % splen);
  }
  /** The current gene: start (absolute, wrapped into the splice), length, the splice's bounds. */
  gene(c: ReelCtl = this.ctl) {
    this.geneNow(c);
    return { s0: this.g0, s1: this.g1, splen: Math.max(1, this.g1 - this.g0), len: this.gLen, start: this.gStart };
  }
  private spR = 1;
  private spF = 0.1;
  /** Window edge (as a fraction of the gene) and spacing between gene starts (in reel samples), into spR, spF; returns the period. */
  private spacing(len: number, m: number) {
    const r = overlap(m);
    const f = clamp((0.003 * this.sr) / len + 0.22 * Math.max(0, r - 1), 0.002, 0.5);
    this.spR = r;
    this.spF = f;
    return Math.max(16, (len * (1 - f)) / r);
  }

  // ── buttons and gates ──────────────────────────────────────────────────────
  /** REC: record into the current splice (a new one if the reel is empty); press again to stop. */
  recToggle() {
    if (this.rec) return this.recStop();
    if (!this.tape.count) return this.recNew();
    const [s0, s1] = this.tape.bounds(this.cur);
    const lead = this.lead();
    this.recHead = lead ? this.wrap(lead.pos, lead.s0, lead.s1) | 0 : this.gene().start | 0;
    if (this.recHead < s0 || this.recHead >= s1) this.recHead = s0;
    this.rec = REC_DUB;
  }
  /** REC held + SPLICE: record a new splice at the end of the reel. */
  recNew() {
    if (this.rec) return this.recStop();
    if (this.tape.len >= this.tape.cap) {
      this.full = true;
      return;
    }
    this.recStart = this.tape.len;
    this.recMarks = [];
    this.rec = REC_NEW;
  }
  recStop() {
    const t = this.tape;
    if (this.rec === REC_NEW) {
      if (t.len - this.recStart < MIN_NEW * this.sr) t.len = this.recStart;
      else {
        const k = this.recStart > 0 ? t.addMarker(this.recStart) : 0;
        for (const m of this.recMarks) t.addMarker(m);
        this.cur = k >= 0 ? k : t.spliceAt(this.recStart);
        this.pending = -1;
        this.shiftOfs = 0;
        t.edits++;
        this.killAll();
        if (this.playing) this.spawn(true);
      }
    }
    this.rec = REC_OFF;
    this.armed = 0;
    this.barsLeft = 0;
  }
  /** SPLICE: a marker where the gene is playing (or, while recording a new splice, where the recording is). */
  splice() {
    if (this.rec === REC_NEW) {
      if (this.tape.len - this.recStart > 0.02 * this.sr) this.recMarks.push(this.tape.len);
      return -1;
    }
    const lead = this.lead();
    const pos = lead ? this.wrap(lead.pos, lead.s0, lead.s1) : this.gene().start;
    const k = this.tape.addMarker(pos);
    return k;
  }
  /** SHIFT: the next splice, at once. */
  shift() {
    const n = this.tape.count;
    if (!n) return;
    this.cur = (this.cur + 1) % n;
    this.pending = -1;
    this.shiftOfs = 0;
    this.killAll();
    if (this.playing) this.spawn(true);
  }
  /** SHIFT + SPLICE: join the current splice with the next. */
  deleteMarker() {
    return this.tape.removeMarker(this.cur);
  }
  /** SHIFT + SPLICE held: every marker gone, one splice. */
  deleteAllMarkers() {
    this.tape.clearMarkers();
    this.cur = 0;
  }
  /** SHIFT + REC: the current splice's audio, cut out of the reel. */
  deleteSplice() {
    if (this.rec) this.recStop();
    this.tape.deleteSplice(this.cur);
    this.cur = Math.max(0, Math.min(this.cur, this.tape.count - 1));
  }
  /** SHIFT + REC held: the whole reel, erased. */
  clearReel() {
    this.rec = REC_OFF;
    this.armed = 0;
    this.tape.clear();
    this.cur = 0;
  }
  /** Jump to splice k at once (a click on the reel). */
  select(k: number) {
    if (k < 0 || k >= this.tape.count) return;
    this.cur = k;
    this.pending = -1;
    this.shiftOfs = 0;
    this.killAll();
    if (this.playing) this.spawn(true);
  }
  togglePlay() {
    this.playBtn = !this.playBtn;
  }
  /** A rising edge at the CLK input. */
  clock() {
    if (this.clockT > 8 && this.clockT < 4 * this.sr) this.clockPeriod = this.clockT;
    this.clockT = 0;
    this.clocked = true;
    if (!this.playing || !this.tape.count || this.scrubOn) return;
    const mode = clockMode(this.ctl.morph);
    if (mode === 'shift') {
      const g = this.gene();
      this.shiftOfs += g.len;
      this.spawn(false);
    } else if (mode === 'sync') this.spawn(false);
  }
  /** A bar has begun (from the sequencer): quantised recording starts and stops on these. */
  bar() {
    if (this.armed && !this.rec) {
      this.recNew();
      this.barsLeft = this.armed;
      return;
    }
    if (this.barsLeft > 0 && --this.barsLeft === 0) this.recStop();
  }
  /** Record exactly `bars` bars of the input, from the next bar. 0 disarms. */
  arm(bars: number) {
    if (this.rec) this.recStop();
    this.armed = bars;
  }
  /** Scrub: drag through the current splice by hand; x is 0..1 of the splice. */
  scrub(on: boolean, x: number) {
    const [s0, s1] = this.tape.bounds(this.cur);
    const target = s0 + clamp(x) * Math.max(0, s1 - s0 - 1);
    if (on && !this.scrubOn) {
      this.scrubPos = target;
      this.scrubVel = 0;
      this.killAll();
    }
    if (!on && this.scrubOn) {
      this.acc = 0;
      if (this.playing) this.spawn(true);
    }
    this.scrubOn = on && this.tape.count > 0;
    this.scrubTarget = target;
    this.scrubS0 = s0;
    this.scrubS1 = s1;
  }

  // ── internals ───────────────────────────────────────────────────────────
  private wrap(p: number, s0: number, s1: number) {
    const n = s1 - s0;
    if (n <= 0) return s0;
    let o = (p - s0) % n;
    if (o < 0) o += n;
    return s0 + o;
  }
  /** The most recently started grain still sounding. */
  lead(): Grain | null {
    let best: Grain | null = null;
    for (const g of this.grains) if (g.on && !(g.kill < 1) && (!best || g.born > best.born)) best = g;
    return best;
  }
  private killAll() {
    for (const g of this.grains) if (g.on) g.kill = Math.min(g.kill, 0.999);
  }
  private eosg() {
    this.eosgLeft = Math.round(0.005 * this.sr);
  }
  /** Start a gene. `restart` = from the slide position (play pressed, splice changed). */
  private spawn(restart: boolean) {
    const t = this.tape;
    if (!t.count) return;
    this.eosg();
    if (this.pending >= 0 && this.pending < t.count && this.pending !== this.cur) {
      this.cur = this.pending;
      this.shiftOfs = 0;
    }
    this.pending = -1;
    if (restart) this.shiftOfs = 0;
    const c = this.ctl;
    this.geneNow(c);
    const g = { s0: this.g0, s1: this.g1, len: this.gLen, start: this.gStart };
    this.spacing(g.len, c.morph);
    const r = this.spR,
      f = this.spF;
    const a = randomness(c.morph);
    let rate = 1,
      pan = 0;
    if (a > 0) {
      const u = this.rng.next();
      if (u < a * 0.45) rate = 2;
      else if (u < a * 0.8) rate = 1.5;
      pan = this.rng.bi() * a;
    }
    // a free grain, or the oldest one
    let v = this.grains.find((x) => !x.on);
    if (!v) {
      v = this.grains.reduce((a2, b) => (b.born < a2.born ? b : a2));
    }
    const dir = this.spd < 0 ? -1 : 1;
    v.on = true;
    v.s0 = g.s0;
    v.s1 = g.s1;
    v.len = g.len;
    v.pos = dir > 0 ? g.start : g.start + g.len;
    v.dist = 0;
    v.rate = rate;
    v.fade = f;
    v.gain = 1 / Math.sqrt(Math.max(1, r));
    v.pan = pan;
    v.kill = 1;
    v.born = this.t;
  }

  /** One frame. inL/inR are what REC would record (already scaled by the input gain). */
  process(inL: number, inR: number, c: ReelCtl) {
    const t = this.tape;
    this.ctl = c;
    this.t++;
    if (t.edits !== this.seen) {
      this.seen = t.edits;
      if (t.moves !== this.seenMoves) {
        this.seenMoves = t.moves;
        this.killAll();
      }
      this.cur = Math.max(0, Math.min(this.cur, Math.max(0, t.count - 1)));
      this.orgVal = c.organize; // a structural edit is not a knob move
    }
    // Vari-Speed, slewed like a tape transport
    const target = speedRatio(c.speed);
    this.spd += (target - this.spd) * 0.0025;
    this.stopG += ((Math.abs(this.spd) > 0.004 ? 1 : 0) - this.stopG) * 0.004;
    // Organize acts when it moves
    if (Math.abs(c.organize - this.orgVal) > 1e-4 || Number.isNaN(this.orgVal)) {
      const first = Number.isNaN(this.orgVal);
      this.orgVal = c.organize;
      if (t.count && !first) this.pending = Math.min(t.count - 1, Math.floor(c.organize * t.count));
    }
    // play: the button's latch or a gate at the PLAY input; a rising edge restarts at Slide
    const was = this.playing;
    // (nothing plays while the reel's very first splice is still being recorded)
    this.playing = (this.playBtn || this.playGate) && t.count > 0 && !(this.rec === REC_NEW && this.recStart === 0);
    if (this.playing && !was && !this.scrubOn) {
      this.acc = 0;
      this.spawn(true);
    }
    // the clock
    this.clockT++;
    if (this.clocked && this.clockT > Math.max(3 * this.sr, this.clockPeriod * 2.5)) this.clocked = false;
    const mode = clockMode(c.morph);
    if (this.clocked && mode === 'stretch' && this.clockPeriod > 0 && this.playing && t.count) {
      this.geneNow(c);
      this.shiftOfs += (this.gLen / this.clockPeriod) * (this.spd < 0 ? -1 : 1);
      if (Math.abs(this.shiftOfs) > 1e9) this.shiftOfs = 0;
    }
    // free-running genes (a clock in shift or sync mode takes over their timing)
    const free = !(this.clocked && mode !== 'stretch');
    if (free && this.playing && !this.scrubOn && Math.abs(this.spd) > 1e-4 && t.count) {
      this.geneNow(c);
      const period = this.spacing(this.gLen, c.morph);
      this.acc += Math.abs(this.spd);
      if (this.acc >= period) {
        this.acc -= period;
        if (this.acc > period) this.acc = 0;
        this.spawn(false);
      }
    }

    // ── play the grains
    let l = 0,
      r = 0;
    if (this.scrubOn && t.count) {
      // a hand on the reel: position follows the pointer through a critically damped spring
      const k = 0.0009;
      this.scrubVel += (this.scrubTarget - this.scrubPos) * k - this.scrubVel * 2 * Math.sqrt(k);
      this.scrubPos += this.scrubVel;
      const speed = Math.abs(this.scrubVel);
      this.scrubAmp += (clamp(speed * 1.6) - this.scrubAmp) * 0.01;
      const p = this.wrap(this.scrubPos, this.scrubS0, this.scrubS1);
      l = this.read(0, p, this.scrubS0, this.scrubS1) * this.scrubAmp;
      r = this.read(1, p, this.scrubS0, this.scrubS1) * this.scrubAmp;
    }
    for (const v of this.grains) {
      if (!v.on) continue;
      const step = this.spd * v.rate;
      const u = v.dist / v.len;
      let w = u < v.fade ? fsin((0.25 * u) / v.fade) : u > 1 - v.fade ? fsin((0.25 * (1 - u)) / v.fade) : 1;
      w *= w;
      if (v.kill < 1) {
        v.kill -= 1 / (0.006 * this.sr);
        if (v.kill <= 0) {
          v.on = false;
          continue;
        }
        w *= v.kill;
      }
      const p = this.wrap(v.pos, v.s0, v.s1);
      const a = w * v.gain;
      const gl = v.pan > 0 ? 1 - v.pan : 1,
        gr = v.pan < 0 ? 1 + v.pan : 1;
      l += this.read(0, p, v.s0, v.s1) * a * gl;
      r += this.read(1, p, v.s0, v.s1) * a * gr;
      v.pos += step;
      v.dist += Math.abs(step);
      if (v.dist >= v.len) v.on = false;
    }
    // S.O.S.: at noon the reel plays at full level; turning clockwise fades it toward the live input
    const b = Math.min(1, 2 * (1 - c.sos));
    const a = Math.min(1, 2 * c.sos);
    l *= b * (this.scrubOn ? 1 : this.stopG);
    r *= b * (this.scrubOn ? 1 : this.stopG);

    // ── record
    if (this.rec === REC_DUB) {
      if (!t.count) this.rec = REC_OFF;
      else {
        this.geneNow(c);
        const s0 = this.g0,
          s1 = this.g1;
        if (this.recHead < s0 || this.recHead >= s1) this.recHead = s0;
        const h = this.recHead;
        t.set(h, soft(a * inL + b * t.get(0, h)), soft(a * inR + b * t.get(1, h)));
        this.recHead = h + 1 >= s1 ? s0 : h + 1;
      }
    } else if (this.rec === REC_NEW) {
      if (!t.append(soft(a * inL), soft(a * inR))) {
        this.full = true;
        this.recStop();
      }
    }

    this.outL = l;
    this.outR = r;
    this.env.run(Math.max(Math.abs(l), Math.abs(r)));
    if (this.eosgLeft > 0) this.eosgLeft--;
  }

  /** 4-point Hermite read at p, neighbours wrapped inside [s0, s1). */
  private read(ch: number, p: number, s0: number, s1: number) {
    const t = this.tape;
    const i = Math.floor(p),
      f = p - i;
    const n = s1 - s0;
    const at = (j: number) => {
      if (j < s0) j += n;
      else if (j >= s1) j -= n;
      return t.get(ch, j);
    };
    const xm = at(i - 1),
      x0 = at(i),
      x1 = at(i + 1),
      x2 = at(i + 2);
    const c1 = 0.5 * (x1 - xm),
      c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2,
      c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }

  /** End-of-splice/gene gate. */
  get eos() {
    return this.eosgLeft > 0 ? 1 : 0;
  }
  /** The CV output: an envelope follower on what the reel plays, 0..1. */
  get cv() {
    return clamp(this.env.v * 2.2);
  }

  /** What the panel draws. Positions are absolute reel samples. */
  mon() {
    const t = this.tape;
    const g = t.count ? this.gene() : null;
    const grains: number[] = [];
    for (const v of this.grains)
      if (v.on) {
        const u = v.dist / v.len;
        grains.push(this.wrap(v.pos, v.s0, v.s1), Math.min(1, v.kill, u < v.fade ? u / v.fade : u > 1 - v.fade ? (1 - u) / v.fade : 1));
      }
    return {
      len: t.len,
      count: t.count,
      cur: this.cur,
      pending: this.pending,
      play: this.playing,
      rec: this.rec,
      recHead: this.rec === REC_NEW ? t.len : this.recHead,
      armed: this.armed,
      barsLeft: this.barsLeft,
      geneStart: g ? g.start : 0,
      geneLen: g ? g.len : 0,
      grains,
      scrub: this.scrubOn ? this.wrap(this.scrubPos, this.scrubS0, this.scrubS1) : -1,
      clock: this.clocked ? clockMode(this.ctl.morph) : '',
      spd: this.spd,
      cv: this.cv,
      cap: t.cap,
    };
  }
}
