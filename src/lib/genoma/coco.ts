/**
 * Quinconce: after Peter Blasser's Cocoquantus (Ciat-Lonbarde). Two "Cocos",
 * looping delays with 8-bit memory whose clock sets both pitch and length, and
 * a Quantussy, five oscillators on a pentagon that sample one another.
 *
 *   Speed    the Coco's clock, 1 to 70 kHz: 65,536 bytes of memory last from under
 *            a second to about a minute
 *   Affect   how far the SP.AF input pushes the speed (either way)
 *   Feedback with REC on, how much of the old loop survives each pass: full, the new
 *            layers on the old; none, it erases
 *   FLIP     plays backwards for a moment
 *   SKIP     jumps ahead by a fixed time (so by more samples at a faster clock)
 *   Dolby    "dolby" punches silence into the quiet parts of the loop; "croce" lets
 *            input and loop gate each other
 */
import { Follower, SVF, Rng, clamp, expMap, onePole } from './fx';

export const COCO_MEM = 65536;
export const FLIP_SEC = 0.28;
export const SKIP_SEC = 0.125;
export const COCO_HZ: [number, number] = [1000, 70000];
export const cocoHz = (x: number) => expMap(clamp(x), COCO_HZ[0], COCO_HZ[1]);

export class Coco {
  mem = new Int8Array(COCO_MEM);
  addr = 0;
  private ph = 0;
  private dir = 1;
  private flipLeft = 0;
  private held = 0;
  private lp = 0;
  private lpHz = -1;
  private lpK = 1;
  private sr: number;
  private inEnv: Follower;
  private fxEnv: Follower;
  private gate = 1;
  out = 0;
  constructor(sr: number) {
    this.sr = sr;
    this.inEnv = new Follower(sr, 2, 90);
    this.fxEnv = new Follower(sr, 2, 90);
  }
  flip() {
    this.flipLeft = FLIP_SEC * this.sr;
  }
  skip(hz: number) {
    this.addr = (this.addr + Math.round(SKIP_SEC * hz)) & (COCO_MEM - 1);
  }
  clear() {
    this.mem.fill(0);
  }
  /**
   * One frame. hz: the clock; rec: recording; fb 0..1; dolby 0 off, 1 dolby, 2 croce.
   */
  process(x: number, hz: number, rec: boolean, fb: number, dolby: number) {
    const ie = this.inEnv.run(x);
    const fe = this.fxEnv.run(this.out);
    // croce: the loop gets out of the way of the input, and records only into its own silences
    let recIn = x;
    if (dolby === 2) recIn *= 1 - clamp(fe * 6);
    if (this.flipLeft > 0 && --this.flipLeft <= 0) this.dir = 1;
    else if (this.flipLeft > 0) this.dir = -1;
    this.ph += hz / this.sr;
    while (this.ph >= 1) {
      this.ph -= 1;
      const old = this.mem[this.addr] / 127;
      this.held = old;
      if (rec) {
        const v = clamp(recIn + fb * old, -1, 1);
        // 8 bits, with a little dither so quiet tails don't freeze into steps
        this.mem[this.addr] = Math.round(v * 127 + (Math.random() - 0.5) * 0.6);
      }
      this.addr = (this.addr + this.dir) & (COCO_MEM - 1);
    }
    // the stepped output, lightly smoothed at half the clock
    if (hz !== this.lpHz) {
      this.lpHz = hz;
      this.lpK = onePole(Math.min(hz * 0.45, 16000), this.sr);
    }
    this.lp += (this.held - this.lp) * this.lpK;
    let y = this.lp;
    if (dolby === 1) {
      // punching silence: below a threshold the loop is gated shut (and its hiss with it)
      const t = clamp((fe - 0.012) / 0.03);
      this.gate += (t - this.gate) * 0.01;
      y *= this.gate;
    } else if (dolby === 2) y *= 1 - clamp(ie * 5);
    this.out = y;
    return y;
  }
  /** where the address is, 0..1 of memory */
  get where() {
    return this.addr / COCO_MEM;
  }
}

/**
 * The Quantussy: five oscillators at the corners of a pentagon. When one
 * rises, it samples the triangle of the petal two corners on and holds it as
 * the pitch offset of its neighbour. Chaos sets how far those held voltages
 * move the pitches; at LFO rate it is a rhythm generator, at audio rate a drone.
 */
export class Quantussy {
  ph = new Float64Array(5);
  sq = new Uint8Array(5);
  tri = new Float64Array(5);
  sh = new Float64Array(5);
  private lp = 0;
  private sr: number;
  /** a rising edge on petal i this frame */
  rose = new Uint8Array(5);
  constructor(sr: number, seed = 5) {
    this.sr = sr;
    const r = new Rng(seed);
    for (let i = 0; i < 5; i++) {
      this.ph[i] = r.next();
      this.sh[i] = r.bi() * 0.5;
    }
  }
  private base = new Float64Array(5);
  private mult = new Float64Array(5);
  private chaos = -1;
  /** Set the petals' rates (five knob values 0..1) and range; cheap enough to call every block. */
  rates(rates: ArrayLike<number>, audio: boolean) {
    for (let i = 0; i < 5; i++) this.base[i] = audio ? expMap(rates[i], 30, 1400) : expMap(rates[i], 0.06, 14);
  }
  /** chaos 0..1. Returns the audio out. */
  process(chaos: number) {
    let sum = 0;
    if (chaos !== this.chaos) {
      this.chaos = chaos;
      for (let i = 0; i < 5; i++) this.mult[i] = Math.pow(2, chaos * 2.5 * this.sh[i]);
    }
    for (let i = 0; i < 5; i++) {
      const f = this.base[i] * this.mult[i];
      this.ph[i] += f / this.sr;
      if (this.ph[i] >= 1) this.ph[i] -= Math.floor(this.ph[i]);
      const p = this.ph[i];
      this.tri[i] = 1 - 4 * Math.abs(p - 0.5);
      const s = p < 0.5 ? 1 : 0;
      this.rose[i] = s && !this.sq[i] ? 1 : 0;
      this.sq[i] = s;
      sum += s - 0.5;
    }
    for (let i = 0; i < 5; i++)
      if (this.rose[i]) {
        const j = (i + 1) % 5;
        this.sh[j] = this.tri[(i + 3) % 5];
        this.mult[j] = Math.pow(2, this.chaos * 2.5 * this.sh[j]);
      }
    this.lp += (sum * 0.25 - this.lp) * 0.2;
    return this.lp;
  }
}

/**
 * A contact microphone on a wooden plate: taps and scratches from the panel
 * excite three resonant modes of the wood. `wood` moves the modes.
 */
export class Piezo {
  private modes: SVF[];
  private burst = 0;
  private scratch = 0;
  private scratchT = 0;
  private rng = new Rng(11);
  private wood = -1;
  constructor(sr: number) {
    this.modes = [0, 1, 2].map(() => new SVF(sr));
  }
  tap(v: number) {
    this.burst = Math.max(this.burst, 0.3 + 0.7 * clamp(v));
  }
  rub(v: number) {
    this.scratchT = clamp(v);
  }
  process(wood: number) {
    if (wood !== this.wood) {
      this.wood = wood;
      const k = expMap(wood, 0.5, 2.2);
      this.modes[0].set(190 * k, 0.93);
      this.modes[1].set(540 * k, 0.9);
      this.modes[2].set(1480 * k, 0.86);
    }
    this.scratch += (this.scratchT - this.scratch) * 0.002;
    this.scratchT *= 0.9995;
    const n = this.rng.bi();
    const x = n * (this.burst + this.scratch * 0.12 * (this.rng.next() < 0.3 ? 1 : 0.2));
    this.burst *= 0.9975;
    const y = this.modes[0].run(x, 1) * 0.9 + this.modes[1].run(x, 1) * 0.6 + this.modes[2].run(x, 1) * 0.35 + x * 0.25;
    return y;
  }
}
