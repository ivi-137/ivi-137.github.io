/**
 * Organismo 23's engine, in plain TypeScript. The AudioWorklet runs it in the browser and
 * scripts/check-organismo.mts runs it under Node, so nothing here touches the Web Audio API.
 *
 * It follows the Soma Laboratory Pulsar-23 as its manual describes it. Where the manual gives a number
 * (a 1 to 200 Hz clock, 128 pulses to a loop, 96 events to a pulse, an LFO from 0.1 to 5000 Hz, a DSP clock that
 * can change seven times over) it is used as given. Where the manual is silent, because Soma does not publish the
 * schematics, the voices are modelled from what the manual and the reviews say each one does. Those choices are
 * marked "my reading", and none of them should be taken for the hardware's own circuit.
 *
 * Every signal is volts divided by ten, so 0 to 1. Audio is centred on 0.5. Pins joined by a clip form a net,
 * and a net's value is the sum of what drives it. A signal crossing a clip is delayed by one sample, which is what
 * lets any patch, loops included, run without ever being unsolvable.
 */
import { BANKS, DIV_PINS, EVENTS_PER_PULSE, LOOP_EVENTS, NPINS, PIDX, PINS, PIN_INDEX, PULSES, SIXTEENTH, defaults, rle, unrle, type Btn, type Cable, type Mon } from './params';

const TAU = Math.PI * 2;
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const den = (x: number) => (x > -1e-20 && x < 1e-20 ? 0 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const frac = (x: number) => x - Math.floor(x);
/** A cheap tanh, exact enough for saturation. */
const th = (x: number) => {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
};
const coef = (seconds: number, sr: number) => 1 - Math.exp(-1 / (Math.max(1e-5, seconds) * sr));
/** Transparent below 0.7, then bends smoothly so that nothing passes 1. */
const limit = (x: number) => {
  const a = Math.abs(x);
  return a <= 0.7 ? x : Math.sign(x) * (0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3));
};

/** A small deterministic noise source, so the same patch always plays the same noise. */
class Rng {
  private x: number;
  constructor(x = 2463534242) {
    this.x = x;
  }
  next() {
    let x = this.x;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.x = x >>> 0;
    return this.x / 4294967296;
  }
}

const PI_ = (id: string) => {
  const i = PIN_INDEX[id];
  if (i === undefined) throw new Error(`no pin ${id}`);
  return i;
};
const C_ = (id: string) => {
  const i = PIDX[id];
  if (i === undefined) throw new Error(`no control ${id}`);
  return i;
};
const each4 = <T>(f: (i: number) => T) => [0, 1, 2, 3].map(f);

/** Every pin the engine touches, resolved to a number once. */
const X = {
  clk: PI_('clk'),
  clkMod: PI_('clk.mod'),
  div: DIV_PINS.map(PI_),
  lrClk: each4((i) => PI_(`lr${i}.clk`)),
  lrst: PI_('lr.rst'),
  trig: each4((i) => PI_(`trig${i}`)),
  env: each4((i) => PI_(`env${i}`)),
  bdMod: PI_('bd.mod'),
  bdWtf: PI_('bd.wtf'),
  bdOmg: PI_('bd.omg'),
  bdExt: PI_('bd.ext'),
  bdOut: PI_('bd.out'),
  bsCv: PI_('bs.cv'),
  bsShape: PI_('bs.shape'),
  bsWarp: PI_('bs.warp'),
  bsAmt: PI_('bs.amt'),
  bsLpf: PI_('bs.lpf'),
  bsExt: PI_('bs.ext'),
  bsOut: PI_('bs.out'),
  sdMod: PI_('sd.mod'),
  sdBpf: PI_('sd.bpf'),
  sdExt: PI_('sd.ext'),
  sdOut: PI_('sd.out'),
  hhMod: PI_('hh.mod'),
  hhHpf: PI_('hh.hpf'),
  hhExt: PI_('hh.ext'),
  hhOut: PI_('hh.out'),
  shMod: PI_('sh.mod'),
  shClk: PI_('sh.clk'),
  shSh: PI_('sh.sh'),
  shData: PI_('sh.data'),
  sh1d: PI_('sh.1d'),
  sh2d: PI_('sh.2d'),
  sh1s: PI_('sh.1s'),
  sh3s: PI_('sh.3s'),
  fxMad: PI_('fx.mad'),
  fxTime: PI_('fx.time'),
  fxClk: PI_('fx.clkmod'),
  fxTune: PI_('fx.tune'),
  fxFb: PI_('fx.fb'),
  fxDlyIn: PI_('fx.dly.in'),
  fxRevIn: PI_('fx.rev.in'),
  fxDlyOut: PI_('fx.dly.out'),
  fxRevOut: PI_('fx.rev.out'),
  lfoMod: PI_('lfo.mod'),
  lfoSq: PI_('lfo.sq'),
  lfoTri: PI_('lfo.tri'),
  lfoSync: PI_('lfo.sync'),
  atIn: each4((i) => PI_(`at${i}.in`)),
  atOut: each4((i) => PI_(`at${i}.out`)),
  vcaIn: [0, 1].map((i) => PI_(`vca${i}.in`)),
  vcaCv: [0, 1].map((i) => PI_(`vca${i}.cv`)),
  vcaOut: [0, 1].map((i) => PI_(`vca${i}.out`)),
  invIn: PI_('inv.in'),
  invOut: PI_('inv.out'),
  cinvIn: PI_('cinv.in'),
  cinvCv: PI_('cinv.cv'),
  cinvOut: PI_('cinv.out'),
  swIn: [0, 1].map((i) => PI_(`sw${i}.in`)),
  swCv: [0, 1].map((i) => PI_(`sw${i}.cv`)),
  swOut: [0, 1].map((i) => PI_(`sw${i}.out`)),
  pcIn: [0, 1].map((i) => PI_(`pc${i}.in`)),
  pcOut: [0, 1].map((i) => PI_(`pc${i}.out`)),
  dioA: PI_('dio.a'),
  dioK: PI_('dio.k'),
  capA: [PI_('cap1.a'), PI_('cap2.a')],
  capB: [PI_('cap1.b'), PI_('cap2.b')],
  sens: [PI_('sens0.cv'), PI_('sens1.cv')],
  midi: each4((i) => PI_(`midi${i}`)),
  noise: PI_('noise'),
  v10: PI_('v10'),
  gnd: PI_('gnd'),
  mixin: PI_('mixin'),
  j1: PI_('j1'),
  j2: PI_('j2'),
  m1: PI_('m1'),
};

const VOICE_IDS = ['bd', 'bs', 'sd', 'hh'];
/** Every control the engine reads, resolved to a number once. */
const K = {
  temp: C_('clk.temp'),
  clkAmt: C_('clk.amt'),
  clkSrc: C_('clk.src'),
  lrMode: each4((i) => C_(`lr${i}.mode`)),
  att: VOICE_IDS.map((v) => C_(`${v}.att`)),
  rel: VOICE_IDS.map((v) => C_(`${v}.rel`)),
  vol: VOICE_IDS.map((v) => C_(`${v}.vol`)),
  fxSend: VOICE_IDS.map((v) => C_(`${v}.fx`)),
  bdTune: C_('bd.tune'),
  bdAmt: C_('bd.amt'),
  bdPitch: C_('bd.pitch'),
  bdDrive: C_('bd.drive'),
  bsMode: C_('bs.mode'),
  bsShape: C_('bs.shape'),
  bsWarp: C_('bs.warp'),
  bsTune: C_('bs.tune'),
  bsAmt: C_('bs.amt'),
  bsLpf: C_('bs.lpf'),
  bsQ: C_('bs.q'),
  sdTune: C_('sd.tune'),
  sdAmt: C_('sd.amt'),
  sdClap: C_('sd.clap'),
  sdMix: C_('sd.mix'),
  sdBpf: C_('sd.bpf'),
  sdQ: C_('sd.q'),
  hhTune: C_('hh.tune'),
  hhWarp: C_('hh.warp'),
  hhHpf: C_('hh.hpf'),
  hhQ: C_('hh.q'),
  shFreq: C_('sh.freq'),
  shLen: C_('sh.len'),
  fxRoute: C_('fx.route'),
  fxMode: C_('fx.mode'),
  fxTime: C_('fx.time'),
  fxTune: C_('fx.tune'),
  fxFb: C_('fx.fb'),
  fxClkmod: C_('fx.clkmod'),
  fxDlyOut: C_('fx.dlyout'),
  fxRevOut: C_('fx.revout'),
  lfoFreq: C_('lfo.freq'),
  lfoAmt: C_('lfo.amt'),
  lfoWave: C_('lfo.wave'),
  lfoRange: C_('lfo.range'),
  distDrive: C_('dist.drive'),
  distMix: C_('dist.mix'),
  at: each4((i) => C_(`at${i}`)),
  vol0: C_('vol'),
};

/** Level of a note in a loop: nothing, low, middle, high. */
export const VEL = [0, 0.35, 0.65, 1];
/** The effects processor's clock when nothing modulates it. */
export const FX_RATE = 32000;

// ── the patch ──────────────────────────────────────────────────────────────

export interface Net {
  /** pins that drive the net */
  src: number[];
  /** pins that read it */
  snk: number[];
  /** 0.5 when everything driving it is audio, else 0 */
  base: number;
  grounded: boolean;
  /** a net with a trigger pin on it answers its strongest signal rather than the sum */
  maxMode: boolean;
  /** shunt capacitors to ground on this net: time constants, and their state */
  shunt: number[];
  lp: number[];
  /** a diode whose anode is on this net, and the net its cathode sits on */
  clampTo: { k: number; kpin: number; vf: number }[];
}

/** Pins that pass a signal on, and the pin each takes its signal from. */
const PASS: Record<string, string> = {
  'at0.out': 'at0.in',
  'at1.out': 'at1.in',
  'at2.out': 'at2.in',
  'at3.out': 'at3.in',
  'vca0.out': 'vca0.in',
  'vca1.out': 'vca1.in',
  'inv.out': 'inv.in',
  'sw0.out': 'sw0.in',
  'sw1.out': 'sw1.in',
  'dio.k': 'dio.a',
  'cap1.b': 'cap1.a',
  'cap2.b': 'cap2.a',
  'cap1.a': 'cap1.b',
  'cap2.a': 'cap2.b',
};
const PASS_PINS = new Set(Object.keys(PASS).map(PI_));

export interface Compiled {
  nets: Net[];
  /** the net each pin is on, or -1 */
  of: Int16Array;
  /** is something other than the pin itself driving its net? */
  driven: Uint8Array;
  /** whether a pin drives its net in this patch */
  isSrc: Uint8Array;
  /** the baseline of a source's own value: 0.5 for audio, 0 otherwise */
  sb: Float64Array;
}

/**
 * Work out the nets of a patch. A clip joins two pins; joined pins form a net; the net's value is what its
 * sources add up to. Whether a pin is a source can depend on a switch (the clock pin is an output unless the clock
 * is set to CLK), and whether a net is audio depends on what drives it, passed on through attenuators, VCAs and the
 * like, so the types are settled by repeating until nothing changes.
 */
export function compile(cables: Cable[], ctl: Float64Array, micOn: boolean): Compiled {
  const parent = Int16Array.from({ length: NPINS }, (_, i) => i);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const used = new Uint8Array(NPINS);
  for (const [a, b] of cables) {
    const ia = PIN_INDEX[a];
    const ib = PIN_INDEX[b];
    if (ia === undefined || ib === undefined || ia === ib) continue;
    used[ia] = used[ib] = 1;
    parent[find(ia)] = find(ib);
  }

  const clkExt = Math.round(ctl[K.clkSrc]) === 1;
  const isSrc = new Uint8Array(NPINS);
  const isSnk = new Uint8Array(NPINS);
  PINS.forEach((p, i) => {
    let src = p.dir === 'out' || p.dir === 'io';
    let snk = p.dir === 'in' || p.dir === 'io';
    if (i === X.clk) {
      src = !clkExt;
      snk = clkExt;
    }
    if (p.mod === 'jacks') {
      src = i === X.m1 && micOn;
      snk = i === X.j1 || i === X.j2;
    }
    isSrc[i] = src ? 1 : 0;
    isSnk[i] = snk ? 1 : 0;
  });

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < NPINS; i++) {
    if (!used[i]) continue;
    const r = find(i);
    const g = byRoot.get(r);
    if (g) g.push(i);
    else byRoot.set(r, [i]);
  }
  const groups = [...byRoot.values()];
  const of = new Int16Array(NPINS).fill(-1);
  groups.forEach((g, gi) => g.forEach((p) => (of[p] = gi)));
  const grounded = (gi: number) => gi >= 0 && groups[gi].includes(X.gnd);

  // the diode drives its cathode net only if nothing else does
  const kOthers = of[X.dioK] >= 0 && groups[of[X.dioK]].some((p) => p !== X.dioK && isSrc[p] === 1);
  isSrc[X.dioK] = kOthers ? 0 : 1;
  isSnk[X.dioA] = 1;

  // capacitors: either a shunt to ground, or series coupling that lets changes through
  const shunts: { net: number; tau: number }[] = [];
  const isDrivenElsewhere = (gi: number, pins: number[]) => gi >= 0 && groups[gi].some((p) => isSrc[p] === 1 && !pins.includes(p));
  [0, 1].forEach((i) => {
    const a = X.capA[i];
    const b = X.capB[i];
    const ga = of[a];
    const gb = of[b];
    isSnk[a] = isSnk[b] = 1;
    isSrc[a] = isSrc[b] = 0;
    if (grounded(ga) && gb >= 0 && gb !== ga) shunts.push({ net: gb, tau: i === 0 ? 0.001 : 0.1 });
    else if (grounded(gb) && ga >= 0 && gb !== ga) shunts.push({ net: ga, tau: i === 0 ? 0.001 : 0.1 });
    else {
      const da = isDrivenElsewhere(ga, [a, b]);
      const db = isDrivenElsewhere(gb, [a, b]);
      // the side that receives is the one the other side drives
      isSrc[b] = da ? 1 : 0;
      isSrc[a] = db ? 1 : 0;
    }
  });

  // signal types, settled by repeating: audio sources are audio, and parts pass their input's type on
  const audioPin = new Uint8Array(NPINS);
  PINS.forEach((p, i) => {
    if (!PASS_PINS.has(i)) audioPin[i] = p.sig === 'audio' ? 1 : 0;
  });
  audioPin[X.m1] = micOn ? 1 : 0;
  const passes = Object.entries(PASS).map(([o, i]) => [PI_(o), PI_(i)] as const);
  for (let iter = 0; iter < 8; iter++) {
    let changed = false;
    for (const [o, i] of passes) {
      // a pass-through output is audio when the net feeding its input is audio apart from itself
      const gi = of[i];
      let audio = false;
      if (gi >= 0) {
        let any = false;
        let all = true;
        for (const p of groups[gi]) {
          if (p === o || isSrc[p] !== 1) continue;
          any = true;
          if (!audioPin[p]) all = false;
        }
        audio = any && all;
      }
      const want = audio ? 1 : 0;
      if (audioPin[o] !== want) {
        audioPin[o] = want;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const sb = new Float64Array(NPINS);
  for (let i = 0; i < NPINS; i++) sb[i] = isSrc[i] === 1 && audioPin[i] === 1 ? 0.5 : 0;

  const nets: Net[] = groups.map((g, gi) => {
    const src = g.filter((p) => isSrc[p] === 1);
    const snk = g.filter((p) => isSnk[p] === 1);
    return { src, snk, base: src.length > 0 && src.every((p) => sb[p] === 0.5) ? 0.5 : 0, grounded: grounded(gi), maxMode: g.some((p) => X.trig.includes(p)), shunt: [], lp: [], clampTo: [] };
  });
  for (const s of shunts) {
    nets[s.net].shunt.push(s.tau);
    nets[s.net].lp.push(0);
  }
  // the anode net cannot rise far above a cathode net that something else drives
  if (kOthers && of[X.dioA] >= 0) nets[of[X.dioA]].clampTo.push({ k: of[X.dioK], kpin: X.dioK, vf: 0.06 });

  const driven = new Uint8Array(NPINS);
  for (let i = 0; i < NPINS; i++) {
    const gi = of[i];
    if (gi >= 0) driven[i] = nets[gi].src.some((p) => p !== i) ? 1 : 0;
  }
  return { nets, of, driven, isSrc, sb };
}

// ── small building blocks ──────────────────────────────────────────────────

/** A topology-preserving state-variable filter. */
class Svf {
  s1 = 0;
  s2 = 0;
  lp = 0;
  bp = 0;
  hp = 0;
  /** `g` is tan(pi fc / sr); `k` is the damping, 2 for none and near 0 for self-oscillation. */
  run(x: number, g: number, k: number) {
    const hp = (x - (k + g) * this.s1 - this.s2) / (1 + g * (g + k));
    const v1 = g * hp;
    const bp = v1 + this.s1;
    this.s1 = den(bp + v1);
    const v2 = g * bp;
    const lp = v2 + this.s2;
    this.s2 = den(lp + v2);
    this.hp = hp;
    this.bp = bp;
    this.lp = lp;
  }
}
const svfG = (fc: number, sr: number) => Math.tan((Math.PI * clamp(fc, 10, sr * 0.45)) / sr);

/** A four-pole resonant low-pass with saturation, after the Moog ladder. */
class Ladder {
  s = [0, 0, 0, 0];
  run(x: number, fc: number, res: number, sr: number) {
    const g = 1 - Math.exp((-TAU * clamp(fc, 20, sr * 0.45)) / sr);
    const inp = th(x - res * this.s[3]);
    this.s[0] += g * (inp - th(this.s[0]));
    this.s[1] += g * (th(this.s[0]) - th(this.s[1]));
    this.s[2] += g * (th(this.s[1]) - th(this.s[2]));
    this.s[3] += g * (th(this.s[2]) - th(this.s[3]));
    for (let i = 0; i < 4; i++) this.s[i] = den(this.s[i]);
    return this.s[3];
  }
}

/** White noise, sampled and held at a given rate: a way to make "spectrum" a single knob. */
class HeldNoise {
  private acc = 0;
  private v = 0;
  private y = 0;
  private rng: Rng;
  constructor(rng: Rng) {
    this.rng = rng;
  }
  run(rate: number, sr: number) {
    this.acc += rate / sr;
    while (this.acc >= 1) {
      this.acc -= 1;
      this.v = this.rng.next() * 2 - 1;
    }
    // a little smoothing, so the held steps are not all there is to hear
    this.y += (this.v - this.y) * clamp((rate * 0.9) / sr, 0.02, 1);
    return this.y;
  }
}

class Pink {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  run(w: number) {
    this.b0 = 0.99765 * this.b0 + w * 0.099046;
    this.b1 = 0.963 * this.b1 + w * 0.2965164;
    this.b2 = 0.57 * this.b2 + w * 1.0526913;
    return (this.b0 + this.b1 + this.b2 + w * 0.1848) * 0.11;
  }
}

const polyblep = (t: number, dt: number) => {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
};

// ── clock ──────────────────────────────────────────────────────────────────

class Clock {
  phase = 0;
  cnt = 0;
  edge = false;
  level = false;
  /** the green LED: 0 off, 1 on, 2 bright at the start of the loop */
  led = 0;
  private midiEdge = false;
  private midiCount = 0;
  private since = 0;
  private extPrev = false;
  private sr: number;

  constructor(sr: number) {
    this.sr = sr;
  }
  reset() {
    this.cnt = 0;
    this.phase = 0;
  }
  /** One MIDI clock message. Twenty-four make a quarter note, so three make a 32nd, which is one tick. */
  midiClock() {
    if (++this.midiCount >= 3) {
      this.midiCount = 0;
      this.midiEdge = true;
    }
  }
  step(src: number, f: number, ext: number) {
    this.edge = false;
    this.since++;
    if (src === 0) {
      this.phase += f / this.sr;
      if (this.phase >= 1) {
        this.phase -= 1;
        this.edge = true;
      }
      this.level = this.phase < 0.5;
    } else if (src === 1) {
      const hi = ext > 0.3;
      if (hi && !this.extPrev) this.edge = true;
      this.extPrev = hi;
      this.level = hi;
    } else {
      if (this.midiEdge) {
        this.midiEdge = false;
        this.edge = true;
      }
      this.level = this.since < this.sr * 0.05;
    }
    // MIDI clock only counts while the switch is on MIDI
    if (src !== 2) {
      this.midiEdge = false;
      this.midiCount = 0;
    }
    if (this.edge) {
      this.since = 0;
      this.cnt = (this.cnt + 1) & (PULSES - 1);
      this.led = this.cnt === 0 ? 2 : this.cnt % 8 === 0 ? 1 : 0;
    } else if (this.since > this.sr * 0.03) this.led = 0;
  }
}

// ── looper ─────────────────────────────────────────────────────────────────

/**
 * Four loopers, one to a voice, each with four banks. A loop is a virtual tape of 128 clock pulses, 96 events to a
 * pulse, that records when ADD is touched, for how long, and how hard. The clock is upsampled by 96 from the
 * period of the pulse before, which is why a clock that changes speed drifts from the dividers until LRST
 * restarts it, as the manual says.
 */
class Loopers {
  mem: Uint8Array[][] = Array.from({ length: BANKS }, () => Array.from({ length: 4 }, () => new Uint8Array(LOOP_EVENTS)));
  bank = 0;
  running = true;
  pulse = [0, 0, 0, 0];
  sub = [0, 0, 0, 0];
  add = [false, false, false, false];
  del = [false, false, false, false];
  L = false;
  M = false;
  BANK = false;
  out = new Float64Array(4);
  private last = [0, 0, 0, 0];
  private period = [0, 0, 0, 0];
  private since = [0, 0, 0, 0];
  private prevClk = [false, false, false, false];
  private prevRst = false;
  /** counts the changes made to each loop, so the panel knows when to redraw a tape */
  rev: number[][] = Array.from({ length: BANKS }, () => [0, 0, 0, 0]);
  /** copying from this bank into the current one, for as long as the three buttons are held */
  private copyFrom = -1;
  private prevBank = 0;
  private switchedAt = -1e9;
  private now = 0;
  private sr: number;

  constructor(sr: number) {
    this.sr = sr;
    this.period.fill(sr / 16);
  }

  restart(at = 0) {
    for (let c = 0; c < 4; c++) {
      this.pulse[c] = at;
      this.sub[c] = 0;
      this.last[c] = at * EVENTS_PER_PULSE;
      this.since[c] = 0;
    }
  }

  private velocity() {
    return this.L && this.M ? 3 : this.L ? 1 : this.M ? 2 : 3;
  }

  button(ch: number, btn: Btn, down: boolean) {
    if (btn === 'add') this.add[ch] = down;
    else this.del[ch] = down;
    if (!down || !this.BANK) return;
    const section = ch * 2 + (btn === 'del' ? 1 : 0);
    if (this.L && this.M) {
      this.quantise(ch);
      this.running = false;
    } else if (this.M) {
      this.running = true;
      this.restart(section * (PULSES / 8));
    } else if (!this.L) {
      if (this.add[ch] && this.del[ch]) {
        // the second of the two buttons: copy from the bank we were in a moment ago
        const from = this.now - this.switchedAt < this.sr * 0.25 ? this.prevBank : this.bank;
        this.copyFrom = from;
        this.bank = ch;
      } else {
        this.prevBank = this.bank;
        this.switchedAt = this.now;
        this.bank = ch;
      }
    }
  }

  rc(btn: 'L' | 'M' | 'BANK', down: boolean) {
    if (btn === 'L') this.L = down;
    else if (btn === 'M') this.M = down;
    else this.BANK = down;
    if (!down) {
      if (btn === 'BANK') this.copyFrom = -1;
      return;
    }
    // BANK and L together stop the looper
    if (this.BANK && this.L && !this.M) this.running = false;
  }

  /** Snap every note of a loop to the grid of sixteenth notes. */
  quantise(ch: number) {
    const m = this.mem[this.bank][ch];
    const out = new Uint8Array(LOOP_EVENTS);
    let i = 0;
    while (i < LOOP_EVENTS) {
      if (!m[i]) {
        i++;
        continue;
      }
      let j = i;
      let v = 0;
      while (j < LOOP_EVENTS && m[j]) v = Math.max(v, m[j++]);
      const a = Math.round(i / SIXTEENTH) * SIXTEENTH;
      let b = Math.round(j / SIXTEENTH) * SIXTEENTH;
      if (b <= a) b = a + SIXTEENTH;
      for (let k = a; k < Math.min(b, LOOP_EVENTS); k++) out[k] = v;
      i = j;
    }
    m.set(out);
    this.rev[this.bank][ch]++;
  }

  /** What one event of one channel does, given the switch and the sensors. Returns the level that plays. */
  private apply(ch: number, idx: number, mode: number) {
    const m = this.mem[this.bank][ch];
    const vel = this.velocity();
    const add = this.add[ch];
    const del = this.del[ch];
    if (mode === 0) {
      const was = m[idx];
      if (this.copyFrom >= 0) m[idx] = this.mem[this.copyFrom][ch][idx];
      else if (add) m[idx] = vel;
      else if (del) m[idx] = 0;
      if (m[idx] !== was) this.rev[this.bank][ch]++;
      return m[idx];
    }
    if (mode === 2) {
      let base = del ? 0 : m[idx];
      if (base && (this.L || this.M)) base = vel;
      return Math.max(base, add ? vel : 0);
    }
    return add ? vel : 0;
  }

  /** One sample. `edge` is the master clock's edge; a channel with its own clock uses that instead. */
  step(edge: boolean, own: boolean[], ownLevel: number[], rst: number, modes: number[]) {
    this.now++;
    const rstHi = rst > 0.2;
    if (rstHi && !this.prevRst) this.restart(0);
    this.prevRst = rstHi;
    for (let c = 0; c < 4; c++) {
      let e = edge;
      if (own[c]) {
        const hi = ownLevel[c] > 0.2;
        e = hi && !this.prevClk[c];
        this.prevClk[c] = hi;
      }
      this.since[c]++;
      if (this.running && e) {
        this.period[c] = clamp(this.since[c], 8, this.sr * 4);
        this.since[c] = 0;
        this.pulse[c] = (this.pulse[c] + 1) % PULSES;
        this.sub[c] = 0;
      } else if (this.running) this.sub[c] = Math.min(EVENTS_PER_PULSE - 0.001, this.sub[c] + EVENTS_PER_PULSE / this.period[c]);
      const idx = this.pulse[c] * EVENTS_PER_PULSE + Math.floor(this.sub[c]);
      // a clock that has stopped, or a looper that has: the sensor simply plays the voice
      if (this.running && this.since[c] < this.sr * 3) {
        let walk = (idx - this.last[c] + LOOP_EVENTS) % LOOP_EVENTS;
        if (walk > LOOP_EVENTS / 2) walk = 0;
        let v = 0;
        if (walk === 0) v = this.apply(c, idx, modes[c]);
        else for (let k = 1; k <= walk; k++) v = this.apply(c, (this.last[c] + k) % LOOP_EVENTS, modes[c]);
        this.out[c] = VEL[v];
      } else this.out[c] = this.add[c] ? VEL[this.velocity()] : 0;
      this.last[c] = idx;
    }
  }
}

/** An attack and release envelope that holds while the trigger does, at the level of the trigger. */
class Env {
  level = 0;
  run(g: number, ka: number, kr: number) {
    this.level += (g - this.level) * (g > this.level ? ka : kr);
    if (this.level < 1e-7 && g === 0) this.level = 0;
    return this.level;
  }
}

// ── effects ────────────────────────────────────────────────────────────────

/** A delay-line pitch shifter: two read heads, crossfaded, drifting at the ratio. */
class PitchShift {
  private buf = new Float64Array(4096);
  private w = 0;
  private ph = 0;
  private readonly W = 1536;
  run(x: number, ratio: number) {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & 4095;
    this.ph += (1 - ratio) / this.W;
    this.ph -= Math.floor(this.ph);
    const p2 = (this.ph + 0.5) % 1;
    const g1 = Math.sin(Math.PI * this.ph) ** 2;
    const g2 = Math.sin(Math.PI * p2) ** 2;
    return this.rd(this.ph) * g1 + this.rd(p2) * g2;
  }
  private rd(p: number) {
    const d = p * this.W + 2;
    const i = Math.floor(d);
    const f = d - i;
    const a = this.buf[(this.w - i + 8192) & 4095];
    const b = this.buf[(this.w - i - 1 + 8192) & 4095];
    return a + (b - a) * f;
  }
}

class Delay {
  buf: Float64Array;
  w = 0;
  constructor(size: number) {
    this.buf = new Float64Array(size);
  }
  read(d: number) {
    const n = this.buf.length;
    const i = Math.floor(d);
    const f = d - i;
    const a = this.buf[(this.w - i + n * 2) % n];
    const b = this.buf[(this.w - i - 1 + n * 2) % n];
    return a + (b - a) * f;
  }
  write(x: number) {
    this.buf[this.w] = x;
    this.w = (this.w + 1) % this.buf.length;
  }
}

class Allpass {
  private d: Delay;
  private n: number;
  constructor(n: number) {
    this.n = n;
    this.d = new Delay(n + 2);
  }
  run(x: number) {
    const z = this.d.read(this.n);
    const y = z - 0.5 * x;
    this.d.write(x + 0.5 * y);
    return y;
  }
}

const REV_A = [1087, 1283, 1523, 1801, 2111, 2437, 2749, 3137];
const REV_B = [1259, 1493, 1777, 2099, 2459, 2851, 3209, 3659];

/**
 * The two-channel effects processor, run at its own clock. The input is sampled at that clock and the output held
 * and smoothed, so slowing the clock lengthens every delay, drops every pitch and lets aliasing in, the way the
 * manual says the whole DSP can change by a factor of seven. The algorithms (a delay with a band-pass in its
 * feedback, a two-tap delay, a delay with a pitch shifter in its feedback, and a hall in three variants) are my reading
 * of the manual's descriptions.
 */
class Fx {
  clip = false;
  dlyOut = 0;
  revOut = 0;
  private acc = 0;
  private aaD = new Svf();
  private aaR = new Svf();
  private outL = 0;
  private outR = 0;
  private recL = new Svf();
  private recR = new Svf();
  private dly = new Delay(32768 + 8);
  private fbBpf = new Svf();
  private fbLp = new Svf();
  private len1 = 4000;
  private len2 = 8000;
  private dPitch = new PitchShift();
  private tank = REV_B.map((n) => new Delay(n * 2 + 64));
  private damp = new Float64Array(8);
  private rd = new Float64Array(8);
  private h = new Float64Array(8);
  private h2 = new Float64Array(8);
  private gains = new Float64Array(8);
  private lastT60 = -1;
  private lastMode = -1;
  private diff = [new Allpass(113), new Allpass(163), new Allpass(229)];
  private rPitch = new PitchShift();
  private rLfo = 0;
  private rng = new Rng(77);
  private madPhase = 0;
  private madVal = 0;
  private sr: number;

  constructor(sr: number) {
    this.sr = sr;
  }

  run(inD: number, inR: number, mode: number, time: number, tune: number, fb: number, rateMul: number, mad: boolean) {
    const sr = this.sr;
    const ga = svfG(11000, sr);
    // converter inputs: a fixed anti-alias filter, then sample and hold at a clock that can run far below it
    this.aaD.run(inD, ga, 1.4);
    this.aaR.run(inR, ga, 1.4);
    this.clip = Math.abs(inD) >= 0.99 || Math.abs(inR) >= 0.99;
    this.acc += (FX_RATE * rateMul) / sr;
    let guard = 4;
    while (this.acc >= 1 && guard-- > 0) {
      this.acc -= 1;
      this.tick(this.aaD.lp, this.aaR.lp, mode, time, tune, fb, mad);
    }
    // the output is held between ticks and smoothed by a fixed reconstruction filter
    this.recL.run(this.outL, ga, 1.4);
    this.recR.run(this.outR, ga, 1.4);
    this.dlyOut = this.recL.lp;
    this.revOut = this.recR.lp;
  }

  private tick(xd: number, xr: number, mode: number, time: number, tune: number, fb: number, mad: boolean) {
    const stereo = mode === 1 && mad;
    const crazy = mad && mode !== 1;
    // ── channel one: the delay ──
    if (crazy) {
      this.madPhase += 7 / FX_RATE;
      if (this.madPhase >= 1) {
        this.madPhase -= 1;
        this.madVal = this.rng.next() * 2 - 1;
      }
    }
    const target1 = clamp(128 * Math.pow(2, time * 8) * (crazy ? 1 + this.madVal * 0.25 : 1), 64, 32000);
    const target2 = clamp(128 * Math.pow(2, tune * 8), 64, 32000);
    this.len1 += (target1 - this.len1) * 0.002;
    this.len2 += (target2 - this.len2) * 0.002;
    const t1 = this.dly.read(this.len1);
    let fbIn = t1;
    let t2 = 0;
    if (mode === 1) {
      t2 = this.dly.read(this.len2);
      fbIn = t2;
    }
    if (mode === 0) {
      this.fbBpf.run(fbIn, svfG(150 * Math.pow(2, tune * 5.4), FX_RATE), 0.9);
      fbIn = this.fbBpf.bp * 0.9;
    } else {
      this.fbLp.run(fbIn, svfG(5200, FX_RATE), 1.5);
      fbIn = this.fbLp.lp;
    }
    if (mode === 2) fbIn = this.dPitch.run(fbIn, Math.pow(2, (tune - 0.5) * 2));
    this.dly.write(th(xd + fbIn * fb * (crazy ? 1.12 : 0.98)));
    const dOut = mode === 1 ? (t1 + t2) * 0.7 : t1;

    // ── channel two: the hall ──
    const t60 = crazy ? 60 : 0.35 + fb * fb * 9;
    if (t60 !== this.lastT60 || mode !== this.lastMode) {
      const lens = mode === 1 ? REV_B : REV_A;
      for (let i = 0; i < 8; i++) this.gains[i] = Math.pow(10, (-3 * lens[i]) / (FX_RATE * t60));
      this.lastT60 = t60;
      this.lastMode = mode;
    }
    const lens = mode === 1 ? REV_B : REV_A;
    this.rLfo += 0.31 / FX_RATE;
    if (this.rLfo >= 1) this.rLfo -= 1;
    let x = xr;
    for (let i = 0; i < 3; i++) x = this.diff[i].run(x);
    const damp = mode === 1 ? 0.38 : 0.55;
    for (let i = 0; i < 8; i++) {
      const wob = i < 2 || crazy ? Math.sin(TAU * (this.rLfo + i * 0.37)) * (crazy ? 14 : 5) : 0;
      const r = this.tank[i].read(lens[i] + wob);
      this.damp[i] += (r * this.gains[i] - this.damp[i]) * damp;
      this.rd[i] = this.damp[i];
    }
    // an eight-point Hadamard mix, which keeps the energy and spreads it
    this.h.set(this.rd);
    for (let len = 1; len < 8; len <<= 1) {
      for (let i = 0; i < 8; i += len << 1)
        for (let j = i; j < i + len; j++) {
          this.h2[j] = this.h[j] + this.h[j + len];
          this.h2[j + len] = this.h[j] - this.h[j + len];
        }
      this.h.set(this.h2);
    }
    let shifted = 0;
    if (mode === 2) {
      let s = 0;
      for (let i = 0; i < 8; i++) s += this.rd[i];
      shifted = this.rPitch.run(s / 8, Math.pow(2, -(tune - 0.5) * 2));
    }
    for (let i = 0; i < 8; i++) this.tank[i].write(th(x * 0.35 + this.h[i] * 0.35355 + shifted * 0.25));
    const rOut = (this.rd[0] + this.rd[2] - this.rd[4] + this.rd[6] - this.rd[1] * 0.5) * 0.9;

    if (stereo) {
      // the two mono outputs become left and right of one stereo mix of the double delay and the hall
      this.outL = t1 * 0.8 + rOut * 0.5;
      this.outR = t2 * 0.8 + rOut * 0.5;
    } else {
      this.outL = dOut;
      this.outR = rOut;
    }
  }
}

// ── the whole instrument ──────────────────────────────────────────────────

export class Organismo {
  readonly sr: number;
  p: Float64Array;
  cables: Cable[] = [];
  micOn = false;

  /** what each pin reads, its baseline, and what each source drives, all 0 to 1 */
  iv = new Float64Array(NPINS);
  ib = new Float64Array(NPINS);
  ov = new Float64Array(NPINS);

  clock: Clock;
  lr: Loopers;
  peak = 0;
  clip = false;
  /** the sound of each voice, before its volume knob, −1 to 1 */
  vo = new Float64Array(4);
  /** the level that reaches each envelope: the strongest of the looper, MIDI and the pin */
  gate = [0, 0, 0, 0];

  private cp!: Compiled;
  private env = [new Env(), new Env(), new Env(), new Env()];
  private ka = [0, 0, 0, 0];
  private kr = [0, 0, 0, 0];
  private midiGate = [0, 0, 0, 0];
  private rng = new Rng(1234567);
  private rng2 = new Rng(987654321);
  private fx: Fx;

  // bass drum
  private bdPhase = 0;
  private bdPe = 0;
  private bdPrev = false;
  // bass
  private bsPhase = 0;
  private bsPe = 0;
  private bsPrev = false;
  private bsNote = 45;
  private bsSemi = 45;
  private bsBend = 0;
  private bsGlide = 0;
  private bsLadder = new Ladder();
  private ktr = 0;
  // snare
  private sdNoise: HeldNoise;
  private sdPink = new Pink();
  private sdSvf = new Svf();
  private sdT = 1e9;
  private sdPrev = false;
  // hat
  private hhNoise: HeldNoise;
  private hhSvf = new Svf();
  // shaos
  private shReg = 0x5a3c;
  private shPhase = 0;
  private shPrevClk = false;
  private shPrevSh = false;
  private shHeld1 = 0;
  private shHeld3 = 0;
  // lfo
  private lfoPhase = 0;
  private lfoPrevSync = false;
  // parts
  private pink = new Pink();
  private pcv = [0, 0];
  private pcPrev = [false, false];
  private capLpAB = [0, 0];
  private capLpBA = [0, 0];
  private sens = [0, 0];
  private sensTo = [0, 0];
  private midiCv = [0, 0, 0, 0];
  private dcX = 0;
  private dcY = 0;
  private exX = [0, 0];
  private exY = [0, 0];
  private monEnv = [0, 0, 0, 0];
  // scratch, so the sample loop makes no arrays
  private own = [false, false, false, false];
  private ownLevel = [0, 0, 0, 0];
  private modes = [0, 0, 0, 0];

  constructor(sr: number, p?: Float64Array) {
    this.sr = sr;
    this.p = p ? Float64Array.from(p) : defaults();
    this.clock = new Clock(sr);
    this.lr = new Loopers(sr);
    this.sdNoise = new HeldNoise(this.rng);
    this.hhNoise = new HeldNoise(this.rng2);
    this.fx = new Fx(sr);
    this.setCables([]);
    this.sync();
  }

  setCables(c: Cable[]) {
    this.cables = c;
    this.recompile();
  }
  micEnable(on: boolean) {
    this.micOn = on;
    this.recompile();
  }
  private recompile() {
    this.cp = compile(this.cables, this.p, this.micOn);
    this.iv.fill(0);
    this.ib.fill(0);
  }
  set(i: number, v: number) {
    this.p[i] = v;
    if (i === K.clkSrc) this.recompile();
  }
  /** Recompute what depends on the knobs. */
  sync() {
    for (let i = 0; i < 4; i++) {
      this.ka[i] = coef(this.p[K.att[i]], this.sr);
      this.kr[i] = coef(this.p[K.rel[i]], this.sr);
    }
  }

  // ── the hands ──
  button(ch: number, btn: Btn, down: boolean) {
    this.lr.button(ch, btn, down);
  }
  rcButton(btn: 'L' | 'M' | 'BANK', down: boolean) {
    this.lr.rc(btn, down);
  }
  /** The RST button: the dividers and the loopers go back to the start together. */
  rst() {
    this.clock.reset();
    this.lr.restart(0);
    this.lr.running = true;
  }
  setSensor(i: number, v: number) {
    this.sensTo[i] = clamp(v, 0, 1);
  }
  trigger(ch: number, v: number) {
    this.midiGate[ch] = clamp(v, 0, 1);
  }
  note(note: number, vel: number, on: boolean) {
    if (on) {
      this.bsNote = note;
      this.midiGate[1] = clamp(vel, 0, 1);
      this.ktr = clamp((note - 24) / 72, 0, 1);
    } else if (note === this.bsNote) this.midiGate[1] = 0;
  }
  /** Controller 5 is the portamento, and it can only be set from MIDI. */
  cc(cc: number, v: number) {
    if (cc === 5) this.bsGlide = clamp(v, 0, 1);
  }
  bend(v: number) {
    this.bsBend = clamp(v, -1, 1);
  }
  setCv(i: number, v: number) {
    this.midiCv[i] = clamp(v, 0, 1);
  }
  midiClock() {
    this.clock.midiClock();
  }
  midiStart() {
    this.rst();
  }
  midiStop() {
    this.lr.running = false;
  }

  loops(): number[][][] {
    return this.lr.mem.map((bank) => bank.map((m) => rle(m)));
  }
  setLoops(data: number[][][]) {
    data.forEach((bank, b) =>
      bank.forEach((r, c) => {
        if (!this.lr.mem[b]?.[c]) return;
        this.lr.mem[b][c].set(unrle(r));
        this.lr.rev[b][c]++;
      }),
    );
  }

  // ── the nets ──
  private evalNets() {
    const { nets, sb } = this.cp;
    const { iv, ib, ov } = this;
    for (let gi = 0; gi < nets.length; gi++) {
      const n = nets[gi];
      let sum = 0;
      if (n.maxMode) {
        for (let k = 0; k < n.src.length; k++) sum = Math.max(sum, ov[n.src[k]] - sb[n.src[k]]);
      } else for (let k = 0; k < n.src.length; k++) sum += ov[n.src[k]] - sb[n.src[k]];
      let val = n.grounded ? 0 : clamp(sum + n.base, 0, 1);
      for (let k = 0; k < n.shunt.length; k++) {
        n.lp[k] += (val - n.lp[k]) * coef(n.shunt[k], this.sr);
        val = n.lp[k];
      }
      for (let k = 0; k < n.clampTo.length; k++) {
        const cl = n.clampTo[k];
        const kn = nets[cl.k];
        let o = 0;
        let any = false;
        for (const s of kn.src) {
          if (s === cl.kpin) continue;
          o += ov[s] - sb[s];
          any = true;
        }
        if (any) val = Math.min(val, clamp(o + kn.base, 0, 1) + cl.vf);
      }
      for (let k = 0; k < n.snk.length; k++) {
        iv[n.snk[k]] = val;
        ib[n.snk[k]] = n.base;
      }
    }
  }

  /** A pin's value with its baseline taken out: audio becomes −0.5 to 0.5, control stays 0 to 1. */
  private bip(pin: number) {
    return this.iv[pin] - this.ib[pin];
  }

  // ── the render ──
  process(L: Float32Array | Float64Array, R: Float32Array | Float64Array, n: number, mic?: Float32Array | null) {
    const p = this.p;
    const { iv, ov, own, ownLevel, modes } = this;
    const cp = this.cp;
    this.sync();
    let peak = 0;
    this.clip = false;
    for (let k = 0; k < 4; k++) own[k] = cp.driven[X.lrClk[k]] === 1;

    for (let s = 0; s < n; s++) {
      if (mic) ov[X.m1] = 0.5 + 0.5 * clamp(mic[s] ?? 0, -1, 1);
      this.evalNets();

      // clock and dividers
      const src = Math.round(p[K.clkSrc]);
      const f = p[K.temp] * Math.pow(2, p[K.clkAmt] * 4 * iv[X.clkMod]);
      const clk = this.clock;
      clk.step(src, clamp(f, 0.05, 2000), iv[X.clk]);
      if (src !== 1) ov[X.clk] = clk.level ? 1 : 0;
      for (let k = 0; k < 7; k++) ov[X.div[k]] = (clk.cnt >> k) & 1;

      // loopers, trigger pins and envelopes
      for (let k = 0; k < 4; k++) {
        ownLevel[k] = iv[X.lrClk[k]];
        modes[k] = Math.round(p[K.lrMode[k]]);
      }
      this.lr.step(clk.edge, own, ownLevel, iv[X.lrst], modes);
      for (let k = 0; k < 4; k++) {
        ov[X.trig[k]] = this.lr.out[k];
        // the TRIG pin is a node: the looper drives it and the envelope reads it, so whatever is clipped there
        // (a diode, another voice's trigger) acts on the looper's output. With nothing clipped, the envelope hears the looper
        const node = cp.of[X.trig[k]] >= 0 ? iv[X.trig[k]] : this.lr.out[k];
        const g = Math.max(node, this.midiGate[k]);
        this.gate[k] = g;
        const e = this.env[k].run(g, this.ka[k], this.kr[k]);
        ov[X.env[k]] = e;
        this.monEnv[k] = e;
      }

      // sources and parts
      for (let i = 0; i < 2; i++) {
        const to = this.sensTo[i];
        this.sens[i] += (to - this.sens[i]) * (to > this.sens[i] ? 0.0008 : 0.004);
        ov[X.sens[i]] = this.sens[i];
      }
      for (let i = 0; i < 4; i++) ov[X.midi[i]] = this.midiCv[i];
      if (this.midiCv[0] === 0) ov[X.midi[0]] = this.ktr;
      ov[X.noise] = 0.5 + 0.5 * clamp(this.pink.run(this.rng.next() * 2 - 1) * 2.2, -1, 1);
      ov[X.v10] = 1;
      this.shaos();
      this.lfo();
      this.parts();

      // voices
      this.bd();
      this.bass();
      this.snare();
      this.hat();

      // mixer: FX sends are taken before the volume knobs
      let sends = 0;
      let main = 0;
      for (let k = 0; k < 4; k++) {
        sends += this.vo[k] * p[K.fxSend[k]];
        main += this.vo[k] * p[K.vol[k]];
      }
      const route = Math.round(p[K.fxRoute]);
      const mad = iv[X.fxMad] > 0.5;
      const inD = (route === 0 ? sends : 0) + this.bip(X.fxDlyIn);
      const inR = (route === 1 ? sends : 0) + this.bip(X.fxRevIn);
      const rateMul = Math.pow(7, -clamp(p[K.fxClkmod] * iv[X.fxClk], 0, 1));
      this.fx.run(
        inD,
        inR,
        Math.round(p[K.fxMode]),
        clamp(p[K.fxTime] + 0.35 * iv[X.fxTime], 0, 1),
        clamp(p[K.fxTune] + iv[X.fxTune], 0, 1),
        clamp(p[K.fxFb] + iv[X.fxFb], 0, 1),
        rateMul,
        mad,
      );
      if (this.fx.clip) this.clip = true;
      ov[X.fxDlyOut] = 0.5 + 0.5 * clamp(this.fx.dlyOut, -1, 1);
      ov[X.fxRevOut] = 0.5 + 0.5 * clamp(this.fx.revOut, -1, 1);
      main += this.bip(X.mixin) + this.fx.dlyOut * p[K.fxDlyOut] + this.fx.revOut * p[K.fxRevOut];

      // parallel distortion, then the volume
      const drive = 1 + p[K.distDrive] * 24;
      const dm = p[K.distMix];
      let out = main * (1 - dm) + th(main * drive) * 0.6 * dm;
      out *= p[K.vol0] * 1.2;
      // a DC blocker, since audio-rate patches leave offsets, and then the external mixer's two outputs
      const y = out - this.dcX + 0.9995 * this.dcY;
      this.dcX = out;
      this.dcY = den(y);
      const e1 = this.bip(X.j1) * 0.5;
      const e2 = this.bip(X.j2) * 0.5;
      const f1 = e1 - this.exX[0] + 0.9995 * this.exY[0];
      const f2 = e2 - this.exX[1] + 0.9995 * this.exY[1];
      this.exX[0] = e1;
      this.exX[1] = e2;
      this.exY[0] = den(f1);
      this.exY[1] = den(f2);
      // a limiter last of all, so that no patch can be unkind to the speakers
      const oL = limit(this.dcY + this.exY[0]);
      const oR = limit(this.dcY + this.exY[1]);
      L[s] = Number.isFinite(oL) ? oL : 0;
      R[s] = Number.isFinite(oR) ? oR : 0;
      const a = Math.max(Math.abs(L[s]), Math.abs(R[s]));
      if (a > peak) peak = a;
    }
    this.peak = peak;
  }

  // ── bass drum ──
  private bd() {
    const { p, iv } = this;
    const sr = this.sr;
    const hi = this.gate[0] > 0.05;
    const tuneHz = 28 * Math.pow(2, p[K.bdTune] * 3.2);
    const pitch = p[K.bdPitch];
    if (hi && !this.bdPrev) {
      this.bdPe = 1;
      this.bdPhase = 0;
    }
    this.bdPrev = hi;
    // my reading: PITCH sets the depth of the drop at the start of the sound and how long it lasts
    this.bdPe *= Math.exp(-1 / ((0.004 + pitch * 0.14) * sr));
    const pe = this.bdPe + this.bip(X.bdWtf);
    const hz = clamp(tuneHz + p[K.bdAmt] * iv[X.bdMod] * 600 + pe * (0.2 + pitch * 5) * tuneHz, 5, sr * 0.45);
    this.bdPhase = frac(this.bdPhase + hz / sr);
    // a triangle at the core; OMG! and EXT come in ahead of the waveshaper
    let x = 1 - 4 * Math.abs(frac(this.bdPhase + 0.25) - 0.5);
    x = clamp(x + this.bip(X.bdOmg) + this.bip(X.bdExt), -1.6, 1.6);
    // DRIVE: triangle, then sine, then square
    const d = p[K.bdDrive];
    const sine = Math.sin((Math.PI / 2) * clamp(x, -1, 1));
    let y: number;
    if (d <= 0.5) y = lerp(x, sine, d / 0.5);
    else {
      const g = 1 + ((d - 0.5) / 0.5) * 40;
      y = th(g * sine) / th(g * 0.9 + 0.1);
    }
    const out = clamp(y, -1.2, 1.2) * this.env[0].level * 0.9;
    this.vo[0] = out;
    this.ov[X.bdOut] = 0.5 + 0.5 * clamp(out, -1, 1);
  }

  // ── bass ──
  private bass() {
    const { p, iv } = this;
    const sr = this.sr;
    const hi = this.gate[1] > 0.05;
    const mode = Math.round(p[K.bsMode]);
    const tune = p[K.bsTune];
    let hz: number;
    if (mode === 1) {
      // MIDI: a keyboard, tuned by half a tone, bent by an octave, with a glide set from controller 5
      const target = this.bsNote + (tune - 0.5) + this.bsBend * 12;
      this.bsSemi += (target - this.bsSemi) * coef(0.001 + this.bsGlide * this.bsGlide * 1.5, sr);
      hz = 440 * Math.pow(2, (this.bsSemi - 69) / 12);
    } else {
      // CV: five octaves of tuning, then one volt per octave over four volts
      const volts = this.cp.driven[X.bsCv] ? iv[X.bsCv] * 10 : 0;
      hz = 32.7 * Math.pow(2, tune * 5) * Math.pow(2, clamp(volts, 0, 4));
    }
    const shape = clamp(p[K.bsShape] + this.bip(X.bsShape), 0, 1);
    const warp = clamp(p[K.bsWarp] + this.bip(X.bsWarp), 0, 1);
    const amt = p[K.bsAmt];
    let duck = 1;
    if (mode === 2) {
      // my reading of PRC: a pitch dive, a little noise, and the MOD input becomes a sidechain
      if (hi && !this.bsPrev) this.bsPe = 1;
      this.bsPe *= Math.exp(-1 / ((0.01 + shape * 0.12) * sr));
      hz *= 1 + this.bsPe * (0.5 + shape * 6);
      duck = 1 - clamp(amt * iv[X.bsAmt], 0, 1);
    }
    this.bsPrev = hi;
    hz = clamp(hz, 8, sr * 0.45);
    const dt = hz / sr;
    this.bsPhase = frac(this.bsPhase + dt);
    const ph = mode === 2 ? this.bsPhase : frac(this.bsPhase + amt * this.bip(X.bsAmt));
    // SHAPE: sine, triangle, saw, then a pulse that narrows, so the harmonics climb all the way as the knob turns clockwise
    const sin = Math.sin(TAU * ph);
    const tri = 1 - 4 * Math.abs(frac(ph + 0.25) - 0.5);
    const saw = 2 * ph - 1 - polyblep(ph, dt);
    const s3 = shape * 3;
    let w: number;
    if (s3 < 1) w = lerp(sin, tri, s3);
    else if (s3 < 2) w = lerp(tri, saw * 0.9, s3 - 1);
    else {
      const d = 0.5 - 0.42 * (s3 - 2);
      const pulse = (ph < d ? 1 : -1) + polyblep(ph, dt) - polyblep(frac(ph + 1 - d), dt) - (2 * d - 1);
      w = lerp(saw * 0.9, pulse * 0.6, Math.min(1, (s3 - 2) * 4));
    }
    if (mode === 2) w += (this.rng.next() * 2 - 1) * warp * 0.35;
    // WARP loads a waveshaper that sits after the oscillator, and does nothing at zero
    const wg = 1 + warp * 14;
    w = lerp(w, th(wg * w) / th(wg), Math.min(1, warp * 8)) + this.bip(X.bsExt);
    const res = 4.1 * p[K.bsQ];
    const fc = p[K.bsLpf] * Math.pow(2, 5 * iv[X.bsLpf]);
    const y = this.bsLadder.run(w * 0.9, fc, res, sr) * (1 + 0.22 * res);
    const out = y * this.env[1].level * duck;
    this.vo[1] = out;
    this.ov[X.bsOut] = 0.5 + 0.5 * clamp(out, -1, 1);
  }

  // ── snare ──
  private snare() {
    const { p, iv } = this;
    const sr = this.sr;
    const hi = this.gate[2] > 0.05;
    if (hi && !this.sdPrev) this.sdT = 0;
    this.sdPrev = hi;
    this.sdT += 1 / sr;
    // TUNE sets how fast a noise is sampled and held, which is to say its spectrum
    const rate = clamp(400 * Math.pow(2, p[K.sdTune] * 6 + p[K.sdAmt] * this.bip(X.sdMod) * 3), 50, sr * 0.9);
    const spectral = this.sdNoise.run(rate, sr);
    const pink = this.sdPink.run(this.rng.next() * 2 - 1) * 3;
    let x = lerp(spectral, pink, p[K.sdMix]) * 0.9 + this.bip(X.sdExt);
    // CLAP splits the attack into a few bursts; at the top of the knob they spread a long way
    const clap = p[K.sdClap];
    if (clap > 0.04) {
      const sp = 0.004 + clap * 0.05;
      if (this.sdT < 3 * sp) x *= lerp(1, Math.exp(-(this.sdT % sp) / 0.01), Math.min(1, clap * 3));
    }
    const q = p[K.sdQ];
    const k = 2 * (1 - q * 0.996) + 0.004;
    this.sdSvf.run(x, svfG(p[K.sdBpf] * Math.pow(2, 4 * iv[X.sdBpf]), sr), k);
    const y = th(this.sdSvf.bp * k * (1 + 2.5 * q * q) * 1.2 + x * 0.12);
    const out = y * this.env[2].level * 0.9;
    this.vo[2] = out;
    this.ov[X.sdOut] = 0.5 + 0.5 * clamp(out, -1, 1);
  }

  // ── hi-hat ──
  private hat() {
    const { p, iv } = this;
    const sr = this.sr;
    const rate = clamp(1500 * Math.pow(2, p[K.hhTune] * 5 + this.bip(X.hhMod) * 3), 100, sr * 0.9);
    const n = this.hhNoise.run(rate, sr);
    const warp = p[K.hhWarp];
    const x = th((1 + warp * 18) * n) * (0.7 + 0.3 * warp) + this.bip(X.hhExt);
    const q = p[K.hhQ];
    this.hhSvf.run(x, svfG(p[K.hhHpf] * Math.pow(2, 3 * iv[X.hhHpf]), sr), 2 * (1 - q * 0.99) + 0.01);
    const out = th(this.hhSvf.hp * (1 + 0.8 * q)) * this.env[3].level * 0.8;
    this.vo[3] = out;
    this.ov[X.hhOut] = 0.5 + 0.5 * clamp(out, -1, 1);
  }

  // ── shaos ──
  private shaos() {
    const { p, iv, ov } = this;
    const sr = this.sr;
    let tick = false;
    if (this.cp.driven[X.shClk] === 1) {
      const hi = iv[X.shClk] > 0.5;
      tick = hi && !this.shPrevClk;
      this.shPrevClk = hi;
    } else {
      this.shPhase += clamp(p[K.shFreq] * Math.pow(2, 6 * iv[X.shMod]), 0.05, sr * 0.45) / sr;
      if (this.shPhase >= 1) {
        this.shPhase -= 1;
        tick = true;
      }
    }
    if (tick) {
      const len = Math.round(p[K.shLen]);
      const r = this.shReg;
      let bit: number;
      if (len === 0) {
        // 63 steps: a maximal 6-bit register, x^6 + x^5 + 1
        bit = (r & 63) === 0 ? 1 : ((r >> 5) ^ (r >> 4)) & 1;
      } else if (len === 1) {
        // 16 steps: the register is a loop of memory, rewritten from the DATA pin when something is clipped there
        bit = this.cp.driven[X.shData] === 1 ? (iv[X.shData] > 0.5 ? 1 : 0) : (r >> 15) & 1;
      } else {
        // 217 steps: a 15-bit register whose feedback has order 217. There are twelve such polynomials; this is one.
        let x = r & 0x4178;
        x ^= x >> 8;
        x ^= x >> 4;
        x ^= x >> 2;
        x ^= x >> 1;
        bit = (r & 0x7fff) === 0 ? 1 : x & 1;
      }
      this.shReg = ((r << 1) | bit) & 0xffff;
    }
    const r = this.shReg;
    // the outputs sit at different stages, so they play shifted copies of one sequence
    ov[X.sh1d] = r & 1;
    ov[X.sh2d] = (((r >> 2) & 1) + 2 * ((r >> 5) & 1)) / 3;
    // sample and hold: on the S/H pin's rising edge, or on the internal clock when nothing is clipped there
    let sample = tick;
    if (this.cp.driven[X.shSh] === 1) {
      const hi = iv[X.shSh] > 0.5;
      sample = hi && !this.shPrevSh;
      this.shPrevSh = hi;
    }
    if (sample) {
      this.shHeld1 = (r >> 9) & 1;
      this.shHeld3 = (((r >> 4) & 1) + 2 * ((r >> 8) & 1) + 4 * ((r >> 12) & 1)) / 7;
    }
    ov[X.sh1s] = this.shHeld1;
    ov[X.sh3s] = this.shHeld3;
  }

  // ── lfo ──
  private lfo() {
    const { p, iv } = this;
    const range = Math.round(p[K.lfoRange]);
    const lo = range === 0 ? 0.1 : range === 1 ? 4 : 200;
    const hi = range === 0 ? 8 : range === 1 ? 400 : 5000;
    const f = clamp(lo * Math.pow(hi / lo, p[K.lfoFreq]) * Math.pow(2, p[K.lfoAmt] * 5 * iv[X.lfoMod]), 0.01, this.sr * 0.45);
    const sync = iv[X.lfoSync] > 0.5;
    if (sync && !this.lfoPrevSync) this.lfoPhase = 0;
    this.lfoPrevSync = sync;
    this.lfoPhase = frac(this.lfoPhase + f / this.sr);
    const a = clamp(p[K.lfoWave], 0.001, 0.999);
    const ph = this.lfoPhase;
    // the knob moves the peak: a falling saw, a triangle, a rising saw
    this.ov[X.lfoTri] = ph < a ? ph / a : (1 - ph) / (1 - a);
    this.ov[X.lfoSq] = ph < 0.5 ? 1 : 0;
  }

  // ── attenuators, VCAs, inverters, switches, pulse converters, the diode, the capacitors ──
  private parts() {
    const { p, iv, ib, ov } = this;
    const sb = this.cp.sb;
    for (let i = 0; i < 4; i++) {
      const b = ib[X.atIn[i]];
      ov[X.atOut[i]] = (iv[X.atIn[i]] - b) * p[K.at[i]] + b;
    }
    for (let i = 0; i < 2; i++) {
      const b = ib[X.vcaIn[i]];
      ov[X.vcaOut[i]] = (iv[X.vcaIn[i]] - b) * iv[X.vcaCv[i]] + b;
      ov[X.swOut[i]] = iv[X.swCv[i]] > 0.5 ? iv[X.swIn[i]] : ib[X.swIn[i]];
      // a pulse converter: a short, fast-decaying pulse for each rising edge
      const hi = iv[X.pcIn[i]] > 0.5;
      if (hi && !this.pcPrev[i]) this.pcv[i] = 1;
      this.pcPrev[i] = hi;
      this.pcv[i] *= Math.exp(-1 / (0.003 * this.sr));
      if (this.pcv[i] < 1e-4) this.pcv[i] = 0;
      ov[X.pcOut[i]] = this.pcv[i];
    }
    // an inverter turns a signal over about 5 volts
    ov[X.invOut] = 1 - iv[X.invIn];
    ov[X.cinvOut] = iv[X.cinvIn] > 0.5 !== iv[X.cinvCv] > 0.5 ? 1 : 0;
    // the diode passes the anode on to the cathode, less its drop, when nothing else drives the cathode
    ov[X.dioK] = Math.max(0, iv[X.dioA] - 0.06);
    // a capacitor in series lets changes through and blocks the level: a high-pass, 10 ms for 0.1 µF and 1 s for 10 µF
    for (let i = 0; i < 2; i++) {
      const k = coef(i === 0 ? 0.01 : 1, this.sr);
      const a = X.capA[i];
      const b = X.capB[i];
      this.capLpAB[i] += (iv[a] - this.capLpAB[i]) * k;
      this.capLpBA[i] += (iv[b] - this.capLpBA[i]) * k;
      ov[b] = sb[b] + (iv[a] - this.capLpAB[i]);
      ov[a] = sb[a] + (iv[b] - this.capLpBA[i]);
    }
  }

  /** What the panel needs to light its LEDs and pins. */
  mon(): Mon {
    const pins = new Array<number>(NPINS);
    for (let i = 0; i < NPINS; i++) pins[i] = this.cp.isSrc[i] ? this.ov[i] : this.iv[i];
    return {
      t: 'mon',
      pins,
      head: [...this.lr.pulse],
      bank: this.lr.bank,
      running: this.lr.running,
      env: [...this.monEnv],
      clip: this.clip,
      led: this.clock.led,
      peak: this.peak,
    };
  }
}
