/**
 * Operatori's voices, after the Elektron Digitone II: sixteen voices shared by
 * sixteen tracks, four machines, six filters, per-track drive, bit and
 * sample-rate reduction, three LFOs per track, and the send effects (chorus,
 * delay, reverb) into a master compressor.
 *
 *   FM Tone   four operators, C A B1 B2, in eight algorithms with two outputs (X, Y)
 *   FM Drum   a body with a pitch sweep, FM from A and B, a wavefolder, a transient, noise
 *   Wavetone  two wavetable oscillators with phase distortion; ring or sync; noise with
 *             its own envelope and filter
 *   Swarmer   a main oscillator (down to two octaves) and a swarm of six, detuned and drifting
 *
 * The algorithms and wavetables here are ours, built in the same scheme; they are
 * not copies of Elektron's.
 */
import { Biquad, Chorus, Compressor, Ladder, Reverb, Rng, SVF, StereoDelay, basic, clamp, expMap, fsin, mtof, tanh } from './fx';
import { BPAIRS, CMP_RATIOS, DELAY_TIMES, LFO_DST, LFO_MULT, MACHINE_SLOTS, RATIOS, SLOT0, TIDX, TN, TPARAMS } from './params';
import { Sequencer, TRACKS, type SeqSink } from './seq';

const I = TIDX;
const CR = 32;
const envTime = (v: number) => 0.0015 * Math.pow(8000, clamp(v / 127));
const reach = (sec: number, sr: number) => 1 - Math.exp(-4.6 / Math.max(1, sec * sr));

// ── wavetables for Wavetone ─────────────────────────────────────────────────────
const WT = 2048;
const MIPS = [64, 24, 8, 3];
/** amplitude and phase of harmonic n (1-based) for wave w of table t */
function harmonic(t: number, w: number, n: number): number {
  if (t === 0) {
    switch (w) {
      case 0:
        return n === 1 ? 1 : 0;
      case 1:
        return n % 2 ? (((n - 1) / 2) % 2 ? -1 : 1) / (n * n) : 0;
      case 2:
        return 1 / n;
      case 3:
        return n % 2 ? 1 / n : 0;
      case 4:
        return Math.sin(n * Math.PI * 0.25) / n;
      case 5:
        return Math.sin(n * Math.PI * 0.1) / n;
      case 6:
        return ({ 1: 1, 2: 0.7, 3: 0.5, 4: 0.45, 6: 0.3, 8: 0.25, 10: 0.12, 12: 0.1, 16: 0.08 } as Record<number, number>)[n] ?? 0;
      default:
        return Math.exp(-((n - 9) ** 2) / 10) * 0.8 + (n === 1 ? 0.5 : 0);
    }
  }
  switch (w) {
    case 0:
      return Math.exp(-((n - 3) ** 2) / 3) + 0.6 * Math.exp(-((n - 8) ** 2) / 6) + (n === 1 ? 0.4 : 0);
    case 1:
      return Math.exp(-((n - 1) ** 2) / 2) + 0.7 * Math.exp(-((n - 14) ** 2) / 10);
    case 2:
      return [1, 3, 5, 9, 13, 21].includes(n) ? 1 / Math.sqrt(n) : 0;
    case 3:
      return n > 6 ? 0.6 / Math.sqrt(n) : n === 1 ? 0.5 : 0;
    case 4:
      return n % 2 === 0 || n === 1 ? 1 / n : 0;
    case 5:
      return n <= 40 ? 0.35 : 0;
    case 6:
      return (n % 2 ? 1 : 0.3) / Math.pow(n, 0.8);
    default:
      return (((n * 7919) % 13) / 13) * (1 / Math.sqrt(n));
  }
}
let TABLES: Float32Array[][][] | null = null;
/** tables[t][w][mip] */
function tables() {
  if (TABLES) return TABLES;
  TABLES = [0, 1].map((t) =>
    Array.from({ length: 8 }, (_, w) =>
      MIPS.map((H) => {
        const a = new Float32Array(WT + 1);
        let peak = 0;
        for (let n = 1; n <= H; n++) {
          const amp = harmonic(t, w, n);
          if (!amp) continue;
          const ph = t === 1 && w === 7 ? n * 1.7 : 0;
          for (let i = 0; i < WT; i++) a[i] += amp * Math.sin((2 * Math.PI * n * i) / WT + ph);
        }
        for (let i = 0; i < WT; i++) peak = Math.max(peak, Math.abs(a[i]));
        for (let i = 0; i < WT; i++) a[i] /= peak || 1;
        a[WT] = a[0];
        return a;
      }),
    ),
  );
  return TABLES;
}
/** CZ-style phase distortion: the first half of the cycle is squeezed into d. */
const warp = (p: number, d: number) => (p < d ? (0.5 * p) / d : 0.5 + (0.5 * (p - d)) / (1 - d));
function wtRead(tb: Float32Array[][], pos: number, p: number, mip: number) {
  const w = Math.min(6.999, Math.max(0, pos));
  const wi = w | 0,
    wf = w - wi;
  const x = p * WT;
  const i = x | 0,
    f = x - i;
  const a = tb[wi][mip],
    b = tb[wi + 1][mip];
  const va = a[i] + (a[i + 1] - a[i]) * f,
    vb = b[i] + (b[i + 1] - b[i]) * f;
  return va + (vb - va) * wf;
}

// ── envelopes ─────────────────────────────────────────────────────────────────
/** delay → attack (linear) → hold → decay (exponential, to sustain) → release */
class Env {
  stage = 0;
  v = 0;
  n = 0;
  private del = 0;
  private atk = 0.01;
  private hold = 0;
  private dk = 0.01;
  private sus = 0;
  private rk = 0.01;
  private ahd = false;
  set(sr: number, del: number, atk: number, hold: number, dec: number, sus: number, rel: number, ahd = false) {
    this.del = del * sr;
    this.atk = 1 / Math.max(1, atk * sr);
    this.hold = hold * sr;
    this.dk = reach(dec, sr);
    this.sus = sus;
    this.rk = reach(rel, sr);
    this.ahd = ahd;
  }
  on(fromZero: boolean) {
    if (fromZero) this.v = 0;
    this.stage = this.del > 0 ? 1 : 2;
    this.n = 0;
  }
  off() {
    if (!this.ahd && this.stage > 0 && this.stage < 5) this.stage = 5;
  }
  run() {
    switch (this.stage) {
      case 1:
        if (++this.n >= this.del) {
          this.stage = 2;
          this.n = 0;
        }
        break;
      case 2:
        this.v += this.atk;
        if (this.v >= 1) {
          this.v = 1;
          this.stage = 3;
          this.n = 0;
        }
        break;
      case 3:
        if (++this.n >= this.hold) this.stage = 4;
        break;
      case 4: {
        const target = this.ahd ? 0 : this.sus;
        this.v += (target - this.v) * this.dk;
        if (this.ahd && this.v < 1e-4) {
          this.v = 0;
          this.stage = 0;
        }
        break;
      }
      case 5:
        this.v += (0 - this.v) * this.rk;
        if (this.v < 1e-4) {
          this.v = 0;
          this.stage = 0;
        }
        break;
    }
    return this.v;
  }
}

// ── LFOs (one set of three per track) ─────────────────────────────────────────────
export class Lfo {
  ph = 0;
  start = 0;
  held = 0;
  out = 0;
  rnd = 0;
  running = true;
  fadeT = 0;
  private rng: Rng;
  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.rnd = this.rng.bi();
  }
  wave(w: number, p: number) {
    p -= Math.floor(p);
    switch (w) {
      case 0:
        return 1 - 4 * Math.abs(((p + 0.25) % 1) - 0.5);
      case 1:
        return fsin(p);
      case 2:
        return p < 0.5 ? 1 : -1;
      case 3:
        return 2 * p - 1;
      case 4:
        return 2 * ((Math.exp(-4 * p) - 0.0183) / 0.9817) - 1;
      case 5:
        return 1 - p;
      default:
        return this.rnd;
    }
  }
  trig(sph: number, mode: number, w: number) {
    this.fadeT = 0;
    if (mode === 2) this.held = this.wave(w, this.ph);
    if (mode === 1 || mode === 3 || mode === 4) {
      this.ph = sph;
      this.start = sph;
      this.running = true;
    }
  }
  /** advance by dt seconds and return the output, −1..1 */
  step(dt: number, hz: number, w: number, mode: number, fade: number) {
    if (this.running) {
      const before = this.ph;
      this.ph += hz * dt;
      if (Math.floor(this.ph) !== Math.floor(before)) this.rnd = this.rng.bi();
      if (mode === 3 && Math.abs(this.ph - this.start) >= 1) {
        this.ph = this.start + Math.sign(hz);
        this.running = false;
      }
      if (mode === 4 && Math.abs(this.ph - this.start) >= 0.5) {
        this.ph = this.start + 0.5 * Math.sign(hz);
        this.running = false;
      }
      if (Math.abs(this.ph) > 1e6) this.ph -= Math.floor(this.ph);
    }
    let v = mode === 2 ? this.held : this.wave(w, this.ph);
    if (fade) {
      this.fadeT += dt;
      const T = (Math.abs(fade) / 64) * 4;
      const g = clamp(this.fadeT / T);
      v *= fade < 0 ? g : 1 - g;
    }
    this.out = v;
    return v;
  }
}

/** A track's live state: LFOs and the offsets they add. */
class TrackState {
  lfos = [new Lfo(1), new Lfo(2), new Lfo(3)];
  mod = new Float64Array(TN);
  modded = false;
  pitch = 0;
  level = 0;
  lastNote = 60;
  mono: Voice | null = null;
}

const NOISE_METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];
/** the largest block the worklet renders at once */
export const BLOCK = 256;
const BUF_KEYS = ['dl', 'dr', 'cl', 'cr', 'el', 'er', 'rl', 'rr'] as const;
/** an operator: a sine, with harmonics folded in by h (0..1) */
const opw = (p: number, h: number) => (h > 0 ? fsin(p + h * 0.3 * fsin(2 * p)) : fsin(p));
const opd = (p: number, h: number) => (h > 0 ? fsin(p + h * 0.35 * fsin(2 * p)) : fsin(p));
const LFO_BASE = [1, 2, 3].map((k) => TIDX[`l${k}.wav`]);
const LFO_DST_IDX = LFO_DST.map((n) => (n === 'pitch' ? -1 : (TIDX[n] ?? -2)));
const SPREAD = [-1, -0.62, -0.28, 0.28, 0.62, 1];

export class Voice {
  on = false;
  k = -1;
  age = 0;
  note = 60;
  pitch = 60;
  target = 60;
  glide = 1;
  vel = 1;
  gate = -1;
  detune = 0;
  panOfs = 0;
  ov = new Float64Array(TN);
  has = new Uint8Array(TN);
  amp = new Env();
  fenv = new Env();
  eA = new Env();
  eB = new Env();
  nenv = new Env();
  ph = new Float64Array(12);
  /** Swarmer: six swarm phases and six drift phases */
  sw = new Float64Array(6);
  dr = new Float64Array(6);
  snh = 0;
  y1 = 0;
  y2 = 0;
  // drum
  sweep = 0;
  sweepK = 0;
  body = 0;
  bodyK = 0;
  bodyHold = 0;
  aE = 0;
  aK = 0;
  bE = 0;
  bK = 0;
  tr = 0;
  trN = 0;
  // filters
  svf: SVF;
  lad: Ladder;
  bq: Biquad;
  svf2: SVF;
  lad2: Ladder;
  bq2: Biquad;
  hp2: SVF;
  lp2: SVF;
  comb = new Float32Array(4096);
  cw = 0;
  clp = 0;
  hp: SVF;
  lp: SVF;
  nhp: SVF;
  nlp: SVF;
  srrN = 0;
  srrL = 0;
  srrR = 0;
  quiet = 0;
  rng: Rng;
  // derived at control rate
  c = new Float64Array(48);
  cn = 0;
  // outputs
  l = 0;
  r = 0;
  sr: number;
  kill = 0;
  constructor(sr: number, seed: number) {
    this.sr = sr;
    this.svf = new SVF(sr);
    this.lad = new Ladder(sr);
    this.bq = new Biquad(sr);
    this.svf2 = new SVF(sr);
    this.lad2 = new Ladder(sr);
    this.bq2 = new Biquad(sr);
    this.hp2 = new SVF(sr);
    this.lp2 = new SVF(sr);
    this.hp = new SVF(sr);
    this.lp = new SVF(sr);
    this.nhp = new SVF(sr);
    this.nlp = new SVF(sr);
    this.rng = new Rng(seed);
    for (let i = 0; i < 12; i++) this.ph[i] = this.rng.next();
    for (let i = 0; i < 6; i++) {
      this.sw[i] = this.rng.next();
      this.dr[i] = this.rng.next();
    }
  }
}

/** Operatori: tracks, voices, the sequencer and the send effects. */
export class Operatori implements SeqSink {
  sr: number;
  voices: Voice[];
  tracks: TrackState[];
  seq: Sequencer;
  cho: Chorus;
  dly: StereoDelay;
  rev: Reverb;
  cmp: Compressor;
  outL = 0;
  outR = 0;
  private age = 0;
  private n = 0;
  private choK = -1;
  /** samples since the effects last made a sound */
  private quiet = 0;
  private choHz = 1;
  private wt = tables();
  /** a trig on track k this frame (process() only) */
  trigged = new Uint8Array(TRACKS);
  /** the block: the mix, the sends, and per sample the tracks that trigged and the clock pulses */
  buf: Record<(typeof BUF_KEYS)[number], Float32Array> = Object.fromEntries(BUF_KEYS.map((k) => [k, new Float32Array(BLOCK)])) as Record<
    (typeof BUF_KEYS)[number],
    Float32Array
  >;
  bL = new Float32Array(BLOCK);
  bR = new Float32Array(BLOCK);
  trigAt = new Uint16Array(BLOCK);
  p16 = new Uint8Array(BLOCK);
  pBar = new Uint8Array(BLOCK);
  private defer = false;
  private evI = 0;
  private evs: {
    i: number;
    k: number;
    notes: number[];
    vel: number;
    gate: number;
    locks: Record<number, number> | null;
    slide: boolean;
    first: boolean;
    lockOnly: boolean;
  }[] = [];
  /** global parameters the machines need: set by the worklet each block */
  g = {
    bpm: 96,
    cho: [0.5, 0.3, 0.8, 0.2, 0.2],
    del: [5, 0.4, 1, 0.8, 0.15, 0.7, 0.15],
    rev: [0.15, 0.55, 0.6, 0.45, 0.15, 0.8],
    cmp: [0.75, 1, 0.3, 0.4, 0.2, 1],
  };

  constructor(sr: number) {
    this.sr = sr;
    this.voices = Array.from({ length: 16 }, (_, i) => new Voice(sr, 100 + i));
    this.tracks = Array.from({ length: TRACKS }, () => new TrackState());
    this.seq = new Sequencer(sr, this);
    this.cho = new Chorus(sr);
    this.dly = new StereoDelay(sr, 4);
    this.rev = new Reverb(sr);
    this.cmp = new Compressor(sr);
  }
  snd(k: number) {
    return this.seq.pat.tracks[k].snd;
  }

  // ── the sink: during a block the sequencer's notes wait for their sample ──────────
  note(k: number, notes: number[], vel: number, gate: number, locks: Record<number, number> | null, slide: boolean, first: boolean) {
    if (this.defer) {
      this.trigAt[this.evI] |= 1 << k;
      this.evs.push({ i: this.evI, k, notes, vel, gate, locks, slide, first, lockOnly: false });
    } else this.noteNow(k, notes, vel, gate, locks, slide, first);
  }
  lock(k: number, locks: Record<number, number>) {
    if (this.defer) this.evs.push({ i: this.evI, k, notes: [], vel: 0, gate: 0, locks, slide: false, first: false, lockOnly: true });
    else this.lockNow(k, locks);
  }
  private noteNow(k: number, notes: number[], vel: number, gate: number, locks: Record<number, number> | null, slide: boolean, first: boolean) {
    const snd = this.snd(k);
    const ts = this.tracks[k];
    if (first) {
      for (let i = 0; i < 3; i++) {
        const b = LFO_BASE[i];
        ts.lfos[i].trig(snd[b + 4] / 128, snd[b + 5], snd[b]);
      }
      // notes held "until the next one" end here
      for (const v of this.voices) if (v.on && v.k === k && v.gate === -1) this.release(v);
    }
    const mode = snd[I.vmode];
    const slideTime = snd[I.porta] > 0 ? 0 : this.seq.sps * 0.9;
    if (mode === 1) {
      const n = notes[0];
      let v = ts.mono && ts.mono.on && ts.mono.k === k ? ts.mono : null;
      const legato = !!v && (slide || snd[I.porta] > 0);
      if (!v) v = this.alloc();
      this.start(v, k, n, vel, gate, locks, legato ? ts.lastNote : n, !legato, slide ? slideTime : -1, 0, 0);
      ts.mono = v;
      ts.lastNote = n;
      return;
    }
    for (const n of notes.slice(0, 4)) {
      const from = slide ? ts.lastNote : n;
      if (mode === 2) {
        this.start(this.alloc(), k, n, vel, gate, locks, from, true, slide ? slideTime : -1, -0.12, -0.45);
        this.start(this.alloc(), k, n, vel, gate, locks, from, true, slide ? slideTime : -1, 0.12, 0.45);
      } else this.start(this.alloc(), k, n, vel, gate, locks, from, true, slide ? slideTime : -1, 0, 0);
    }
    ts.lastNote = notes[0];
  }
  private lockNow(k: number, locks: Record<number, number>) {
    for (const v of this.voices)
      if (v.on && v.k === k)
        for (const key in locks) {
          v.ov[+key] = locks[key];
          v.has[+key] = 1;
        }
  }
  /** A key on the panel's keyboard: held until released. */
  key(k: number, n: number, vel: number, on: boolean) {
    if (on) this.note(k, [n], vel, -2, null, false, true);
    else for (const v of this.voices) if (v.on && v.k === k && v.note === n && v.gate === -2) this.release(v);
  }
  allOff() {
    for (const v of this.voices) if (v.on) this.release(v);
  }

  private alloc(): Voice {
    let best: Voice | null = null;
    for (const v of this.voices) if (!v.on) return v;
    // steal: a releasing voice with the lowest level, else the oldest
    for (const v of this.voices) if (v.amp.stage === 5 && (!best || v.amp.v < best.amp.v)) best = v;
    if (best) return best;
    for (const v of this.voices) if (!best || v.age < best.age) best = v;
    return best!;
  }
  private release(v: Voice) {
    v.gate = 0;
    v.amp.off();
    v.fenv.off();
    v.nenv.off();
  }

  private start(
    v: Voice,
    k: number,
    n: number,
    vel: number,
    gate: number,
    locks: Record<number, number> | null,
    from: number,
    retrig: boolean,
    slideSamples: number,
    detune: number,
    panOfs: number,
  ) {
    const snd = this.snd(k);
    const stolen = v.on;
    v.on = true;
    v.k = k;
    v.age = ++this.age;
    v.note = n;
    v.target = n;
    v.pitch = from;
    v.vel = vel / 127;
    v.gate = gate;
    v.detune = detune;
    v.panOfs = panOfs;
    v.has.fill(0);
    if (locks)
      for (const key in locks) {
        v.ov[+key] = locks[key];
        v.has[+key] = 1;
      }
    const P = (i: number) => (v.has[i] ? v.ov[i] : snd[i]);
    const porta = P(I.porta);
    const glideSec = slideSamples > 0 ? slideSamples / this.sr : porta > 0 ? 0.002 * Math.pow(1000, porta / 127) : 0;
    v.glide = glideSec > 0 ? reach(glideSec, this.sr) : 1;
    if (!retrig) return;
    const m = P(0);
    const sl = (i: number) => P(SLOT0 + i);
    const sr = this.sr;
    v.amp.set(
      sr,
      0,
      envTime(P(I['a.atk'])),
      P(I['a.hold']) ? envTime(P(I['a.hold'])) : 0,
      envTime(P(I['a.dec'])),
      P(I['a.sus']) / 127,
      envTime(P(I['a.rel'])),
      P(I['a.mode']) === 1,
    );
    v.amp.on(!stolen);
    v.fenv.set(
      sr,
      P(I['f.edel']) ? envTime(P(I['f.edel'])) : 0,
      envTime(P(I['f.atk'])),
      0,
      envTime(P(I['f.dec'])),
      P(I['f.sus']) / 127,
      envTime(P(I['f.rel'])),
    );
    v.fenv.on(true);
    if (m === 0) {
      v.eA.set(sr, sl(16) ? envTime(sl(16)) : 0, envTime(sl(8)), 0, envTime(sl(9)), sl(10) / 127, 0.05);
      v.eB.set(sr, sl(18) ? envTime(sl(18)) : 0, envTime(sl(12)), 0, envTime(sl(13)), sl(14) / 127, 0.05);
      if (sl(17) || !v.eA.stage) v.eA.on(true);
      if (sl(19) || !v.eB.stage) v.eB.on(true);
      if (sl(20)) for (let i = 0; i < 4; i++) v.ph[i] = 0;
      v.y1 = v.y2 = 0;
    } else if (m === 1) {
      v.sweep = 1;
      v.sweepK = 1 - Math.exp(-1 / (envTime(sl(1)) * 0.25 * sr));
      v.body = 1;
      v.bodyHold = sl(10) ? envTime(sl(10)) * sr : 0;
      v.bodyK = 1 - Math.exp(-1 / (envTime(sl(9)) * 0.25 * sr));
      v.aE = v.bE = 1;
      v.aK = 1 - Math.exp(-1 / (envTime(sl(12)) * 0.25 * sr));
      v.bK = 1 - Math.exp(-1 / (envTime(sl(14)) * 0.25 * sr));
      v.tr = 1;
      v.trN = 0;
      v.nenv.set(sr, 0, 0.0005, 0, envTime(sl(18)), 0, 0.05, true);
      v.nenv.on(true);
      for (let i = 0; i < 4; i++) v.ph[i] = 0;
      v.y1 = v.y2 = 0;
    } else if (m === 2) {
      v.nenv.set(sr, 0, envTime(sl(16)), sl(17) ? envTime(sl(17)) : 0, envTime(sl(18)), 0, 0.05, true);
      v.nenv.on(true);
    }
    v.cn = 0;
    v.kill = 0;
    v.quiet = 0;
  }

  // ── control rate: everything that changes slowly ────────────────────────────────
  private cv: Voice | null = null;
  private csnd: number[] = [];
  private cmod: Float64Array = new Float64Array(0);
  private cslots = MACHINE_SLOTS[0];
  private P(i: number) {
    const v = this.cv!;
    return (v.has[i] ? v.ov[i] : this.csnd[i]) + this.cmod[i];
  }
  private slf(i: number) {
    const s = this.cslots[i];
    return clamp(this.P(SLOT0 + i), s.min, s.max);
  }
  private sl(i: number) {
    const s = this.cslots[i];
    return clamp(Math.round(this.P(SLOT0 + i)), s.min, s.max);
  }
  private control(v: Voice, snd: number[]) {
    const ts = this.tracks[v.k];
    const m = snd[0] | 0;
    this.cv = v;
    this.csnd = snd;
    this.cmod = ts.mod;
    this.cslots = MACHINE_SLOTS[m];
    const c = v.c;
    const sr = this.sr;
    const pitch = v.pitch + this.P(I.tune) + this.P(I.fine) / 100 + ts.pitch + v.detune;
    const f0 = mtof(pitch);
    c[0] = f0;
    if (m === 0) {
      const dt = this.slf(5) / 127;
      c[1] = (f0 * RATIOS[this.sl(1)]) / sr;
      c[2] = (f0 * RATIOS[this.sl(2)] * (1 + dt * 0.012)) / sr;
      const [b1, b2] = BPAIRS[this.sl(3)];
      c[3] = (f0 * b1 * (1 - dt * 0.009)) / sr;
      c[4] = (f0 * b2 * (1 + dt * 0.017)) / sr;
      const h = this.slf(4) / 64;
      c[5] = Math.max(0, -h);
      c[6] = Math.max(0, h);
      c[7] = (this.slf(6) / 127) * 0.45;
      c[8] = (this.slf(7) + 64) / 127;
      const key = (x: number) => 1 + ((v.note - 60) / 48) * (x / 127);
      c[9] = (this.slf(11) / 127) * 2.2 * key(this.slf(21));
      c[10] = (this.slf(15) / 127) * 2.2 * key(this.slf(22));
      c[11] = this.sl(0);
    } else if (m === 1) {
      c[1] = f0 * Math.pow(2, this.slf(0) / 12);
      c[2] = (this.slf(2) / 127) * 5;
      c[3] = RATIOS[this.sl(5)];
      c[4] = this.slf(4) / 127;
      c[5] = this.slf(6) / 127;
      c[6] = (this.slf(7) / 127) * 0.4;
      c[7] = this.slf(8) / 127;
      c[8] = (this.slf(11) / 127) * 2.5;
      c[9] = (this.slf(13) / 127) * 2.5;
      c[10] = this.sl(15);
      c[11] = this.slf(16) / 127;
      c[12] = (this.slf(17) / 127) ** 1.5;
      c[13] = this.sl(21);
      c[14] = this.sl(3);
      const base = 20 * Math.pow(2, (this.slf(19) / 127) * 10);
      v.nhp.set(base, 0.1);
      v.nlp.set(Math.min(20000, base * Math.pow(2, (this.slf(20) / 127) * 10)), 0.1);
    } else if (m === 2) {
      c[1] = (this.slf(0) / 127) * 7;
      c[2] = 0.5 - 0.49 * (this.slf(1) / 127);
      c[3] = (f0 * Math.pow(2, this.slf(2) / 12) + this.slf(3) * 0.1) / sr;
      c[4] = this.slf(4) / 127;
      c[5] = (this.slf(5) / 127) * 7;
      c[6] = 0.5 - 0.49 * (this.slf(6) / 127);
      c[7] = Math.max(0, f0 * Math.pow(2, this.slf(7) / 12) + this.slf(8) * 0.1) / sr;
      c[8] = this.slf(9) / 127;
      c[9] = this.sl(10);
      c[10] = this.sl(11);
      c[11] = (this.slf(12) / 127) ** 1.5;
      c[12] = this.sl(13);
      const f = Math.max(c[3], c[7]) * sr;
      c[13] = f < 350 ? 0 : f < 1000 ? 1 : f < 3000 ? 2 : 3;
      const base = 20 * Math.pow(2, (this.slf(14) / 127) * 10);
      v.nhp.set(base, 0.1);
      v.nlp.set(Math.min(20000, base * Math.pow(2, (this.slf(15) / 127) * 10)), 0.1);
    } else {
      c[1] = (f0 * Math.pow(2, this.slf(0) / 12)) / sr;
      c[2] = this.sl(1);
      c[3] = (this.slf(2) / 127) * 0.45;
      c[4] = this.slf(3) / 127;
      c[5] = [1, 0.5, 0.25][this.sl(4)];
      c[6] = this.sl(5);
      c[7] = expMap(this.slf(6) / 127, 0.05, 9);
      c[8] = (this.slf(7) / 127) * 0.03;
      c[9] = this.slf(8) / 127;
    }
    // the filter
    const ftype = clamp(Math.round(this.P(I['f.type'])), 0, 5);
    const envAmt = clamp(this.P(I['f.env']), -64, 63) / 64;
    const fe = v.fenv.v;
    let hz = 20 * Math.pow(2, (clamp(this.P(I['f.freq']), 0, 127) / 127) * 10);
    hz *= Math.pow(2, envAmt * fe * 7 + ((v.note - 60) / 12) * (clamp(this.P(I['f.key']), 0, 127) / 127));
    hz = clamp(hz, 16, sr * 0.45);
    const res = clamp(this.P(I['f.res']), 0, 127) / 127;
    const morph = clamp(this.P(I['f.morph']), 0, 127) / 127;
    c[20] = ftype;
    c[21] = morph;
    const st = m === 3;
    if (ftype === 0) {
      v.svf.set(hz, res * 0.98);
      if (st) v.svf2.set(hz, res * 0.98);
    } else if (ftype === 1) {
      v.lad.set(hz, res);
      if (st) v.lad2.set(hz, res);
    } else if (ftype === 2) {
      v.bq.peak(hz, 0.3 + res * 9, (morph - 0.5) * 36);
      if (st) v.bq2.peak(hz, 0.3 + res * 9, (morph - 0.5) * 36);
    } else if (ftype === 3 || ftype === 4) {
      c[22] = Math.min(4000, sr / hz);
      c[23] = res * 0.97 * (ftype === 3 ? -1 : 1);
      c[24] = 1 - morph * 0.9;
    } else {
      v.svf.set(hz, Math.min(0.995, res * 1.02));
      if (st) v.svf2.set(hz, Math.min(0.995, res * 1.02));
    }
    const base = clamp(this.P(I['f.base']), 0, 127),
      width = clamp(this.P(I['f.width']), 0, 127);
    c[25] = base > 0 ? 1 : 0;
    c[26] = width < 127 ? 1 : 0;
    const bhz = 20 * Math.pow(2, (base / 127) * 10);
    const whz = Math.min(sr * 0.45, bhz * Math.pow(2, (width / 127) * 10));
    if (c[25]) v.hp.set(bhz, 0.05);
    if (c[26]) v.lp.set(whz, 0.05);
    if (st && c[25]) v.hp2.set(bhz, 0.05);
    if (st && c[26]) v.lp2.set(whz, 0.05);
    // drive, crush, level, pan, sends
    const od = clamp(this.P(I.od), 0, 127) / 127;
    c[27] = 1 + od * od * 28;
    c[28] = clamp(Math.round(this.P(I.odpos)), 0, 1);
    const bits = clamp(this.P(I.bits), 0, 127);
    c[29] = bits > 0 ? Math.pow(2, 15 - (bits / 127) * 14) : 0;
    const srr = clamp(this.P(I.srr), 0, 127);
    c[30] = srr > 0 ? 1 + Math.round((srr / 127) ** 2 * 63) : 0;
    const velS = clamp(this.P(I.vel), 0, 127) / 127;
    const lvl = (clamp(this.P(I.vol), 0, 127) / 127) ** 2 * (1 - velS * (1 - v.vel));
    const pan = clamp(clamp(this.P(I.pan), -64, 63) / 64 + v.panOfs, -1, 1);
    c[31] = lvl * Math.cos((pan + 1) * Math.PI * 0.25) * 1.414;
    c[32] = lvl * Math.sin((pan + 1) * Math.PI * 0.25) * 1.414;
    c[33] = clamp(this.P(I.cho), 0, 127) / 127;
    c[34] = clamp(this.P(I.del), 0, 127) / 127;
    c[35] = clamp(this.P(I.rev), 0, 127) / 127;
  }

  // ── one voice, one frame ─────────────────────────────────────────────────────────
  /** One voice over samples [a, b) of the block, mixed into the block buffers. */
  private render(v: Voice, snd: number[], a: number, b: number) {
    const B = this.buf;
    let lvl = 0;
    for (let i = a; i < b; i++) {
      if (v.cn-- <= 0) {
        v.cn = CR - 1;
        if (v.pitch !== v.target) {
          v.pitch += (v.target - v.pitch) * Math.min(1, v.glide * CR);
          if (Math.abs(v.pitch - v.target) < 0.001) v.pitch = v.target;
        }
        this.control(v, snd);
      }
      if (v.gate > 0 && --v.gate <= 0) this.release(v);
      const c = v.c;
      const m = snd[0] | 0;
      const sr = this.sr;
      const ph = v.ph;
      let x = 0,
        xr = NaN;
      if (m === 0) {
        const eA = v.eA.run(),
          eB = v.eB.run();
        const mA = c[9] * eA,
          mB = c[10] * eB;
        const hC = c[5],
          hAB = c[6];
        const fbv = (v.y1 + v.y2) * 0.5 * c[7];
        const op = opw;
        let C = 0,
          A = 0,
          B1 = 0,
          B2 = 0,
          X = 0,
          Y = 0,
          fbo = 0;
        switch (c[11]) {
          case 0:
            B2 = op(ph[3] + fbv, hAB);
            B1 = op(ph[2] + B2 * mB, hAB);
            A = op(ph[1] + B1 * mB, hAB);
            C = op(ph[0] + A * mA, hC);
            X = C;
            Y = A * eA;
            fbo = B2;
            break;
          case 1:
            A = op(ph[1] + fbv, hAB);
            B2 = op(ph[3], hAB);
            B1 = op(ph[2] + B2 * mB, hAB);
            C = op(ph[0] + A * mA + B1 * mB, hC);
            X = C;
            Y = B1 * eB;
            fbo = A;
            break;
          case 2:
            B2 = op(ph[3] + fbv, hAB);
            B1 = op(ph[2] + B2 * mB, hAB);
            A = op(ph[1], hAB);
            C = op(ph[0] + A * mA, hC);
            X = C;
            Y = B1 * eB;
            fbo = B2;
            break;
          case 3:
            B2 = op(ph[3] + fbv, hAB);
            A = op(ph[1] + B2 * mB, hAB);
            B1 = op(ph[2] + B2 * mB, hAB);
            C = op(ph[0] + A * mA, hC);
            X = C;
            Y = B1 * eB;
            fbo = B2;
            break;
          case 4:
            A = op(ph[1] + fbv, hAB);
            B1 = op(ph[2] + A * mA, hAB);
            B2 = op(ph[3], hAB);
            C = op(ph[0] + A * mA, hC);
            X = C;
            Y = (B1 + B2) * 0.5 * eB;
            fbo = A;
            break;
          case 5:
            A = op(ph[1] + fbv, hAB);
            B1 = op(ph[2], hAB);
            B2 = op(ph[3], hAB);
            C = op(ph[0] + A * mA + (B1 + B2) * mB * 0.5, hC);
            X = C;
            Y = A * eA;
            fbo = A;
            break;
          case 6:
            A = op(ph[1] + fbv, hAB);
            B1 = op(ph[2], hAB);
            B2 = op(ph[3], hAB);
            C = op(ph[0] + A * mA, hC);
            X = C;
            Y = (B1 + B2) * 0.5 * eB;
            fbo = A;
            break;
          default:
            B1 = op(ph[2] + fbv, hAB);
            B2 = op(ph[3], hAB);
            A = op(ph[1], hAB);
            C = op(ph[0], hC);
            X = (C + A * eA) * 0.6;
            Y = (B1 + B2) * 0.5 * eB;
            fbo = B1;
        }
        v.y2 = v.y1;
        v.y1 = fbo;
        x = X * (1 - c[8]) + Y * c[8];
        for (let i = 0; i < 4; i++) {
          ph[i] += c[1 + i];
          if (ph[i] >= 1) ph[i] -= 1;
        }
      } else if (m === 1) {
        v.sweep += (0 - v.sweep) * v.sweepK;
        if (v.bodyHold > 0) v.bodyHold--;
        else v.body += (0 - v.body) * v.bodyK;
        v.aE += (0 - v.aE) * v.aK;
        v.bE += (0 - v.bE) * v.bK;
        const f = c[1] * Math.pow(2, c[2] * v.sweep);
        const fbv = (v.y1 + v.y2) * 0.5 * c[6];
        const shapeC = c[4],
          shapeAB = c[5];
        const op = opd;
        const a = op(ph[1] + fbv, shapeAB) * c[8] * v.aE;
        const b = op(ph[2], shapeAB) * c[9] * v.bE;
        let body: number,
          extra = 0;
        switch (c[14]) {
          case 1: {
            const a2 = op(ph[1] + b + fbv, shapeAB) * c[8] * v.aE;
            body = op(ph[0] + a2, shapeC);
            v.y2 = v.y1;
            v.y1 = a2;
            break;
          }
          case 2:
            body = op(ph[0] + a + b, shapeC);
            v.y2 = v.y1;
            v.y1 = a;
            break;
          case 3:
            body = op(ph[0] + a, shapeC);
            extra = op(ph[2], shapeAB) * (c[9] / 2.5) * v.bE * 0.6;
            v.y2 = v.y1;
            v.y1 = a;
            break;
          default:
            body = op(ph[0] + a, shapeC);
            v.y2 = v.y1;
            v.y1 = a;
        }
        if (c[7] > 0) body = fsin(body * (1 + c[7] * 5) * 0.25);
        x = (body + extra) * v.body;
        if (v.body < 2e-4 && v.bodyHold <= 0 && v.tr < 1e-4 && (c[12] <= 0 || v.nenv.stage === 0)) v.amp.stage = 0;
        ph[0] += f / sr;
        ph[1] += (f * c[3]) / sr;
        ph[2] += (f * c[3] * 1.41) / sr;
        for (let i = 0; i < 3; i++) if (ph[i] >= 1) ph[i] -= Math.floor(ph[i]);
        // transient
        if (v.tr > 1e-4 && c[10] > 0) {
          const n = v.trN++;
          let tv = 0;
          const tt = n / sr;
          switch (c[10]) {
            case 1:
              tv = n < 2 ? 1 : 0;
              v.tr = n < 2 ? 1 : 0;
              break;
            case 2:
              tv = fsin(tt * 2600) * Math.exp(-tt / 0.0025);
              v.tr = Math.exp(-tt / 0.0025);
              break;
            case 3:
              tv = v.rng.bi() * Math.exp(-tt / 0.006);
              v.tr = Math.exp(-tt / 0.006);
              break;
            default:
              tv = fsin(ph[10]) * Math.exp(-tt / 0.012);
              ph[10] += (150 + 6000 * Math.exp(-tt / 0.004)) / sr;
              v.tr = Math.exp(-tt / 0.012);
          }
          x += tv * c[11];
        }
        // noise
        if (c[12] > 0) {
          const ne = v.nenv.run();
          let nz: number;
          if (c[13] === 1) {
            nz = 0;
            for (let i = 0; i < 6; i++) {
              ph[4 + i] += (NOISE_METAL[i] * (c[1] / 220)) / sr;
              if (ph[4 + i] >= 1) ph[4 + i] -= Math.floor(ph[4 + i]);
              nz += ph[4 + i] < 0.5 ? 1 : -1;
            }
            nz /= 6;
          } else if (c[13] === 2) nz = v.rng.next() < 0.04 ? v.rng.bi() * 3 : 0;
          else nz = v.rng.bi();
          v.nhp.tick(nz);
          x += v.nlp.run(v.nhp.hp, 0) * ne * c[12];
        }
      } else if (m === 2) {
        const tb = this.wt[c[10]];
        const mip = c[13];
        const p1 = ph[0],
          p2 = ph[1];
        const o1 = wtRead(tb, c[1], warp(p1, c[2]), mip);
        const o2 = wtRead(tb, c[5], warp(p2, c[6]), mip);
        if (c[9] === 1) x = o1 * c[4] + o1 * o2 * c[8];
        else x = o1 * c[4] + o2 * c[8];
        ph[0] += c[3];
        ph[1] += c[7];
        if (ph[0] >= 1) {
          ph[0] -= 1;
          if (c[9] === 2) ph[1] = ph[0] * (c[7] / Math.max(1e-9, c[3]));
        }
        if (ph[1] >= 1) ph[1] -= Math.floor(ph[1]);
        x *= 0.6;
        if (c[11] > 0) {
          const ne = v.nenv.run();
          let nz: number;
          if (c[12] === 1) nz = v.rng.next() < 0.03 ? v.rng.bi() * 3 : 0;
          else if (c[12] === 2) {
            ph[2] += c[3];
            if (ph[2] >= 1) {
              ph[2] -= 1;
              v.snh = v.rng.bi();
            }
            nz = v.snh;
          } else nz = v.rng.bi();
          v.nhp.tick(nz);
          x += v.nlp.run(v.nhp.hp, 0) * ne * c[11];
        }
      } else {
        // Swarmer: the main oscillator, then six around it, each with its own slow drift
        const dt0 = c[1] * c[5];
        const main = basic(c[6], ph[0], dt0);
        ph[0] += dt0;
        if (ph[0] >= 1) ph[0] -= 1;
        let sl = 0,
          sr2 = 0;
        const noise = c[8] > 0 ? v.rng.bi() * c[8] : 0;
        for (let i = 0; i < 6; i++) {
          const spread = SPREAD[i];
          v.dr[i] += (c[7] * (0.7 + 0.13 * i)) / sr;
          if (v.dr[i] >= 1) v.dr[i] -= 1;
          const drift = 1 + 0.35 * fsin(v.dr[i]);
          const dt = c[1] * Math.pow(2, (spread * c[3] * drift) / 12) * (1 + noise);
          const y = basic(c[2], v.sw[i], dt);
          v.sw[i] += dt;
          if (v.sw[i] >= 1) v.sw[i] -= 1;
          const pan = spread * c[9];
          sl += y * (1 - pan) * 0.5;
          sr2 += y * (1 + pan) * 0.5;
        }
        const w = c[4];
        x = main * (1 - w) * 0.8 + sl * w * 0.42;
        xr = main * (1 - w) * 0.8 + sr2 * w * 0.42;
      }
      // drive (pre), filter, drive (post), crush
      const stereo = !Number.isNaN(xr);
      let yl = this.chain(v, x, 0);
      let yr = stereo ? this.chain(v, xr, 1) : yl;
      if (c[30] > 0) {
        if (v.srrN-- <= 0) {
          v.srrN = c[30] - 1;
          v.srrL = yl;
          v.srrR = yr;
        }
        yl = v.srrL;
        yr = v.srrR;
      }
      if (c[29] > 0) {
        yl = Math.round(yl * c[29]) / c[29];
        yr = Math.round(yr * c[29]) / c[29];
      }
      v.fenv.run();
      const a = v.amp.run();
      v.l = yl * a * c[31];
      v.r = yr * a * c[32];
      // a voice that has gone quiet in its decay or release is let go
      if (v.amp.stage >= 4 && Math.abs(v.l) + Math.abs(v.r) < 2e-5) v.quiet++;
      else v.quiet = 0;
      if (!v.amp.stage || v.quiet > 2400) {
        v.on = false;
        v.l = v.r = 0;
      }
      const l = v.l,
        r = v.r,
        c2 = v.c;
      B.dl[i] += l;
      B.dr[i] += r;
      B.cl[i] += l * c2[33];
      B.cr[i] += r * c2[33];
      B.el[i] += l * c2[34];
      B.er[i] += r * c2[34];
      B.rl[i] += l * c2[35];
      B.rr[i] += r * c2[35];
      const lv = Math.abs(l) + Math.abs(r);
      if (lv > lvl) lvl = lv;
      if (!v.on) break;
    }
    const ts = this.tracks[v.k];
    if (lvl > ts.level) ts.level = lvl;
  }

  /** drive → filter → base/width → drive, for one channel (the Swarmer's right channel has its own filters) */
  private chain(v: Voice, x: number, ch: number) {
    const c = v.c;
    const drv = c[27];
    if (drv > 1.001 && c[28] === 0) x = tanh(x * drv) * (0.6 + 0.4 / drv) * 1.3;
    const svf = ch ? v.svf2 : v.svf;
    const t = c[20];
    if (t === 0) {
      svf.tick(x);
      const m = c[21];
      x = m < 0.5 ? svf.lp + (svf.bp - svf.lp) * m * 2 : svf.bp + (svf.hp - svf.bp) * (m - 0.5) * 2;
    } else if (t === 1) x = (ch ? v.lad2 : v.lad).run(x);
    else if (t === 2) x = (ch ? v.bq2 : v.bq).run(x);
    else if (t === 3 || t === 4) {
      if (ch === 0) {
        const d = c[22];
        const i = v.cw - d;
        const i0 = Math.floor(i);
        const f = i - i0;
        const a = v.comb[i0 & 4095],
          b = v.comb[(i0 + 1) & 4095];
        v.clp += (a + (b - a) * f - v.clp) * c[24];
        const y = x + c[23] * v.clp;
        v.comb[v.cw & 4095] = tanh(y);
        v.cw = (v.cw + 1) & 0xfffffff;
        x = y * 0.6;
      } else x = (x + c[23] * v.clp) * 0.6;
    } else {
      svf.tick(x);
      x = c[21] < 0.5 ? svf.lp : svf.hp;
    }
    if (c[25]) x = (ch ? v.hp2 : v.hp).run(x, 2);
    if (c[26]) x = (ch ? v.lp2 : v.lp).run(x, 0);
    if (drv > 1.001 && c[28] === 1) x = tanh(x * drv) * (0.6 + 0.4 / drv) * 1.3;
    return x;
  }

  // ── the LFOs, per track at control rate ──────────────────────────────────────────
  private lfos(dt: number) {
    const barHz = this.g.bpm / 240;
    const tracks = this.seq.pat.tracks;
    for (let k = 0; k < TRACKS; k++) {
      const ts = this.tracks[k];
      const snd = tracks[k].snd;
      if (!ts.modded && !(snd[LFO_BASE[0] + 7] || snd[LFO_BASE[1] + 7] || snd[LFO_BASE[2] + 7])) continue;
      ts.mod.fill(0);
      ts.pitch = 0;
      let active = false;
      for (let i = 0; i < 3; i++) {
        const b = LFO_BASE[i];
        const dst = snd[b + 6] | 0;
        const dep = snd[b + 7] + (i === 0 ? 0 : ts.mod[b + 7]);
        if (!dst || !dep) continue;
        active = true;
        const spd = snd[b + 1] + ts.mod[b + 1];
        const hz = ((spd * LFO_MULT[snd[b + 2] | 0]) / 64) * barHz;
        const w = ts.lfos[i].step(dt, hz, snd[b] | 0, snd[b + 5] | 0, snd[b + 3]);
        const amt = (dep / 64) * w;
        const idx = LFO_DST_IDX[dst];
        if (idx === -1) ts.pitch += amt * 12;
        else {
          if (idx < 0) continue;
          const spec = idx >= SLOT0 && idx < SLOT0 + 24 ? MACHINE_SLOTS[snd[0] | 0][idx - SLOT0] : TPARAMS[idx];
          ts.mod[idx] += amt * ((spec.max - spec.min) / 2);
        }
      }
      ts.modded = active;
    }
  }

  /** One frame (for tests and offline checks): a block of one. */
  process() {
    this.processBlock(1);
    this.outL = this.bL[0];
    this.outR = this.bR[0];
    this.trigged.fill(0);
    for (let k = 0; k < TRACKS; k++) if ((this.trigAt[0] >> k) & 1) this.trigged[k] = 1;
  }

  /**
   * A block of Operatori. The sequencer runs sample by sample and its notes are
   * queued with their sample offsets; then each voice renders the stretches
   * between events in one tight loop; then the send effects and the compressor.
   */
  processBlock(n: number) {
    const B = this.buf;
    for (const k of BUF_KEYS) B[k].fill(0, 0, n);
    this.trigAt.fill(0, 0, n);
    this.p16.fill(0, 0, n);
    this.pBar.fill(0, 0, n);
    const seq = this.seq;
    seq.bpm = this.g.bpm;
    this.evs.length = 0;
    this.defer = true;
    for (let i = 0; i < n; i++) {
      this.evI = i;
      seq.tick();
      if (seq.pulse16) this.p16[i] = 1;
      if (seq.pulseBar) this.pBar[i] = 1;
    }
    this.defer = false;
    this.lfos(n / this.sr);
    const rg = this.g.rev;
    this.rev.set(rg[2], 0.3 * Math.pow(60, rg[1]), rg[3]);
    let a = 0;
    for (const e of this.evs) {
      if (e.i > a) {
        this.renderAll(a, e.i);
        a = e.i;
      }
      if (e.lockOnly) this.lockNow(e.k, e.locks!);
      else this.noteNow(e.k, e.notes, e.vel, e.gate, e.locks, e.slide, e.first);
    }
    this.renderAll(a, n);
    const g = this.g;
    if (g.cho[1] !== this.choK) {
      this.choK = g.cho[1];
      this.choHz = expMap(g.cho[1], 0.05, 6);
    }
    const beat = (60 / g.bpm) * this.sr;
    const dtime = DELAY_TIMES[g.del[0] | 0].b * beat;
    const cp = g.cmp;
    const thr = -36 + 36 * cp[0],
      ratio = CMP_RATIOS[cp[1] | 0],
      atk = 0.0005 * Math.pow(60, cp[2]),
      rel = 0.02 * Math.pow(50, cp[3]),
      make = cp[4] * 18;
    // nothing sounding and every tail gone: the effects rest
    let input = false;
    for (let i = 0; i < n && !input; i++) if (B.dl[i] || B.dr[i] || B.cl[i] || B.cr[i] || B.el[i] || B.er[i] || B.rl[i] || B.rr[i]) input = true;
    if (!input && this.quiet > this.sr * 0.5) {
      this.bL.fill(0, 0, n);
      this.bR.fill(0, 0, n);
      return;
    }
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const ch = this.cho.run(B.cl[i], B.cr[i], g.cho[0], this.choHz, g.cho[2], g.cho[3]);
      const c0 = ch[0],
        c1 = ch[1];
      const dly = this.dly.run(B.el[i], B.er[i], dtime, g.del[1], g.del[2], g.del[3], g.del[4], g.del[5]);
      const d0 = dly[0],
        d1 = dly[1];
      const rv = this.rev.run(B.rl[i] + c0 * g.cho[4] + d0 * g.del[6], B.rr[i] + c1 * g.cho[4] + d1 * g.del[6], g.rev[0] * 0.3, g.rev[4]);
      const L = (B.dl[i] + c0 + d0 + rv[0] * g.rev[5]) * 0.5,
        R = (B.dr[i] + c1 + d1 + rv[1] * g.rev[5]) * 0.5;
      const o = this.cmp.run(L, R, thr, ratio, atk, rel, make, cp[5]);
      this.bL[i] = o[0];
      this.bR[i] = o[1];
      const q = Math.abs(o[0]) + Math.abs(o[1]);
      if (q > peak) peak = q;
    }
    this.quiet = input || peak > 1e-5 ? 0 : this.quiet + n;
  }
  private renderAll(a: number, b: number) {
    if (b <= a) return;
    const tracks = this.seq.pat.tracks;
    for (const v of this.voices) if (v.on) this.render(v, tracks[v.k].snd, a, b);
  }

  /** Track levels for the panel's LEDs (decaying peaks). */
  levels() {
    const out: number[] = [];
    for (const t of this.tracks) {
      out.push(Math.min(1, t.level));
      t.level *= 0.6;
    }
    return out;
  }
}
