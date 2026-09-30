/**
 * Genoma's DSP kit: small, pure classes that take the sample rate in their
 * constructor, so the audio thread and the node tests run the same code.
 */
export const TAU = Math.PI * 2;

const TBL = 4096;
const SIN = new Float32Array(TBL + 1);
for (let i = 0; i <= TBL; i++) SIN[i] = Math.sin((i / TBL) * TAU);
/** sin(2π·c) by table, c in cycles (any real). */
export function fsin(c: number) {
  c -= Math.floor(c);
  const x = c * TBL;
  const i = x | 0;
  return SIN[i] + (SIN[i + 1] - SIN[i]) * (x - i);
}
/** Padé tanh: exact at 0, saturates at ±3. */
export const tanh = (x: number) => (x < -3 ? -1 : x > 3 ? 1 : (x * (27 + x * x)) / (27 + 9 * x * x));
export const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const expMap = (x: number, lo: number, hi: number) => lo * Math.pow(hi / lo, x);
export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const dbToGain = (db: number) => Math.pow(10, db / 20);
/** One-pole smoothing coefficient for a corner frequency. */
export const onePole = (hz: number, sr: number) => 1 - Math.exp((-TAU * Math.min(hz, sr * 0.45)) / sr);
/** Coefficient that reaches 1/e² of the way in `sec` (a time constant of sec/2). */
export const timeCoef = (sec: number, sr: number) => 1 - Math.exp(-2 / Math.max(1, sec * sr));

/** A coefficient recomputed only when its input changes (knobs move rarely, samples fly). */
export class Coef {
  private x = NaN;
  private f: (x: number) => number;
  v = 0;
  constructor(f: (x: number) => number) {
    this.f = f;
  }
  get(x: number) {
    if (x !== this.x) {
      this.x = x;
      this.v = this.f(x);
    }
    return this.v;
  }
}

/** PolyBLEP residual for a discontinuity at phase 0. */
export function blep(t: number, dt: number) {
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
/** Band-limited basic waves: 0 saw, 1 square, 2 triangle, 3 sine. `p` in cycles [0,1), `dt` = f/sr. */
export function basic(k: number, p: number, dt: number) {
  if (k === 0) return 2 * p - 1 - blep(p, dt);
  if (k === 1) return (p < 0.5 ? 1 : -1) + blep(p, dt) - blep(p + 0.5 - (p >= 0.5 ? 1 : 0), dt);
  if (k === 2) return 1 - 4 * Math.abs(p - 0.5);
  return fsin(p);
}

/** mulberry32: a seeded generator, so renders and tests repeat. */
export class Rng {
  s: number;
  constructor(seed = 1) {
    this.s = seed >>> 0 || 1;
  }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  bi() {
    return this.next() * 2 - 1;
  }
}

export class Delay {
  buf: Float32Array;
  mask: number;
  w = 0;
  constructor(len: number) {
    const n = 2 ** Math.ceil(Math.log2(Math.max(4, len)));
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
  /** Absolute position (for loops captured out of the ring). */
  at(pos: number) {
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.buf[i & this.mask];
    return a + (this.buf[(i + 1) & this.mask] - a) * f;
  }
  clear() {
    this.buf.fill(0);
  }
}

/** Simper's state-variable filter (TPT form): stable at any cutoff, cheap to modulate. */
export class SVF {
  ic1 = 0;
  ic2 = 0;
  a1 = 0;
  a2 = 0;
  a3 = 0;
  k = 2;
  sr: number;
  constructor(sr: number) {
    this.sr = sr;
    this.set(1000, 0);
  }
  /** res 0..1 (1 is the edge of self-oscillation) */
  set(hz: number, res: number) {
    const g = Math.tan((Math.PI * clamp(hz, 5, this.sr * 0.46)) / this.sr);
    this.k = 2 - 1.97 * clamp(res, 0, 1);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  /** One sample; the three outputs land in lp, bp (unity peak) and hp. */
  lp = 0;
  bp = 0;
  hp = 0;
  tick(x: number) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1 * this.k;
    this.hp = x - this.k * v1 - v2;
  }
  /** mode 0 LP, 1 BP, 2 HP, 3 notch */
  run(x: number, mode: number) {
    this.tick(x);
    return mode === 0 ? this.lp : mode === 1 ? this.bp : mode === 2 ? this.hp : this.hp + this.lp;
  }
  reset() {
    this.ic1 = this.ic2 = 0;
  }
}

/** A four-pole low pass after the transistor ladder: four TPT one-poles, a saturated feedback path. */
export class Ladder {
  s = new Float64Array(4);
  G = 0.5;
  k = 0;
  y = 0;
  sr: number;
  constructor(sr: number) {
    this.sr = sr;
  }
  set(hz: number, res: number) {
    const g = Math.tan((Math.PI * clamp(hz, 5, this.sr * 0.45)) / this.sr);
    this.G = g / (1 + g);
    this.k = 4.1 * clamp(res, 0, 1);
  }
  run(x: number) {
    let u = tanh(x - this.k * this.y) * (1 + this.k * 0.25);
    const s = this.s;
    for (let i = 0; i < 4; i++) {
      const v = (u - s[i]) * this.G;
      const out = v + s[i];
      s[i] = out + v;
      u = out;
    }
    this.y = u;
    return u;
  }
  reset() {
    this.s.fill(0);
    this.y = 0;
  }
}

/** RBJ biquad (peaking EQ, or low/high pass when asked). */
export class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  z1 = 0;
  z2 = 0;
  sr: number;
  constructor(sr: number) {
    this.sr = sr;
  }
  peak(hz: number, q: number, db: number) {
    const A = Math.pow(10, db / 40);
    const w = (TAU * clamp(hz, 10, this.sr * 0.45)) / this.sr;
    const al = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + al / A;
    this.b0 = (1 + al * A) / a0;
    this.b1 = (-2 * c) / a0;
    this.b2 = (1 - al * A) / a0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - al / A) / a0;
  }
  run(x: number) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() {
    this.z1 = this.z2 = 0;
  }
}

/**
 * Doppler pitch shifter: two taps sweep through a window in opposite phase,
 * crossfaded by sin²/cos² so their gains always sum to one. A ratio of −1
 * reads the window backwards: a reverse delay.
 */
export class Shifter {
  ph: number;
  constructor(ph = 0) {
    this.ph = ph;
  }
  run(dl: Delay, base: number, W: number, ratio: number) {
    this.ph += (1 - ratio) / W;
    this.ph -= Math.floor(this.ph);
    const p2 = this.ph + 0.5 - (this.ph >= 0.5 ? 1 : 0);
    const s = fsin(this.ph * 0.5);
    const g = s * s;
    return dl.read(base + this.ph * W) * g + dl.read(base + p2 * W) * (1 - g);
  }
}

/** Envelope follower: fast attack, slow release, on |x|. */
export class Follower {
  v = 0;
  a: number;
  r: number;
  constructor(sr: number, atkMs = 3, relMs = 120) {
    this.a = timeCoef(atkMs / 1000, sr);
    this.r = timeCoef(relMs / 1000, sr);
  }
  run(x: number) {
    const e = Math.abs(x);
    this.v += (e - this.v) * (e > this.v ? this.a : this.r);
    return this.v;
  }
}

/** Two modulated delay lines a side: the Digitone's chorus, roughly. */
export class Chorus {
  l: Delay;
  r: Delay;
  ph = 0;
  hpL = 0;
  hpR = 0;
  sr: number;
  private hpc: Coef;
  constructor(sr: number) {
    this.sr = sr;
    this.hpc = new Coef((hp) => onePole(expMap(hp, 20, 2000), sr));
    this.l = new Delay(sr * 0.06);
    this.r = new Delay(sr * 0.06);
  }
  /** depth, width 0..1; rate in Hz; hp 0..1 (a high pass before the lines) */
  out = [0, 0];
  run(inL: number, inR: number, depth: number, rate: number, width: number, hp: number) {
    const c = this.hpc.get(hp);
    this.hpL += (inL - this.hpL) * c;
    this.hpR += (inR - this.hpR) * c;
    const xl = inL - this.hpL,
      xr = inR - this.hpR;
    this.l.write(xl);
    this.r.write(xr);
    this.ph += rate / this.sr;
    if (this.ph >= 1) this.ph -= 1;
    const base = 0.011 * this.sr,
      d = depth * 0.008 * this.sr;
    const w = 0.25 * width;
    const a = this.l.read(base + d * (0.5 + 0.5 * fsin(this.ph))) + this.l.read(base * 1.3 + d * (0.5 + 0.5 * fsin(this.ph + 0.5)));
    const b = this.r.read(base + d * (0.5 + 0.5 * fsin(this.ph + w))) + this.r.read(base * 1.3 + d * (0.5 + 0.5 * fsin(this.ph + 0.5 + w)));
    const mid = (a + b) * 0.5,
      side = (a - b) * 0.5 * width;
    this.out[0] = (mid + side) * 0.7;
    this.out[1] = (mid - side) * 0.7;
    return this.out;
  }
}

/** A stereo delay with ping-pong, width, and filters inside the feedback loop. */
export class StereoDelay {
  l: Delay;
  r: Delay;
  t = 0;
  hpL = 0;
  hpR = 0;
  lpL = 0;
  lpR = 0;
  sr: number;
  out = [0, 0];
  private hpc: Coef;
  private lpc: Coef;
  constructor(sr: number, maxSec = 3) {
    this.sr = sr;
    this.hpc = new Coef((hp) => onePole(expMap(hp, 20, 3000), sr));
    this.lpc = new Coef((lp) => onePole(expMap(lp, 400, 18000), sr));
    this.l = new Delay(sr * maxSec);
    this.r = new Delay(sr * maxSec);
  }
  /** time in samples (glides), fb 0..1.1, pp 0/1, width 0..1, hp/lp 0..1 */
  run(inL: number, inR: number, time: number, fb: number, pp: number, width: number, hp: number, lp: number) {
    this.t += (time - this.t) * 0.0004;
    if (Math.abs(this.t - time) > this.sr) this.t = time;
    const d = Math.max(2, this.t);
    let a = this.l.read(d),
      b = this.r.read(d);
    const ch = this.hpc.get(hp),
      cl = this.lpc.get(lp);
    this.hpL += (a - this.hpL) * ch;
    this.hpR += (b - this.hpR) * ch;
    a -= this.hpL;
    b -= this.hpR;
    this.lpL += (a - this.lpL) * cl;
    this.lpR += (b - this.lpR) * cl;
    a = tanh(this.lpL);
    b = tanh(this.lpR);
    if (pp > 0.5) {
      this.l.write((inL + inR) * 0.5 + b * fb);
      this.r.write(a * fb);
    } else {
      this.l.write(inL + a * fb);
      this.r.write(inR + b * fb);
    }
    const mid = (a + b) * 0.5,
      side = (a - b) * 0.5;
    this.out[0] = mid + side * width;
    this.out[1] = mid - side * width;
    return this.out;
  }
}

const FDN_MS = [31.7, 37.3, 41.9, 47.3, 53.1, 59.9, 67.3, 73.1];
/** Eight delay lines mixed by a Hadamard matrix, damped inside the loop; a pre-delay in front. */
export class Reverb {
  lines: Delay[];
  len = new Float64Array(8);
  g = new Float64Array(8);
  lp = new Float64Array(8);
  y = new Float64Array(8);
  pre: Delay;
  damp = 0.5;
  hpL = 0;
  hpR = 0;
  sr: number;
  out = [0, 0];
  private k0 = NaN;
  private k1 = NaN;
  private k2 = NaN;
  private hpc: Coef;
  constructor(sr: number) {
    this.sr = sr;
    this.hpc = new Coef((hp) => onePole(expMap(hp, 20, 1500), sr));
    this.lines = FDN_MS.map(() => new Delay(sr * 0.2));
    this.pre = new Delay(sr * 0.3);
  }
  /** size 0..1, t60 in seconds, damping 0..1 (1 darkest). Cheap to call every block. */
  set(size: number, t60: number, dark: number) {
    if (size === this.k0 && t60 === this.k1 && dark === this.k2) return;
    this.k0 = size;
    this.k1 = t60;
    this.k2 = dark;
    for (let i = 0; i < 8; i++) {
      this.len[i] = (FDN_MS[i] / 1000) * this.sr * (0.35 + size * 1.4);
      this.g[i] = Math.pow(10, (-3 * this.len[i]) / (Math.max(0.1, t60) * this.sr));
    }
    this.damp = onePole(expMap(1 - dark, 1200, 16000), this.sr);
  }
  /** preSec: pre-delay; hp 0..1 on the output */
  run(inL: number, inR: number, preSec: number, hp: number) {
    this.pre.write((inL + inR) * 0.5);
    const vin = this.pre.read(Math.max(1, preSec * this.sr));
    const Y = this.y;
    for (let k = 0; k < 8; k++) {
      this.lp[k] += (this.lines[k].read(this.len[k]) - this.lp[k]) * this.damp;
      Y[k] = this.lp[k];
    }
    for (let h = 1; h < 8; h <<= 1)
      for (let a = 0; a < 8; a += h << 1)
        for (let b = a; b < a + h; b++) {
          const u = Y[b],
            w = Y[b + h];
          Y[b] = u + w;
          Y[b + h] = u - w;
        }
    for (let k = 0; k < 8; k++) this.lines[k].write(vin + Y[k] * 0.35355339 * this.g[k]);
    let l = (this.lp[0] + this.lp[2] + this.lp[4] + this.lp[6]) * 0.5;
    let r = (this.lp[1] + this.lp[3] + this.lp[5] + this.lp[7]) * 0.5;
    const c = this.hpc.get(hp);
    this.hpL += (l - this.hpL) * c;
    this.hpR += (r - this.hpR) * c;
    l -= this.hpL;
    r -= this.hpR;
    this.out[0] = l;
    this.out[1] = r;
    return this.out;
  }
}

/** Feed-forward stereo compressor, soft knee, linked detector. */
export class Compressor {
  env = 0;
  gr = 0;
  sr: number;
  out = [0, 0];
  private ac: Coef;
  private rc: Coef;
  constructor(sr: number) {
    this.sr = sr;
    this.ac = new Coef((t) => timeCoef(t, sr));
    this.rc = new Coef((t) => timeCoef(t, sr));
  }
  /** thrDb, ratio ≥ 1, atk/rel in seconds, makeDb, mix 0..1 */
  run(l: number, r: number, thrDb: number, ratio: number, atk: number, rel: number, makeDb: number, mix: number) {
    const x = Math.max(Math.abs(l), Math.abs(r));
    this.env += (x - this.env) * (x > this.env ? this.ac.get(atk) : this.rc.get(rel));
    const db = 20 * Math.log10(this.env + 1e-9);
    const over = db - thrDb,
      knee = 6;
    let red = 0;
    if (over > knee / 2) red = over * (1 - 1 / ratio);
    else if (over > -knee / 2) red = ((over + knee / 2) ** 2 / (2 * knee)) * (1 - 1 / ratio);
    this.gr = red;
    const g = dbToGain(makeDb - red);
    this.out[0] = l * (1 - mix) + l * g * mix;
    this.out[1] = r * (1 - mix) + r * g * mix;
    return this.out;
  }
}
