/**
 * Melencolia: the audio thread.
 *
 *   voice ─▶ gain ─▶ gate ─┬─▶ analysis bank (N bandpasses) ─▶ envelopes ─┐
 *                          ├─▶ pitch tracker (YIN) ─▶ carrier notes        │
 *                          └─▶ sibilants (high-pass), voiced/unvoiced      │
 *   carrier: chords from the sad harmony, or your own pitch ──▶ synthesis bank × envelopes
 *   ─▶ tape ─▶ ping-pong echo ─▶ 8-line reverb ─▶ volume · duck ─▶ limiter ─▶ out
 *
 * A channel vocoder after Dudley (1939): the voice's spectral envelope,
 * measured in bands, is imposed on another sound.
 *
 * Feedback. With speakers, the room carries the output back into the mic.
 * Three defences: a noise gate; per-band echo suppression (a band only opens
 * when the mic is louder there than the calibrated share of what we are
 * playing in that band); and a howl detector that ducks the output and
 * notches the band when one frequency takes over.
 */
import { Melancholy, type SadMethod } from './melancholy';
import { BARS, ECHO, VIDX, VPARAMS, type ToVoc } from './params';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const SR = sampleRate;
const CR = 64;
const TAU = Math.PI * 2;
const MAXB = 32;
const I = VIDX;
const METHODS: SadMethod[] = ['path', 'lament', 'chromatic', 'mixture', 'durer'];

const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const tanh = (x: number) => (x < -3 ? -1 : x > 3 ? 1 : (x * (27 + x * x)) / (27 + 9 * x * x));
const rnd = () => Math.random() * 2 - 1;
const expMap = (x: number, lo: number, hi: number) => lo * Math.pow(hi / lo, x);
const dbToLin = (db: number) => Math.pow(10, db / 20);
const linToDb = (x: number) => 20 * Math.log10(Math.max(1e-7, x));
const onePole = (hz: number) => 1 - Math.exp((-TAU * Math.min(hz, SR * 0.45)) / SR);
const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
function blep(t: number, dt: number) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}
const TBL = 4096;
const SIN = new Float32Array(TBL + 1);
for (let i = 0; i <= TBL; i++) SIN[i] = Math.sin((i / TBL) * TAU);
function fsin(c: number) {
  c -= Math.floor(c);
  const x = c * TBL;
  const i = x | 0;
  return SIN[i] + (SIN[i + 1] - SIN[i]) * (x - i);
}

/** A bank of 4th-order bandpasses (two RBJ sections in series), state in flat arrays. */
class Bank {
  n = 0;
  f = new Float64Array(MAXB);
  b0 = new Float64Array(MAXB);
  a1 = new Float64Array(MAXB);
  a2 = new Float64Array(MAXB);
  s = new Float64Array(MAXB * 4); // z1, z2 for each of the two sections
  set(centers: Float64Array, n: number, q: number) {
    this.n = n;
    for (let j = 0; j < n; j++) {
      const f = Math.min(centers[j], SR * 0.45);
      this.f[j] = f;
      const w = (TAU * f) / SR;
      const alpha = Math.sin(w) / (2 * q);
      const a0 = 1 + alpha;
      this.b0[j] = alpha / a0;
      this.a1[j] = (-2 * Math.cos(w)) / a0;
      this.a2[j] = (1 - alpha) / a0;
    }
  }
  /** Filter x through band j (transposed direct form II, twice). */
  run(j: number, x: number) {
    const b0 = this.b0[j],
      a1 = this.a1[j],
      a2 = this.a2[j],
      s = this.s,
      k = j * 4;
    let y = b0 * x + s[k];
    s[k] = -a1 * y + s[k + 1];
    s[k + 1] = -b0 * x - a2 * y;
    const y2 = b0 * y + s[k + 2];
    s[k + 2] = -a1 * y2 + s[k + 3];
    s[k + 3] = -b0 * y - a2 * y2;
    return y2;
  }
}

class Delay {
  buf: Float32Array;
  mask: number;
  w = 0;
  constructor(len: number) {
    const n = 2 ** Math.ceil(Math.log2(len));
    this.buf = new Float32Array(n);
    this.mask = n - 1;
  }
  write(x: number) {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }
  read(d: number) {
    const r = this.w - d;
    const i = Math.floor(r);
    const f = r - i;
    const a = this.buf[i & this.mask];
    return a + (this.buf[(i + 1) & this.mask] - a) * f;
  }
}

interface Voice {
  midi: number;
  target: number;
  amp: number;
  ampT: number;
  ph: Float64Array;
  bend: number;
  resolveAt: number;
  resolveTo: number;
}

interface Opts {
  processorOptions?: { p?: number[]; seed?: number; offline?: boolean };
}

class Melencolia extends AudioWorkletProcessor {
  P = new Float64Array(VPARAMS.length);
  S = new Float64Array(VPARAMS.length);
  offline: boolean;
  harmony: Melancholy;
  // banks
  ana = new Bank();
  syn = new Bank();
  /** the final output, measured in the same bands: what the speakers actually play */
  ref = new Bank();
  refEnv = new Float64Array(MAXB);
  centers = new Float64Array(MAXB);
  env = new Float64Array(MAXB);
  gain = new Float64Array(MAXB);
  outEnv = new Float64Array(MAXB);
  couple = new Float64Array(MAXB).fill(0.35);
  notch = new Float64Array(MAXB).fill(1);
  bandKey = '';
  // voice analysis
  inEnv = 0;
  hfEnv = 0;
  lfEnv = 0;
  hp1 = 0;
  hp2 = 0;
  hpx = 0;
  lp1 = 0;
  gateG = 0;
  gateOpen = false;
  unvoiced = 0;
  echoing = 0;
  // pitch
  dec: Float32Array = new Float32Array(1024);
  decW = 0;
  decN = 0;
  decPhase = 0;
  dl1 = 0;
  dl2 = 0;
  f0 = 0;
  clarity = 0;
  sinceYin = 0;
  yd = new Float64Array(256);
  // carrier
  voices: Voice[] = [];
  pink = [0, 0, 0, 0, 0, 0, 0];
  follow = 0;
  // clock
  frame = 0;
  nextChord = 0;
  chordLen = SR * 3;
  // after
  tape = new Delay(SR * 0.08);
  tapeLp = 0;
  wow = 0;
  flut = 0;
  echoL = new Delay(SR * 3);
  echoR = new Delay(SR * 3);
  echoLp = [0, 0];
  fdn = [31.7, 37.3, 41.9, 47.3, 53.1, 59.9, 67.3, 73.1].map(() => new Delay(SR * 0.4));
  fdnLen = new Float64Array(8);
  fdnG = new Float64Array(8);
  fdnLp = new Float64Array(8);
  fdnY = new Float64Array(8);
  fdnDamp = 0.5;
  // safety
  duck = 1;
  duckT = 1;
  duckUntil = 0;
  howlBand = -1;
  howlTime = 0;
  lim = 1;
  outLvl = 0;
  cal = -1; // frames left in calibration
  calMic = new Float64Array(MAXB);
  calOut = new Float64Array(MAXB);
  calN = 0;
  /** the room on its own, before the hiss: only what the hiss adds is coupling */
  calBase = new Float64Array(MAXB);
  calBaseN = 0;
  // the loop probe: a singer breathes, a feedback loop never does
  openFor = 0;
  probe = 0;
  probeLevel = 0;
  probeG = 1;
  /** mic ÷ output in each band just before the probe: if it was a loop, that is the room's coupling */
  probeRatio = new Float64Array(MAXB);
  monT = 0;

  constructor(opts: Opts) {
    super();
    const o = opts.processorOptions ?? {};
    this.offline = !!o.offline;
    this.harmony = new Melancholy(o.seed ?? (Math.random() * 1e9) | 0);
    for (let i = 0; i < VPARAMS.length; i++) this.P[i] = this.S[i] = o.p?.[i] ?? VPARAMS[i].def;
    this.port.onmessage = (e: MessageEvent<ToVoc>) => {
      const m = e.data;
      if (m.t === 'p') {
        this.P[m.i] = m.v;
        if (VPARAMS[m.i].step >= 1) this.S[m.i] = m.v;
        if (m.i === I['h.method'] || m.i === I['h.tonic']) {
          this.harmony.reset();
          this.nextChord = this.frame;
        }
      } else if (m.t === 'all') for (let i = 0; i < VPARAMS.length; i++) this.P[i] = this.S[i] = m.p[i] ?? VPARAMS[i].def;
      else if (m.c === 'next') this.nextChord = this.frame;
      else if (m.c === 'restart') {
        this.harmony.reset();
        this.nextChord = this.frame;
      } else if (m.c === 'calibrate') {
        this.cal = Math.round(SR * 2.2);
        this.calMic.fill(0);
        this.calOut.fill(0);
        this.calBase.fill(0);
        this.calN = 0;
        this.calBaseN = 0;
      }
    };
    this.setBands();
    for (let i = 0; i < 8; i++) this.voices.push({ midi: 57, target: 57, amp: 0, ampT: 0, ph: new Float64Array(3).map(() => Math.random()), bend: 0, resolveAt: -1, resolveTo: 57 });
  }

  setBands() {
    const n = Math.round(this.P[I['vc.bands']]);
    const q = expMap(this.S[I['vc.q']], 1.2, 9) * (n / 20);
    const shift = Math.pow(2, this.P[I['vc.formant']] / 12);
    const key = `${n}|${q.toFixed(2)}|${shift}`;
    if (key === this.bandKey) return;
    this.bandKey = key;
    const lo = 110,
      hi = Math.min(7800, SR * 0.42);
    for (let j = 0; j < n; j++) this.centers[j] = lo * Math.pow(hi / lo, n > 1 ? j / (n - 1) : 0);
    this.ana.set(this.centers, n, q);
    this.ref.set(this.centers, n, q);
    const shifted = this.centers.map((f) => f * shift);
    this.syn.set(shifted, n, q);
  }

  /** The next chord from the sad harmony: set the carrier voices, lean on an appoggiatura, tell the panel. */
  chord(atFrame: number) {
    const P = this.P;
    const h = this.harmony;
    h.method = METHODS[Math.round(P[I['h.method']])] ?? 'path';
    h.tonic = Math.round(P[I['h.tonic']]);
    h.tears = P[I['h.tears']];
    h.spice = P[I['h.spice']];
    const c = h.next();
    const notes = c.notes;
    const glide = P[I['car.glide']];
    // how far the upper voices move: small motion is one of the sad cues
    let motion = 0,
      moved = 0;
    for (let k = 1; k < notes.length; k++)
      if (this.voices[k].amp > 0.01) {
        motion += Math.abs(notes[k] - this.voices[k].target);
        moved++;
      }
    motion = moved ? motion / moved : 0;
    const beat = (60 / P[I['g.bpm']]) * SR;
    for (let k = 0; k < this.voices.length; k++) {
      const v = this.voices[k];
      if (k < notes.length) {
        v.target = notes[k];
        if (v.amp < 0.01 || glide < 0.02) v.midi = notes[k];
        v.ampT = k === 0 ? 0.8 : 1;
        v.resolveAt = -1;
      } else v.ampT = 0;
    }
    // Sloboda's tears: the top voice leans on the note above and falls to the chord tone
    if (c.app !== null) {
      const top = this.voices[notes.length - 1];
      top.target = c.app;
      top.resolveTo = notes[notes.length - 1];
      top.resolveAt = atFrame + beat * 1.2;
    }
    this.port.postMessage({ t: 'chord', at: atFrame / SR, name: c.name, roman: c.roman, notes, why: c.why, cell: c.cell ?? null, minor: c.pcs.includes((c.root + 3) % 12) && !c.pcs.includes((c.root + 4) % 12), motion });
  }

  /** YIN (de Cheveigné & Kawahara 2002) on the decimated voice: fundamental and clarity. */
  yin(srd: number) {
    const W = 256,
      tmin = Math.floor(srd / 900),
      tmax = Math.floor(srd / 70);
    const N = this.dec.length,
      m = N - 1;
    const start = this.decW - W - tmax - 2;
    let sum = 0,
      best = -1,
      bestV = 1;
    const d = this.yd;
    for (let t = 1; t <= tmax + 1; t++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const a = this.dec[(start + j) & m] - this.dec[(start + j + t) & m];
        s += a * a;
      }
      sum += s;
      d[t] = sum > 0 ? (s * t) / sum : 1;
    }
    for (let t = tmin; t <= tmax; t++) {
      if (d[t] < 0.15) {
        while (t + 1 <= tmax && d[t + 1] < d[t]) t++;
        best = t;
        bestV = d[t];
        break;
      }
    }
    if (best < 0) {
      this.clarity *= 0.8;
      return;
    }
    const a = d[best - 1],
      b = d[best],
      c = d[best + 1];
    const den = a - 2 * b + c;
    const tt = best + (den ? (0.5 * (a - c)) / den : 0);
    this.f0 = srd / tt;
    this.clarity = 1 - bestV;
  }

  control() {
    const P = this.P,
      S = this.S;
    for (let i = 0; i < S.length; i++) if (VPARAMS[i].step < 1) S[i] += (P[i] - S[i]) * 0.2;
    this.setBands();
    const n = this.ana.n;
    const speakers = P[I['in.mode']] === 1 && !this.offline;
    const freeze = P[I['vc.freeze']] === 1;
    const blur = S[I['vc.blur']];
    const dark = S[I['vc.dark']];
    const makeup = 7 * Math.sqrt(20 / n);
    // "senza voce": every band open, the carrier heard as a pad
    const solo = P[I['car.solo']] === 1;
    let echo = 0;
    for (let j = 0; j < n; j++) {
      if (freeze && !solo) continue;
      let e = solo ? 0.014 : this.env[j] * this.gateG;
      // echo suppression: what we play in this band, heard back through the room, is not a voice
      if (speakers && !solo) {
        // everything we played in this band (echo and reverb tails included), as the room returns it
        const heard = this.refEnv[j] * this.couple[j] * 1.5;
        if (e < heard * 1.4) echo++;
        e = Math.max(0, e - heard);
      }
      const tilt = Math.pow(this.centers[j] / 900, -dark * 0.9);
      this.gain[j] = e * makeup * tilt * this.notch[j];
    }
    this.echoing = speakers ? echo / n : 0;
    if (blur > 0.01 && !freeze) {
      const g = this.gain;
      let prev = g[0];
      for (let j = 0; j < n; j++) {
        const cur = g[j],
          nx = j + 1 < n ? g[j + 1] : cur;
        g[j] = cur * (1 - blur * 0.66) + (prev + nx) * blur * 0.33;
        prev = cur;
      }
    }
    // howl: one band towers over all the others for a while, with sound coming in
    if (!this.offline) {
      let max = 0,
        mi = 0,
        sum = 0;
      for (let j = 0; j < n; j++) {
        sum += this.env[j];
        if (this.env[j] > max) {
          max = this.env[j];
          mi = j;
        }
      }
      const mean = (sum - max) / Math.max(1, n - 1);
      const crest = max / (mean + 1e-9);
      const loud = linToDb(this.inEnv) > -42 && this.outLvl > 0.02;
      // in a howl the output is ringing in the same band the mic is
      let outMax = 0;
      for (let j = 0; j < n; j++) outMax = Math.max(outMax, this.outEnv[j]);
      const ringing = this.outEnv[mi] > outMax * 0.6;
      if (loud && ringing && crest > (speakers ? 7 : 11) && mi === this.howlBand) this.howlTime += CR / SR;
      else this.howlTime = Math.max(0, this.howlTime - (CR / SR) * 0.5);
      this.howlBand = mi;
      if (this.howlTime > 0.35) {
        this.howlTime = 0;
        this.duckT = 0.1;
        this.duckUntil = this.frame + SR * 2.5;
        for (let j = Math.max(0, mi - 1); j <= Math.min(n - 1, mi + 1); j++) this.notch[j] = 0.05;
        this.port.postMessage({ t: 'howl', hz: Math.round(this.centers[mi]) });
      }
      for (let j = 0; j < n; j++) this.notch[j] += (1 - this.notch[j]) * 0.0015;
      if (this.frame > this.duckUntil) this.duckT = 1;
      // ten seconds without a breath: silence the output for a moment and see whether the mic falls silent too
      if (this.gateOpen && this.outLvl > 0.008 && this.probe <= 0 && this.cal <= 0) this.openFor += CR / SR;
      else if (!this.gateOpen) this.openFor = 0;
      if (this.openFor > 10 && this.probe <= 0) {
        this.openFor = 0;
        this.probe = Math.round(SR * 0.32);
        this.probeLevel = this.inEnv;
        for (let j = 0; j < n; j++) this.probeRatio[j] = this.env[j] / (this.refEnv[j] + 1e-9);
      }
    }
    // clock: chords at the tempo
    const bars = BARS[Math.round(P[I['g.bars']])] ?? 1;
    this.chordLen = bars * 4 * (60 / P[I['g.bpm']]) * SR;
    if (this.frame >= this.nextChord) {
      if (P[I['h.hold']] !== 1 || this.harmony.count === 0) this.chord(this.frame);
      this.nextChord = this.frame + this.chordLen;
    }
    // carrier voices: glide, bend, resolve appoggiaturas, follow the voice
    const glideT = expMap(S[I['car.glide']], 0.004, 0.9);
    const gk = 1 - Math.exp(-CR / (glideT * SR));
    const bend = S[I['car.bend']];
    const followMode = Math.round(P[I['car.follow']]);
    if (followMode > 0 && this.clarity > 0.7 && this.gateOpen && this.f0 > 60) {
      const m = 69 + 12 * Math.log2(this.f0 / 440);
      // quantise to the minor scale of the key: the voice is pulled to the nearest sad degree
      const t = Math.round(P[I['h.tonic']]);
      const scale = [0, 2, 3, 5, 7, 8, 10, 11];
      let best = Math.round(m),
        bd = 99;
      for (let k = Math.floor(m) - 2; k <= Math.ceil(m) + 2; k++)
        if (scale.includes((((k - t) % 12) + 12) % 12) && Math.abs(k - m) < bd) {
          bd = Math.abs(k - m);
          best = k;
        }
      this.follow = best;
    }
    for (let k = 0; k < this.voices.length; k++) {
      const v = this.voices[k];
      if (v.resolveAt >= 0 && this.frame >= v.resolveAt) {
        v.target = v.resolveTo;
        v.resolveAt = -1;
      }
      v.midi += (v.target - v.midi) * gk;
      v.bend = clamp(v.bend + rnd() * 0.08 * bend - v.bend * 0.01, -1, 1);
      v.amp += (v.ampT - v.amp) * 0.02;
    }
    // the follower lives in the last two voices
    if (followMode > 0 && this.follow) {
      const fv = this.voices[6],
        hv = this.voices[7];
      fv.target = this.follow;
      fv.ampT = this.gateOpen ? 1 : fv.ampT * 0.98;
      if (P[I['car.harm']] === 1) {
        hv.target = this.follow - 3; // the minor third of sad speech
        hv.ampT = fv.ampT * 0.8;
      } else hv.ampT = 0;
      if (followMode === 1) for (let k = 0; k < 6; k++) this.voices[k].ampT = 0;
    } else if (followMode === 0) {
      this.voices[6].ampT = 0;
      this.voices[7].ampT = 0;
    }
    // echo & reverb coefficients
    const size = S[I['fx.size']];
    const t60 = 0.8 + size * size * 11;
    for (let i = 0; i < 8; i++) {
      this.fdnLen[i] = ([31.7, 37.3, 41.9, 47.3, 53.1, 59.9, 67.3, 73.1][i] / 1000) * SR * (0.5 + size * 1.3);
      this.fdnG[i] = Math.pow(10, (-3 * this.fdnLen[i]) / (t60 * SR));
    }
    this.fdnDamp = onePole(expMap(1 - S[I['fx.dark']], 1500, 14000));
    // calibration: first the room alone (silence out), then with the hiss, after the latency has passed
    if (this.cal > SR * 1.8 && this.cal < SR * 2.15) {
      for (let j = 0; j < n; j++) this.calBase[j] += this.env[j];
      this.calBaseN++;
    }
    if (this.cal > 0 && this.cal < SR * 1.4) {
      for (let j = 0; j < n; j++) {
        this.calMic[j] += this.env[j];
        this.calOut[j] += this.refEnv[j];
      }
      this.calN++;
    }
    this.monT += CR;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const oL = out[0],
      oR = out[1] ?? out[0];
    const inp = inputs[0];
    const P = this.P,
      S = this.S;
    const n = this.ana.n;
    const len = oL.length;
    const inGain = dbToLin(-12 + 42 * S[I['in.gain']]);
    const gateDb = -80 + 60 * S[I['in.gate']];
    const sib = S[I['in.sib']],
      dry = S[I['in.dry']];
    const type = Math.round(P[I['car.type']]);
    const det = S[I['car.detune']] * 0.012;
    const octMul = Math.pow(2, Math.round(P[I['car.oct']]));
    const noiseBase = S[I['car.noise']];
    const atk = 1 - Math.exp(-1 / (expMap(S[I['vc.atk']], 0.001, 0.08) * SR));
    const rel = 1 - Math.exp(-1 / (expMap(S[I['vc.rel']], 0.015, 0.8) * SR));
    const outRel = 1 - Math.exp(-1 / (0.35 * SR));
    const refRel = 1 - Math.exp(-1 / (0.3 * SR));
    const tapeAmt = S[I['fx.tape']];
    const bpm = P[I['g.bpm']];
    const echoT = Math.min(2.8, ECHO[Math.round(P[I['fx.time']])].beats * (60 / bpm)) * SR;
    const echoMix = S[I['fx.echo']],
      fb = S[I['fx.fb']] * 0.85;
    const verbMix = S[I['fx.verb']];
    const vol = S[I['g.vol']];
    const D = Math.max(1, Math.round(SR / 12000));
    const srd = SR / D;
    let sumSq = 0;
    for (let i = 0; i < len; i++) {
      if ((this.frame & (CR - 1)) === 0) this.control();
      this.frame++;
      // the voice
      let x = 0;
      if (inp?.length) x = (inp[0][i] + (inp[1] ? inp[1][i] : inp[0][i])) * 0.5 * inGain;
      const ax = Math.abs(x);
      this.inEnv += (ax - this.inEnv) * (ax > this.inEnv ? 0.01 : 0.0015);
      // gate with 4 dB of hysteresis
      const lvl = linToDb(this.inEnv);
      if (!this.gateOpen && lvl > gateDb + 2) this.gateOpen = true;
      else if (this.gateOpen && lvl < gateDb - 2) this.gateOpen = false;
      this.gateG += ((this.gateOpen ? 1 : 0) - this.gateG) * (this.gateOpen ? 0.004 : 0.0006);
      // sibilants: a high-pass above ~4 kHz, and a voiced/unvoiced decision
      this.hp1 += (x - this.hp1) * 0.42;
      const hp = x - this.hp1;
      this.hp2 += (hp - this.hp2) * 0.6;
      const hf = this.hp2;
      this.lp1 += (x - this.lp1) * 0.12;
      const ah = Math.abs(hf),
        al = Math.abs(this.lp1);
      this.hfEnv += (ah - this.hfEnv) * 0.004;
      this.lfEnv += (al - this.lfEnv) * 0.004;
      const uv = clamp((this.hfEnv / (this.lfEnv + 1e-6) - 0.35) * 1.6);
      this.unvoiced += (uv - this.unvoiced) * 0.003;
      // pitch: two one-poles, then keep every D-th sample
      this.dl1 += (x - this.dl1) * 0.25;
      this.dl2 += (this.dl1 - this.dl2) * 0.25;
      if (++this.decPhase >= D) {
        this.decPhase = 0;
        this.dec[this.decW & 1023] = this.dl2;
        this.decW++;
        if (++this.sinceYin >= 128 && this.decW > 700) {
          this.sinceYin = 0;
          if (this.gateOpen) this.yin(srd);
          else this.clarity *= 0.9;
        }
      }
      // analysis: the voice's envelope in each band
      if (P[I['vc.freeze']] !== 1)
        for (let j = 0; j < n; j++) {
          const y = Math.abs(this.ana.run(j, x));
          const e = this.env[j];
          this.env[j] = e + (y - e) * (y > e ? atk : rel);
        }
      // the carrier
      let car = 0;
      if (type === 3) car = this.pinkNoise() * 1.4;
      else
        for (let k = 0; k < this.voices.length; k++) {
          const v = this.voices[k];
          if (v.amp < 0.001) continue;
          const f = midiHz(v.midi + v.bend * 0.4) * octMul;
          car += this.osc(v, f, type, det) * v.amp;
        }
      const noiseMix = clamp(noiseBase + this.unvoiced * 0.9);
      car = car * (1 - noiseMix * 0.7) + this.pinkNoise() * noiseMix * 1.2;
      // calibration replaces the carrier with steady noise, at a known level
      if (this.cal > 0) {
        this.cal--;
        car = this.cal > SR * 1.8 ? 0 : this.pinkNoise() * 1.5;
        if (this.cal === 0) this.finishCal();
      }
      // synthesis: the carrier, band by band, shaped by the voice
      let y = 0;
      for (let j = 0; j < n; j++) {
        const b = this.syn.run(j, car);
        const g = this.cal > 0 ? (this.cal > SR * 1.8 ? 0 : 0.08) : this.gain[j];
        const o = b * g;
        y += o;
        const ao = Math.abs(o);
        this.outEnv[j] += (ao - this.outEnv[j]) * (ao > this.outEnv[j] ? 0.02 : outRel);
      }
      y += hf * sib * (0.3 + this.unvoiced) * this.gateG * 2.5;
      y += x * dry * 0.8;
      // tape: wow, flutter, saturation, a little lost treble
      this.wow += 0.55 / SR;
      this.flut += 6.8 / SR;
      this.tape.write(y);
      const d = SR * 0.012 + tapeAmt * SR * (0.0022 * (1 + fsin(this.wow)) + 0.00018 * (1 + fsin(this.flut)));
      let t = this.tape.read(d);
      t = tanh(t * (1 + tapeAmt * 2.5)) / (1 + tapeAmt * 0.6);
      this.tapeLp += (t - this.tapeLp) * onePole(16000 - tapeAmt * 11000);
      y = y * (1 - tapeAmt) + this.tapeLp * tapeAmt;
      // ping-pong echo, darker at every return
      const eL = this.echoL.read(echoT),
        eR = this.echoR.read(echoT);
      this.echoLp[0] += (eR - this.echoLp[0]) * 0.25;
      this.echoLp[1] += (eL - this.echoLp[1]) * 0.25;
      this.echoL.write(y + this.echoLp[0] * fb);
      this.echoR.write(this.echoLp[1] * fb);
      let l = y + eL * echoMix,
        r = y + eR * echoMix;
      // reverb: eight delay lines, Hadamard-mixed
      const vin = (l + r) * 0.5;
      const Y = this.fdnY;
      for (let k = 0; k < 8; k++) {
        this.fdnLp[k] += (this.fdn[k].read(this.fdnLen[k]) - this.fdnLp[k]) * this.fdnDamp;
        Y[k] = this.fdnLp[k];
      }
      for (let h = 1; h < 8; h <<= 1)
        for (let a = 0; a < 8; a += h << 1)
          for (let b = a; b < a + h; b++) {
            const u = Y[b],
              w = Y[b + h];
            Y[b] = u + w;
            Y[b + h] = u - w;
          }
      for (let k = 0; k < 8; k++) this.fdn[k].write(vin + Y[k] * 0.35355339 * this.fdnG[k]);
      const wl = (this.fdnLp[0] + this.fdnLp[2] + this.fdnLp[4] + this.fdnLp[6]) * 0.5;
      const wr = (this.fdnLp[1] + this.fdnLp[3] + this.fdnLp[5] + this.fdnLp[7]) * 0.5;
      l = l * (1 - verbMix * 0.5) + wl * verbMix;
      r = r * (1 - verbMix * 0.5) + wr * verbMix;
      // volume, duck, loop probe, limiter
      this.duck += (this.duckT - this.duck) * (this.duckT < this.duck ? 0.01 : 0.0002);
      if (this.probe > 0) {
        this.probeG += (0 - this.probeG) * 0.02;
        if (--this.probe === 0) {
          // the mic dropped with the output: it was listening to the speakers
          if (this.inEnv < this.probeLevel * 0.25) {
            this.P[I['in.mode']] = 1;
            for (let j = 0; j < this.ana.n; j++) this.couple[j] = Math.max(this.couple[j], Math.min(8, this.probeRatio[j] * 1.3));
            this.port.postMessage({ t: 'loop' });
          }
        }
      } else this.probeG += (1 - this.probeG) * 0.002;
      const gOut = vol * this.duck * this.probeG;
      l *= gOut;
      r *= gOut;
      const pk = Math.max(Math.abs(l), Math.abs(r));
      const want = pk > 0.89 ? 0.89 / pk : 1;
      this.lim += (want - this.lim) * (want < this.lim ? 0.4 : 0.0003);
      l = tanh(l * this.lim);
      r = tanh(r * this.lim);
      if (!(l === l) || !(r === r)) {
        l = r = 0;
        this.resetState();
      }
      oL[i] = l;
      if (oR !== oL) oR[i] = r;
      sumSq += l * l + r * r;
      if (!this.offline) {
        const mo = (l + r) * 0.5;
        for (let j = 0; j < n; j++) {
          const a = Math.abs(this.ref.run(j, mo));
          this.refEnv[j] += (a - this.refEnv[j]) * (a > this.refEnv[j] ? 0.02 : refRel);
        }
      }
    }
    this.outLvl += (Math.sqrt(sumSq / (2 * len)) - this.outLvl) * 0.3;
    if (!this.offline && this.monT >= SR / 25) {
      this.monT = 0;
      let num = 0,
        den = 0;
      for (let j = 0; j < n; j++) {
        num += this.centers[j] * this.env[j];
        den += this.env[j];
      }
      this.port.postMessage({
        t: 'mon',
        inDb: linToDb(this.inEnv),
        outDb: linToDb(this.outLvl),
        gate: this.gateG,
        f0: this.clarity > 0.7 && this.gateOpen ? this.f0 : 0,
        clarity: this.clarity,
        centroid: den > 1e-6 ? num / den : 0,
        unvoiced: this.unvoiced,
        bands: Array.from(this.gain.subarray(0, n)),
        echo: this.echoing,
        duck: this.duck,
      });
    }
    return true;
  }

  osc(v: Voice, f: number, type: number, det: number) {
    const ph = v.ph;
    if (type === 0) {
      // coro: three detuned saws
      let s = 0;
      for (let k = 0; k < 3; k++) {
        const dt = (f * (1 + (k - 1) * det)) / SR;
        ph[k] += dt;
        if (ph[k] >= 1) ph[k] -= 1;
        s += 2 * ph[k] - 1 - blep(ph[k], dt);
      }
      return s * 0.4;
    }
    if (type === 1) {
      // organo: a square and its octave
      let s = 0;
      for (let k = 0; k < 2; k++) {
        const dt = (f * (k + 1) * (1 + k * det * 0.5)) / SR;
        ph[k] += dt;
        if (ph[k] >= 1) ph[k] -= 1;
        const p = ph[k];
        s += ((p < 0.5 ? 1 : -1) + blep(p, dt) - blep(p + 0.5 - (p >= 0.5 ? 1 : 0), dt)) * (k ? 0.45 : 0.7);
      }
      return s * 0.5;
    }
    // vetro: two-operator FM, a glassy pad
    const dt = f / SR;
    ph[0] += dt;
    ph[1] += dt * 2.001;
    if (ph[0] >= 1) ph[0] -= 1;
    if (ph[1] >= 1) ph[1] -= 1;
    return fsin(ph[0] + fsin(ph[1]) * (0.6 + det * 20)) * 0.8;
  }

  pinkNoise() {
    const b = this.pink,
      w = rnd();
    b[0] = 0.99886 * b[0] + w * 0.0555179;
    b[1] = 0.99332 * b[1] + w * 0.0750759;
    b[2] = 0.969 * b[2] + w * 0.153852;
    b[3] = 0.8665 * b[3] + w * 0.3104856;
    b[4] = 0.55 * b[4] + w * 0.5329522;
    b[5] = -0.7616 * b[5] - w * 0.016898;
    const o = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
    b[6] = w * 0.115926;
    return o * 0.11;
  }

  finishCal() {
    const n = this.ana.n;
    let sum = 0,
      k = 0;
    for (let j = 0; j < n; j++) {
      if (this.calOut[j] < 1e-9) continue;
      const base = this.calBaseN ? this.calBase[j] / this.calBaseN : 0;
      const heard = Math.max(0, this.calMic[j] / Math.max(1, this.calN) - base);
      const c = heard / (this.calOut[j] / Math.max(1, this.calN));
      this.couple[j] = clamp(c, 0.01, 4);
      sum += this.couple[j];
      k++;
    }
    const mean = k ? sum / k : 0.35;
    this.port.postMessage({ t: 'cal', db: Math.round(linToDb(mean)), ok: k > n / 2 });
  }

  resetState() {
    this.ana.s.fill(0);
    this.syn.s.fill(0);
    this.env.fill(0);
    this.outEnv.fill(0);
    this.fdn.forEach((d) => d.buf.fill(0));
    this.echoL.buf.fill(0);
    this.echoR.buf.fill(0);
  }
}

registerProcessor('melencolia', Melencolia);
