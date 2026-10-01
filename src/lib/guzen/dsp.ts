/**
 * GUZEN's engine, in plain TypeScript. The AudioWorklet runs it in the browser and scripts/check-guzen.mts
 * runs it under Node, so nothing here touches the Web Audio API.
 *
 * It is a port of the VST3 plugin of the same name: six agents, each a complex oscillator into a wavefolder
 * into a vactrol low-pass gate, triggered by chance. All of that chance comes from one 48-bit linear
 * congruential generator, the same one JUCE uses (and java.util.Random before it), so a piece is a function
 * of its seed and its knob positions. Draws are made in the same order as the plugin makes them.
 */
import { AGENT0, AGENT_STRIDE, G, GEN0, GEN_MULT, LEAF, NUM_AGENTS, NUM_GENS, QUARTERS, SCALE_DEGREES } from './params';

const TAU = Math.PI * 2;
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
/** Flush values too small to matter to zero: subnormal numbers make some CPUs very slow. */
const den = (x: number) => (x > -1e-20 && x < 1e-20 ? 0 : x);

// ── the dice ────────────────────────────────────────────────────────────────

const AL = 0xece66d; // the low 24 bits of the multiplier 0x5DEECE66D
const AH = 0x5de; // and its high 12 bits
const M24 = 16777216;

/**
 * s ← (s · 0x5DEECE66D + 11) mod 2⁴⁸, and the output is the top 32 bits of s. The state is held as two 24-bit
 * halves because a 48-bit product does not fit in a double; every partial product below stays under 2⁵³.
 */
export class Lcg48 {
  hi = 0;
  lo = 0;
  constructor(seed = 1) {
    this.seed(seed);
  }
  seed(n: number) {
    n = Number.isFinite(n) ? Math.floor(Math.abs(n)) % 2 ** 48 : 1;
    this.hi = Math.floor(n / M24);
    this.lo = n - this.hi * M24;
  }
  get state() {
    return this.hi * M24 + this.lo;
  }
  next32() {
    const t = this.lo * AL + 11;
    const carry = Math.floor(t / M24);
    const lo = t - carry * M24;
    const mid = this.hi * AL + this.lo * AH + carry;
    this.hi = mid - Math.floor(mid / M24) * M24;
    this.lo = lo;
    return this.hi * 256 + (lo >>> 16);
  }
  /** A float in [0, 1). */
  float() {
    return Math.min(this.next32() / 4294967296, 1 - 1.1920929e-7);
  }
}

/** The three kinds of unpredictability, after the Buchla 266 Source of Uncertainty. */
export class Uncertainty {
  rng = new Lcg48();
  current = 0;
  private sr = 48000;
  private phase = 0;
  private inc = 0;
  private from = 0;
  private to = 0;

  prepare(sr: number) {
    this.sr = sr;
    this.setDriftRate(0.5);
    this.reset();
  }
  reset() {
    this.phase = 0;
    this.from = this.to = this.current = 0;
  }
  setDriftRate(hz: number) {
    this.inc = clamp(hz, 0.01, 50) / this.sr;
  }

  /** The continuous source: random targets joined by smoothstep, so it never has a corner. */
  advance() {
    this.phase += this.inc;
    if (this.phase >= 1) {
      this.phase -= 1;
      this.from = this.to;
      this.to = this.rng.float() * 2 - 1;
    }
    const t = this.phase;
    this.current = this.from + (this.to - this.from) * (t * t * (3 - 2 * t));
  }

  /** Raise a uniform draw to a power that BIAS sweeps from 1/4 to 4. Centre leaves it uniform. */
  shape(u: number, bias: number) {
    const e = Math.pow(2, (clamp(bias, 0, 1) - 0.5) * 4);
    return Math.pow(clamp(u, 0, 1), e);
  }
  /** One of `states` evenly spaced values, 0 to 1. */
  stepped(states: number, bias: number) {
    const n = clamp(Math.floor(states), 2, 32);
    const shaped = this.shape(this.rng.float(), bias);
    return clamp(Math.floor(shaped * n), 0, n - 1) / (n - 1);
  }
  /** Sample and hold with a shapeable distribution, 0 to 1. */
  stored(bias: number) {
    return this.shape(this.rng.float(), bias);
  }
  chance(p: number) {
    return this.rng.float() < clamp(p, 0, 1);
  }
}

// ── pitch ───────────────────────────────────────────────────────────────────

/** Snaps a random value to a scale. C2 is the floor, so six octaves of spread stay in the audio range. */
export class Quantizer {
  scale = 3;
  root = 0;
  toHz(value01: number, spreadOctaves: number, octaveOffset: number) {
    const degrees = SCALE_DEGREES[clamp(this.scale, 0, SCALE_DEGREES.length - 1)];
    const semis = clamp(value01, 0, 1) * clamp(spreadOctaves, 0, 6) * 12;
    const octave = Math.floor(semis / 12);
    const within = semis - octave * 12;
    let best = degrees[0];
    let bestD = Math.abs(within - best);
    for (let i = 1; i < degrees.length; i++) {
      const d = Math.abs(within - degrees[i]);
      if (d < bestD) {
        bestD = d;
        best = degrees[i];
      }
    }
    const midi = clamp(36 + this.root + octaveOffset * 12 + octave * 12 + best, 12, 127);
    return 440 * Math.pow(2, (midi - 69) / 12);
  }
}

// ── the clock ───────────────────────────────────────────────────────────────

/** A master clock feeding three generators. A tick is an opportunity, not an event: it fires with a probability. */
export class Clock {
  static readonly SLOTS = NUM_GENS + 1;
  static readonly MASTER = NUM_GENS;
  private sr = 48000;
  private rate = 2;
  private swing = 0;
  private phase = new Float64Array(Clock.SLOTS);
  private inc = new Float64Array(Clock.SLOTS);
  private mult = new Float64Array(Clock.SLOTS).fill(1);
  private prob = new Float64Array(Clock.SLOTS).fill(1);
  private even = new Uint8Array(Clock.SLOTS).fill(1);
  private did = new Uint8Array(Clock.SLOTS);

  prepare(sr: number) {
    this.sr = sr;
    this.update();
    this.reset();
  }
  reset() {
    this.phase.fill(0);
    this.even.fill(1);
    this.did.fill(0);
  }
  setRate(hz: number) {
    this.rate = clamp(hz, 0.02, 40);
    this.update();
  }
  setSynced(bpm: number, div: number) {
    this.rate = clamp(bpm / 60 / QUARTERS[clamp(div, 0, QUARTERS.length - 1)], 0.02, 40);
    this.update();
  }
  /** Past about 0.4 the short half is too short to hear as a pulse. */
  setSwing(a: number) {
    this.swing = clamp(a, 0, 1) * 0.4;
  }
  setGenerator(i: number, multIndex: number, probability: number) {
    this.mult[i] = GEN_MULT[clamp(Math.round(multIndex), 0, GEN_MULT.length - 1)];
    this.prob[i] = clamp(probability, 0, 1);
    this.update();
  }
  private update() {
    for (let i = 0; i < Clock.SLOTS; i++) this.inc[i] = (this.rate * this.mult[i]) / this.sr;
  }
  advance(u: Uncertainty) {
    for (let i = 0; i < Clock.SLOTS; i++) {
      this.did[i] = 0;
      this.phase[i] += this.inc[i];
      // swing lengthens every other interval and shortens the one after, so a pair still takes the same time
      const threshold = this.even[i] ? 1 + this.swing : 1 - this.swing;
      if (this.phase[i] >= threshold) {
        this.phase[i] -= threshold;
        this.even[i] ^= 1;
        this.did[i] = u.chance(this.prob[i]) ? 1 : 0;
      }
    }
  }
  fired(slot: number) {
    return this.did[slot] === 1;
  }
}

// ── filters ─────────────────────────────────────────────────────────────────

/** A topology-preserving state-variable filter, low-pass output. */
export class Svf {
  private g = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private ic1 = 0;
  private ic2 = 0;
  setup(fc: number, sr: number, k: number) {
    this.g = Math.tan((Math.PI * clamp(fc, 20, sr * 0.45)) / sr);
    this.a1 = 1 / (1 + this.g * (this.g + k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }
  reset() {
    this.ic1 = this.ic2 = 0;
  }
  lp(x: number) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = den(2 * v1 - this.ic1);
    this.ic2 = den(2 * v2 - this.ic2);
    return v2;
  }
}

class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;
  lowpass(fc: number, sr: number, q: number) {
    const w0 = (TAU * fc) / sr;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  reset() {
    this.z1 = this.z2 = 0;
  }
  process(x: number) {
    const y = this.b0 * x + this.z1;
    this.z1 = den(this.b1 * x - this.a1 * y + this.z2);
    this.z2 = den(this.b2 * x - this.a2 * y);
    return y;
  }
}

// ── the oscillator and the folder ───────────────────────────────────────────

/**
 * An exact triangle fold into [-1, 1], equal to (2/π)·asin(sin(πx/2)). Reflecting in a loop works too, but
 * the loop count grows with the drive. This folds any input, however hot, in constant time.
 */
export const triFold = (x: number) => {
  const t = (x - 1) * 0.25;
  return 1 - 4 * Math.abs(t - Math.floor(t + 0.5));
};

/**
 * A principal oscillator, phase-modulated by a second one, into a wavefolder. Folding is where the harmonics
 * come from, and it makes far more of them than fit under Nyquist, so this runs at twice the sample rate and
 * is filtered on the way down by a fourth-order Butterworth. That quietens the aliases; it does not remove them.
 */
export class ComplexOscillator {
  private osr = 96000;
  private pPhase = 0;
  private mPhase = 0;
  private freq = 110;
  private ratio = 1.5;
  private fm = 0;
  private fold = 0;
  private sym = 0;
  private dA = new Biquad();
  private dB = new Biquad();

  prepare(sr: number) {
    this.osr = sr * 2;
    this.dA.lowpass(sr * 0.45, this.osr, 0.5411961);
    this.dB.lowpass(sr * 0.45, this.osr, 1.30656296);
    this.reset();
  }
  reset() {
    this.pPhase = this.mPhase = 0;
    this.dA.reset();
    this.dB.reset();
  }
  set(freq: number, ratio: number, fm: number, fold: number, sym: number) {
    this.freq = clamp(freq, 0.01, 12000);
    this.ratio = clamp(ratio, 0.1, 16);
    this.fm = clamp(fm, 0, 1);
    this.fold = clamp(fold, 0, 1);
    this.sym = clamp(sym, -1, 1);
  }
  private once() {
    this.mPhase += (this.freq * this.ratio) / this.osr;
    this.mPhase -= Math.floor(this.mPhase);
    this.pPhase += this.freq / this.osr;
    this.pPhase -= Math.floor(this.pPhase);
    const mod = Math.sin(TAU * this.mPhase);
    // FM as a phase offset; the top of the control is dense but still tracks pitch
    const s = Math.sin(TAU * (this.pPhase + this.fm * 2.5 * mod));
    // drive, then symmetry as an offset: folding an asymmetric wave is what gives the even harmonics
    const folded = triFold(s * (1 + this.fold * 7) + this.sym * this.fold);
    // real folders use diodes, which do not switch instantly: soften the corners
    return Math.tanh(folded * 1.3) * 0.82;
  }
  process() {
    this.dB.process(this.dA.process(this.once()));
    return this.dB.process(this.dA.process(this.once()));
  }
}

// ── the gate ────────────────────────────────────────────────────────────────

export const GATE_VCA = 0;
export const GATE_VCF = 1;
export const GATE_BOTH = 2;

/**
 * A low-pass gate modelled as a vactrol: an LED shining on a photoresistor that has memory. It brightens in
 * a couple of milliseconds and darkens slowly, and the darker it gets the slower it goes. One conductance c
 * sets both level and cutoff, so quiet means dull.
 *
 * Closing the gate steps  c ← c − c·k·(0.12 + 0.88 c),  k = 1 − e^(−1/(T·fs)). For small steps that is
 * dc/dt = −(0.12 c + 0.88 c²)/T, and with u = 1/c it solves to  c(t) = 1/((25/3)·e^(0.12 t/T) − 22/3).
 */
export class LowpassGate {
  conductance = 0;
  private sr = 48000;
  private mode = GATE_BOTH;
  private colour = 0.6;
  private rise = 0;
  private fall = 0;
  private svf = new Svf();
  private last = -1;

  prepare(sr: number) {
    this.sr = sr;
    this.rise = 1 - Math.exp(-1 / (0.0025 * sr));
    this.setFall(0.4);
    this.reset();
  }
  reset() {
    this.conductance = 0;
    this.svf.reset();
    this.last = -1;
  }
  setMode(m: number) {
    this.mode = clamp(Math.round(m), 0, 2);
  }
  setColour(c: number) {
    this.colour = clamp(c, 0, 1);
  }
  setFall(seconds: number) {
    this.fall = 1 - Math.exp(-1 / (clamp(seconds, 0.01, 8) * this.sr));
  }
  process(input: number, control: number) {
    const target = clamp(control, 0, 1);
    if (target > this.conductance) this.conductance += (target - this.conductance) * this.rise;
    else this.conductance += (target - this.conductance) * this.fall * (0.12 + 0.88 * this.conductance);
    this.conductance = clamp(this.conductance, 0, 1);
    if (this.conductance < 1e-9 && target === 0) this.conductance = 0;
    const c = this.conductance;

    let s = input;
    if (this.mode !== GATE_VCA) {
      // the cutoff follows c squared: the gate closes optically, not linearly
      const cutoff = 30 + (12000 * this.colour - 30) * c * c;
      if (Math.abs(cutoff - this.last) > 0.5) {
        this.svf.setup(cutoff, this.sr, 1.4);
        this.last = cutoff;
      }
      s = this.svf.lp(s);
    }
    // a little better than linear: the ear hears the tail for longer
    if (this.mode !== GATE_VCF) s *= Math.pow(c, 1.4);
    return s;
  }
}

// ── an agent ────────────────────────────────────────────────────────────────

export interface AgentParams {
  octave: number;
  fine: number;
  ratio: number;
  fm: number;
  fold: number;
  symmetry: number;
  lpgMode: number;
  lpgFall: number;
  lpgColour: number;
  rise: number;
  fall: number;
  cycle: boolean;
  trigProb: number;
  envProb: number;
  pitchSource: number;
  pitchSpread: number;
  pitchBias: number;
  pan: number;
  panChance: number;
  level: number;
  enabled: boolean;
}

const IDLE = 0;
const RISING = 1;
const FALLING = 2;

/**
 * One voice: complex oscillator, wavefolder, low-pass gate, driven by a function generator that chance
 * triggers. The envelope's height is a ceiling that is rolled again on every trigger, not a value.
 */
export class Agent {
  panL = Math.SQRT1_2;
  panR = Math.SQRT1_2;
  private sr = 48000;
  private p!: AgentParams;
  private osc = new ComplexOscillator();
  private gate = new LowpassGate();
  private stage = IDLE;
  private env = 0;
  private ceiling = 1;
  private riseInc = 0.01;
  private fallInc = 0.001;
  private pan = 0;
  private hz = 220;
  private count = 0;
  private wasOn = true;
  // The folder is asymmetric when SYMMETRY is off-centre, which puts a constant offset in the wave. The
  // plugin leaves it for the host to deal with; here it is removed before the gate, so it can't thump.
  private dcX = 0;
  private dcY = 0;
  private dcR = 0.999;

  get activity() {
    return this.gate.conductance;
  }

  prepare(sr: number) {
    this.sr = sr;
    this.dcR = 1 - (TAU * 5) / sr;
    this.osc.prepare(sr);
    this.gate.prepare(sr);
    this.reset();
  }
  /** Back to the state of a new agent, so a restart replays the piece sample for sample. */
  reset() {
    this.osc.reset();
    this.gate.reset();
    this.stage = IDLE;
    this.env = 0;
    this.ceiling = 1;
    this.count = 0;
    this.hz = 220;
    this.pan = 0;
    this.gains();
    this.wasOn = true;
    this.dcX = this.dcY = 0;
  }
  setParams(p: AgentParams) {
    this.p = p;
    this.gate.setMode(p.lpgMode);
    this.gate.setFall(p.lpgFall);
    this.gate.setColour(p.lpgColour);
    this.riseInc = 1 / Math.max(1, p.rise * this.sr);
    this.fallInc = 1 / Math.max(1, p.fall * this.sr);
    // with no scatter the position is fixed, so settle it here
    if (p.panChance <= 0.001) {
      this.pan = p.pan;
      this.gains();
    }
  }
  private gains() {
    const a = ((clamp(this.pan, -1, 1) + 1) * Math.PI) / 4;
    this.panL = Math.cos(a);
    this.panR = Math.sin(a);
  }
  private pitch(q: Quantizer, v01: number) {
    this.hz = q.toHz(v01, this.p.pitchSpread, this.p.octave) * Math.pow(2, this.p.fine / 12);
  }
  private trigger(u: Uncertainty, q: Quantizer) {
    const p = this.p;
    // Ongaku's idea: the envelope control sets the highest the envelope may go, not where it does go
    this.ceiling = clamp(1 - p.envProb * u.stored(0.5), 0.05, 1);
    this.stage = RISING;
    if (p.pitchSource === 1) this.pitch(q, u.stepped(7, p.pitchBias));
    else if (p.pitchSource === 2) this.pitch(q, u.stored(p.pitchBias));
    if (p.panChance > 0.001) this.pan = clamp(p.pan + (u.stored(0.5) * 2 - 1) * p.panChance, -1, 1);
    else this.pan = p.pan;
    this.gains();
  }
  process(triggered: boolean, u: Uncertainty, q: Quantizer) {
    const p = this.p;
    if (!p.enabled) {
      if (this.wasOn) {
        this.gate.reset();
        this.wasOn = false;
      }
      this.env = 0;
      this.stage = IDLE;
      return 0;
    }
    this.wasOn = true;
    if (triggered) this.trigger(u, q);

    // the continuous source glides, so it is read outside the trigger
    if (p.pitchSource === 0 && --this.count <= 0) {
      this.count = 32;
      this.pitch(q, u.current * 0.5 + 0.5);
    }

    switch (this.stage) {
      case RISING:
        this.env += this.riseInc;
        if (this.env >= this.ceiling) {
          this.env = this.ceiling;
          this.stage = FALLING;
        }
        break;
      case FALLING:
        this.env -= this.fallInc;
        if (this.env <= 0) {
          this.env = 0;
          this.stage = p.cycle ? RISING : IDLE;
          // a cycling generator picks a new ceiling each pass, so even free-running agents keep moving
          if (p.cycle) this.ceiling = clamp(1 - p.envProb * u.stored(0.5), 0.05, 1);
        }
        break;
      default:
        if (p.cycle) this.stage = RISING;
    }

    this.osc.set(this.hz, p.ratio, p.fm, p.fold, p.symmetry);
    const raw = this.osc.process();
    const ac = raw - this.dcX + this.dcR * this.dcY;
    this.dcX = raw;
    this.dcY = den(ac);
    const out = this.gate.process(ac, this.env) * p.level;
    return Number.isFinite(out) ? out : 0;
  }
}

// ── the room ────────────────────────────────────────────────────────────────

class Comb {
  private buf: Float64Array;
  private i = 0;
  private last = 0;
  constructor(size: number) {
    this.buf = new Float64Array(size);
  }
  clear() {
    this.buf.fill(0);
    this.last = 0;
  }
  process(x: number, damp: number, fb: number) {
    const out = this.buf[this.i];
    this.last = den(out * (1 - damp) + this.last * damp);
    this.buf[this.i] = x + this.last * fb;
    if (++this.i >= this.buf.length) this.i = 0;
    return out;
  }
}

class Allpass {
  private buf: Float64Array;
  private i = 0;
  constructor(size: number) {
    this.buf = new Float64Array(size);
  }
  clear() {
    this.buf.fill(0);
  }
  process(x: number) {
    const b = this.buf[this.i];
    this.buf[this.i] = x + b * 0.5;
    if (++this.i >= this.buf.length) this.i = 0;
    return b - x;
  }
}

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const SPREAD = 23;

/** Freeverb, with the gains JUCE's Reverb uses, so the plugin's presets keep their balance. */
export class Reverb {
  private c: Comb[][];
  private a: Allpass[][];
  private feedback = 0.9;
  private damp = 0.2;
  private wet = 0.75;
  private dry = 1.5;
  constructor(sr: number) {
    const k = sr / 44100;
    this.c = [0, 1].map((ch) => COMBS.map((n) => new Comb(Math.floor((n + ch * SPREAD) * k))));
    this.a = [0, 1].map((ch) => ALLPASSES.map((n) => new Allpass(Math.floor((n + ch * SPREAD) * k))));
  }
  reset() {
    this.c.flat().forEach((x) => x.clear());
    this.a.flat().forEach((x) => x.clear());
  }
  set(room: number, damping: number, mix: number) {
    this.feedback = 0.7 + clamp(room, 0, 1) * 0.28;
    this.damp = clamp(damping, 0, 1) * 0.4;
    this.wet = mix * 3;
    this.dry = (1 - mix) * 2;
  }
  /** In place, over the first `n` samples of each channel. */
  process(L: Float64Array | Float32Array, R: Float64Array | Float32Array, n: number) {
    for (let s = 0; s < n; s++) {
      const x = (L[s] + R[s]) * 0.015;
      let l = 0;
      let r = 0;
      for (let j = 0; j < COMBS.length; j++) {
        l += this.c[0][j].process(x, this.damp, this.feedback);
        r += this.c[1][j].process(x, this.damp, this.feedback);
      }
      for (let j = 0; j < ALLPASSES.length; j++) {
        l = this.a[0][j].process(l);
        r = this.a[1][j].process(r);
      }
      L[s] = l * this.wet + L[s] * this.dry;
      R[s] = r * this.wet + R[s] * this.dry;
    }
  }
}

/** Transparent below the knee, then bends smoothly so the output never passes 1. */
export const softLimit = (x: number) => {
  const T = 0.7;
  const a = Math.abs(x);
  return a <= T ? x : Math.sign(x) * (T + (1 - T) * Math.tanh((a - T) / (1 - T)));
};

// ── the whole instrument ────────────────────────────────────────────────────

/** Six agents summing flat would clip on a dense passage. */
const MIX_TRIM = 0.42;

export class Guzen {
  readonly sr: number;
  /** The parameter values, indexed as in params.ts. Write through `set`. */
  p: Float64Array;
  readonly agents = Array.from({ length: NUM_AGENTS }, () => new Agent());
  readonly clock = new Clock();
  readonly dice = new Uncertainty();
  private quant = new Quantizer();
  private room: Reverb;
  private mfL = new Svf();
  private mfR = new Svf();
  private slot = new Int32Array(NUM_AGENTS);
  private prob = new Float64Array(NUM_AGENTS);
  private ap: AgentParams[] = Array.from({ length: NUM_AGENTS }, () => ({}) as AgentParams);
  private dirty = true;
  private master = 0.7;
  /** Peak of the last block, for a meter. */
  peak = 0;

  constructor(sr: number, p: Float64Array, seed = 1) {
    this.sr = sr;
    this.p = p;
    this.room = new Reverb(sr);
    this.dice.prepare(sr);
    this.clock.prepare(sr);
    this.agents.forEach((a) => a.prepare(sr));
    this.restart(seed);
  }

  /** Start the piece again from its seed: the same seed and knobs give the same piece. */
  restart(seed: number) {
    this.dice.rng.seed(seed);
    this.dice.reset();
    this.clock.reset();
    this.agents.forEach((a) => a.reset());
    this.room.reset();
    this.mfL.reset();
    this.mfR.reset();
    this.dirty = true;
  }

  set(i: number, v: number) {
    this.p[i] = v;
    this.dirty = true;
  }

  /** Read the knobs into the engine. Done once per block, and only when something moved. */
  private pull() {
    const p = this.p;
    this.quant.scale = p[G.scale];
    this.quant.root = p[G.root];
    this.dice.setDriftRate(p[G.drift]);
    if (p[G.clockSync] > 0.5) this.clock.setSynced(p[G.tempo], Math.round(p[G.clockDiv]));
    else this.clock.setRate(p[G.clockRate]);
    this.clock.setSwing(p[G.swing]);
    for (let g = 0; g < NUM_GENS; g++) this.clock.setGenerator(g, p[GEN0 + g * 2], p[GEN0 + g * 2 + 1]);

    for (let i = 0; i < NUM_AGENTS; i++) {
      const o = AGENT0 + i * AGENT_STRIDE;
      const a = this.ap[i];
      a.octave = p[o + LEAF.octave];
      a.fine = p[o + LEAF.fine];
      a.ratio = p[o + LEAF.ratio];
      a.fm = p[o + LEAF.fm];
      a.fold = p[o + LEAF.fold];
      a.symmetry = p[o + LEAF.symmetry];
      a.lpgMode = p[o + LEAF.lpgMode];
      a.lpgFall = p[o + LEAF.lpgFall];
      a.lpgColour = p[o + LEAF.lpgColour];
      a.rise = p[o + LEAF.rise];
      a.fall = p[o + LEAF.fall];
      a.cycle = p[o + LEAF.cycle] > 0.5;
      a.trigProb = p[o + LEAF.trigProb];
      a.envProb = p[o + LEAF.envProb];
      a.pitchSource = Math.round(p[o + LEAF.pitchSource]);
      a.pitchSpread = p[o + LEAF.pitchSpread];
      a.pitchBias = p[o + LEAF.pitchBias];
      a.pan = p[o + LEAF.pan];
      a.panChance = p[o + LEAF.panChance];
      a.level = p[o + LEAF.level];
      a.enabled = p[o + LEAF.on] > 0.5;
      this.agents[i].setParams(a);
      // "free" follows the bare master clock instead of a generator
      const src = Math.round(p[o + LEAF.trigSource]);
      this.slot[i] = src >= NUM_GENS ? Clock.MASTER : src;
      this.prob[i] = a.trigProb;
    }

    // Q runs from 0.5 to 3.5. The plugin hands this knob straight to a filter that only accepts 0.1 to 0.9,
    // which is overdamped throughout; here the whole range does something.
    const k = 1 / (0.5 + 3 * p[G.reso]);
    this.mfL.setup(p[G.cutoff], this.sr, k);
    this.mfR.setup(p[G.cutoff], this.sr, k);
    this.room.set(p[G.revSize], p[G.revDamp], p[G.revMix]);
    this.master = p[G.master];
    this.dirty = false;
  }

  /** Render `n` samples into L and R. */
  process(L: Float32Array | Float64Array, R: Float32Array | Float64Array, n: number) {
    if (this.dirty) this.pull();
    const { dice, clock, quant, agents, slot, prob } = this;

    for (let s = 0; s < n; s++) {
      dice.advance();
      clock.advance(dice);
      let l = 0;
      let r = 0;
      for (let i = 0; i < NUM_AGENTS; i++) {
        // two gates in series: the generator has to fire, and then the agent's own probability has to pass too
        const tick = clock.fired(slot[i]);
        const triggered = tick && dice.chance(prob[i]);
        const a = agents[i];
        const x = a.process(triggered, dice, quant);
        l += x * a.panL;
        r += x * a.panR;
      }
      L[s] = this.mfL.lp(l * MIX_TRIM);
      R[s] = this.mfR.lp(r * MIX_TRIM);
    }

    this.room.process(L, R, n);

    let peak = 0;
    const m = this.master;
    for (let s = 0; s < n; s++) {
      const a = softLimit(L[s] * m);
      const b = softLimit(R[s] * m);
      L[s] = Number.isFinite(a) ? a : 0;
      R[s] = Number.isFinite(b) ? b : 0;
      const q = Math.max(Math.abs(L[s]), Math.abs(R[s]));
      if (q > peak) peak = q;
    }
    this.peak = peak;
  }
}
