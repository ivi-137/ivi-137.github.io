/**
 * Organismo 23: the control table and the patch bay, shared by the panel and the audio thread.
 *
 * It is a study of the Soma Laboratory Pulsar-23, from the manufacturer's manual and quick-start guide. Every
 * knob and switch is one entry in PARAMS; every alligator-clip pin is one entry in PINS. The panel binds to them
 * by id, and the AudioWorklet reads them by index, so the two sides only exchange (index, value) pairs.
 *
 * Signals follow the original's convention: audio and control voltage share one range, 0 to 10 volts, written
 * here as 0 to 1. Audio is centred on 5 volts (0.5). A pin with several clips on it adds them together.
 */

export type Kind = 'float' | 'choice';
export type Fmt = 'pct' | 'hz' | 's' | 'int';

export interface ParamSpec {
  id: string;
  label: string;
  kind: Kind;
  def: number;
  min: number;
  max: number;
  step: number;
  /** `exp` runs the range geometrically (frequencies, times); `lin` runs it evenly. */
  map: 'lin' | 'exp';
  options?: string[];
  fmt: Fmt;
}

const lin = (id: string, label: string, def = 0, min = 0, max = 1, fmt: Fmt = 'pct'): ParamSpec => ({ id, label, kind: 'float', def, min, max, step: 0.001, map: 'lin', fmt });
const exp = (id: string, label: string, def: number, min: number, max: number, fmt: Fmt): ParamSpec => ({ id, label, kind: 'float', def, min, max, step: 0.001, map: 'exp', fmt });
const sw = (id: string, label: string, def: number, options: string[]): ParamSpec => ({ id, label, kind: 'choice', def, min: 0, max: options.length - 1, step: 1, map: 'lin', options, fmt: 'int' });

export const VOICES = ['bd', 'bs', 'sd', 'hh'] as const;
export type Voice = (typeof VOICES)[number];
export const VOICE_NAMES = ['BD', 'BASS', 'SD', 'HHT'];

/** Attack and release are the same on all four voices. */
const att = (id: string) => exp(id, 'att', 0.0015, 0.0003, 0.8, 's');
const rel = (id: string, def: number) => exp(id, 'rel', def, 0.003, 4, 's');

export const PARAMS: ParamSpec[] = [
  // clock
  exp('clk.temp', 'temp', 16, 1, 200, 'hz'),
  lin('clk.amt', 'amt', 0),
  sw('clk.src', 'clock', 0, ['INT', 'CLK', 'MIDI']),

  // looper channel modes
  ...VOICES.map((_, i) => sw(`lr${i}.mode`, 'rec · play', 2, ['REC', 'MUTE', 'PLAY'])),

  // bass drum
  lin('bd.tune', 'tune', 0.35),
  lin('bd.amt', 'amt', 0),
  lin('bd.pitch', 'pitch', 0.45),
  lin('bd.drive', 'drive', 0.5),
  lin('bd.vol', 'vol', 0.8),
  lin('bd.fx', 'fx', 0),
  att('bd.att'),
  rel('bd.rel', 0.16),

  // bass
  sw('bs.mode', 'dco', 0, ['CV', 'MIDI', 'PRC']),
  lin('bs.shape', 'shape', 0.3),
  lin('bs.warp', 'warp', 0.1),
  lin('bs.tune', 'tune', 0.35),
  lin('bs.amt', 'amt', 0),
  exp('bs.lpf', 'lpf fr', 1800, 40, 18000, 'hz'),
  lin('bs.q', 'lpf q', 0.3),
  lin('bs.vol', 'vol', 0.6),
  lin('bs.fx', 'fx', 0),
  att('bs.att'),
  rel('bs.rel', 0.3),

  // snare
  lin('sd.tune', 'tune', 0.5),
  lin('sd.amt', 'amt', 0),
  lin('sd.clap', 'clap', 0),
  lin('sd.mix', 'mix', 0.4),
  exp('sd.bpf', 'bpf fr', 1800, 150, 9000, 'hz'),
  lin('sd.q', 'bpf q', 0.5),
  lin('sd.vol', 'vol', 0.7),
  lin('sd.fx', 'fx', 0),
  att('sd.att'),
  rel('sd.rel', 0.2),

  // hi-hat
  lin('hh.tune', 'tune', 0.6),
  lin('hh.warp', 'warp', 0.3),
  exp('hh.hpf', 'hpf fr', 6000, 1500, 14000, 'hz'),
  lin('hh.q', 'hpf q', 0.2),
  lin('hh.vol', 'vol', 0.5),
  lin('hh.fx', 'fx', 0),
  att('hh.att'),
  rel('hh.rel', 0.08),

  // shaos
  exp('sh.freq', 'freq', 6, 0.2, 15000, 'hz'),
  sw('sh.len', 'length', 0, ['63', '16', '217']),

  // fx
  sw('fx.route', 'send to', 0, ['DLY', 'REV']),
  sw('fx.mode', 'mode', 0, ['BPF', 'DBL', 'PCH']),
  lin('fx.time', 'time', 0.45),
  lin('fx.tune', 'tune', 0.5),
  lin('fx.fb', 'fb', 0.35),
  lin('fx.clkmod', 'clk mod', 0),
  lin('fx.dlyout', 'dly out', 0.35),
  lin('fx.revout', 'rev out', 0.3),

  // lfo
  lin('lfo.freq', 'freq', 0.5),
  lin('lfo.amt', 'amt', 0),
  lin('lfo.wave', 'wave', 0.5),
  sw('lfo.range', 'range', 0, ['LOW', 'MID', 'HI']),

  // distortion, attenuators, master
  lin('dist.drive', 'drive', 0.3),
  lin('dist.mix', 'mix', 0),
  ...[0, 1, 2, 3].map((i) => lin(`at${i}`, 'level', 1)),
  lin('vol', 'volume', 0.6),
];

export const PIDX: Record<string, number> = Object.fromEntries(PARAMS.map((p, i) => [p.id, i]));
export const spec = (id: string) => PARAMS[PIDX[id]];
export const defaults = () => Float64Array.from(PARAMS.map((p) => p.def));

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** Real value to knob position, 0 to 1. */
export function toNorm(s: ParamSpec, v: number) {
  v = clamp(v, s.min, s.max);
  if (s.kind === 'choice') return s.max === s.min ? 0 : (v - s.min) / (s.max - s.min);
  return s.map === 'exp' ? Math.log(v / s.min) / Math.log(s.max / s.min) : (v - s.min) / (s.max - s.min);
}

/** Knob position, 0 to 1, to real value. */
export function fromNorm(s: ParamSpec, n: number) {
  n = clamp(n, 0, 1);
  if (s.kind === 'choice') return Math.round(s.min + n * (s.max - s.min));
  return s.map === 'exp' ? s.min * Math.pow(s.max / s.min, n) : s.min + n * (s.max - s.min);
}

export function format(s: ParamSpec, v: number): string {
  switch (s.fmt) {
    case 'pct':
      return `${Math.round(v * 100)}`;
    case 'hz':
      return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v >= 100 ? `${Math.round(v)}` : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    case 's':
      return v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`;
    default:
      return s.options ? (s.options[Math.round(v)] ?? '') : `${Math.round(v)}`;
  }
}

// ── the patch bay ──────────────────────────────────────────────────────────

/** Which way a pin faces. `io` pins both send and receive (a trigger pin is the looper's output and the envelope's input). */
export type Dir = 'out' | 'in' | 'io';
/** What a pin carries. Audio sits around 5 volts; everything else sits at 0. Pass-through parts inherit it. */
export type Sig = 'audio' | 'cv' | 'gate';

export interface PinSpec {
  id: string;
  /** The section of the panel it belongs to. */
  mod: string;
  label: string;
  dir: Dir;
  sig: Sig;
  /** A hint shown on hover. */
  tip?: string;
}

const pin = (id: string, mod: string, label: string, dir: Dir, sig: Sig, tip?: string): PinSpec => ({ id, mod, label, dir, sig, tip });

const DIV_NAMES = ['16', '8', '4', '2', '1', '0.5', '0.25'];
export const DIV_PINS = ['div.16', 'div.8', 'div.4', 'div.2', 'div.1', 'div.05', 'div.025'];

export const PINS: PinSpec[] = [
  // clock
  pin('clk', 'clock', 'clk', 'io', 'gate', 'Clock out; with the switch on CLK it is the clock input'),
  pin('clk.mod', 'clock', 'mod', 'in', 'cv', 'Modulates the clock frequency'),
  ...DIV_PINS.map((id, i) => pin(id, 'clock', DIV_NAMES[i], 'out', 'gate', `Clock divider: ${DIV_NAMES[i]}`)),

  // looper
  ...VOICES.map((_, i) => pin(`lr${i}.clk`, 'looper', 'clk', 'in', 'gate', `Individual clock for the ${VOICE_NAMES[i]} looper`)),
  pin('lr.rst', 'looper', 'lrst', 'in', 'gate', 'Restart the looper from zero. Keep it joined to the 0.25 divider'),
  ...VOICES.map((_, i) => pin(`trig${i}`, 'looper', 'trig', 'io', 'gate', `${VOICE_NAMES[i]}: looper output and envelope input`)),

  // envelopes
  ...VOICES.map((_, i) => pin(`env${i}`, 'looper', 'env', 'out', 'cv', `${VOICE_NAMES[i]} envelope`)),

  // bd
  pin('bd.mod', 'bd', 'mod', 'in', 'cv', 'Pitch, volts per hertz'),
  pin('bd.wtf', 'bd', 'wtf?', 'in', 'cv', 'Circuit-bending node: the pitch modulator'),
  pin('bd.omg', 'bd', 'omg!', 'in', 'cv', 'Circuit-bending node: the triangle core'),
  pin('bd.ext', 'bd', 'ext', 'in', 'audio', 'External signal, before the waveshaper'),
  pin('bd.out', 'bd', 'out', 'out', 'audio', 'Before the volume knob'),

  // bass
  pin('bs.cv', 'bs', 'cv in', 'in', 'cv', 'Pitch, one volt per octave, 0 to 4 V'),
  pin('bs.shape', 'bs', 'shape', 'in', 'cv', 'Shape'),
  pin('bs.warp', 'bs', 'warp', 'in', 'cv', 'Warp'),
  pin('bs.amt', 'bs', 'pm', 'in', 'cv', 'Phase modulation; a sidechain input in PRC'),
  pin('bs.lpf', 'bs', 'lpf', 'in', 'cv', 'Filter cutoff'),
  pin('bs.ext', 'bs', 'ext', 'in', 'audio', 'External signal, before the filter'),
  pin('bs.out', 'bs', 'out', 'out', 'audio', 'Before the volume knob'),

  // sd
  pin('sd.mod', 'sd', 'mod', 'in', 'cv', 'Noise spectrum'),
  pin('sd.bpf', 'sd', 'bpf', 'in', 'cv', 'Band-pass cutoff'),
  pin('sd.ext', 'sd', 'ext', 'in', 'audio', 'External signal, before the filter'),
  pin('sd.out', 'sd', 'out', 'out', 'audio', 'Before the volume knob'),

  // hht
  pin('hh.mod', 'hh', 'mod', 'in', 'cv', 'Noise spectrum'),
  pin('hh.hpf', 'hh', 'hpf', 'in', 'cv', 'High-pass cutoff'),
  pin('hh.ext', 'hh', 'ext', 'in', 'audio', 'External signal, before the filter'),
  pin('hh.out', 'hh', 'out', 'out', 'audio', 'Before the volume knob'),

  // shaos
  pin('sh.mod', 'shaos', 'mod', 'in', 'cv', 'Clock frequency'),
  pin('sh.clk', 'shaos', 'clk', 'in', 'gate', 'External clock; the internal one stops while something is clipped here'),
  pin('sh.sh', 'shaos', 's/h', 'in', 'gate', 'Sample and hold pulses'),
  pin('sh.data', 'shaos', 'data', 'in', 'gate', 'Writes into the 16-step memory'),
  pin('sh.1d', 'shaos', '1bit', 'out', 'gate', '1 bit, direct'),
  pin('sh.2d', 'shaos', '2bit', 'out', 'cv', '2 bits, direct'),
  pin('sh.1s', 'shaos', '1bit', 'out', 'gate', '1 bit, sample and hold'),
  pin('sh.3s', 'shaos', '3bit', 'out', 'cv', '3 bits, sample and hold'),

  // fx
  pin('fx.mad', 'fx', 'mad!', 'in', 'gate', 'Madness in BPF and PCH; stereo in DBL. Join it to +10v to keep it on'),
  pin('fx.time', 'fx', 'time', 'in', 'cv', 'Delay time'),
  pin('fx.clkmod', 'fx', 'clk', 'in', 'cv', 'Modulates the clock of the whole DSP'),
  pin('fx.tune', 'fx', 'tune', 'in', 'cv', 'Tune'),
  pin('fx.fb', 'fx', 'fb', 'in', 'cv', 'Feedback'),
  pin('fx.dly.in', 'fx', 'dly', 'in', 'audio', 'Auxiliary delay input'),
  pin('fx.rev.in', 'fx', 'rev', 'in', 'audio', 'Auxiliary reverb input'),
  pin('fx.dly.out', 'fx', 'dly', 'out', 'audio', 'Delay output (left in stereo mode)'),
  pin('fx.rev.out', 'fx', 'rev', 'out', 'audio', 'Reverb output (right in stereo mode)'),

  // lfo
  pin('lfo.mod', 'lfo', 'mod', 'in', 'cv', 'Frequency'),
  pin('lfo.sq', 'lfo', 'sq', 'out', 'gate', 'Square'),
  pin('lfo.tri', 'lfo', 'tri', 'out', 'cv', 'Triangle, or a saw'),
  pin('lfo.sync', 'lfo', 'sync', 'in', 'gate', 'A rising edge resets it to zero'),

  // attenuators
  ...[0, 1, 2, 3].flatMap((i) => [pin(`at${i}.in`, 'att', 'in', 'in', 'cv'), pin(`at${i}.out`, 'att', 'out', 'out', 'cv')]),

  // vca, inverters, switches, pulse converters
  ...[0, 1].flatMap((i) => [pin(`vca${i}.in`, 'vca', 'in', 'in', 'cv'), pin(`vca${i}.cv`, 'vca', 'cv', 'in', 'cv', 'Gain, 0 to 1'), pin(`vca${i}.out`, 'vca', 'out', 'out', 'cv')]),
  pin('inv.in', 'inv', 'in', 'in', 'cv'),
  pin('inv.out', 'inv', 'out', 'out', 'cv', 'Inverted around 5 volts'),
  pin('cinv.in', 'inv', 'in', 'in', 'gate'),
  pin('cinv.cv', 'inv', 'cv', 'in', 'gate', 'Above 5 volts it inverts the trigger'),
  pin('cinv.out', 'inv', 'out', 'out', 'gate'),
  ...[0, 1].flatMap((i) => [pin(`sw${i}.in`, 'sw', 'in', 'in', 'cv'), pin(`sw${i}.cv`, 'sw', 'cv', 'in', 'gate', 'Above 5 volts it closes the switch'), pin(`sw${i}.out`, 'sw', 'out', 'out', 'cv')]),
  ...[0, 1].flatMap((i) => [pin(`pc${i}.in`, 'pc', 'in', 'in', 'gate'), pin(`pc${i}.out`, 'pc', 'out', 'out', 'gate', 'A short pulse for each rising edge')]),

  // single components
  pin('dio.a', 'parts', 'anode', 'in', 'cv'),
  pin('dio.k', 'parts', 'cathode', 'out', 'cv'),
  pin('cap1.a', 'parts', '0.1µF', 'in', 'cv'),
  pin('cap1.b', 'parts', '0.1µF', 'out', 'cv'),
  pin('cap2.a', 'parts', '10µF', 'in', 'cv'),
  pin('cap2.b', 'parts', '10µF', 'out', 'cv'),

  // sensors and midi
  pin('sens0.cv', 'sens', 'cv', 'out', 'cv', 'Touch sensor: 0 to 10 volts by pressure'),
  pin('sens1.cv', 'sens', 'cv', 'out', 'cv', 'Touch sensor: 0 to 10 volts by pressure'),
  pin('midi0', 'midi', 'ktr', 'out', 'cv', 'MIDI to CV 1, or key tracking of the bass'),
  pin('midi1', 'midi', '2', 'out', 'cv', 'MIDI to CV 2'),
  pin('midi2', 'midi', '3', 'out', 'cv', 'MIDI to CV 3'),
  pin('midi3', 'midi', '4', 'out', 'cv', 'MIDI to CV 4'),

  // utility
  pin('noise', 'util', 'noise', 'out', 'audio', 'Pink noise'),
  pin('v10', 'util', '+10v', 'out', 'gate', 'A constant 10 volts'),
  pin('gnd', 'util', 'gnd', 'in', 'cv', 'Ground'),
  pin('mixin', 'util', 'mix in', 'in', 'audio', 'Added to the main mix'),

  // adapters
  ...[1, 2, 3, 4, 5, 6].map((n) => pin(`j${n}`, 'jacks', `${n}`, 'io', 'audio', n === 1 ? 'Left output of the external mixer' : n === 2 ? 'Right output of the external mixer' : 'A free junction')),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => pin(`m${n}`, 'jacks', `${n}`, 'io', 'cv', n === 1 ? 'Audio input from the microphone, once enabled' : 'A free junction')),
];

export const PIN_INDEX: Record<string, number> = Object.fromEntries(PINS.map((p, i) => [p.id, i]));
export const NPINS = PINS.length;

/** Cables are pairs of pin ids. Which pins share a net is all that matters: the order of a pair never does. */
export type Cable = [string, string];

// ── looper geometry ────────────────────────────────────────────────────────

/** A loop is 128 pulses of the clock: four bars of four quarters, a pulse being a 32nd note. */
export const PULSES = 128;
/** The looper upsamples the clock by 96, which is 192 events to a sixteenth note. */
export const EVENTS_PER_PULSE = 96;
export const LOOP_EVENTS = PULSES * EVENTS_PER_PULSE;
export const BANKS = 4;
export const SIXTEENTH = 2 * EVENTS_PER_PULSE;

// ── messages between the panel and the audio thread ────────────────────────

export type Btn = 'add' | 'del';

export type ToDsp =
  | { t: 'init'; p: number[]; cables: Cable[] }
  | { t: 'p'; i: number; v: number }
  | { t: 'cables'; c: Cable[] }
  | { t: 'lr'; ch: number; btn: Btn; down: boolean }
  | { t: 'rc'; btn: 'L' | 'M' | 'BANK'; down: boolean }
  | { t: 'rst' }
  | { t: 'bank'; b: number }
  | { t: 'sens'; i: number; v: number }
  | { t: 'trig'; ch: number; v: number }
  | { t: 'note'; note: number; vel: number; on: boolean }
  | { t: 'cc'; cc: number; v: number }
  | { t: 'bend'; v: number }
  | { t: 'cv'; i: number; v: number }
  | { t: 'mclk' }
  | { t: 'mstart' }
  | { t: 'mstop' }
  | { t: 'mic'; on: boolean }
  | { t: 'loops'; data: number[][][] }
  | { t: 'dump' };

export interface Mon {
  t: 'mon';
  /** the value on every pin, 0 to 1 */
  pins: number[];
  /** playhead of each looper in pulses, 0 to 127 */
  head: number[];
  bank: number;
  running: boolean;
  /** envelope level of each voice */
  env: number[];
  clip: boolean;
  /** green clock LED: 0 off, 1 on, 2 bright (loop start) */
  led: number;
  peak: number;
}

export interface Dump {
  t: 'dump';
  /** [bank][channel], each a run-length code */
  data: number[][][];
}

/** One loop, sent when it changes, so the panel can draw its tape. */
export interface Tape {
  t: 'tape';
  bank: number;
  ch: number;
  r: number[];
}

// ── notes of a loop, for presets and share links ───────────────────────────

/** A note in the grid of sixteenth notes: where it starts, how long, and how hard (1 low, 2 middle, 3 high). */
export type GridNote = [start16: number, len16: number, vel?: number];

export function gridToEvents(notes: GridNote[]): Uint8Array {
  const e = new Uint8Array(LOOP_EVENTS);
  for (const [s, l, v = 3] of notes) {
    const a = Math.round(s * SIXTEENTH);
    const b = Math.min(LOOP_EVENTS, a + Math.max(1, Math.round(l * SIXTEENTH)));
    for (let i = a; i < b; i++) e[i % LOOP_EVENTS] = v;
  }
  return e;
}

/** Run-length code for a loop: [value, run] pairs. Loops are mostly silence, so it stays short. */
export function rle(e: ArrayLike<number>): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < e.length) {
    const v = e[i];
    let j = i + 1;
    while (j < e.length && e[j] === v) j++;
    out.push(v, j - i);
    i = j;
  }
  return out;
}

export function unrle(r: number[]): Uint8Array {
  const e = new Uint8Array(LOOP_EVENTS);
  let at = 0;
  for (let k = 0; k + 1 < r.length && at < LOOP_EVENTS; k += 2) {
    const v = r[k] & 3;
    const n = Math.min(r[k + 1], LOOP_EVENTS - at);
    if (v) e.fill(v, at, at + n);
    at += n;
  }
  return e;
}
