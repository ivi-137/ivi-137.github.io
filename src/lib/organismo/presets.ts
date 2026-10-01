/**
 * Organismo 23's starting points. The Pulsar-23 forgets everything when it is switched off, so these are patches to
 * clip together and loops to play, not stored sounds. Several are the examples from the manufacturer's manual (the
 * metronome, the basic techno rhythm, the sidechain, the hip-hop pitch drop, the hi-hat shift with the controlled
 * inverter, the DSP clock following the kick); the rest show what the Shaos, the loopers' own clocks and the touch
 * sensors can do.
 *
 * Loops are written as notes on a grid of sixteenths: four bars of sixteen, 64 places.
 */
import { PIDX, PARAMS, defaults, gridToEvents, rle, type Cable, type GridNote } from './params';

export interface Preset {
  id: string;
  name: string;
  group: string;
  /** What it does and how to play with it. */
  blurb: string;
  set?: Record<string, number>;
  cables?: Cable[];
  /** per bank, per channel (0 BD, 1 BASS, 2 SD, 3 HHT), the notes of its loop */
  loops?: Record<number, GridNote[]>[];
  /** the bank to start in */
  bank?: number;
}

/** A pattern of one bar of sixteenths, repeated over the four bars of a loop. */
const bars = (pattern: number[], len = 1, vel = 3): GridNote[] => [0, 1, 2, 3].flatMap((b) => pattern.map((s) => [s + 16 * b, len, vel] as GridNote));

const FLOOR = [0, 4, 8, 12];
const BACKBEAT = [4, 12];
const OFFBEAT = [2, 6, 10, 14];
const LRST: Cable = ['div.025', 'lr.rst'];

export const PRESETS: Preset[] = [
  {
    id: 'unpatched',
    name: 'Unpatched',
    group: 'start',
    blurb: 'The Pulsar as it comes out of the box: a clock, four empty loopers, four voices, effects and an output. Nothing is clipped to anything. Touch ADD under a voice to play it; set REC and keep touching, and the loop records it, for as long as you touch.',
    set: {},
  },
  {
    id: 'loop-kit',
    name: 'Loop kit',
    group: 'start',
    blurb: 'Four loops already recorded in bank 1: kick, bass, snare and hats. LRST is clipped to the 0.25 divider so the looper and the dividers stay together. Bank 2 has a busier version: hold BANK and touch the ADD sensor of the BASS channel to switch.',
    set: {
      'clk.temp': 16,
      'bd.tune': 0.3, 'bd.pitch': 0.5, 'bd.drive': 0.55, 'bd.rel': 0.2, 'bd.vol': 0.85,
      'bs.tune': 0.28, 'bs.shape': 0.45, 'bs.warp': 0.25, 'bs.lpf': 900, 'bs.q': 0.35, 'bs.rel': 0.22, 'bs.vol': 0.5,
      'sd.tune': 0.55, 'sd.mix': 0.5, 'sd.bpf': 1900, 'sd.q': 0.55, 'sd.clap': 0.35, 'sd.rel': 0.18, 'sd.vol': 0.55, 'sd.fx': 0.25,
      'hh.tune': 0.75, 'hh.hpf': 7500, 'hh.q': 0.2, 'hh.rel': 0.05, 'hh.vol': 0.38,
      'fx.route': 1, 'fx.mode': 0, 'fx.fb': 0.4, 'fx.revout': 0.3,
    },
    cables: [LRST],
    loops: [
      { 0: bars(FLOOR, 1.2), 1: bars([2, 3.5, 6, 10, 11.5, 14], 0.7), 2: bars(BACKBEAT, 1.5), 3: bars(OFFBEAT, 0.5, 2) },
      { 0: [...bars(FLOOR, 1.2), ...[15, 31, 47, 62, 63].map((s) => [s, 0.8, 3] as GridNote)], 1: bars([0, 3, 6, 8, 11, 14], 0.8), 2: [...bars(BACKBEAT, 1.5), [30, 0.5, 2], [31, 0.5, 3], [62, 0.5, 2], [63, 0.5, 3]], 3: bars([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 0.3, 2) },
    ],
  },
  {
    id: 'techno',
    name: 'Basic techno',
    group: 'from the manual',
    blurb: 'The manual\'s own recipe: output 2 of the clock divider through a pulse converter to the snare, output 4 through the second converter to the kick, and output 16 straight to the hi-hat. No looper at all, only the dividers, so tempo and swing come from the clock: try AMT on the clock with the 0.25 divider into MOD.',
    set: {
      'clk.temp': 16,
      'bd.tune': 0.3, 'bd.pitch': 0.5, 'bd.drive': 0.55, 'bd.rel': 0.2, 'bd.vol': 0.85,
      'sd.tune': 0.6, 'sd.mix': 0.5, 'sd.bpf': 1800, 'sd.q': 0.55, 'sd.rel': 0.16, 'sd.vol': 0.6,
      'hh.tune': 0.7, 'hh.hpf': 7000, 'hh.rel': 0.04, 'hh.vol': 0.4,
    },
    cables: [['div.2', 'pc0.in'], ['pc0.out', 'trig2'], ['div.4', 'pc1.in'], ['pc1.out', 'trig0'], ['div.16', 'trig3'], LRST],
  },
  {
    id: 'metronome',
    name: 'Metronome',
    group: 'from the manual',
    blurb: 'Output 2 of the divider into an attenuator, and the attenuator into MIX IN. The attenuator is the volume of the click. The manual also does it with a finger on each pin, using the body as the cable.',
    set: { 'clk.temp': 16, at0: 0.5 },
    cables: [['div.2', 'at0.in'], ['at0.out', 'mixin'], LRST],
  },
  {
    id: 'sidechain',
    name: 'Sidechain',
    group: 'from the manual',
    blurb: 'The kick\'s envelope goes through the inverter into the CV of a VCA, and the pink noise goes through that VCA into MIX IN. Every kick ducks the noise, which is how a sidechain compressor works, with no compressor.',
    set: {
      'clk.temp': 16, 'bd.tune': 0.3, 'bd.pitch': 0.5, 'bd.drive': 0.55, 'bd.rel': 0.28, 'bd.vol': 0.85,
      'hh.tune': 0.75, 'hh.hpf': 7500, 'hh.rel': 0.05, 'hh.vol': 0.3, at0: 0.35,
    },
    cables: [['env0', 'inv.in'], ['inv.out', 'vca0.cv'], ['noise', 'vca0.in'], ['vca0.out', 'at0.in'], ['at0.out', 'mixin'], LRST],
    loops: [{ 0: bars(FLOOR, 1.2), 3: bars(OFFBEAT, 0.5, 2) }],
  },
  {
    id: 'hiphop',
    name: 'Hip-hop drop',
    group: 'from the manual',
    blurb: 'The kick\'s own envelope clipped back into its pitch input, with AMT turned up a little: each hit falls through an extra drop. Move AMT and PITCH together.',
    set: {
      'clk.temp': 12, 'bd.tune': 0.22, 'bd.pitch': 0.35, 'bd.drive': 0.5, 'bd.rel': 0.45, 'bd.amt': 0.28, 'bd.vol': 0.9,
      'sd.tune': 0.5, 'sd.mix': 0.6, 'sd.bpf': 1600, 'sd.q': 0.45, 'sd.clap': 0.5, 'sd.rel': 0.2, 'sd.vol': 0.6, 'sd.fx': 0.3,
      'hh.tune': 0.8, 'hh.hpf': 8000, 'hh.rel': 0.035, 'hh.vol': 0.3, 'fx.route': 1, 'fx.revout': 0.25,
    },
    cables: [['env0', 'bd.mod'], LRST],
    loops: [{ 0: [[0, 1.5], [10, 1], [16, 1.5], [26, 1], [32, 1.5], [42, 1], [48, 1.5], [58, 1], [62, 1]], 2: bars(BACKBEAT, 1.5), 3: bars([0, 2, 4, 6, 8, 10, 12, 14], 0.4, 2) }],
  },
  {
    id: 'flip',
    name: 'Backbeat flip',
    group: 'from the manual',
    blurb: 'The controlled inverter turns each hi-hat pulse over when its CV is above 5 volts. Here the CV is the first touch sensor: put a finger on its plates and the hats move from the quarters to the off-beat eighths, and back when you let go.',
    set: {
      'clk.temp': 16, 'bd.tune': 0.3, 'bd.pitch': 0.5, 'bd.rel': 0.2, 'bd.vol': 0.85,
      'sd.tune': 0.6, 'sd.mix': 0.5, 'sd.bpf': 1800, 'sd.q': 0.5, 'sd.rel': 0.16, 'sd.vol': 0.55,
      'hh.tune': 0.7, 'hh.hpf': 7000, 'hh.rel': 0.04, 'hh.vol': 0.42,
    },
    cables: [['div.4', 'cinv.in'], ['sens0.cv', 'cinv.cv'], ['cinv.out', 'pc0.in'], ['pc0.out', 'trig3'], LRST],
    loops: [{ 0: bars(FLOOR, 1.2), 2: bars(BACKBEAT, 1.5) }],
  },
  {
    id: 'shaos-hats',
    name: 'Shaos hats',
    group: 'shaos',
    blurb: 'The 1-bit output of the Shaos, clocked by the 16th-note divider, is a random pattern of on and off that repeats every 63 sixteenths, so it drifts against the four-bar loop. A pulse converter makes triggers of it. The 3-bit sample-and-hold output moves the hat\'s noise spectrum.',
    set: {
      'clk.temp': 16, 'sh.len': 0,
      'bd.tune': 0.3, 'bd.pitch': 0.5, 'bd.rel': 0.2, 'bd.vol': 0.85,
      'sd.tune': 0.6, 'sd.mix': 0.5, 'sd.bpf': 1800, 'sd.q': 0.5, 'sd.rel': 0.16, 'sd.vol': 0.5,
      'hh.tune': 0.35, 'hh.hpf': 6500, 'hh.rel': 0.06, 'hh.vol': 0.45, 'hh.warp': 0.4,
    },
    cables: [['div.16', 'sh.clk'], ['sh.1d', 'pc0.in'], ['pc0.out', 'trig3'], ['sh.3s', 'hh.mod'], LRST],
    loops: [{ 0: bars(FLOOR, 1.2), 2: bars(BACKBEAT, 1.5) }],
  },
  {
    id: 'random-bass',
    name: 'Random bass',
    group: 'shaos',
    blurb: 'The 3-bit sample-and-hold output, through an attenuator, sets the bass\'s pitch with its volt-per-octave input, one of eight notes each eighth. Switch the Shaos from 63 to 16 and the sequence becomes a loop of sixteen that you can rewrite with the DATA pin. The 217 position gives a long melody that does not repeat for a long time.',
    set: {
      'clk.temp': 16, 'sh.len': 0, at1: 0.3,
      'bd.tune': 0.3, 'bd.pitch': 0.5, 'bd.rel': 0.2, 'bd.vol': 0.85,
      'bs.mode': 0, 'bs.tune': 0.2, 'bs.shape': 0.55, 'bs.warp': 0.3, 'bs.lpf': 1200, 'bs.q': 0.45, 'bs.rel': 0.12, 'bs.vol': 0.5, 'bs.fx': 0.2,
      'hh.tune': 0.75, 'hh.hpf': 7500, 'hh.rel': 0.04, 'hh.vol': 0.3, 'fx.route': 0, 'fx.mode': 0, 'fx.time': 0.55, 'fx.fb': 0.4, 'fx.tune': 0.3, 'fx.dlyout': 0.3,
    },
    cables: [['div.8', 'sh.clk'], ['sh.3s', 'at1.in'], ['at1.out', 'bs.cv'], ['div.8', 'pc0.in'], ['pc0.out', 'trig1'], ['env1', 'bs.lpf'], LRST],
    loops: [{ 0: bars(FLOOR, 1.2), 3: bars(OFFBEAT, 0.5, 2) }],
  },
  {
    id: 'drone',
    name: 'Drone',
    group: 'sustain',
    blurb: 'The looper records how long a note lasts, and an envelope holds while it does. Here one note fills the whole four bars: the bass becomes a drone, with the LFO opening its filter. Shorten the note with DEL, or add more with ADD, and the drone turns back into a rhythm.',
    set: {
      'clk.temp': 10, 'lfo.range': 0, 'lfo.freq': 0.3, 'lfo.wave': 0.5, at2: 0.5,
      'bs.mode': 0, 'bs.tune': 0.18, 'bs.shape': 0.7, 'bs.warp': 0.35, 'bs.lpf': 300, 'bs.q': 0.55, 'bs.att': 0.4, 'bs.rel': 1.5, 'bs.vol': 0.55, 'bs.fx': 0.6,
      'hh.tune': 0.5, 'hh.hpf': 3500, 'hh.q': 0.6, 'hh.att': 0.3, 'hh.rel': 1, 'hh.vol': 0.2,
      'fx.route': 1, 'fx.mode': 0, 'fx.fb': 0.75, 'fx.revout': 0.5,
    },
    cables: [['lfo.tri', 'at2.in'], ['at2.out', 'bs.lpf'], LRST],
    loops: [{ 1: [[0, 62, 3]], 3: [[0, 60, 1]] }],
  },
  {
    id: 'pitch-tails',
    name: 'Pitch-shift tails',
    group: 'effects',
    blurb: 'The effects processor in PCH mode: a delay and a hall that each have a pitch shifter in their feedback, shifting in opposite directions by up to an octave. The snare and the hats feed the delay; TUNE sets the interval.',
    set: {
      'clk.temp': 14,
      'bd.tune': 0.3, 'bd.pitch': 0.5, 'bd.rel': 0.2, 'bd.vol': 0.8,
      'sd.tune': 0.6, 'sd.mix': 0.5, 'sd.bpf': 1800, 'sd.q': 0.55, 'sd.rel': 0.14, 'sd.vol': 0.4, 'sd.fx': 0.7,
      'hh.tune': 0.75, 'hh.hpf': 7000, 'hh.rel': 0.04, 'hh.vol': 0.3, 'hh.fx': 0.35,
      'fx.route': 0, 'fx.mode': 2, 'fx.time': 0.6, 'fx.tune': 0.78, 'fx.fb': 0.72, 'fx.dlyout': 0.55, 'fx.revout': 0.2,
    },
    cables: [['sd.out', 'fx.rev.in'], LRST],
    loops: [{ 0: bars([0, 8], 1.2), 2: bars([4, 12, 15], 1.2), 3: bars([2, 6, 10, 14], 0.4, 2) }],
  },
  {
    id: 'clock-wobble',
    name: 'DSP clock wobble',
    group: 'effects',
    blurb: 'The manual\'s tip: the kick\'s envelope into CLK MOD, so the effects processor\'s clock follows the kick. Every hit slows the whole DSP, sliding the delay\'s pitch and letting aliasing in, then it speeds back up. Turn CLK MOD up and the effect gets stranger.',
    set: {
      'clk.temp': 15, 'bd.tune': 0.28, 'bd.pitch': 0.5, 'bd.rel': 0.3, 'bd.vol': 0.85,
      'sd.tune': 0.6, 'sd.mix': 0.5, 'sd.bpf': 1800, 'sd.q': 0.5, 'sd.rel': 0.15, 'sd.vol': 0.45, 'sd.fx': 0.6,
      'hh.tune': 0.75, 'hh.hpf': 7500, 'hh.rel': 0.04, 'hh.vol': 0.3, 'hh.fx': 0.4,
      'fx.route': 0, 'fx.mode': 0, 'fx.time': 0.5, 'fx.tune': 0.35, 'fx.fb': 0.62, 'fx.clkmod': 0.85, 'fx.dlyout': 0.6,
    },
    cables: [['env0', 'fx.clkmod'], LRST],
    loops: [{ 0: bars(FLOOR, 1.2), 2: bars(BACKBEAT, 1.5), 3: bars(OFFBEAT, 0.5, 2) }],
  },
  {
    id: 'noise-kick',
    name: 'Noise kick',
    group: 'circuit bending',
    blurb: 'The pink noise clipped to the kick\'s pitch input, with AMT up: the kick\'s pitch wobbles at random, and a sparse loop turns it into a rumble. WTF? and OMG! are circuit-bending nodes inside the kick; try joining them to the LFO.',
    set: {
      'clk.temp': 14, 'bd.tune': 0.25, 'bd.pitch': 0.4, 'bd.drive': 0.5, 'bd.rel': 0.5, 'bd.amt': 0.12, 'bd.vol': 0.9, at3: 0.4,
    },
    cables: [['noise', 'at3.in'], ['at3.out', 'bd.mod'], LRST],
    loops: [{ 0: [[0, 6, 3], [16, 2, 3], [24, 6, 2], [32, 8, 3], [48, 3, 3], [56, 8, 3]] }],
  },
  {
    id: 'aleatoric',
    name: 'Aleatoric clocks',
    group: 'sequencing',
    blurb: 'Each looper can have a clock of its own. Here the hi-hat loop is clocked by the Shaos\' 1-bit output, which is a random pulse train, and the snare loop by a slow LFO square, so two loops wander at different speeds while the kick and bass keep the beat. The manual says any signal can be a clock and nothing will crash.',
    set: {
      'clk.temp': 16, 'sh.freq': 26, 'sh.len': 2, 'lfo.range': 0, 'lfo.freq': 0.55,
      'bd.tune': 0.3, 'bd.pitch': 0.5, 'bd.rel': 0.2, 'bd.vol': 0.85,
      'bs.tune': 0.25, 'bs.shape': 0.5, 'bs.lpf': 900, 'bs.q': 0.4, 'bs.rel': 0.2, 'bs.vol': 0.45,
      'sd.tune': 0.6, 'sd.mix': 0.5, 'sd.bpf': 1800, 'sd.q': 0.55, 'sd.rel': 0.15, 'sd.vol': 0.5,
      'hh.tune': 0.75, 'hh.hpf': 7500, 'hh.rel': 0.04, 'hh.vol': 0.38,
    },
    cables: [['sh.1d', 'lr3.clk'], ['lfo.sq', 'lr2.clk'], LRST],
    loops: [{ 0: bars(FLOOR, 1.2), 1: bars([2, 6, 10, 14], 1), 2: bars(BACKBEAT, 1.5), 3: bars([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 0.4, 2) }],
  },
  {
    id: 'touch',
    name: 'Touch',
    group: 'playing',
    blurb: 'Two touch sensors drive the bass filter and the snare\'s band-pass. Hold a plate and the voltage climbs with the pressure; let go and it falls. The manual\'s point is that your body is part of the circuit.',
    set: {
      'clk.temp': 14,
      'bd.tune': 0.3, 'bd.pitch': 0.5, 'bd.rel': 0.2, 'bd.vol': 0.8,
      'bs.tune': 0.3, 'bs.shape': 0.65, 'bs.warp': 0.3, 'bs.lpf': 250, 'bs.q': 0.6, 'bs.rel': 0.3, 'bs.vol': 0.5,
      'sd.tune': 0.55, 'sd.mix': 0.4, 'sd.bpf': 900, 'sd.q': 0.8, 'sd.rel': 0.25, 'sd.vol': 0.5,
      'hh.tune': 0.75, 'hh.hpf': 7500, 'hh.rel': 0.04, 'hh.vol': 0.32,
    },
    cables: [['sens0.cv', 'bs.lpf'], ['sens1.cv', 'sd.bpf'], LRST],
    loops: [{ 0: bars(FLOOR, 1.2), 1: bars([0, 3, 6, 8, 11, 14], 1.4), 2: bars(BACKBEAT, 1.5), 3: bars(OFFBEAT, 0.5, 2) }],
  },
];

/** How far each preset's master volume is brought down, so that switching between them does not jump in loudness. */
const TRIM: Record<string, number> = {
  'loop-kit': 0.55,
  sidechain: 0.55,
  hiphop: 0.62,
  flip: 0.62,
  'shaos-hats': 0.62,
  'random-bass': 0.62,
  'clock-wobble': 0.6,
  'noise-kick': 0.62,
  aleatoric: 0.62,
  touch: 0.6,
  'pitch-tails': 0.78,
};

/** The knob values of a preset as a full control array. */
export function presetControls(i: number): Float64Array {
  const p = defaults();
  for (const [id, v] of Object.entries(PRESETS[i].set ?? {})) {
    const k = PIDX[id];
    if (k === undefined) throw new Error(`preset ${PRESETS[i].id}: no control ${id}`);
    p[k] = Math.min(PARAMS[k].max, Math.max(PARAMS[k].min, v));
  }
  const trim = TRIM[PRESETS[i].id];
  if (trim) p[PIDX.vol] *= trim;
  return p;
}

/** The loops of a preset as run-length codes, per bank and channel. */
export function presetLoops(i: number): number[][][] {
  const out: number[][][] = [0, 1, 2, 3].map(() => [[], [], [], []]);
  (PRESETS[i].loops ?? []).forEach((bank, b) => {
    for (const [ch, notes] of Object.entries(bank)) out[b][Number(ch)] = rle(gridToEvents(notes));
  });
  return out;
}

export const GROUPS = [...new Set(PRESETS.map((p) => p.group))];
