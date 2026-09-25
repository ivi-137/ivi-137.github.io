/**
 * Orfeo 32: the audio thread.
 *
 * One AudioWorkletProcessor renders the whole instrument, sample by sample:
 *
 *   lead voice ─┐   complex oscillator (259/DPO) → wave multiplier (Serge) →
 *   choir ×8  ──┤   multimode SVF → low pass gate with a vactrol model (292)
 *   gongue ×5 ──┼─→ pedalboard (8 pedals, any order) → limiter → out
 *   fonologia ──┘
 *
 * The panel never touches audio. It posts `(index, value)` parameter pairs,
 * timestamped note events (the sequencer schedules ~120 ms ahead on the
 * AudioContext clock, so every event lands on its exact sample here), patch
 * cables, and the pedal order. Modulation (16 sources × 16 destinations) and
 * the pedals' ramps run at control rate, every CR samples.
 */
import { DIP_POL, DIVS, DST, HARMONIC_RATIOS, HEADS, PARAMS, PEDALS, PIDX, SOURCES, type Cable, type SynthEvent, type ToDsp } from './params';

declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const SR = sampleRate;
const CR = 32; // control-rate block
const TAU = Math.PI * 2;

// ── small DSP kit ──────────────────────────────────────────────────────────
const TBL = 4096;
const SIN = new Float32Array(TBL + 1);
for (let i = 0; i <= TBL; i++) SIN[i] = Math.sin((i / TBL) * TAU);
/** sin(2π·c) by table, c in cycles (any real). */
function fsin(c: number) {
  c -= Math.floor(c);
  const x = c * TBL;
  const i = x | 0;
  return SIN[i] + (SIN[i + 1] - SIN[i]) * (x - i);
}
/** Padé tanh: exact at 0, saturates at ±3. */
const tanh = (x: number) => (x < -3 ? -1 : x > 3 ? 1 : (x * (27 + x * x)) / (27 + 9 * x * x));
const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const expMap = (x: number, lo: number, hi: number) => lo * Math.pow(hi / lo, x);
const rnd = () => Math.random() * 2 - 1;
/** PolyBLEP residual for a discontinuity at phase 0. */
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
/** The four primary waves of oscillator A: 0 sine, 1 triangle, 2 saw, 3 square. */
function wave(k: number, p: number, dt: number) {
  if (k === 0) return fsin(p);
  if (k === 1) return 1 - 4 * Math.abs(p - 0.5);
  if (k === 2) return 2 * p - 1 - blep(p, dt);
  return (p < 0.5 ? 1 : -1) + blep(p, dt) - blep(p + 0.5 - (p >= 0.5 ? 1 : 0), dt);
}
const onePole = (hz: number) => 1 - Math.exp((-TAU * Math.min(hz, SR * 0.45)) / SR);
const pow2 = (n: number) => 2 ** Math.ceil(Math.log2(n));

class Delay {
  buf: Float32Array;
  mask: number;
  w = 0;
  constructor(len: number) {
    const n = pow2(len);
    this.buf = new Float32Array(n);
    this.mask = n - 1;
  }
  write(x: number) {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }
  /** d ≥ 1 samples behind the last write, fractional. */
  read(d: number) {
    const r = this.w - d;
    const i = Math.floor(r);
    const f = r - i;
    const a = this.buf[i & this.mask];
    return a + (this.buf[(i + 1) & this.mask] - a) * f;
  }
  /** Absolute position read (for loopers and grains). */
  at(pos: number) {
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.buf[i & this.mask];
    return a + (this.buf[(i + 1) & this.mask] - a) * f;
  }
}

/**
 * Doppler pitch shifter: two taps sweep through a short window in opposite
 * phase, crossfaded by sin²/cos² so their gains always sum to one.
 */
class Shifter {
  ph = Math.random();
  run(dl: Delay, base: number, W: number, ratio: number) {
    this.ph += (1 - ratio) / W;
    this.ph -= Math.floor(this.ph);
    const p2 = this.ph + 0.5 - (this.ph >= 0.5 ? 1 : 0);
    const s = fsin(this.ph * 0.5);
    const g = s * s;
    return dl.read(base + this.ph * W) * g + dl.read(base + p2 * W) * (1 - g);
  }
}

/** Chamberlin/Simper state-variable filter (TPT form, stable at any cutoff). */
class SVF {
  ic1 = 0;
  ic2 = 0;
  a1 = 0;
  a2 = 0;
  a3 = 0;
  k = 2;
  set(hz: number, res: number) {
    const g = Math.tan((Math.PI * Math.min(hz, SR * 0.46)) / SR);
    this.k = 2 - 1.96 * res;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  /** mode 0 LP, 1 BP, 2 HP, 3 notch */
  run(x: number, mode: number) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    if (mode === 0) return v2;
    if (mode === 1) return v1;
    const hp = x - this.k * v1 - v2;
    return mode === 2 ? hp : hp + v2;
  }
}

/** Coloured noise, including a shortwave "radio" (after Koma's Field Kit). */
class Noise {
  b0 = 0;
  b1 = 0;
  b2 = 0;
  b3 = 0;
  b4 = 0;
  b5 = 0;
  b6 = 0;
  br = 0;
  rl = 0;
  rb = 0;
  rc = 900;
  wh = 0;
  whf = 1200;
  fade = 0;
  pink() {
    const w = rnd();
    this.b0 = 0.99886 * this.b0 + w * 0.0555179;
    this.b1 = 0.99332 * this.b1 + w * 0.0750759;
    this.b2 = 0.969 * this.b2 + w * 0.153852;
    this.b3 = 0.8665 * this.b3 + w * 0.3104856;
    this.b4 = 0.55 * this.b4 + w * 0.5329522;
    this.b5 = -0.7616 * this.b5 - w * 0.016898;
    const o = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362;
    this.b6 = w * 0.115926;
    return o * 0.11;
  }
  brown() {
    this.br = (this.br + 0.02 * rnd()) / 1.02;
    return this.br * 3.5;
  }
  /** called at control rate: the dial drifts, the whistle wanders, the signal fades */
  drift() {
    this.rc = clamp(this.rc * (1 + rnd() * 0.02), 300, 3500);
    this.whf = clamp(this.whf * (1 + rnd() * 0.004), 180, 5200);
    this.fade += (1 / SR) * CR * 0.23;
  }
  radio() {
    const f = 2 * Math.sin((Math.PI * this.rc) / SR);
    const x = rnd();
    this.rl += f * this.rb;
    const h = x - this.rl - 0.35 * this.rb;
    this.rb += f * h;
    this.wh += this.whf / SR;
    const am = 0.35 + 0.65 * Math.abs(fsin(this.fade));
    return (this.rb * 0.9 + fsin(this.wh) * 0.12) * am;
  }
  get(color: number) {
    return color === 0 ? rnd() * 0.6 : color === 1 ? this.pink() : color === 2 ? this.brown() : this.radio();
  }
}

/**
 * A Maths-style function generator: rise, fall, vari-response curve, optional
 * cycling and sustain. Output 0..1, advanced at control rate.
 */
class Slope {
  lin = 0;
  stage = 0; // 0 idle, 1 rise, 2 hold, 3 fall
  out = 0;
  trig() {
    this.stage = 1;
  }
  tick(riseS: number, fallS: number, curve: number, hold: boolean, gate: boolean, cycle: boolean) {
    const n = CR / SR;
    if (this.stage === 0 && cycle) this.stage = 1;
    if (this.stage === 1) {
      this.lin += n / riseS;
      if (this.lin >= 1) {
        this.lin = 1;
        this.stage = hold && gate ? 2 : 3;
      }
    } else if (this.stage === 2) {
      if (!gate) this.stage = 3;
    } else if (this.stage === 3) {
      this.lin -= n / fallS;
      if (this.lin <= 0) {
        this.lin = 0;
        this.stage = cycle ? 1 : 0;
      }
    }
    this.out = Math.pow(this.lin, 2 ** ((curve - 0.5) * 4));
    return this.out;
  }
}

// ── voices ───────────────────────────────────────────────────────────────

/** The lead: complex oscillator, sources, wave multiplier, SVF, LPG. */
class Lead {
  pa = 0; // osc A phase
  pb = 0; // modulator phase
  ps = 0; // sub phase
  t = [0, 0.33, 0.66]; // groviglio phases
  tOut = [0, 0, 0];
  logF = Math.log2(220);
  target = Math.log2(220);
  glideOn = false;
  hz = 220;
  vel = 0.8;
  gate = false;
  offAt = -1;
  env = new Slope();
  vac = 0; // vactrol
  vacCtl = 0;
  aAtk = 1 - Math.exp(-1 / (0.0035 * SR));
  aRel = 0.001;
  svf = new SVF();
  lpg = new SVF();
  noise = new Noise();
  ks: Float32Array = new Float32Array(pow2(SR / 15));
  ksW = 0;
  ksLen = 200;
  ksPrev = 0;
  ksExc = 0;
  ksFb = 0.99;
  drift = 0;
  xPrev = 0;
  // per-block values
  fA = 220;
  fB = 440;
  fm = 0;
  am = 0;
  shape = 0;
  bshape = 0;
  sync = false;
  fold = 0;
  sym = 0;
  mode = 0;
  lpgMode = 0;
  levels = { osc: 0, sub: 0, noise: 0, color: 1, tangle: 0, chaos: 0, string: 0, field: 0 };

  noteOn(hz: number, vel: number, slide: boolean, dur: number, frame: number) {
    const legato = slide && (this.gate || this.env.stage === 1 || this.env.stage === 2);
    this.target = Math.log2(Math.max(8, hz));
    this.glideOn = legato;
    if (!legato) {
      this.logF = this.target;
      this.env.trig();
      this.vel = vel;
      this.ksExc = Math.round(this.ksLen);
    } else this.vel = Math.max(this.vel * 0.9, vel);
    this.gate = true;
    this.offAt = dur < 0 ? -1 : frame + Math.max(1, Math.round(dur * SR));
  }
  noteOff() {
    this.gate = false;
    this.offAt = -1;
  }

  /** Oscillator A: sine → triangle → saw → square, band-limited where it matters. */
  oscA(p: number, dt: number) {
    const s = this.shape * 3;
    const seg = s >= 3 ? 2 : s | 0;
    const f = s - seg;
    const a = wave(seg, p, dt);
    return f < 0.001 ? a : a + (wave(seg + 1, p, dt) - a) * f;
  }

  sample(field: number) {
    const L = this.levels;
    // modulator
    const dtB = this.fB / SR;
    this.pb += dtB;
    let wrapped = false;
    if (this.pb >= 1) {
      this.pb -= 1;
      wrapped = true;
    }
    const q = this.pb;
    const bs = this.bshape * 2;
    const mb =
      bs < 1
        ? fsin(q) * (1 - bs) + (1 - 4 * Math.abs(q - 0.5)) * bs
        : (1 - 4 * Math.abs(q - 0.5)) * (2 - bs) + (q < 0.5 ? 1 : -1) * (bs - 1);
    // carrier: linear through-zero FM
    let dtA = (this.fA * (1 + this.fm * mb)) / SR;
    if (dtA > 0.45) dtA = 0.45;
    else if (dtA < -0.45) dtA = -0.45;
    this.pa += dtA;
    if (this.pa >= 1) this.pa -= 1;
    else if (this.pa < 0) this.pa += 1;
    if (this.sync && wrapped) {
      const r = (q * this.fA) / this.fB;
      this.pa = r - Math.floor(r);
    }
    let x = this.oscA(this.pa, Math.abs(dtA) + 1e-9) * (1 - this.am + this.am * mb) * L.osc;
    // sub, one octave down
    const dtS = this.fA / SR / 2;
    this.ps += dtS;
    if (this.ps >= 1) this.ps -= 1;
    if (L.sub > 0) x += ((this.ps < 0.5 ? 1 : -1) + blep(this.ps, dtS) - blep(this.ps + 0.5 - (this.ps >= 0.5 ? 1 : 0), dtS)) * L.sub * 0.7;
    if (L.noise > 0) x += this.noise.get(L.color) * L.noise;
    // groviglio: three triangle cores, each bending the next one's pitch
    if (L.tangle > 0) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        const fk = this.fA * (k === 0 ? 1 : k === 1 ? 1.4983 : 2.2449) * (1 + L.chaos * 1.6 * this.tOut[(k + 1) % 3]);
        this.t[k] += fk / SR;
        this.t[k] -= Math.floor(this.t[k]);
        this.tOut[k] = 1 - 4 * Math.abs(this.t[k] - 0.5);
        sum += this.tOut[k];
      }
      x += sum * 0.33 * L.tangle;
    }
    // corda: Karplus–Strong string, plucked by each new note
    if (L.string > 0) {
      const m = this.ks.length - 1;
      const r = this.ksW - this.ksLen;
      const i = Math.floor(r);
      const f = r - i;
      const a = this.ks[i & m];
      const y = a + (this.ks[(i + 1) & m] - a) * f;
      let inp = 0;
      if (this.ksExc > 0) {
        inp = rnd() * this.vel;
        this.ksExc--;
      }
      const lp = (y + this.ksPrev) * 0.5;
      this.ksPrev = y;
      this.ks[this.ksW & m] = lp * this.ksFb + inp;
      this.ksW = (this.ksW + 1) & m;
      x += y * L.string;
    }
    if (L.field > 0) x += field * L.field * 2;
    // wave multiplier: sine folding, 2× averaged to tame aliasing
    if (this.fold > 0.001) {
      const g = 1 + this.fold * 7;
      const xm = (x + this.xPrev) * 0.5;
      this.xPrev = x;
      const f1 = fsin((xm * g + this.sym) * 0.25);
      const f2 = fsin((x * g + this.sym) * 0.25);
      const folded = (f1 + f2) * 0.5;
      const mix = Math.min(1, this.fold * 5);
      x = x * (1 - mix) + folded * mix;
    } else this.xPrev = x;
    x = this.svf.run(x, this.mode);
    // low pass gate: the vactrol opens fast and closes slowly and unevenly
    const c = this.vacCtl;
    this.vac += (c - this.vac) * (c > this.vac ? this.aAtk : this.aRel);
    const v = this.vac;
    if (this.lpgMode !== 2) x = this.lpg.run(x, 0);
    if (this.lpgMode !== 1) x *= v * Math.sqrt(v);
    return x;
  }
}

/** A choir voice: two detuned oscillators, a 2-pole lowpass, an ASR or pluck envelope. */
class ChoirVoice {
  on = false;
  kind = 0;
  p1 = Math.random();
  p2 = Math.random();
  hz = 220;
  vel = 0.6;
  env = 0;
  offAt = 0;
  age = 0;
  pan = 0;
  lp1 = 0;
  lp2 = 0;
  start(hz: number, vel: number, dur: number, kind: number, frame: number, pan: number) {
    this.on = true;
    this.hz = hz;
    this.vel = vel;
    this.kind = kind;
    this.offAt = frame + Math.round(Math.max(0.02, dur) * SR);
    this.age = 0;
    this.pan = pan;
  }
  get idle() {
    return !this.on && this.env < 0.0005;
  }
}

/** Gongue: a struck bank of four inharmonic resonators (after Ciat-Lonbarde). */
class Gong {
  c1 = new Float64Array(4);
  c2 = new Float64Array(4);
  g = new Float64Array(4);
  y1 = new Float64Array(4);
  y2 = new Float64Array(4);
  exc = 0;
  excN = 1;
  vel = 0;
  alive = 0;
  strike(hz: number, metal: number, decay: number, vel: number) {
    const bar = [1, 2.756, 5.404, 8.933];
    const drum = [1, 1.593, 2.136, 2.653];
    const t60 = 0.08 + decay * decay * 3.5;
    for (let m = 0; m < 4; m++) {
      const f = hz * (drum[m] + (bar[m] - drum[m]) * metal);
      const w = (TAU * f) / SR;
      if (f > SR * 0.45) {
        this.g[m] = 0;
        continue;
      }
      const r = Math.exp(-6.91 / (Math.max(0.03, t60 / (1 + m * 0.7)) * SR));
      this.c1[m] = 2 * r * Math.cos(w);
      this.c2[m] = -r * r;
      this.g[m] = Math.sin(w) * (m === 0 ? 1 : 0.6 / m);
    }
    this.excN = Math.max(8, Math.round(SR * 0.0015));
    this.exc = this.excN;
    this.vel = vel;
    this.alive = Math.round((t60 + 0.1) * SR);
  }
  run() {
    if (this.alive <= 0) return 0;
    this.alive--;
    let x = 0;
    if (this.exc > 0) {
      x = rnd() * this.vel * (this.exc / this.excN);
      this.exc--;
    }
    let out = 0;
    for (let m = 0; m < 4; m++) {
      const y = this.c1[m] * this.y1[m] + this.c2[m] * this.y2[m] + x * this.g[m];
      this.y2[m] = this.y1[m];
      this.y1[m] = y;
      out += y;
    }
    return out;
  }
}

/** Nine sine oscillators, after the Studio di Fonologia (RAI Milano, 1955). */
class Fonologia {
  ph = new Float64Array(9);
  amp = new Float64Array(9).fill(1);
  tgt = new Float64Array(9).fill(1);
  base = 55;
  baseTarget = 55;
  timer = 0;
  control(level: number, motion: number) {
    this.base += (this.baseTarget - this.base) * 0.02;
    this.timer -= CR;
    if (this.timer <= 0) {
      this.timer = SR * (0.3 + Math.random() * 1.5);
      for (let i = 0; i < 9; i++) this.tgt[i] = 1 - motion * Math.random();
    }
    for (let i = 0; i < 9; i++) this.amp[i] += (this.tgt[i] - this.amp[i]) * 0.004;
    return level;
  }
}

// ── pedals ─────────────────────────────────────────────────────────────────

abstract class Pedal {
  ol = 0;
  or = 0;
  kv = new Float64Array(6);
  dip = 0;
  wet = 0; // bypass crossfade
  rp = 0; // ramp phase
  rv = 0; // ramp value
  envf = 0; // input envelope, for "soffio" (sweep) ramps
  has(bit: number) {
    return (this.dip >> bit) & 1;
  }
  control(_bpm: number) {}
  onStep() {}
  onBar() {}
  abstract run(l: number, r: number): void;
}

/** Caos: bit depth, sample-rate reduction, and random solder bridges (Gieskes). */
class Caos extends Pedal {
  hl = 0;
  hr = 0;
  cnt = 0;
  mem = new Delay(SR * 1.2);
  memR = new Delay(SR * 1.2);
  g = 0; // glitch samples left
  gType = 0;
  gStart = 0;
  gLen = 1;
  gT = 0;
  control() {
    const bridge = this.kv[2];
    const rompi = this.has(9);
    if (this.g <= 0 && Math.random() < bridge * bridge * 0.012 * (rompi ? 4 : 1)) {
      this.gType = (Math.random() * 3) | 0;
      this.gLen = Math.round(SR * (0.02 + Math.random() * 0.2));
      this.g = Math.round(this.gLen * (1 + Math.random() * 4));
      this.gStart = this.mem.w - this.gLen - 1;
      this.gT = 0;
    }
  }
  run(l: number, r: number) {
    this.mem.write(l);
    this.memR.write(r);
    let x = l,
      y = r;
    if (this.g > 0) {
      this.g--;
      this.gT++;
      const t = this.gT;
      const pos = this.gType === 0 ? this.gStart + (t % this.gLen) : this.gType === 1 ? this.gStart + ((t * 0.5) % this.gLen) : this.gStart + this.gLen - (t % this.gLen);
      const fade = Math.min(1, this.g / 64);
      x = x * (1 - fade) + this.mem.at(pos) * fade;
      y = y * (1 - fade) + this.memR.at(pos) * fade;
    }
    const hold = 1 + Math.floor(this.kv[1] * this.kv[1] * 48);
    if (++this.cnt >= hold) {
      this.cnt = 0;
      const q = Math.pow(2, 15 - this.kv[0] * 13.5);
      this.hl = Math.round(x * q) / q;
      this.hr = Math.round(y * q) / q;
      if (this.has(9) && Math.random() < 0.002) this.hl = -this.hl;
    }
    const m = this.kv[3];
    this.ol = l + (this.hl - l) * m;
    this.or = r + (this.hr - r) * m;
  }
}

/** Flegetonte: two drives, overdrive into fuzz (after Brothers). */
class Flegetonte extends Pedal {
  lpL = 0;
  lpR = 0;
  dcL = 0;
  dcR = 0;
  c = 0.5;
  heat = 0;
  control() {
    this.c = onePole(expMap(this.kv[2], 500, 14000));
  }
  shape(x: number) {
    const a = this.kv[0],
      b = clamp(this.kv[1] + this.heat * 0.4);
    const A = tanh(x * (1 + a * 10) + 0.2 * a) - tanh(0.2 * a);
    const gb = 1 + b * 45;
    const bx = (this.has(9) ? x : A) * gb;
    const B = bx > 0 ? 1 - Math.exp(-bx) : -(1 - Math.exp(bx)) * 0.85;
    const y = this.has(9) ? (A + B) * 0.5 : b > 0.01 ? B : A;
    return y * (0.9 / (1 + a * 0.6 + b * 0.8));
  }
  run(l: number, r: number) {
    let x = this.shape(l),
      y = this.shape(r);
    this.lpL += (x - this.lpL) * this.c;
    this.lpR += (y - this.lpR) * this.c;
    x = this.lpL - this.dcL;
    y = this.lpR - this.dcR;
    this.dcL += x * 0.0015;
    this.dcR += y * 0.0015;
    const m = this.kv[3];
    this.ol = l + (x - l) * m;
    this.or = r + (y - r) * m;
  }
}

/** Radix-2 FFT, in place. */
class FFT {
  n: number;
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
  constructor(n: number) {
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((TAU * i) / n);
      this.sin[i] = -Math.sin((TAU * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }
  run(re: Float64Array, im: Float64Array, inverse: boolean) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1,
        step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = this.cos[k],
            wi = inverse ? -this.sin[k] : this.sin[k];
          const a = i + j,
            b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

/** Acheronte: an STFT that loses what a codec would lose (after Lossy). */
class Acheronte extends Pedal {
  N = 1024;
  H = 256;
  fft = new FFT(1024);
  win = new Float64Array(1024);
  inF = new Float64Array(1024);
  outF = new Float64Array(1024);
  re = new Float64Array(1024);
  im = new Float64Array(1024);
  frozen = new Float64Array(513);
  lastMag = new Float64Array(513);
  w = 0;
  hop = 0;
  dryL = new Delay(2048);
  dryR = new Delay(2048);
  constructor() {
    super();
    for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((TAU * i) / this.N);
  }
  frame() {
    const { N, re, im, win } = this;
    for (let i = 0; i < N; i++) {
      re[i] = this.inF[(this.w + i) % N] * win[i];
      im[i] = 0;
    }
    this.fft.run(re, im, false);
    const loss = this.kv[0],
      gap = this.kv[1];
    const kc = Math.max(2, Math.floor((expMap(this.kv[2], 180, SR / 2) / SR) * N));
    const freeze = this.has(9);
    const drop = Math.random() < gap * gap * 0.6;
    const repeat = drop && Math.random() < 0.5;
    let max = 1e-9;
    for (let k = 0; k <= N / 2; k++) max = Math.max(max, Math.hypot(re[k], im[k]));
    const floor = max * Math.pow(10, (-70 + loss * 62) / 20);
    for (let k = 0; k <= N / 2; k++) {
      let mag = Math.hypot(re[k], im[k]);
      let ph = Math.atan2(im[k], re[k]);
      if (freeze) {
        if (this.frozen[k] === 0) this.frozen[k] = mag + 1e-9;
        mag = this.frozen[k];
        ph = Math.random() * TAU;
      } else {
        this.frozen[k] = 0;
        if (repeat) mag = this.lastMag[k];
        else if (drop) mag = 0;
        if (k > kc || mag < floor || Math.random() < loss * loss * 0.25) mag = 0;
        // coarse quantisation of what survives: the codec's "birdies"
        if (loss > 0.05 && mag > 0) {
          const q = max * loss * 0.08;
          mag = Math.max(q, Math.round(mag / q) * q);
        }
      }
      this.lastMag[k] = mag;
      re[k] = mag * Math.cos(ph);
      im[k] = mag * Math.sin(ph);
      if (k > 0 && k < N / 2) {
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
    }
    this.fft.run(re, im, true);
    const scale = 1 / (N * 1.5);
    for (let i = 0; i < N; i++) this.outF[(this.w + i) % N] += re[i] * win[i] * scale;
  }
  run(l: number, r: number) {
    this.dryL.write(l);
    this.dryR.write(r);
    this.inF[this.w] = (l + r) * 0.5;
    const y = this.outF[this.w];
    this.outF[this.w] = 0;
    this.w = (this.w + 1) % this.N;
    if (++this.hop >= this.H) {
      this.hop = 0;
      this.frame();
    }
    const m = this.kv[3];
    const dl = this.dryL.read(this.N),
      dr = this.dryR.read(this.N);
    this.ol = dl + (y - dl) * m;
    this.or = dr + (y - dr) * m;
  }
}

interface Grain {
  pos: number;
  speed: number;
  len: number;
  age: number;
  pan: number;
}
/** Mnemosine: a granular memory that can be scanned or frozen (after Habit, Morphagene, Gleetchlab). */
class Mnemosine extends Pedal {
  bl = new Delay(SR * 6);
  br = new Delay(SR * 6);
  grains: Grain[] = [];
  timer = 0;
  scanMod = 0;
  static STEPS = [-12, -7, -5, -3, 0, 3, 5, 7, 12];
  spawn() {
    const size = expMap(this.kv[0], 0.015, 0.6) * SR;
    const scan = clamp(this.kv[3] + this.scanMod);
    const pi = Math.round(this.kv[2] * (Mnemosine.STEPS.length - 1));
    let st = Mnemosine.STEPS[pi];
    if (Math.random() < Math.abs(this.kv[2] - 0.5) * 0.4) st += Math.random() < 0.5 ? 12 : -12;
    const speed = Math.pow(2, st / 12) * (Math.random() < scan * 0.25 ? -1 : 1);
    // start far enough back that a fast grain never overtakes the write head
    const back = SR * (0.05 + scan * 4.2) + Math.random() * size * 0.5 + size * (Math.abs(speed) + 0.5);
    if (this.grains.length >= 32) this.grains.shift();
    this.grains.push({ pos: this.bl.w - back, speed, len: size, age: 0, pan: rnd() * 0.8 });
  }
  run(l: number, r: number) {
    if (!this.has(9)) {
      this.bl.write(l);
      this.br.write(r);
    }
    const rate = expMap(this.kv[1], 1.5, 70);
    this.timer -= rate / SR;
    if (this.timer <= 0) {
      this.timer = 1 + rnd() * 0.3;
      this.spawn();
    }
    let x = 0,
      y = 0;
    for (let i = this.grains.length - 1; i >= 0; i--) {
      const g = this.grains[i];
      const s = fsin((g.age / g.len) * 0.5);
      const w = s * s;
      const p = g.pos + g.age * g.speed;
      const a = this.bl.at(p) * w,
        b = this.br.at(p) * w;
      x += a * (1 - g.pan) + b * Math.max(0, -g.pan);
      y += b * (1 + g.pan) + a * Math.max(0, g.pan);
      if (++g.age >= g.len) this.grains.splice(i, 1);
    }
    const n = 0.9 / Math.sqrt(1 + this.grains.length * 0.35);
    const m = this.kv[4];
    this.ol = l + (x * n - l) * m;
    this.or = r + (y * n - r) * m;
  }
}

/** Cerbero: three heads, each repeat pitch-shifted by its own interval (after Thermae). */
class Cerbero extends Pedal {
  dl = new Delay(SR * 4.2);
  heads = [new Shifter(), new Shifter(), new Shifter()];
  ratio = [1, 1, 1];
  T = SR * 0.25;
  W = Math.round(SR * 0.05);
  fbLp = 0;
  swap = false;
  control(bpm: number) {
    const div = DIVS[Math.round(clamp(this.kv[0], 0, DIVS.length - 1))];
    const T = Math.min(1.3, div.bars * 4 * (60 / bpm)) * SR;
    this.T += (T - this.T) * 0.05;
    const iv = HEADS[Math.round(clamp(this.kv[2], 0, HEADS.length - 1))].i;
    const g = this.kv[3] > 0.001 ? 1 - Math.exp(-CR / (this.kv[3] * this.kv[3] * 1.5 * SR)) : 1;
    for (let k = 0; k < 3; k++) this.ratio[k] += (Math.pow(2, iv[k] / 12) - this.ratio[k]) * g;
  }
  onBar() {
    if (this.has(9)) this.swap = !this.swap;
  }
  run(l: number, r: number) {
    const x = (l + r) * 0.5;
    const h1 = this.heads[0].run(this.dl, this.T, this.W, this.ratio[0]);
    const h2 = this.heads[1].run(this.dl, this.T * 2, this.W, this.ratio[1]);
    const h3 = this.heads[2].run(this.dl, this.T * 3, this.W, this.ratio[2]);
    this.fbLp += (h1 - this.fbLp) * 0.35;
    this.dl.write(x + tanh(this.fbLp * this.kv[1] * 1.05));
    const a = this.swap ? h2 : h1,
      b = this.swap ? h1 : h2;
    const wl = a + h3 * 0.6,
      wr = b + h3 * 0.6;
    const m = this.kv[4];
    this.ol = l * (1 - m * 0.4) + wl * m * 0.7;
    this.or = r * (1 - m * 0.4) + wr * m * 0.7;
  }
}

/** Stige: an always-listening micro-looper with varispeed and slips (after Mood). */
class Stige extends Pedal {
  bl = new Delay(SR * 12.5);
  br = new Delay(SR * 12.5);
  held = false;
  start = 0;
  len = SR;
  pos = 0;
  speed = 1;
  bpm = 96;
  static SPEEDS = [-2, -1, -0.5, 0.5, 1, 2];
  loopLen() {
    const div = DIVS[Math.round(clamp(this.kv[0], 0, DIVS.length - 1))];
    return Math.round(Math.min(12, div.bars * 4 * (60 / this.bpm)) * SR);
  }
  capture() {
    this.len = this.loopLen();
    this.start = this.bl.w - this.len;
    this.pos = 0;
    this.held = true;
  }
  control(bpm: number) {
    this.bpm = bpm;
    const i = clamp(this.kv[1], 0, 1) * 5;
    const a = Math.floor(Math.min(4, i));
    const s = Stige.SPEEDS[a] + (Stige.SPEEDS[a + 1] - Stige.SPEEDS[a]) * (i - a);
    this.speed += (s - this.speed) * 0.08; // tape inertia
  }
  onStep() {
    if (this.held && Math.random() < this.kv[2] * this.kv[2]) {
      const slices = Math.max(1, Math.round(this.len / (SR * (15 / this.bpm))));
      this.pos = (Math.floor(Math.random() * slices) * this.len) / slices;
    }
  }
  run(l: number, r: number) {
    if (!this.held || this.has(10)) {
      if (this.held && this.has(10)) {
        const p = Math.floor(this.start + this.pos);
        const m = this.bl.mask;
        this.bl.buf[p & m] = this.bl.buf[p & m] * 0.8 + l * 0.5;
        this.br.buf[p & m] = this.br.buf[p & m] * 0.8 + r * 0.5;
      } else {
        this.bl.write(l);
        this.br.write(r);
      }
    }
    if (!this.held) {
      this.ol = l;
      this.or = r;
      return;
    }
    this.pos += this.speed;
    if (this.pos >= this.len || this.pos < 0) {
      this.pos -= Math.floor(this.pos / this.len) * this.len;
      if (this.has(9)) this.start = this.bl.w - this.len; // auto: keep renewing from the latest past
    }
    const edge = Math.min(this.pos, this.len - this.pos) / (SR * 0.004);
    const g = edge < 1 ? edge : 1;
    const p = this.start + this.pos;
    const m = this.kv[3];
    this.ol = l * (1 - m * 0.5) + this.bl.at(p) * g * m;
    this.or = r * (1 - m * 0.5) + this.br.at(p) * g * m;
  }
}

/** Cocito: an 8-line feedback delay network with a frozen lake and an octave reflection (after Dark World). */
class Cocito extends Pedal {
  static MS = [31.7, 37.3, 41.9, 47.3, 53.1, 59.9, 67.3, 73.1];
  lines = Cocito.MS.map(() => new Delay(SR * 0.4));
  len = new Float64Array(8);
  g = new Float64Array(8);
  lp = new Float64Array(8);
  y = new Float64Array(8);
  damp = 0.5;
  pre = new Delay(SR * 0.05);
  ap1 = new Delay(512);
  ap2 = new Delay(512);
  shim = new Delay(SR * 0.2);
  shifter = new Shifter();
  shimOut = 0;
  lfo = 0;
  sizeMod = 0;
  control() {
    const size = clamp(this.kv[0] + this.sizeMod);
    const scale = 0.35 + this.kv[0] * 1.6;
    const t60 = 0.5 + size * size * 18;
    const freeze = this.has(9);
    for (let i = 0; i < 8; i++) {
      this.len[i] = (Cocito.MS[i] / 1000) * SR * scale;
      this.g[i] = freeze ? 0.99995 : Math.pow(10, (-3 * this.len[i]) / (t60 * SR));
    }
    this.damp = freeze ? 1 : onePole(expMap(1 - this.kv[1], 1200, 16000));
    this.lfo += (CR / SR) * 0.37;
  }
  run(l: number, r: number) {
    const freeze = this.has(9);
    let x = freeze ? 0 : (l + r) * 0.5;
    this.pre.write(x);
    x = this.pre.read(SR * 0.012);
    // two allpass diffusers
    let z = this.ap1.read(142);
    let v = x + z * 0.6;
    this.ap1.write(v);
    x = z - v * 0.6;
    z = this.ap2.read(107);
    v = x + z * 0.6;
    this.ap2.write(v);
    x = z - v * 0.6;
    x += this.shimOut * this.kv[2] * 0.55;
    const y = this.y;
    const mod = this.kv[3] * SR * 0.0016;
    for (let i = 0; i < 8; i++) {
      const d = this.len[i] + (i < 2 ? (i ? fsin(this.lfo * 1.3) : fsin(this.lfo)) * mod : 0);
      this.lp[i] += (this.lines[i].read(d) - this.lp[i]) * this.damp;
      y[i] = this.lp[i];
    }
    // Hadamard mixing, 1/√8
    for (let h = 1; h < 8; h <<= 1)
      for (let i = 0; i < 8; i += h << 1)
        for (let j = i; j < i + h; j++) {
          const a = y[j],
            b = y[j + h];
          y[j] = a + b;
          y[j + h] = a - b;
        }
    for (let i = 0; i < 8; i++) this.lines[i].write(x + y[i] * 0.35355339 * this.g[i]);
    const wl = (this.lp[0] + this.lp[2] + this.lp[4] + this.lp[6]) * 0.45;
    const wr = (this.lp[1] + this.lp[3] + this.lp[5] + this.lp[7]) * 0.45;
    if (this.kv[2] > 0.001) {
      this.shim.write((wl + wr) * 0.5);
      this.shimOut = this.shifter.run(this.shim, 1, SR * 0.06, 2);
    }
    const m = this.kv[4];
    const dry = 1 - m * m * 0.6;
    this.ol = l * dry + wl * m;
    this.or = r * dry + wr * m;
  }
}

/** Lete: tape that forgets: wow, flutter, saturation, lost bandwidth, hiss, dropouts (after Generation Loss). */
class Lete extends Pedal {
  dl = new Delay(SR * 0.25);
  dr = new Delay(SR * 0.25);
  wow = 0;
  wowRate = 0.6;
  flut = 0;
  walk = 0;
  lp1 = [0, 0];
  lp2 = [0, 0];
  hp = [0, 0];
  cLp = 0.5;
  cHp = 0.01;
  gain = 1;
  drop = 0;
  dropDepth = 0;
  noise = new Noise();
  hissHp = 0;
  wowMod = 0;
  control() {
    const gen = this.kv[3];
    this.cLp = onePole(18000 * Math.pow(0.12, gen));
    this.cHp = onePole(20 * Math.pow(12, gen));
    this.wowRate = clamp(this.wowRate + rnd() * 0.01, 0.3, 1.2);
    this.walk = clamp(this.walk + rnd() * 0.02, -1, 1);
    const fail = this.kv[5];
    if (this.drop <= 0 && Math.random() < fail * fail * 0.02) {
      this.drop = Math.round(SR * (0.03 + Math.random() * 0.35));
      this.dropDepth = 0.3 + Math.random() * 0.7;
    }
  }
  run(l: number, r: number) {
    const wowD = clamp(this.kv[0] + this.wowMod) * SR * 0.004;
    const flD = this.kv[1] * SR * 0.00028;
    this.wow += this.wowRate / SR;
    this.flut += (8.5 + this.walk) / SR;
    const d = SR * 0.012 + wowD * (1 + fsin(this.wow) + this.walk * 0.4) + flD * (1 + fsin(this.flut) + rnd() * 0.3);
    this.dl.write(l);
    this.dr.write(r);
    const sat = 1 + this.kv[2] * 6 + this.kv[3] * 2;
    const comp = 1 / (1 + this.kv[2] * 1.2);
    let out0 = 0,
      out1 = 0;
    for (let c = 0; c < 2; c++) {
      let x = (c ? this.dr : this.dl).read(d);
      x = tanh(x * sat) * comp;
      this.lp1[c] += (x - this.lp1[c]) * this.cLp;
      this.lp2[c] += (this.lp1[c] - this.lp2[c]) * this.cLp;
      this.hp[c] += (this.lp2[c] - this.hp[c]) * this.cHp;
      x = this.lp2[c] - this.hp[c];
      if (c) out1 = x;
      else out0 = x;
    }
    const n = this.noise.pink();
    this.hissHp += (n - this.hissHp) * 0.25;
    const hiss = (n - this.hissHp) * this.kv[4] * 0.06 * (1 + this.kv[3]);
    let tg = 1;
    if (this.drop > 0) {
      this.drop--;
      tg = 1 - this.dropDepth;
    }
    this.gain += (tg - this.gain) * 0.004;
    const dry = this.has(9) ? 0.5 : 0;
    this.ol = (out0 * this.gain + hiss) * (1 - dry) + l * dry;
    this.or = (out1 * this.gain + hiss) * (1 - dry) + r * dry;
  }
}

// ── the processor ─────────────────────────────────────────────────────────

const I = PIDX;
const NP = PARAMS.length;
const DISCRETE = new Uint8Array(NP);
PARAMS.forEach((s, i) => (DISCRETE[i] = s.step >= 1 ? 1 : 0));

class Orfeo extends AudioWorkletProcessor {
  P = new Float64Array(NP);
  S = new Float64Array(NP);
  ready = false;
  queue: SynthEvent[] = [];
  lead = new Lead();
  choir = Array.from({ length: 8 }, () => new ChoirVoice());
  choirRR = 0;
  gongs = Array.from({ length: 5 }, () => new Gong());
  fono = new Fonologia();
  pedals: Pedal[] = [new Caos(), new Flegetonte(), new Acheronte(), new Mnemosine(), new Cerbero(), new Stige(), new Cocito(), new Lete()];
  order = [0, 1, 2, 3, 4, 5, 6, 7];
  cables: Cable[] = [];
  src = new Float64Array(SOURCES.length);
  md = new Float64Array(16);
  fa = new Slope();
  fb = new Slope();
  lfoPh = 0;
  lfoSH = 0;
  unc = 0;
  uncFrom = 0;
  uncTo = 0;
  uncT = 1;
  stp = 0;
  stpTarget = 0;
  reg = (Math.random() * 65535) | 0;
  lnT = 0;
  lnM = 0;
  press = 0;
  x = 0.5;
  y = 0.5;
  colony = 0;
  rollz = 0;
  follow = 0;
  lim = 1;
  monT = 0;
  level = 0;
  choirLp = 0.1;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToDsp>) => this.onMsg(e.data);
  }

  onMsg(m: ToDsp) {
    switch (m.t) {
      case 'init':
        for (let i = 0; i < NP; i++) this.P[i] = this.S[i] = m.p[i] ?? PARAMS[i].def;
        this.order = m.order;
        this.cables = m.cables;
        this.ready = true;
        break;
      case 'p':
        this.P[m.i] = m.v;
        if (DISCRETE[m.i]) this.S[m.i] = m.v;
        break;
      case 'order':
        this.order = m.o;
        break;
      case 'cables':
        this.cables = m.c;
        break;
      case 'ev':
        for (const e of m.e) this.queue.push(e);
        this.queue.sort((a, b) => a.at - b.at);
        break;
      case 'ctl':
        if (m.k === 'press') this.press = m.v;
        else if (m.k === 'x') this.x = m.v;
        else if (m.k === 'y') this.y = m.v;
        else this.colony = m.v;
        break;
      case 'cmd': {
        const st = this.pedals[5] as Stige;
        if (m.c === 'capture') st.capture();
        else if (m.c === 'release') st.held = false;
        else {
          this.queue.length = 0;
          this.lead.noteOff();
          this.lead.env.stage = 3;
          for (const v of this.choir) v.on = false;
        }
        break;
      }
    }
  }

  apply(e: SynthEvent, frame: number) {
    const P = this.P;
    switch (e.k) {
      case 'n':
        this.lead.noteOn(e.hz, e.vel, e.slide === 1, e.dur, frame);
        this.lnT = e.t;
        this.lnM = e.m;
        if (!e.slide) {
          if (P[I['fa.trig']] === 0) this.fa.trig();
          if (P[I['fb.trig']] === 0) this.fb.trig();
        }
        break;
      case 'off':
        this.lead.noteOff();
        break;
      case 'c': {
        let v = this.choir.find((c) => c.idle);
        if (!v) {
          v = this.choir.reduce((a, b) => (b.age > a.age ? b : a));
        }
        const width = P[I['co.width']];
        const pan = e.kind === 2 ? 0.25 : (this.choirRR++ % 2 ? 1 : -1) * width * (0.3 + Math.random() * 0.7);
        v.start(e.hz, e.vel, e.dur, e.kind, frame, pan);
        break;
      }
      case 'g': {
        const base = expMap(P[I['rz.tone']], 60, 900);
        const ratios = [1, 1.335, 1.498, 1.782, 2.245];
        this.gongs[e.i].strike(base * ratios[e.i], P[I['rz.metal']], P[I['rz.decay']], e.vel);
        this.rollz = 1;
        if (P[I['fa.trig']] === 2) this.fa.trig();
        if (P[I['fb.trig']] === 2) this.fb.trig();
        break;
      }
      case 's': {
        // stepped random (Serge Smooth & Stepped / Buchla 266 stored random)
        this.stpTarget = this.randDist();
        // registro: a shift register that sometimes flips the bit it recycles
        const len = Math.round(P[I['reg.len']]);
        let bit = (this.reg >> (len - 1)) & 1;
        if (Math.random() > P[I['reg.lock']]) bit ^= 1;
        this.reg = ((this.reg << 1) | bit) & ((1 << len) - 1);
        if (P[I['fa.trig']] === 3) this.fa.trig();
        if (P[I['fb.trig']] === 3) this.fb.trig();
        for (const pd of this.pedals) pd.onStep();
        break;
      }
      case 'b':
        if (P[I['fa.trig']] === 1) this.fa.trig();
        if (P[I['fb.trig']] === 1) this.fb.trig();
        for (const pd of this.pedals) pd.onBar();
        break;
      case 'root': {
        let hz = e.hz;
        while (hz > 70) hz /= 2;
        while (hz < 35) hz *= 2;
        this.fono.baseTarget = hz;
        break;
      }
    }
  }

  /** Buchla 266-style distribution: 0 = clustered at the centre, ½ = uniform, 1 = pushed to the edges. */
  randDist() {
    const d = this.P[I['unc.dist']];
    const u = rnd();
    if (d < 0.5) {
      const g = (rnd() + rnd() + rnd() + rnd()) / 4;
      return u + (g - u) * (1 - d * 2);
    }
    const e = Math.sign(u) * Math.pow(Math.abs(u), 1 / (1 + (d - 0.5) * 6));
    return e;
  }

  /** Everything that runs every CR samples: slopes, random sources, the patchbay, coefficients. */
  control() {
    const P = this.P,
      S = this.S;
    for (let i = 0; i < NP; i++) if (!DISCRETE[i]) S[i] += (P[i] - S[i]) * 0.25;
    const bpm = P[I['g.bpm']];
    const heat = S[I['g.heat']];
    const L = this.lead;

    // sources
    const env = L.env.tick(expMap(S[I['env.rise']], 0.0008, 4), expMap(S[I['env.fall']], 0.004, 8), S[I['env.curve']], P[I['env.hold']] === 1, L.gate, false);
    const fa = this.fa.tick(expMap(S[I['fa.rise']], 0.002, 10), expMap(S[I['fa.fall']], 0.002, 10), S[I['fa.curve']], false, false, P[I['fa.cycle']] === 1);
    const fb = this.fb.tick(expMap(S[I['fb.rise']], 0.002, 10), expMap(S[I['fb.fall']], 0.002, 10), S[I['fb.curve']], false, false, P[I['fb.cycle']] === 1);
    let lfoHz: number;
    if (P[I['lfo.sync']] === 1) {
      const div = DIVS[Math.round(clamp(S[I['lfo.rate']], 0, 1) * (DIVS.length - 1))];
      lfoHz = 1 / (div.bars * 4 * (60 / bpm));
    } else lfoHz = expMap(S[I['lfo.rate']], 0.02, 30);
    const prev = this.lfoPh;
    this.lfoPh += (lfoHz * CR) / SR;
    this.lfoPh -= Math.floor(this.lfoPh);
    if (this.lfoPh < prev) this.lfoSH = rnd();
    const lp = this.lfoPh;
    const shape = P[I['lfo.shape']];
    const lfo = shape === 0 ? fsin(lp) : shape === 1 ? 1 - 4 * Math.abs(lp - 0.5) : shape === 2 ? 1 - 2 * lp : shape === 3 ? (lp < 0.5 ? 1 : -1) : this.lfoSH;
    // fluctuating random: cosine-interpolated random targets
    this.uncT += (CR / SR) * expMap(S[I['unc.rate']], 0.05, 20);
    if (this.uncT >= 1) {
      this.uncT -= Math.floor(this.uncT);
      this.uncFrom = this.uncTo;
      this.uncTo = this.randDist();
    }
    this.unc = this.uncFrom + (this.uncTo - this.uncFrom) * (0.5 - 0.5 * Math.cos(Math.PI * this.uncT));
    const slew = S[I['unc.slew']];
    this.stp += (this.stpTarget - this.stp) * (slew < 0.01 ? 1 : 1 - Math.exp(-CR / (slew * slew * 0.5 * SR)));
    const regLen = Math.round(P[I['reg.len']]);
    const reg = (this.reg / ((1 << regLen) - 1)) * 2 - 1;
    this.rollz *= Math.exp(-CR / (0.08 * SR));
    const src = this.src;
    src[0] = env;
    src[1] = fa;
    src[2] = fb;
    src[3] = lfo;
    src[4] = this.unc;
    src[5] = this.stp;
    src[6] = reg;
    src[7] = L.vel;
    src[8] = this.lnT;
    src[9] = this.lnM;
    src[10] = this.press;
    src[11] = this.x;
    src[12] = this.y;
    src[13] = this.rollz;
    src[14] = clamp((L.logF - Math.log2(55)) / 5);
    src[15] = clamp(this.follow * 3);
    src[16] = this.colony;

    // patchbay
    const md = this.md;
    md.fill(0);
    for (const [s, d, a] of this.cables) md[d] += a * src[s];

    // lead voice
    const glideT = 0.003 + S[I['voc.glide']] * S[I['voc.glide']] * 1.4;
    if (L.glideOn) L.logF += (L.target - L.logF) * (1 - Math.exp(-CR / (glideT * SR)));
    else L.logF = L.target;
    L.drift = clamp(L.drift + rnd() * 0.006 - L.drift * 0.0002, -1, 1);
    const cents = S[I['osc.fine']] * 100 + L.drift * S[I['voc.drift']] * 22;
    const semis = md[DST.pitch] * 24 + cents / 100 + P[I['voc.oct']] * 12;
    L.fA = Math.pow(2, L.logF + semis / 12);
    const ratioK = clamp(S[I['osc.ratio']] + md[DST.ratio]);
    const ratio = P[I['osc.harm']] === 1 ? HARMONIC_RATIOS[Math.round(ratioK * (HARMONIC_RATIOS.length - 1))] : 0.25 * Math.pow(32, ratioK);
    L.fB = L.fA * ratio;
    const fm = clamp(S[I['osc.fm']] + md[DST.fm] + heat * 0.25);
    L.fm = fm * fm * 9;
    L.am = clamp(S[I['osc.am']] + md[DST.am]);
    L.shape = clamp(S[I['osc.shape']] + md[DST.shape]);
    L.bshape = S[I['osc.bshape']];
    L.sync = P[I['osc.sync']] === 1;
    L.fold = clamp(S[I['osc.fold']] + md[DST.fold] + heat * 0.35);
    L.sym = S[I['osc.sym']];
    const lv = L.levels;
    lv.osc = S[I['osc.level']];
    lv.sub = S[I['src.sub']];
    lv.noise = clamp(S[I['src.noise']] + md[DST.noise]);
    lv.color = P[I['src.color']];
    lv.tangle = S[I['src.tangle']];
    lv.chaos = clamp(S[I['src.chaos']] + md[DST.chaos] + heat * 0.4);
    lv.string = S[I['src.string']];
    lv.field = S[I['src.field']];
    if (lv.color === 3) L.noise.drift();
    L.ksLen = Math.max(2, SR / L.fA - 0.5);
    L.ksFb = 0.9 + (1 - S[I['src.damp']]) * 0.0998;
    const track = Math.pow(L.fA / 261.6, S[I['flt.track']]);
    const cut = clamp(S[I['flt.cut']] + md[DST.cut]);
    L.svf.set(expMap(cut, 20, 18000) * track, clamp(S[I['flt.res']] + md[DST.res], 0, 0.98));
    L.mode = P[I['flt.type']];
    L.lpgMode = P[I['lpg.mode']];
    const base = clamp(S[I['lpg.base']] + md[DST.lpg]);
    L.vacCtl = clamp(base + env * L.vel * (1 - base));
    const decay = expMap(S[I['lpg.decay']], 0.04, 2.5) * (1 + 2 * (1 - L.vac));
    L.aRel = 1 - Math.exp(-1 / (decay * 0.25 * SR));
    L.lpg.set(expMap(Math.pow(L.vac, 0.9), 40, 19000), S[I['lpg.res']] * 0.9);

    // choir
    this.choirLp = onePole(expMap(S[I['co.tone']], 250, 9000));

    // pedals: effective knob values, with Chase Bliss-style ramps
    const barS = 4 * (60 / bpm);
    for (let n = 0; n < PEDALS.length; n++) {
      const def = PEDALS[n];
      const pd = this.pedals[n];
      const pre = `fx.${def.id}.`;
      pd.dip = P[I[pre + 'dip']];
      const mode = P[I[pre + 'rmode']];
      const per = DIVS[Math.round(P[I[pre + 'ramp']])].bars * barS;
      pd.rp += CR / SR / per;
      if (mode === 1) {
        pd.rp -= Math.floor(pd.rp);
        pd.rv = pd.rp;
      } else if (mode === 2) {
        pd.rp -= Math.floor(pd.rp);
        pd.rv = 1 - Math.abs(2 * pd.rp - 1);
      } else if (mode === 3) pd.rv += (clamp(pd.envf * 4) - pd.rv) * 0.1;
      else pd.rv = 1;
      const pol = pd.has(DIP_POL);
      for (let k = 0; k < def.knobs.length; k++) {
        const id = I[pre + def.knobs[k]];
        const v = DISCRETE[id] ? P[id] : S[id];
        if (mode !== 0 && pd.has(k)) {
          const sp = PARAMS[id];
          const lo = pol ? v : sp.min,
            hi = pol ? sp.max : v;
          pd.kv[k] = lo + (hi - lo) * pd.rv;
        } else pd.kv[k] = v;
      }
      const target = P[I[pre + 'on']];
      pd.wet += (target - pd.wet) * 0.15;
      if (pd.wet < 0.0005 && target === 0) pd.wet = 0;
      pd.control(bpm);
    }
    (this.pedals[1] as Flegetonte).heat = heat;
    (this.pedals[3] as Mnemosine).scanMod = md[DST.grain];
    (this.pedals[6] as Cocito).sizeMod = md[DST.verb];
    (this.pedals[7] as Lete).wowMod = md[DST.wow];

    this.fono.control(S[I['fo.level']], S[I['fo.motion']]);
    if (P[I['fo.follow']] === 0) this.fono.baseTarget = expMap(S[I['fo.base']], 27.5, 220);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const oL = out[0],
      oR = out[1] ?? out[0];
    if (!this.ready) return true;
    const inp = inputs[0]?.[0];
    const S = this.S;
    const L = this.lead;
    const n = oL.length;
    const q = this.queue;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const frame = currentFrame + i;
      if ((frame & (CR - 1)) === 0) {
        this.control();
        this.monT += CR;
      }
      const t = frame / SR;
      while (q.length && q[0].at <= t) this.apply(q.shift()!, frame);
      if (L.offAt >= 0 && frame >= L.offAt) L.noteOff();

      const field = inp ? inp[i] : 0;
      const fa = Math.abs(inp ? field : 0);
      this.follow += (fa - this.follow) * (fa > this.follow ? 0.01 : 0.0003);

      // lead
      const ampMod = clamp(1 + this.md[DST.amp], 0, 2);
      const v = L.sample(field) * S[I['voc.level']] * ampMod;
      const pan = clamp(S[I['voc.pan']] + this.md[DST.pan], -1, 1);
      let l = v * (1 - Math.max(0, pan)),
        r = v * (1 + Math.min(0, pan));
      if (!inp) {
        const a = Math.abs(v);
        this.follow += (a - this.follow) * (a > this.follow ? 0.01 : 0.0003);
      }

      // choir
      const coLevel = S[I['co.level']],
        cpLevel = S[I['cp.level']];
      const det = S[I['co.detune']] * 0.012;
      const cshape = S[I['co.shape']];
      const atk = expMap(S[I['co.attack']], 0.004, 3),
        rel = expMap(S[I['co.release']], 0.05, 6);
      for (const c of this.choir) {
        if (c.idle) continue;
        c.age++;
        if (c.on && frame >= c.offAt) c.on = false;
        let target: number, tau: number;
        if (c.kind === 0) {
          target = c.on ? 1 : 0;
          tau = c.on ? atk : rel;
        } else if (c.kind === 1) {
          target = c.age < SR * 0.004 ? 1 : 0;
          tau = c.age < SR * 0.004 ? 0.001 : rel * 0.3;
        } else {
          target = c.on ? 0.8 : 0;
          tau = c.on ? 0.012 : 0.18;
        }
        c.env += (target - c.env) * (1 - Math.exp(-1 / (tau * SR)));
        if (!c.on && c.env < 0.0005) {
          c.env = 0;
          continue;
        }
        const d1 = (c.hz * (1 + det)) / SR,
          d2 = (c.hz * (1 - det)) / SR;
        c.p1 += d1;
        if (c.p1 >= 1) c.p1 -= 1;
        c.p2 += d2;
        if (c.p2 >= 1) c.p2 -= 1;
        const saw1 = 2 * c.p1 - 1 - blep(c.p1, d1),
          saw2 = 2 * c.p2 - 1 - blep(c.p2, d2);
        const tri1 = 1 - 4 * Math.abs(c.p1 - 0.5),
          tri2 = 1 - 4 * Math.abs(c.p2 - 0.5);
        const sh = c.kind === 2 ? 0.1 : cshape;
        let x = (tri1 + tri2) * (1 - sh) + (saw1 + saw2) * sh;
        const k = c.kind === 1 ? Math.min(0.9, this.choirLp * (0.5 + c.env * 2)) : this.choirLp;
        c.lp1 += (x - c.lp1) * k;
        c.lp2 += (c.lp1 - c.lp2) * k;
        x = c.lp2 * c.env * c.vel * 0.22 * (c.kind === 2 ? cpLevel : coLevel);
        l += x * (1 - Math.max(0, c.pan));
        r += x * (1 + Math.min(0, c.pan));
      }

      // gongue
      const gl = S[I['rz.level']];
      if (gl > 0) {
        for (let g = 0; g < 5; g++) {
          const y = this.gongs[g].run();
          if (y !== 0) {
            const pp = (g - 2) * 0.35;
            l += y * gl * 0.5 * (1 - Math.max(0, pp));
            r += y * gl * 0.5 * (1 + Math.min(0, pp));
          }
        }
      }

      // fonologia
      const fl = S[I['fo.level']];
      if (fl > 0.0005) {
        const fo = this.fono;
        const stretch = 1 + S[I['fo.spread']] * 0.35;
        const beat = S[I['fo.beat']] * 1.8;
        const tilt = S[I['fo.tilt']] * 1.6;
        let a = 0,
          b = 0;
        for (let k = 0; k < 9; k++) {
          const f = fo.base * Math.pow(k + 1, stretch) + beat * ((k % 3) - 1);
          if (f > SR * 0.45) continue;
          fo.ph[k] += f / SR;
          if (fo.ph[k] >= 1) fo.ph[k] -= 1;
          const y = fsin(fo.ph[k]) * fo.amp[k] * Math.pow(k + 1, -tilt);
          if (k % 2) a += y;
          else b += y;
        }
        l += (a * 0.8 + b * 0.2) * fl * 0.22;
        r += (b * 0.8 + a * 0.2) * fl * 0.22;
      }

      // pedalboard
      for (let o = 0; o < this.order.length; o++) {
        const pd = this.pedals[this.order[o]];
        if (pd.wet <= 0) continue;
        const e = Math.abs(l) + Math.abs(r);
        pd.envf += (e - pd.envf) * (e > pd.envf ? 0.01 : 0.0004);
        pd.run(l, r);
        const w = pd.wet;
        l += (pd.ol - l) * w;
        r += (pd.or - r) * w;
      }

      // master: volume, peak limiter, soft clip
      const vol = S[I['g.vol']];
      l *= vol;
      r *= vol;
      const pk = Math.max(Math.abs(l), Math.abs(r));
      const want = pk > 0.9 ? 0.9 / pk : 1;
      this.lim += (want - this.lim) * (want < this.lim ? 0.3 : 0.0002);
      l = tanh(l * this.lim);
      r = tanh(r * this.lim);
      if (!(l === l)) l = 0; // NaN guard
      if (!(r === r)) r = 0;
      oL[i] = l;
      if (oR !== oL) oR[i] = r;
      sumSq += l * l + r * r;
    }
    this.level += (Math.sqrt(sumSq / (2 * n)) - this.level) * 0.3;

    if (this.monT >= SR / 30) {
      this.monT = 0;
      const st = this.pedals[5] as Stige;
      this.port.postMessage({
        t: 'mon',
        s: Array.from(this.src),
        r: this.pedals.map((p) => p.rv),
        loop: st.held ? st.pos / st.len : -1,
        held: st.held ? 1 : 0,
        grains: (this.pedals[3] as Mnemosine).grains.length,
        level: this.level,
      });
    }
    return true;
  }
}

registerProcessor('orfeo', Orfeo);
