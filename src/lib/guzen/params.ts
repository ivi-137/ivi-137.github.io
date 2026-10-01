/**
 * GUZEN: the parameter table, shared by the panel and the audio thread.
 *
 * Every knob, selector and switch on the instrument is one entry here. The panel binds to entries by id;
 * the AudioWorklet reads them by index from a flat Float64Array, so the two sides only ever exchange
 * `(index, value)` pairs. Presets and share links speak the same language.
 *
 * Continuous parameters hold their real value (Hz, seconds, 0–1). Knobs turn in a normalised 0–1 space and
 * `fromNorm` maps that to the real value with a skew, the way JUCE's NormalisableRange does in the plugin:
 * value = min + (max − min) · n^(1/skew). A skew below 1 crowds the low end of the range.
 */

export type Kind = 'float' | 'int' | 'choice' | 'bool';
export type Fmt = 'pct' | 'bi' | 'hz' | 's' | 'st' | 'oct' | 'ratio' | 'bpm' | 'rate' | 'span' | 'int';

export interface ParamSpec {
  id: string;
  label: string;
  kind: Kind;
  def: number;
  min: number;
  max: number;
  step: number;
  /** JUCE-style skew for `float`: 1 is linear, below 1 gives the low end more room. */
  skew: number;
  options?: string[];
  fmt: Fmt;
}

// ── choice lists ───────────────────────────────────────────────────────────

export const LPG_MODES = ['VCA', 'VCF', 'BOTH'];
export const PITCH_SOURCES = ['fluctuate', 'stepped', 'stored'];
export const TRIGGERS = ['gen 1', 'gen 2', 'gen 3', 'free'];
export const DIVISIONS = ['8/1', '4/1', '2/1', '1/1', '1/2', '1/4', '1/8', '1/16'];
export const SCALES = ['chromatic', 'major', 'minor', 'pentatonic', 'whole tone', 'in sen', 'hirajoshi', 'kumoi', 'iwato'];
export const ROOTS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** Beat length of each DIVISIONS entry, in quarter notes. */
export const QUARTERS = [32, 16, 8, 4, 2, 1, 0.5, 0.25];
/** Multiplier each generator applies to the master clock, indexed like DIVISIONS. */
export const GEN_MULT = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16];

/** Semitone degrees of each scale above the root. */
export const SCALE_DEGREES: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  [0, 2, 4, 5, 7, 9, 11],
  [0, 2, 3, 5, 7, 8, 10],
  [0, 3, 5, 7, 10],
  [0, 2, 4, 6, 8, 10],
  [0, 1, 5, 7, 10],
  [0, 2, 3, 7, 8],
  [0, 2, 3, 7, 9],
  [0, 1, 5, 6, 10],
];

// ── building the table ─────────────────────────────────────────────────────

interface Extra {
  step?: number;
  skew?: number;
  options?: string[];
  fmt?: Fmt;
}

const num = (id: string, label: string, def: number, min = 0, max = 1, e: Extra = {}): ParamSpec => ({
  id,
  label,
  kind: 'float',
  def,
  min,
  max,
  step: e.step ?? 0.001,
  skew: e.skew ?? 1,
  fmt: e.fmt ?? 'pct',
});
const int = (id: string, label: string, def: number, min: number, max: number, fmt: Fmt = 'int'): ParamSpec => ({ id, label, kind: 'int', def, min, max, step: 1, skew: 1, fmt });
const pick = (id: string, label: string, def: number, options: string[]): ParamSpec => ({ id, label, kind: 'choice', def, min: 0, max: options.length - 1, step: 1, skew: 1, options, fmt: 'int' });
const flag = (id: string, label: string, def: boolean): ParamSpec => ({ id, label, kind: 'bool', def: def ? 1 : 0, min: 0, max: 1, step: 1, skew: 1, fmt: 'int' });

export const NUM_AGENTS = 6;
export const NUM_GENS = 3;

/** The leaves of one agent, in the order they sit in the table. */
export const LEAVES = [
  'octave', 'fine', 'ratio', 'fm', 'fold', 'symmetry',
  'lpgMode', 'lpgFall', 'lpgColour', 'rise', 'fall', 'cycle',
  'trigSource', 'trigProb', 'envProb',
  'pitchSource', 'pitchSpread', 'pitchBias',
  'pan', 'panChance', 'level', 'on',
] as const;
export type Leaf = (typeof LEAVES)[number];
export const LEAF: Record<Leaf, number> = Object.fromEntries(LEAVES.map((l, i) => [l, i])) as Record<Leaf, number>;
export const AGENT_STRIDE = LEAVES.length;

/** Where each agent starts out: octave, modulator ratio, fold, trigger source, pan, level, pitch source. */
const AGENT_DEFAULTS = [
  { octave: -1, ratio: 1.0, fold: 0.3, trig: 0, pan: -0.6, level: 0.55, pitch: 1 },
  { octave: 0, ratio: 1.5, fold: 0.4, trig: 1, pan: 0.6, level: 0.5, pitch: 1 },
  { octave: 1, ratio: 2.0, fold: 0.25, trig: 2, pan: -0.3, level: 0.4, pitch: 2 },
  { octave: 0, ratio: 3.0, fold: 0.5, trig: 0, pan: 0.3, level: 0.4, pitch: 1 },
  { octave: -2, ratio: 0.5, fold: 0.15, trig: 1, pan: 0, level: 0.45, pitch: 0 },
  { octave: 2, ratio: 4.01, fold: 0.6, trig: 2, pan: 0, level: 0.3, pitch: 2 },
];

function agentSpecs(i: number): ParamSpec[] {
  const d = AGENT_DEFAULTS[i];
  const id = (l: Leaf) => `a${i}.${l}`;
  return [
    int(id('octave'), 'octave', d.octave, -3, 3, 'oct'),
    num(id('fine'), 'fine', 0, -12, 12, { step: 0.01, fmt: 'st' }),
    num(id('ratio'), 'ratio', d.ratio, 0.1, 16, { skew: 0.4, fmt: 'ratio' }),
    num(id('fm'), 'FM', 0),
    num(id('fold'), 'fold', d.fold),
    num(id('symmetry'), 'symmetry', 0, -1, 1, { fmt: 'bi' }),
    pick(id('lpgMode'), 'gate', 2, LPG_MODES),
    num(id('lpgFall'), 'vactrol', 0.4, 0.02, 6, { skew: 0.35, fmt: 's' }),
    num(id('lpgColour'), 'colour', 0.6),
    // up to 4 s: three presets ask for rises of 2 to 4 s, which the plugin's 2 s knob silently cuts short
    num(id('rise'), 'rise', 0.005, 0.0005, 4, { skew: 0.3, fmt: 's' }),
    num(id('fall'), 'fall', 0.3, 0.005, 8, { skew: 0.3, fmt: 's' }),
    flag(id('cycle'), 'cycle', false),
    pick(id('trigSource'), 'trigger', d.trig, TRIGGERS),
    num(id('trigProb'), 'chance', 0.75),
    num(id('envProb'), 'accent', 0.3),
    pick(id('pitchSource'), 'pitch', d.pitch, PITCH_SOURCES),
    num(id('pitchSpread'), 'spread', 2, 0, 6, { fmt: 'span' }),
    num(id('pitchBias'), 'bias', 0.5),
    num(id('pan'), 'pan', d.pan, -1, 1, { fmt: 'bi' }),
    num(id('panChance'), 'scatter', 0),
    num(id('level'), 'level', d.level),
    flag(id('on'), 'on', true),
  ];
}

export const GLOBAL_LEAVES = [
  'clockRate', 'clockSync', 'clockDiv', 'tempo', 'swing', 'scale', 'root', 'drift',
  'cutoff', 'reso', 'revMix', 'revSize', 'revDamp', 'master',
] as const;
export type GLeaf = (typeof GLOBAL_LEAVES)[number];

export const PARAMS: ParamSpec[] = [
  num('clockRate', 'clock', 2, 0.05, 20, { skew: 0.4, fmt: 'rate' }),
  flag('clockSync', 'sync', false),
  pick('clockDiv', 'div', 5, DIVISIONS),
  num('tempo', 'tempo', 100, 40, 240, { step: 1, fmt: 'bpm' }),
  num('swing', 'swing', 0),
  pick('scale', 'scale', 3, SCALES),
  pick('root', 'root', 0, ROOTS),
  num('drift', 'drift', 0.4, 0.01, 20, { skew: 0.35, fmt: 'rate' }),
  num('cutoff', 'filter', 12000, 100, 18000, { skew: 0.3, fmt: 'hz' }),
  num('reso', 'reso', 0.2),
  num('revMix', 'reverb', 0.25),
  num('revSize', 'size', 0.7),
  num('revDamp', 'damp', 0.4),
  num('master', 'master', 0.7),
  ...[0, 1, 2].flatMap((g) => [pick(`g${g}.mult`, `gen ${g + 1}`, 3 + g, DIVISIONS), num(`g${g}.prob`, `P${g + 1}`, 0.7)]),
  ...[0, 1, 2, 3, 4, 5].flatMap(agentSpecs),
];

export const PIDX: Record<string, number> = Object.fromEntries(PARAMS.map((p, i) => [p.id, i]));
export const spec = (id: string) => PARAMS[PIDX[id]];

/** Offsets into the flat array, so the audio thread never looks anything up by name. */
export const G = Object.fromEntries(GLOBAL_LEAVES.map((l) => [l, PIDX[l]])) as Record<GLeaf, number>;
export const GEN0 = PIDX['g0.mult'];
export const AGENT0 = PIDX['a0.octave'];
export const defaults = () => Float64Array.from(PARAMS.map((p) => p.def));

// ── knob space ─────────────────────────────────────────────────────────────

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** Snap a real value onto the parameter's grid and range. */
export function snap(s: ParamSpec, v: number) {
  v = clamp(v, s.min, s.max);
  return s.kind === 'float' ? v : Math.round(v);
}

/** Real value to knob position, 0–1. */
export function toNorm(s: ParamSpec, v: number) {
  const n = (clamp(v, s.min, s.max) - s.min) / (s.max - s.min || 1);
  return s.kind === 'float' && s.skew !== 1 ? Math.pow(n, s.skew) : n;
}

/** Knob position, 0–1, to real value. */
export function fromNorm(s: ParamSpec, n: number) {
  n = clamp(n, 0, 1);
  if (s.kind === 'float' && s.skew !== 1) n = Math.pow(n, 1 / s.skew);
  return snap(s, s.min + n * (s.max - s.min));
}

export function format(s: ParamSpec, v: number): string {
  switch (s.fmt) {
    case 'pct':
      return `${Math.round(v * 100)}`;
    case 'bi':
      return `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
    case 'hz':
      return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
    case 's':
      return v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(v < 10 ? 2 : 1)}s`;
    case 'st':
      return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
    case 'oct':
      return v > 0 ? `+${v}` : `${v}`;
    case 'ratio':
      return `×${v < 10 ? v.toFixed(2) : v.toFixed(1)}`;
    case 'bpm':
      return `${Math.round(v)}`;
    case 'rate':
      return v < 1 ? `${v.toFixed(2)}Hz` : `${v.toFixed(1)}Hz`;
    case 'span':
      return `${v.toFixed(1)}oct`;
    default:
      return s.options ? (s.options[Math.round(v)] ?? '') : `${Math.round(v)}`;
  }
}

// ── messages between the panel and the audio thread ────────────────────────

export type ToDsp =
  | { t: 'init'; p: number[]; seed: number }
  | { t: 'p'; i: number; v: number }
  | { t: 'restart'; seed: number };

export interface Mon {
  t: 'mon';
  /** gate conductance of each agent, 0–1 */
  act: number[];
  /** the dice: the 48-bit generator state as two 24-bit halves */
  hi: number;
  lo: number;
  peak: number;
}

// ── seeds ──────────────────────────────────────────────────────────────────

export const SEED_MAX = 2 ** 48;
export const seedHex = (n: number) => Math.floor(n).toString(16).padStart(12, '0');
export const parseSeed = (s: string) => {
  const v = parseInt(s.replace(/[^0-9a-f]/gi, '').slice(0, 12) || '0', 16);
  return Number.isFinite(v) ? v % SEED_MAX : 0;
};
