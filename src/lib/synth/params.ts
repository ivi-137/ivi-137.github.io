/**
 * Orfeo 32: the parameter table, shared by the panel and the audio thread.
 *
 * Every knob, switch and dip on the instrument is one entry here. The panel
 * binds to entries by id; the AudioWorklet reads them by index from a flat
 * Float64Array, so the two sides only ever exchange `(index, value)` pairs.
 * Presets, share links, boons and MIDI learn all speak this same language.
 */

export type Fmt = 'pct' | 'bi' | 'int' | 'bpm' | 'st' | 'cents' | 'ratio' | 'div' | 'bits' | 'oct';

export interface ParamSpec {
  id: string;
  label: string;
  def: number;
  min: number;
  max: number;
  step: number;
  /** Named detents: an enum knob or a switch shows these instead of a number. */
  pos?: string[];
  fmt?: Fmt;
}

const p = (id: string, label: string, def: number, min = 0, max = 1, step = 0.001, extra: Partial<ParamSpec> = {}): ParamSpec => ({
  id,
  label,
  def,
  min,
  max,
  step,
  ...extra,
});
const sw = (id: string, label: string, def: number, pos: string[]) => p(id, label, def, 0, pos.length - 1, 1, { pos });

/** Ratios for the modulation oscillator when "armonico" is on (Buchla 259 style). */
export const HARMONIC_RATIOS = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8];

/** Tempo divisions in bars, used by synced LFO, ramps, delays and loops. */
export const DIVS = [
  { n: '1/16', bars: 1 / 16 },
  { n: '1/8T', bars: 1 / 12 },
  { n: '1/8', bars: 1 / 8 },
  { n: '1/8.', bars: 3 / 16 },
  { n: '1/4', bars: 1 / 4 },
  { n: '1/4.', bars: 3 / 8 },
  { n: '1/2', bars: 1 / 2 },
  { n: '1', bars: 1 },
  { n: '2', bars: 2 },
  { n: '4', bars: 4 },
  { n: '8', bars: 8 },
];

/** Cerbero's three heads: the pitch interval (semitones) each repeat is shifted by. */
export const HEADS = [
  { n: 'unisono', i: [0, 0, 0] },
  { n: 'quinte', i: [7, 12, 19] },
  { n: 'ottave', i: [12, 24, -12] },
  { n: 'quarte', i: [5, 10, 15] },
  { n: 'minore', i: [3, 7, 10] },
  { n: 'maggiore', i: [4, 7, 11] },
  { n: 'discesa', i: [-5, -12, -17] },
  { n: 'tritono', i: [6, -6, 12] },
];

export const PARAMS: ParamSpec[] = [
  // ── globale ────────────────────────────────────────────────────────────
  p('g.bpm', 'tempo', 96, 40, 240, 1, { fmt: 'bpm' }),
  p('g.swing', 'swing', 0.08, 0, 0.6),
  p('g.vol', 'volume', 0.8),
  p('g.heat', 'calore', 0),
  p('g.gate', 'gate', 0.55, 0.05, 1),

  // ── oscillatore complesso (Buchla 259 · Make Noise DPO) ──────────────────
  p('osc.shape', 'forma', 0.4),
  p('osc.fine', 'fine', 0, -1, 1, 0.001, { fmt: 'cents' }),
  p('osc.ratio', 'rapporto', 0.36),
  sw('osc.harm', 'armonico', 1, ['libero', 'armonico']),
  p('osc.bshape', 'forma B', 0),
  p('osc.fm', 'FM', 0.12),
  p('osc.am', 'anello', 0),
  sw('osc.sync', 'sync', 0, ['off', 'sync']),
  p('osc.fold', 'timbro', 0.22),
  p('osc.sym', 'simmetria', 0, -1, 1, 0.001, { fmt: 'bi' }),
  p('osc.level', 'livello', 0.85),

  // ── sorgenti ─────────────────────────────────────────────────────────
  p('src.sub', 'sub', 0.2),
  p('src.noise', 'rumore', 0),
  sw('src.color', 'colore', 1, ['bianco', 'rosa', 'bruno', 'radio']),
  p('src.tangle', 'groviglio', 0),
  p('src.chaos', 'caos', 0.35),
  p('src.string', 'corda', 0),
  p('src.damp', 'smorza', 0.45),
  p('src.field', 'campo', 0),

  // ── filtro (Serge VCFQ) + gate a bassa (Buchla 292) ────────────────────────
  p('flt.cut', 'taglio', 0.72),
  p('flt.res', 'risonanza', 0.18),
  sw('flt.type', 'tipo', 0, ['LP', 'BP', 'HP', 'notch']),
  p('flt.track', 'segui', 0.5),
  sw('lpg.mode', 'modo', 0, ['LPG', 'VCF', 'VCA']),
  p('lpg.res', 'Q', 0.12),
  p('lpg.decay', 'vactrol', 0.35),
  p('lpg.base', 'apertura', 0),

  // ── contorno (Maths ch.1) ────────────────────────────────────────────────
  p('env.rise', 'salita', 0.04),
  p('env.fall', 'discesa', 0.32),
  p('env.curve', 'curva', 0.5),
  sw('env.hold', 'tieni', 0, ['AD', 'ASR']),

  // ── voce ──────────────────────────────────────────────────────────────
  p('voc.glide', 'glide', 0.18),
  p('voc.drift', 'deriva', 0.15),
  p('voc.pan', 'pan', 0, -1, 1, 0.001, { fmt: 'bi' }),
  p('voc.level', 'voce', 0.75),
  p('voc.oct', 'ottava', 0, -3, 3, 1, { fmt: 'oct' }),

  // ── funzioni (Maths) · LFO · incertezza (Buchla 266) · registro ───────────
  p('fa.rise', 'salita', 0.2),
  p('fa.fall', 'discesa', 0.45),
  p('fa.curve', 'curva', 0.3),
  sw('fa.cycle', 'ciclo', 0, ['uno', 'ciclo']),
  sw('fa.trig', 'innesco', 0, ['nota', 'battuta', 'rollz', 'passo']),
  p('fb.rise', 'salita', 0.5),
  p('fb.fall', 'discesa', 0.6),
  p('fb.curve', 'curva', 0.7),
  sw('fb.cycle', 'ciclo', 1, ['uno', 'ciclo']),
  sw('fb.trig', 'innesco', 1, ['nota', 'battuta', 'rollz', 'passo']),
  p('lfo.rate', 'velocità', 0.4),
  sw('lfo.shape', 'onda', 0, ['sin', 'tri', 'saw', 'quadra', 'S&H']),
  sw('lfo.sync', 'sync', 1, ['libero', 'tempo']),
  p('unc.rate', 'fluttua', 0.35),
  p('unc.dist', 'distrib.', 0.5),
  p('unc.slew', 'slew', 0.2),
  p('reg.lock', 'blocco', 0.85),
  p('reg.len', 'lunghezza', 8, 2, 16, 1, { fmt: 'int' }),

  // ── rollz + gongue (Ciat-Lonbarde) ───────────────────────────────────────
  sw('rz.on', 'rollz', 0, ['off', 'on']),
  p('rz.d1', 'I', 3, 0, 16, 1, { fmt: 'int' }),
  p('rz.d2', 'II', 4, 0, 16, 1, { fmt: 'int' }),
  p('rz.d3', 'III', 5, 0, 16, 1, { fmt: 'int' }),
  p('rz.d4', 'IV', 0, 0, 16, 1, { fmt: 'int' }),
  p('rz.d5', 'V', 7, 0, 16, 1, { fmt: 'int' }),
  p('rz.level', 'gongue', 0.5),
  p('rz.decay', 'decadim.', 0.45),
  p('rz.tone', 'tono', 0.45),
  p('rz.metal', 'metallo', 0.5),

  // ── fonologia (nove oscillatori, RAI Milano 1955) ──────────────────────────
  p('fo.level', 'livello', 0),
  p('fo.base', 'base', 0.3),
  p('fo.spread', 'stira', 0),
  p('fo.beat', 'battimenti', 0.2),
  p('fo.motion', 'moto', 0.4),
  p('fo.tilt', 'inclina', 0.5),
  sw('fo.follow', 'segui', 1, ['libero', 'accordo']),

  // ── coro (Armonia) ──────────────────────────────────────────────────────
  p('co.level', 'coro', 0.45),
  p('co.tone', 'tono', 0.45),
  p('co.attack', 'attacco', 0.35),
  p('co.release', 'rilascio', 0.5),
  p('co.detune', 'coro-det.', 0.3),
  p('co.shape', 'forma', 0.5),
  p('co.width', 'ampiezza', 0.7),
  p('cp.level', 'contrapp.', 0.5),

  // ── pedaliera ───────────────────────────────────────────────────────────
  // Caos (Gieskes): circuit bending
  p('fx.caos.bits', 'bit', 0.3),
  p('fx.caos.rate', 'campioni', 0.2),
  p('fx.caos.bridge', 'ponte', 0.15),
  p('fx.caos.mix', 'mix', 0.6),
  // Flegetonte (Brothers): two drives in series
  p('fx.fleg.a', 'spinta', 0.35),
  p('fx.fleg.b', 'fuzz', 0.25),
  p('fx.fleg.tone', 'tono', 0.55),
  p('fx.fleg.mix', 'mix', 0.8),
  // Acheronte (Lossy): spectral loss
  p('fx.ach.loss', 'perdita', 0.4),
  p('fx.ach.gap', 'pacchetti', 0.15),
  p('fx.ach.band', 'banda', 0.6),
  p('fx.ach.mix', 'mix', 0.7),
  // Mnemosine (Habit · Morphagene · Gleetchlab): granular memory
  p('fx.mne.size', 'grano', 0.35),
  p('fx.mne.dens', 'densità', 0.4),
  p('fx.mne.pitch', 'altezza', 0.5),
  p('fx.mne.scan', 'scansione', 0.3),
  p('fx.mne.mix', 'mix', 0.4),
  // Cerbero (Thermae): three pitch-shifted heads
  p('fx.cer.time', 'tempo', 3, 0, DIVS.length - 1, 1, { fmt: 'div' }),
  p('fx.cer.fb', 'ritorno', 0.4),
  p('fx.cer.heads', 'teste', 1, 0, HEADS.length - 1, 1, { pos: HEADS.map((h) => h.n) }),
  p('fx.cer.glide', 'glide', 0.2),
  p('fx.cer.mix', 'mix', 0.35),
  // Stige (Mood): micro-looper
  p('fx.sti.len', 'lunghezza', 7, 0, DIVS.length - 1, 1, { fmt: 'div' }),
  p('fx.sti.speed', 'velocità', 0.75),
  p('fx.sti.slip', 'scivola', 0.1),
  p('fx.sti.mix', 'mix', 0.6),
  // Cocito (Dark World): frozen reverb
  p('fx.coc.size', 'lago', 0.55),
  p('fx.coc.dark', 'buio', 0.5),
  p('fx.coc.shim', 'riflesso', 0.15),
  p('fx.coc.mod', 'moto', 0.3),
  p('fx.coc.mix', 'mix', 0.3),
  // Lete (Generation Loss): tape that forgets
  p('fx.lete.wow', 'wow', 0.3),
  p('fx.lete.flut', 'flutter', 0.2),
  p('fx.lete.sat', 'saturaz.', 0.3),
  p('fx.lete.gen', 'generaz.', 0.25),
  p('fx.lete.hiss', 'fruscio', 0.15),
  p('fx.lete.fail', 'guasto', 0.08),
];

/** The eight pedals, in their factory order. Knobs are param ids (without the prefix). */
export interface PedalDef {
  id: string;
  name: string;
  river: string;
  after: string;
  knobs: string[];
  /** Named dip switches besides the per-knob ramp dips. */
  dips: string[];
  hue: string;
}

export const PEDALS: PedalDef[] = [
  { id: 'caos', name: 'Caos', river: 'the void before the gods', after: 'Gieskes circuit bending', knobs: ['bits', 'rate', 'bridge', 'mix'], dips: ['pol', 'rompi'], hue: '#b46cff' },
  { id: 'fleg', name: 'Flegetonte', river: 'river of fire', after: 'Brothers', knobs: ['a', 'b', 'tone', 'mix'], dips: ['pol', 'parallelo'], hue: '#ff5a1f' },
  { id: 'ach', name: 'Acheronte', river: 'river of woe', after: 'Lossy', knobs: ['loss', 'gap', 'band', 'mix'], dips: ['pol', 'congela'], hue: '#8fa3b8' },
  { id: 'mne', name: 'Mnemosine', river: 'pool of memory', after: 'Habit · Morphagene', knobs: ['size', 'dens', 'pitch', 'scan', 'mix'], dips: ['pol', 'congela'], hue: '#5fe3c0' },
  { id: 'cer', name: 'Cerbero', river: 'the three-headed gate', after: 'Thermae', knobs: ['time', 'fb', 'heads', 'glide', 'mix'], dips: ['pol', 'ping-pong'], hue: '#e8b04a' },
  { id: 'sti', name: 'Stige', river: 'river of oaths', after: 'Mood', knobs: ['len', 'speed', 'slip', 'mix'], dips: ['pol', 'auto', 'sovraincidi'], hue: '#d4213d' },
  { id: 'coc', name: 'Cocito', river: 'frozen lake of lament', after: 'Dark World', knobs: ['size', 'dark', 'shim', 'mod', 'mix'], dips: ['pol', 'congela'], hue: '#7fd4ff' },
  { id: 'lete', name: 'Lete', river: 'river of forgetting', after: 'Generation Loss', knobs: ['wow', 'flut', 'sat', 'gen', 'hiss', 'fail'], dips: ['pol', 'secco'], hue: '#c9c1a8' },
];

/** Per pedal: on/off, ramp rate, ramp mode and a bitmask of dips. */
for (const pd of PEDALS) {
  PARAMS.push(
    sw(`fx.${pd.id}.on`, 'on', pd.id === 'coc' || pd.id === 'lete' ? 1 : 0, ['off', 'on']),
    p(`fx.${pd.id}.ramp`, 'rampa', 6, 0, DIVS.length - 1, 1, { fmt: 'div' }),
    sw(`fx.${pd.id}.rmode`, 'modo', 0, ['fermo', 'rampa', 'rimbalzo', 'soffio']),
    p(`fx.${pd.id}.dip`, 'dip', 0, 0, 1023, 1, { fmt: 'int' }),
  );
}

export const PIDX: Record<string, number> = Object.fromEntries(PARAMS.map((s, i) => [s.id, i]));
export const spec = (id: string) => PARAMS[PIDX[id]];
export const defaults = () => Object.fromEntries(PARAMS.map((s) => [s.id, s.def])) as Record<string, number>;

/** Dip bit layout: bits 0..5 = ramp this knob; bit 8 = polarity; bits 9.. = the pedal's named dips after `pol`. */
export const DIP_POL = 8;
export const dipBit = (pd: PedalDef, name: string) => (name === 'pol' ? DIP_POL : 8 + pd.dips.indexOf(name));

// ── patchbay ─────────────────────────────────────────────────────────────
/** Modulation sources. `bi` sources swing −1..1, the others 0..1. */
export const SOURCES = [
  { id: 'env', n: 'contorno', bi: false },
  { id: 'fa', n: 'funz. A', bi: false },
  { id: 'fb', n: 'funz. B', bi: false },
  { id: 'lfo', n: 'LFO', bi: true },
  { id: 'unc', n: 'fluttuante', bi: true },
  { id: 'stp', n: 'a gradini', bi: true },
  { id: 'reg', n: 'registro', bi: true },
  { id: 'vel', n: 'velocità', bi: false },
  { id: 'lnT', n: 'corsia T', bi: false },
  { id: 'lnM', n: 'corsia M', bi: false },
  { id: 'press', n: 'pressione', bi: false },
  { id: 'x', n: 'piastra X', bi: false },
  { id: 'y', n: 'piastra Y', bi: false },
  { id: 'rollz', n: 'rollz', bi: false },
  { id: 'note', n: 'nota', bi: false },
  { id: 'follow', n: 'inseguitore', bi: false },
  { id: 'colony', n: 'colonia', bi: false },
] as const;

export const DESTS = [
  { id: 'pitch', n: 'altezza' },
  { id: 'fold', n: 'timbro' },
  { id: 'shape', n: 'forma' },
  { id: 'fm', n: 'FM' },
  { id: 'ratio', n: 'rapporto' },
  { id: 'am', n: 'anello' },
  { id: 'cut', n: 'taglio' },
  { id: 'res', n: 'risonanza' },
  { id: 'lpg', n: 'LPG' },
  { id: 'noise', n: 'rumore' },
  { id: 'chaos', n: 'caos' },
  { id: 'pan', n: 'pan' },
  { id: 'amp', n: 'volume' },
  { id: 'grain', n: 'Mnemosine' },
  { id: 'verb', n: 'Cocito' },
  { id: 'wow', n: 'Lete' },
] as const;

export const SRC = Object.fromEntries(SOURCES.map((s, i) => [s.id, i])) as Record<(typeof SOURCES)[number]['id'], number>;
export const DST = Object.fromEntries(DESTS.map((d, i) => [d.id, i])) as Record<(typeof DESTS)[number]['id'], number>;

/** A patch cable: source index, destination index, amount −1..1. */
export type Cable = [number, number, number];

// ── messages between the panel and the audio thread ─────────────────────────
export type SynthEvent =
  /** lead voice note. dur < 0 = held until an `off`. */
  | { k: 'n'; at: number; hz: number; vel: number; dur: number; slide: 0 | 1; t: number; m: number }
  | { k: 'off'; at: number }
  /** choir / arpeggio / counterpoint note. kind 0 pad, 1 pluck, 2 counterpoint */
  | { k: 'c'; at: number; hz: number; vel: number; dur: number; kind: 0 | 1 | 2 }
  /** a rollz strike on gongue i */
  | { k: 'g'; at: number; i: number; vel: number }
  /** sequencer clock: one step, and the start of a bar */
  | { k: 's'; at: number }
  | { k: 'b'; at: number }
  /** fonologia follows the harmony: base frequency */
  | { k: 'root'; at: number; hz: number };

export type ToDsp =
  | { t: 'init'; p: number[]; order: number[]; cables: Cable[] }
  | { t: 'p'; i: number; v: number }
  | { t: 'order'; o: number[] }
  | { t: 'cables'; c: Cable[] }
  | { t: 'ev'; e: SynthEvent[] }
  | { t: 'ctl'; k: 'press' | 'x' | 'y' | 'colony'; v: number }
  | { t: 'cmd'; c: 'capture' | 'release' | 'panic' };

export type FromDsp = { t: 'mon'; s: number[]; r: number[]; loop: number; held: 0 | 1; grains: number; level: number };
