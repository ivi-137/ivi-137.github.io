/**
 * Orfeo 32: the whole instrument as one serialisable object.
 *
 * Presets, share links, undo and the boons all read and write this shape.
 * Knob values live flat in `p` (see params.ts); the sequencer's patterns,
 * the harmony settings, the patch cables and the pedal order sit beside them.
 */
import { PARAMS, PEDALS, SOURCES, DESTS, defaults, type Cable } from './params';
import { euclid } from './rhythm';

export { euclid };

export const STEPS = 32;

export const LANES = ['gate', 'note', 'vel', 'prob', 'ratch', 'timb', 'mod', 'time'] as const;
export type LaneId = (typeof LANES)[number];
export const LANE_INFO: Record<LaneId, { n: string; hint: string; min: number; max: number; step: number; def: number }> = {
  gate: { n: 'porta', hint: 'off · on · slide (legato + glide)', min: 0, max: 2, step: 1, def: 0 },
  note: { n: 'nota', hint: 'scale degree above the root', min: -7, max: 21, step: 1, def: 0 },
  vel: { n: 'accento', hint: 'velocity: how hard the LPG is struck', min: 0, max: 1, step: 0.01, def: 0.75 },
  prob: { n: 'probabilità', hint: 'chance that a lit step sounds', min: 0, max: 1, step: 0.01, def: 1 },
  ratch: { n: 'ribattuto', hint: 'ratchets: 1–4 hits inside the step', min: 1, max: 4, step: 1, def: 1 },
  timb: { n: 'corsia T', hint: 'per-step value, patch it anywhere (default: timbre)', min: 0, max: 1, step: 0.01, def: 0.5 },
  mod: { n: 'corsia M', hint: 'per-step value, patch it anywhere', min: 0, max: 1, step: 0.01, def: 0.5 },
  time: { n: 'durata', hint: 'this step’s length, after Buchla’s 248 MARF', min: 0, max: 4, step: 1, def: 2 },
};
/** The time lane's step lengths, in sixteenths. */
export const TIME_MULT = [0.5, 0.75, 1, 1.5, 2];

export const DIRS = [
  { id: 'fwd', n: 'avanti', g: '→' },
  { id: 'rev', n: 'indietro', g: '←' },
  { id: 'pend', n: 'pendolo', g: '⇄' },
  { id: 'drunk', n: 'ubriaco', g: '⤳' },
  { id: 'rand', n: 'caso', g: '⁂' },
  { id: 'rene', n: 'René 8×4', g: '▦' },
  { id: 'knight', n: 'cavallo', g: '♞' },
] as const;

export const SCALES: Array<{ id: string; n: string; iv: number[] }> = [
  { id: 'maj', n: 'maggiore', iv: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'min', n: 'minore', iv: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'harm', n: 'minore armonica', iv: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'mel', n: 'minore melodica', iv: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'dor', n: 'dorico', iv: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phr', n: 'frigio', iv: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lyd', n: 'lidio', iv: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mix', n: 'misolidio', iv: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'loc', n: 'locrio', iv: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'lyddom', n: 'lidio dominante', iv: [0, 2, 4, 6, 7, 9, 10] },
  { id: 'penta', n: 'pentatonica', iv: [0, 2, 4, 7, 9] },
  { id: 'pentam', n: 'pentatonica minore', iv: [0, 3, 5, 7, 10] },
  { id: 'blues', n: 'blues', iv: [0, 3, 5, 6, 7, 10] },
  { id: 'whole', n: 'esatonale (modo 1)', iv: [0, 2, 4, 6, 8, 10] },
  { id: 'oct', n: 'ottatonica (modo 2)', iv: [0, 1, 3, 4, 6, 7, 9, 10] },
  { id: 'mode3', n: 'Messiaen modo 3', iv: [0, 2, 3, 4, 6, 7, 8, 10, 11] },
  { id: 'hex', n: 'esatonica (Cohn)', iv: [0, 1, 4, 5, 8, 9] },
  { id: 'hijaz', n: 'hijaz', iv: [0, 1, 4, 5, 7, 8, 10] },
  { id: 'iwato', n: 'iwato', iv: [0, 1, 5, 6, 10] },
  { id: 'enig', n: 'enigmatica (Verdi)', iv: [0, 1, 4, 6, 8, 10, 11] },
  { id: 'chrom', n: 'cromatica', iv: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];

/** Tunings: cents of the twelve chromatic degrees above the root, or an EDO. */
export const TUNINGS: Array<{ id: string; n: string; cents?: number[]; edo?: number; ratios?: number[] }> = [
  { id: '12', n: 'temperamento equabile' },
  { id: 'ji', n: 'giusta (5-limite)', ratios: [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5, 15 / 8] },
  { id: 'pyth', n: 'pitagorica', ratios: [1, 256 / 243, 9 / 8, 32 / 27, 81 / 64, 4 / 3, 729 / 512, 3 / 2, 128 / 81, 27 / 16, 16 / 9, 243 / 128] },
  { id: 'mean', n: 'mesotonica ¼ comma', cents: [0, 76.0, 193.2, 310.3, 386.3, 503.4, 579.5, 696.6, 772.6, 889.7, 1006.8, 1082.9] },
  { id: 'werck', n: 'Werckmeister III', cents: [0, 90.2, 192.2, 294.1, 390.2, 498.0, 588.3, 696.1, 792.2, 888.3, 996.1, 1092.2] },
  { id: '19', n: '19-EDO', edo: 19 },
  { id: 'harm', n: 'serie armonica 16–32', ratios: [1, 17 / 16, 9 / 8, 19 / 16, 5 / 4, 21 / 16, 11 / 8, 3 / 2, 13 / 8, 27 / 16, 7 / 4, 15 / 8] },
];

/** A MIDI note number (may be fractional) → Hz, in a tuning anchored on `root`. */
export function tuneHz(midi: number, root: number, tuning: string): number {
  const t = TUNINGS.find((x) => x.id === tuning) ?? TUNINGS[0];
  if (!t.cents && !t.ratios && !t.edo) return 440 * 2 ** ((midi - 69) / 12);
  const rel = midi - (60 + root);
  const oct = Math.floor(rel / 12);
  const deg = Math.round(rel - oct * 12);
  const rootHz = 440 * 2 ** ((60 + root - 69) / 12);
  let ratio: number;
  if (t.edo) ratio = 2 ** (Math.round((deg * t.edo) / 12) / t.edo);
  else if (t.ratios) ratio = t.ratios[((deg % 12) + 12) % 12];
  else ratio = 2 ** (t.cents![((deg % 12) + 12) % 12] / 1200);
  return rootHz * ratio * 2 ** oct;
}

export interface Pattern {
  lanes: Record<LaneId, number[]>;
  len: Record<LaneId, number>;
  div: Record<LaneId, number>;
  dir: number;
  /** elementary automaton that rewrites the gate lane at every loop */
  ca: { on: boolean; rule: number };
  /** Turing-machine chance that a note changes at every loop */
  mut: number;
  /** a counterpoint line (MIDI) written by Fux's rules over this pattern */
  cp: Array<number | null> | null;
}

export interface Harm {
  on: boolean;
  method: string;
  /** sixteenths per chord */
  rate: number;
  spice: number;
  voicing: 'stretta' | 'lata' | 'bassa';
  /** 0 pad, 1 up, 2 down, 3 up-down, 4 random */
  arp: number;
  /** sixteenths per arpeggio note */
  arpRate: number;
  /** how the lead's note lane is read: 0 scale degrees, 1 chord tones, 2 semitones */
  follow: number;
  cp: boolean;
  negative: boolean;
}

export interface OrfeoState {
  v: 1;
  p: Record<string, number>;
  patterns: Pattern[];
  cur: number;
  /** song mode: pattern indices played in turn; empty loops `cur` */
  chain: number[];
  root: number;
  scale: string;
  tuning: string;
  harm: Harm;
  cables: Cable[];
  order: string[];
  /** the living background writes the gate lane at every loop */
  colonyGates: boolean;
  /** notes drop gliders into the background */
  feed: boolean;
}

export const lanesFill = (): Record<LaneId, number[]> =>
  Object.fromEntries(LANES.map((l) => [l, new Array(STEPS).fill(LANE_INFO[l].def)])) as Record<LaneId, number[]>;

export function emptyPattern(): Pattern {
  return {
    lanes: lanesFill(),
    len: Object.fromEntries(LANES.map((l) => [l, STEPS])) as Record<LaneId, number>,
    div: Object.fromEntries(LANES.map((l) => [l, 1])) as Record<LaneId, number>,
    dir: 0,
    ca: { on: false, rule: 90 },
    mut: 0,
    cp: null,
  };
}

/** Build a pattern from a gate string (x on, - slide, . rest) and a list of degrees. */
export function pattern(gates: string, notes: number[], extra: Partial<Pattern> & { vel?: number[]; ratch?: number[]; prob?: number[] } = {}): Pattern {
  const p = emptyPattern();
  const g = gates.replace(/\s/g, '');
  for (let i = 0; i < STEPS; i++) {
    const c = g[i % g.length];
    p.lanes.gate[i] = c === 'x' ? 1 : c === '-' ? 2 : 0;
    p.lanes.note[i] = notes[i % notes.length];
    if (extra.vel) p.lanes.vel[i] = extra.vel[i % extra.vel.length];
    if (extra.ratch) p.lanes.ratch[i] = extra.ratch[i % extra.ratch.length];
    if (extra.prob) p.lanes.prob[i] = extra.prob[i % extra.prob.length];
    p.lanes.timb[i] = 0.5 + 0.45 * Math.sin((i / STEPS) * Math.PI * 4);
    p.lanes.mod[i] = (i * 7) % 11 / 10;
  }
  const { vel: _v, ratch: _r, prob: _p, ...rest } = extra;
  return { ...p, ...rest };
}

export const PEDAL_ORDER = PEDALS.map((p) => p.id);

export function makeDefault(): OrfeoState {
  const patterns = [
    pattern('x.x- x.x. .x-x x.xx x.x- x..x .x-x x.x.', [0, 0, 2, 4, 7, 4, 3, 2, 0, 4, 5, 4, 2, 0, -1, 0, 0, 7, 6, 4, 2, 4, 5, 7, 9, 7, 4, 2, 0, -3, -1, 0], {
      vel: [1, 0.6, 0.8, 0.5, 0.9, 0.6, 0.7, 0.55],
      ratch: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1],
    }),
  ];
  for (let i = 1; i < 8; i++) patterns.push(emptyPattern());
  return {
    v: 1,
    p: defaults(),
    patterns,
    cur: 0,
    chain: [],
    root: 2,
    scale: 'dor',
    tuning: '12',
    harm: { on: true, method: 'piston', rate: 16, spice: 0.3, voicing: 'stretta', arp: 0, arpRate: 2, follow: 0, cp: false, negative: false },
    cables: [
      [0, 1, 0.35], // contorno → timbro
      [8, 6, 0.25], // corsia T → taglio
      [3, 0, 0.02], // LFO → altezza (a little vibrato)
    ],
    order: [...PEDAL_ORDER],
    colonyGates: false,
    feed: false,
  };
}

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// ── factory presets ────────────────────────────────────────────────────────

type Preset = { id: string; n: string; blurb: string; make: (s: OrfeoState) => void };
const set = (s: OrfeoState, kv: Record<string, number>) => Object.assign(s.p, kv);
const pedals = (s: OrfeoState, on: string[]) => PEDALS.forEach((pd) => (s.p[`fx.${pd.id}.on`] = on.includes(pd.id) ? 1 : 0));

export const PRESETS: Preset[] = [
  { id: 'casa', n: 'Casa di Ade', blurb: 'The house patch: complex oscillator pinging a low pass gate, Piston’s harmony, a frozen lake and old tape.', make: () => {} },
  {
    id: 'asfodelo',
    n: 'Asfodelo',
    blurb: 'West-coast bongos: FM at a 3.5 ratio, folded, struck through the LPG; Rollz roll 3 against 4 against 5.',
    make(s) {
      set(s, { 'osc.shape': 0.05, 'osc.ratio': 0.62, 'osc.fm': 0.38, 'osc.fold': 0.45, 'lpg.decay': 0.25, 'env.fall': 0.2, 'env.curve': 0.75, 'rz.on': 1, 'rz.level': 0.55, 'g.bpm': 108, 'src.sub': 0 });
      s.patterns[0] = pattern(euclid(7, 16).map((x) => (x ? 'x' : '.')).join(''), [0, 4, 2, 7, 5, 9, 4, 11, 7, 2], { vel: [1, 0.5, 0.7, 0.4] });
      s.harm.method = 'rohrmeier';
      pedals(s, ['cer', 'coc', 'lete']);
    },
  },
  {
    id: 'elisio',
    n: 'Elisio',
    blurb: 'Spectral chords tuned exactly, a slow choir, the nine oscillators of the Fonologia, and a shimmering lake.',
    make(s) {
      set(s, { 'co.level': 0.75, 'co.attack': 0.7, 'co.release': 0.8, 'co.tone': 0.35, 'fo.level': 0.35, 'fo.follow': 1, 'osc.shape': 0.35, 'osc.fold': 0.1, 'voc.level': 0.4, 'fx.coc.shim': 0.45, 'fx.coc.size': 0.8, 'fx.coc.mix': 0.5, 'g.bpm': 72 });
      s.harm = { ...s.harm, method: 'spectral', rate: 32, spice: 0.5 };
      s.patterns[0] = pattern('x... ..x. x... .... ..x. ...x ..x. ....', [7, 9, 11, 14, 12, 9, 7, 4]);
      pedals(s, ['mne', 'coc', 'lete']);
    },
  },
  {
    id: 'tartaro',
    n: 'Tartaro',
    blurb: 'A pit of acid: saw into square, slides and ratchets, both drives of the river of fire, and heat.',
    make(s) {
      set(s, { 'osc.shape': 0.72, 'osc.fm': 0.05, 'osc.fold': 0.15, 'flt.cut': 0.38, 'flt.res': 0.72, 'lpg.mode': 1, 'env.fall': 0.28, 'voc.glide': 0.3, 'src.sub': 0.45, 'g.heat': 0.25, 'fx.fleg.a': 0.55, 'fx.fleg.b': 0.35, 'g.bpm': 128, 'voc.oct': -1 });
      s.cables = [
        [0, 6, 0.55],
        [7, 7, 0.2],
      ];
      s.patterns[0] = pattern('xx-x .x-x x.-x x.xx xx-x .x-x x.xx -.x.', [0, 0, 12, 0, 3, 0, 5, 7, 0, 10, 12, 0, 7, 5, 3, 0], { vel: [1, 0.5, 0.9, 0.6, 1, 0.4], ratch: [1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 3, 1, 1] });
      s.scale = 'phr';
      s.harm.on = false;
      pedals(s, ['fleg', 'cer', 'lete']);
    },
  },
  {
    id: 'fonologia',
    n: 'Fonologia 1955',
    blurb: 'Nine sine oscillators, a sine voice, Partch’s hexads in just intonation, tape loops that run backwards.',
    make(s) {
      set(s, { 'osc.shape': 0, 'osc.fm': 0.22, 'osc.ratio': 0.4, 'osc.harm': 0, 'osc.fold': 0, 'fo.level': 0.5, 'fo.spread': 0.25, 'fo.beat': 0.5, 'fo.follow': 1, 'fx.sti.speed': 0.2, 'fx.sti.mix': 0.5, 'env.hold': 1, 'env.rise': 0.3, 'g.bpm': 66 });
      s.tuning = 'ji';
      s.harm = { ...s.harm, method: 'partch', rate: 32, spice: 0.6 };
      s.patterns[0] = pattern('x.-- ..x- ...x --.. x.-. ..x. -..x ....', [0, 4, 7, 11, 9, 5, 2, 14]);
      pedals(s, ['cer', 'sti', 'coc', 'lete']);
    },
  },
  {
    id: 'plumbutter',
    n: 'Plumbutter',
    blurb: 'Cross-coupled triangle cores in a tangle, five gongues rolling 3:4:5:7, circuit bends between them.',
    make(s) {
      set(s, { 'src.tangle': 0.7, 'src.chaos': 0.65, 'osc.level': 0.3, 'rz.on': 1, 'rz.d1': 3, 'rz.d2': 4, 'rz.d3': 5, 'rz.d4': 7, 'rz.d5': 0, 'rz.level': 0.7, 'rz.metal': 0.8, 'fa.trig': 2, 'g.bpm': 90 });
      s.cables = [
        [13, 1, 0.5],
        [1, 10, 0.4],
        [4, 0, 0.1],
      ];
      s.patterns[0] = pattern('x..x ..x. .x.. x.x. ..x. x..x .x.. x...', [0, 3, 5, 7, 10, 12]);
      s.patterns[0].ca = { on: true, rule: 30 };
      pedals(s, ['caos', 'coc', 'lete']);
    },
  },
  {
    id: 'gieskes',
    n: 'Circuito piegato',
    blurb: 'Bent electronics: hard sync, shortwave radio, bits falling off, solder bridges, a codec losing packets.',
    make(s) {
      set(s, { 'osc.sync': 1, 'osc.ratio': 0.8, 'osc.harm': 0, 'osc.shape': 0.66, 'src.noise': 0.35, 'src.color': 3, 'fx.caos.bits': 0.6, 'fx.caos.bridge': 0.5, 'fx.caos.rate': 0.35, 'fx.ach.loss': 0.6, 'fx.ach.gap': 0.35, 'g.bpm': 118 });
      s.cables = [
        [5, 4, 0.4],
        [0, 1, 0.3],
      ];
      s.patterns[0] = pattern('xx.x x.xx .xx. x.x. xx.x x.x. .x.x xxx.', [0, 12, 3, 15, 7, 0, 10, 5]);
      s.patterns[0].dir = 4;
      pedals(s, ['caos', 'ach', 'fleg']);
    },
  },
  {
    id: 'giant',
    n: 'Passi da gigante',
    blurb: 'Coltrane’s three tonal centres a major third apart, arpeggiated; the lead plucks a string and follows the chord.',
    make(s) {
      set(s, { 'src.string': 0.7, 'osc.level': 0.35, 'src.damp': 0.3, 'co.level': 0.5, 'g.bpm': 140, 'env.fall': 0.25 });
      s.harm = { ...s.harm, method: 'coltrane', rate: 8, arp: 3, arpRate: 1, follow: 1, spice: 0.2 };
      s.scale = 'maj';
      s.root = 11;
      s.patterns[0] = pattern('x.x. x.xx .x.x x.x.', [0, 2, 1, 3, 2, 0, 3, 1, 4, 2]);
      pedals(s, ['coc', 'lete']);
    },
  },
  {
    id: 'hexatonic',
    n: 'Poli esatonici',
    blurb: 'Cohn’s maximally smooth cycle: six triads, a semitone each, a granular memory scanning what just happened.',
    make(s) {
      set(s, { 'co.level': 0.6, 'co.attack': 0.5, 'fx.mne.mix': 0.55, 'fx.mne.scan': 0.5, 'fx.mne.pitch': 0.625, 'osc.shape': 0.2, 'g.bpm': 84 });
      s.harm = { ...s.harm, method: 'hexatonic', rate: 16 };
      s.patterns[0] = pattern('x.-. ..x. x.-. ..x.', [0, 1, 2, 1, 0, 2, 3, 1]);
      s.harm.follow = 1;
      pedals(s, ['mne', 'coc', 'lete']);
    },
  },
  {
    id: 'serge',
    n: 'Moltiplicatore',
    blurb: 'Serge-style: the wave multiplier worked by an LFO, stepped random on the pitch, René’s cartesian path.',
    make(s) {
      set(s, { 'osc.shape': 0.33, 'osc.fold': 0.55, 'osc.sym': 0.3, 'lfo.rate': 0.35, 'lfo.shape': 1, 'unc.slew': 0.4, 'lpg.mode': 2, 'env.hold': 1, 'g.bpm': 100 });
      s.cables = [
        [3, 1, 0.45],
        [5, 0, 0.08],
        [2, 6, 0.3],
      ];
      s.patterns[0] = pattern('xx.x x.x. x.xx .x.x', [0, 4, 7, 2, 9, 5, 11, 7, 0, 3]);
      s.patterns[0].dir = 5;
      pedals(s, ['cer', 'coc']);
    },
  },
  {
    id: 'fux',
    n: 'Gradus ad Parnassum',
    blurb: 'A cantus firmus in the lead and a second voice that obeys Fux: consonances only, no parallel fifths, perfect ends.',
    make(s) {
      set(s, { 'osc.shape': 0.33, 'osc.fm': 0, 'osc.fold': 0, 'co.level': 0, 'cp.level': 0.7, 'lpg.mode': 2, 'env.hold': 1, 'env.rise': 0.25, 'g.bpm': 80, 'g.gate': 0.9 });
      s.root = 2;
      s.scale = 'dor';
      // Fux's dorian cantus firmus, one note every two sixteenths
      s.patterns[0] = pattern('x.x. x.x. x.x. x.x. x.x. x.', [0, 0, 2, 2, 1, 1, 0, 0, 3, 3, 2, 2, 4, 4, 3, 3, 2, 2, 1, 1, 0, 0]);
      s.patterns[0].len.gate = 22;
      s.patterns[0].len.note = 22;
      s.harm = { ...s.harm, on: false, cp: true };
      pedals(s, ['coc']);
    },
  },
  {
    id: 'orfeo',
    n: 'Orfeo ed Euridice',
    blurb: 'The lament: harmony mirrored through Levy’s axis, a looper that keeps renewing itself, a lake that freezes.',
    make(s) {
      set(s, { 'osc.shape': 0.15, 'osc.fold': 0.3, 'co.level': 0.55, 'fx.sti.mix': 0.55, 'fx.sti.speed': 0.5, 'fx.sti.len': 8, 'fx.sti.dip': 1 << 9, 'fx.sti.slip': 0.25, 'g.bpm': 76 });
      s.harm = { ...s.harm, method: 'negative', rate: 16, spice: 0.4 };
      s.scale = 'harm';
      s.root = 9;
      s.patterns[0] = pattern('x.-. x..x .x-. ..x.', [4, 3, 2, 1, 0, -1, 0, 2, 4, 5, 4, 2]);
      pedals(s, ['sti', 'coc', 'lete']);
    },
  },
];

export function preset(id: string): OrfeoState {
  const s = makeDefault();
  PRESETS.find((p) => p.id === id)?.make(s);
  return s;
}

// ── validation, share links ───────────────────────────────────────────────

const num = (x: unknown, lo: number, hi: number, d: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);

/** Merge anything that looks like a saved state onto a fresh default, dropping what doesn't fit. */
export function sanitize(raw: any): OrfeoState {
  const s = makeDefault();
  if (!raw || typeof raw !== 'object') return s;
  if (raw.p && typeof raw.p === 'object') for (const sp of PARAMS) if (sp.id in raw.p) s.p[sp.id] = num(raw.p[sp.id], sp.min, sp.max, sp.def);
  if (Array.isArray(raw.patterns))
    s.patterns = s.patterns.map((def, i) => {
      const r = raw.patterns[i];
      if (!r?.lanes) return def;
      const p = emptyPattern();
      for (const l of LANES) {
        const info = LANE_INFO[l];
        if (Array.isArray(r.lanes[l])) p.lanes[l] = p.lanes[l].map((d, k) => num(r.lanes[l][k], info.min, info.max, d));
        p.len[l] = Math.round(num(r.len?.[l], 1, STEPS, STEPS));
        p.div[l] = Math.round(num(r.div?.[l], 1, 8, 1));
      }
      p.dir = Math.round(num(r.dir, 0, DIRS.length - 1, 0));
      p.ca = { on: !!r.ca?.on, rule: Math.round(num(r.ca?.rule, 0, 255, 90)) };
      p.mut = num(r.mut, 0, 1, 0);
      p.cp = Array.isArray(r.cp) ? r.cp.slice(0, STEPS).map((x: unknown) => (typeof x === 'number' ? num(x, 0, 127, 60) : null)) : null;
      return p;
    });
  s.cur = Math.round(num(raw.cur, 0, 7, 0));
  s.chain = Array.isArray(raw.chain) ? raw.chain.filter((x: unknown) => typeof x === 'number' && x >= 0 && x < 8).slice(0, 64) : [];
  s.root = Math.round(num(raw.root, 0, 11, s.root));
  if (SCALES.some((x) => x.id === raw.scale)) s.scale = raw.scale;
  if (TUNINGS.some((x) => x.id === raw.tuning)) s.tuning = raw.tuning;
  if (raw.harm && typeof raw.harm === 'object') {
    const h = raw.harm;
    s.harm = {
      on: h.on !== false,
      method: typeof h.method === 'string' ? h.method : s.harm.method,
      rate: [4, 8, 16, 32, 64].includes(h.rate) ? h.rate : 16,
      spice: num(h.spice, 0, 1, 0.3),
      voicing: ['stretta', 'lata', 'bassa'].includes(h.voicing) ? h.voicing : 'stretta',
      arp: Math.round(num(h.arp, 0, 4, 0)),
      arpRate: [1, 2, 4].includes(h.arpRate) ? h.arpRate : 2,
      follow: Math.round(num(h.follow, 0, 2, 0)),
      cp: !!h.cp,
      negative: !!h.negative,
    };
  }
  if (Array.isArray(raw.cables))
    s.cables = raw.cables
      .filter((c: unknown) => Array.isArray(c) && c.length === 3)
      .map((c: number[]) => [Math.round(num(c[0], 0, SOURCES.length - 1, 0)), Math.round(num(c[1], 0, DESTS.length - 1, 0)), num(c[2], -1, 1, 0.3)] as Cable)
      .slice(0, 24);
  if (Array.isArray(raw.order) && raw.order.length === PEDAL_ORDER.length && PEDAL_ORDER.every((id) => raw.order.includes(id))) s.order = raw.order;
  s.colonyGates = !!raw.colonyGates;
  s.feed = !!raw.feed;
  return s;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** The whole instrument, deflated into a URL fragment. */
export async function encode(s: OrfeoState): Promise<string> {
  // drop empty patterns and round knob values: shorter links
  const lean = clone(s) as any;
  for (const k of Object.keys(lean.p)) lean.p[k] = Math.round(lean.p[k] * 1000) / 1000;
  lean.patterns = lean.patterns.map((p: Pattern) => (p.lanes.gate.some(Boolean) ? p : null));
  const json = new TextEncoder().encode(JSON.stringify(lean));
  if (typeof CompressionStream === 'undefined') return 'j' + b64url(json);
  return 'z' + b64url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decode(code: string): Promise<OrfeoState | null> {
  try {
    const body = unb64url(code.slice(1));
    const bytes = code[0] === 'z' ? await pipe(body, new DecompressionStream('deflate-raw')) : body;
    const raw = JSON.parse(new TextDecoder().decode(bytes));
    if (Array.isArray(raw.patterns)) raw.patterns = raw.patterns.map((p: unknown) => p ?? emptyPattern());
    return sanitize(raw);
  } catch {
    return null;
  }
}
