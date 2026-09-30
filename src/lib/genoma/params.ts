/**
 * Genoma's parameter tables, shared by the panel and the audio thread.
 *
 * Global parameters (the reel, the pad, Quinconce, Operatori's effects, the
 * mixer and the cables) are one flat table; the panel sends `(index, value)`.
 * Each Operatori track has its own sound: a vector of track parameters in
 * Elektron's 0–127 (or −64–63) ranges, stored in the pattern like a kit.
 */
export interface Spec {
  id: string;
  label: string;
  def: number;
  min: number;
  max: number;
  step: number;
  pos?: string[];
  fmt?: string;
  /** a longer name for the tooltip and the screen reader */
  hint?: string;
}
const p = (id: string, label: string, def: number, min = 0, max = 1, step = 0.001, extra: Partial<Spec> = {}): Spec => ({
  id,
  label,
  def,
  min,
  max,
  step,
  ...extra,
});
const sw = (id: string, label: string, def: number, pos: string[], extra: Partial<Spec> = {}): Spec =>
  p(id, label, def, 0, pos.length - 1, 1, { pos, ...extra });

// ── sources and destinations for cables ─────────────────────────────────────
export const CV_SRC = [
  '—',
  'orologio',
  'battuta',
  'EOSG',
  'inviluppo',
  'petalo 1',
  'petalo 2',
  'petalo 3',
  'petalo 4',
  'petalo 5',
  'segui',
  'caso',
  ...Array.from({ length: 16 }, (_, i) => `traccia ${i + 1}`),
];
export const CV_SRC_HINT: Record<string, string> = {
  orologio: 'a pulse on every sixteenth from Operatori',
  battuta: 'a pulse on every bar from Operatori',
  EOSG: 'the reel: end of splice or gene',
  inviluppo: "the reel's CV out: an envelope follower on what it plays",
  segui: "Quinconce's envelope follower on its input",
  caso: 'a new random value on every sixteenth',
};
export const CV_SRC_TRACK = 12;
/** Destinations: gates (rising edge) first, then continuous ones. */
export const CV_DST = [
  '—',
  'nastro · CLK',
  'nastro · PLAY',
  'nastro · REC',
  'nastro · SPLICE',
  'nastro · SHIFT',
  'nastro · vari-speed',
  'nastro · gene',
  'nastro · slide',
  'nastro · morph',
  'nastro · organize',
  'nastro · S.O.S.',
  'coco A · FLIP',
  'coco A · SKIP',
  'coco A · REC',
  'coco A · SP.AF',
  'coco B · FLIP',
  'coco B · SKIP',
  'coco B · REC',
  'coco B · SP.AF',
  'pad · X',
  'pad · Y',
];
export const D = {
  none: 0,
  clk: 1,
  play: 2,
  rec: 3,
  splice: 4,
  shift: 5,
  speed: 6,
  gene: 7,
  slide: 8,
  morph: 9,
  organize: 10,
  sos: 11,
  aFlip: 12,
  aSkip: 13,
  aRec: 14,
  aSpaf: 15,
  bFlip: 16,
  bSkip: 17,
  bRec: 18,
  bSpaf: 19,
  padX: 20,
  padY: 21,
} as const;
/** Destinations that listen for a rising edge rather than a level. */
export const GATE_DST = new Set<number>([D.clk, D.play, D.rec, D.splice, D.shift, D.aFlip, D.aSkip, D.aRec, D.bFlip, D.bSkip, D.bRec]);
export const CABLES = 8;
export const CABLE_INK = ['#ff4b1f', '#2f45ff', '#2f6b00', '#9a6bff', '#d8a000', '#00a3a3', '#d6246e', '#16140f'];

export const BUSES = ['voce', 'nastro', 'quinconce', 'operatori', 'tutto'];
/** What the reel can record: everything but itself. */
export const REEL_SRC = ['voce', 'quinconce', 'operatori', 'tutto'];
export const Q_SRC = ['voce', 'piezo', 'nastro', 'operatori', 'tutto'];
export const DELAY_TIMES = [
  { n: '1/32', b: 0.125 },
  { n: '1/16', b: 0.25 },
  { n: '1/16.', b: 0.375 },
  { n: '1/8T', b: 1 / 3 },
  { n: '1/8', b: 0.5 },
  { n: '1/8.', b: 0.75 },
  { n: '1/4T', b: 2 / 3 },
  { n: '1/4', b: 1 },
  { n: '1/4.', b: 1.5 },
  { n: '1/2', b: 2 },
  { n: '1 bar', b: 4 },
];
export const CMP_RATIOS = [2, 4, 8, 20];

export const GPARAMS: Spec[] = [
  // the mixer
  p('m.vol', 'volume', 0.75),
  p('m.voce', 'voce', 0, 0, 1, 0.001, { hint: 'the microphone, straight to the speakers (headphones!)' }),
  p('m.nastro', 'nastro', 0.85),
  p('m.quinc', 'quinconce', 0.75),
  p('m.oper', 'operatori', 0.8),
  sw('m.mode', 'ascolto', 0, ['cuffie', 'casse']),

  // il nastro (the Morphagene)
  p('n.speed', 'vari-speed', 0.5, -1, 1, 0.001, { fmt: 'speed', hint: 'Vari-Speed: noon stops the tape; clockwise forward, counter-clockwise reverse' }),
  p('n.gene', 'gene size', 0, 0, 1, 0.001, { fmt: 'gene', hint: 'Gene Size: the whole splice fully counter-clockwise, microsound fully clockwise' }),
  p('n.slide', 'slide', 0, 0, 1, 0.001, { hint: 'Slide: where in the splice the gene begins' }),
  p('n.morph', 'morph', 0.15, 0, 1, 0.001, { fmt: 'morph', hint: 'Morph: gaps, seamless 1/1, overlap up to 3/1, then random pitch and pan' }),
  p('n.organize', 'organize', 0, 0, 1, 0.001, { fmt: 'organize', hint: 'Organize: which splice plays next (at the end of the gene)' }),
  p('n.sos', 'S.O.S.', 0.5, 0, 1, 0.001, { fmt: 'sos', hint: 'Sound on sound: new input against old reel, when recording and when listening' }),
  p('n.in', 'ingresso', 0.8, 0, 1, 0.001, { fmt: 'db', hint: 'input level into the reel' }),
  sw('n.src', 'sorgente', 2, REEL_SRC, { hint: 'what REC records' }),
  sw('n.play', 'play', 1, ['off', 'on']),
  sw('n.qrec', 'a tempo', 0, ['libero', '1 bar', '2 bar', '4 bar'], { hint: 'The Gloaming: record exactly this many bars, from the next bar' }),
  sw('n.clkdiv', 'divisione', 0, ['1', '2', '4', '8'], { hint: 'divide the CLK input' }),

  // posto giusto (the pad)
  sw('r.mode', 'effetto', 2, ['filtro', '440', 'taglia', 'rovescio', 'whammy']),
  sw('r.src', 'su', 1, BUSES),
  p('r.mix', 'mix', 1),
  sw('r.hold', 'hold', 0, ['off', 'on']),
  p('r.x', 'X', 0.5),
  p('r.y', 'Y', 0.5),

  // quinconce (the Cocoquantus)
  sw('q.src', 'ingresso', 3, Q_SRC),
  p('q.wood', 'legno', 0.5, 0, 1, 0.001, { hint: 'the wooden plate: small and bright, or large and dark' }),
  ...(['a', 'b'] as const).flatMap((w) => [
    p(`q${w}.speed`, 'speed', w === 'a' ? 0.62 : 0.45, 0, 1, 0.001, { fmt: 'hz' }),
    p(`q${w}.aff`, 'affect', w === 'a' ? 0.25 : -0.35, -1, 1, 0.001),
    p(`q${w}.fb`, 'feedback', 0.7),
    p(`q${w}.in`, 'in', 0.8),
    p(`q${w}.vol`, 'out', 0.7),
    p(`q${w}.pan`, 'pan', w === 'a' ? -0.55 : 0.55, -1, 1, 0.001, { fmt: 'pan' }),
    sw(`q${w}.dolby`, 'dolby', 0, ['off', 'dolby', 'croce']),
    sw(`q${w}.rec`, 'rec', 0, ['off', 'on']),
    sw(`q${w}.flip`, 'flip ←', w === 'a' ? 2 : 0, ['—', '1', '2', '3', '4', '5'], { hint: 'the petal that flips this Coco' }),
    sw(`q${w}.skip`, 'skip ←', w === 'a' ? 0 : 4, ['—', '1', '2', '3', '4', '5'], { hint: 'the petal that makes this Coco skip' }),
    sw(`q${w}.spaf`, 'sp.af ←', w === 'a' ? 1 : 3, ['—', '1', '2', '3', '4', '5'], { hint: 'the petal that pushes the speed, by Affect' }),
  ]),
  sw('qb.from', 'B ascolta', 0, ['ingresso', 'coco A'], { hint: 'feed B from the input, or from A (in series)' }),
  ...[1, 2, 3, 4, 5].map((i) => p(`q.p${i}`, `petalo ${i}`, [0.42, 0.55, 0.3, 0.66, 0.48][i - 1])),
  sw('q.range', 'gamma', 0, ['lento', 'audio']),
  p('q.chaos', 'caos', 0.45),
  p('q.vol', 'voce q.', 0, 0, 1, 0.001, { hint: 'the Quantussy itself, as sound' }),
  p('q.feed', 'nei coco', 0, 0, 1, 0.001, { hint: 'the Quantussy into both Cocos' }),

  // operatori (the Digitone II): tempo and the send effects
  p('o.bpm', 'tempo', 96, 30, 300, 0.1, { fmt: 'bpm' }),
  p('o.swing', 'swing', 50, 50, 80, 1, { fmt: 'swing' }),
  p('o.cho.depth', 'prof.', 0.5, 0, 1, 0.001, { hint: 'chorus depth' }),
  p('o.cho.speed', 'veloc.', 0.3, 0, 1, 0.001, { fmt: 'lfohz', hint: 'chorus speed' }),
  p('o.cho.width', 'ampiezza', 0.8),
  p('o.cho.hp', 'passa-alto', 0.2),
  p('o.cho.rev', '→ riv.', 0.2),
  sw(
    'o.del.time',
    'tempo',
    5,
    DELAY_TIMES.map((d) => d.n),
  ),
  p('o.del.fb', 'ritorno', 0.4, 0, 1.05),
  sw('o.del.pp', 'ping-pong', 1, ['off', 'on']),
  p('o.del.width', 'ampiezza', 0.8),
  p('o.del.hp', 'passa-alto', 0.15),
  p('o.del.lp', 'passa-basso', 0.7),
  p('o.del.rev', '→ riv.', 0.15),
  p('o.rev.pre', 'pre-delay', 0.15, 0, 1, 0.001, { fmt: 'ms300' }),
  p('o.rev.decay', 'coda', 0.55, 0, 1, 0.001, { fmt: 't60', hint: 'reverb decay time (T60)' }),
  p('o.rev.size', 'stanza', 0.6),
  p('o.rev.dark', 'ombra', 0.45),
  p('o.rev.hp', 'passa-alto', 0.15),
  p('o.rev.mix', 'ritorno', 0.8),
  p('o.cmp.thr', 'soglia', 0.75, 0, 1, 0.001, { fmt: 'thr' }),
  sw(
    'o.cmp.ratio',
    'rapporto',
    1,
    CMP_RATIOS.map((r) => `${r}:1`),
  ),
  p('o.cmp.atk', 'attacco', 0.3, 0, 1, 0.001, { fmt: 'cmpatk' }),
  p('o.cmp.rel', 'rilascio', 0.4, 0, 1, 0.001, { fmt: 'cmprel' }),
  p('o.cmp.make', 'guadagno', 0.2, 0, 1, 0.001, { fmt: 'make' }),
  p('o.cmp.mix', 'mix', 1),

  // the cables
  ...Array.from({ length: CABLES }, (_, k) => [
    p(`c${k + 1}.src`, 'da', 0, 0, CV_SRC.length - 1, 1),
    p(`c${k + 1}.dst`, 'a', 0, 0, CV_DST.length - 1, 1),
    p(`c${k + 1}.amt`, 'quanto', 0.5, -1, 1, 0.001),
  ]).flat(),
];
export const GIDX: Record<string, number> = Object.fromEntries(GPARAMS.map((s, i) => [s.id, i]));
export const gspec = (id: string) => GPARAMS[GIDX[id]];
export const gdefaults = () => GPARAMS.map((s) => s.def);

// ── Operatori: the four machines ───────────────────────────────────────────
/** Operator frequency ratios, as on the Digitone's C and A knobs. */
export const RATIOS = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 9, 10, 11, 12, 13, 14, 15, 16];
/** B1·B2 ratio pairs: one knob steps through pairs, the Digitone's "revolving" B. */
export const BPAIRS: [number, number][] = [
  [0.25, 0.5],
  [0.5, 0.5],
  [0.5, 1],
  [1, 1],
  [1, 2],
  [1, 3],
  [1.5, 1],
  [2, 1],
  [2, 2],
  [2, 3],
  [3, 1],
  [3, 2],
  [3, 4],
  [4, 1],
  [4, 3],
  [5, 2],
  [6, 1],
  [7, 3],
  [8, 5],
  [9, 4],
  [11, 7],
  [13, 5],
  [16, 9],
];
const r2s = (r: number) => (r < 1 ? r.toFixed(2).replace(/^0/, '') : String(r));
export const MACHINES = ['FM Tone', 'FM Drum', 'Wavetone', 'Swarmer'] as const;
export const MACHINE_ABBR = ['TONE', 'DRUM', 'WAVE', 'SWRM'];
export const WAVES = ['sega', 'quadra', 'triangolo', 'seno'];
export const SLOTS = 24;

export interface Slot {
  label: string;
  def: number;
  min: number;
  max: number;
  pos?: string[];
  fmt?: string;
  hint?: string;
}
const s = (label: string, def: number, min = 0, max = 127, extra: Partial<Slot> = {}): Slot => ({ label, def, min, max, ...extra });
const sp = (label: string, def: number, pos: string[], extra: Partial<Slot> = {}): Slot => ({ label, def, min: 0, max: pos.length - 1, pos, ...extra });
const none = (): Slot => ({ label: '', def: 0, min: 0, max: 0 });

/** Machine parameters, 24 slots each, shown on SYN pages of eight. */
export const MACHINE_SLOTS: Slot[][] = [
  // FM Tone: four operators, C A B1 B2, two outputs X and Y
  [
    sp('algo', 0, ['1', '2', '3', '4', '5', '6', '7', '8'], { hint: 'algorithm: how the operators modulate each other' }),
    sp('C', 3, RATIOS.map(r2s), { hint: 'ratio of operator C (the carrier)' }),
    sp('A', 5, RATIOS.map(r2s), { hint: 'ratio of operator A' }),
    sp(
      'B',
      4,
      BPAIRS.map(([a, b]) => `${r2s(a)}·${r2s(b)}`),
      { hint: 'ratios of B1 and B2, a pair per step' },
    ),
    s('harm', 0, -64, 63, { hint: 'harmonics: negative on C, positive on A and B' }),
    s('dtun', 0, 0, 127, { hint: 'detune A and B against C' }),
    s('fdbk', 0, 0, 127, { hint: 'feedback on the algorithm’s feedback operator' }),
    s('mix', -64, -64, 63, { hint: 'from output X to output Y' }),
    s('A atk', 0),
    s('A dec', 60),
    s('A end', 20),
    s('A lev', 60, 0, 127, { hint: 'how much A modulates: its envelope level' }),
    s('B atk', 0),
    s('B dec', 50),
    s('B end', 0),
    s('B lev', 30),
    s('A del', 0, 0, 127, { hint: 'envelope A waits this long' }),
    sp('A trig', 1, ['libero', 'nota'], { hint: 'restart envelope A on each note' }),
    s('B del', 0),
    sp('B trig', 1, ['libero', 'nota']),
    sp('fase', 1, ['libera', 'azzera'], { hint: 'reset the operators’ phase on each note' }),
    s('A key', 0, 0, 127, { hint: 'A level follows the keyboard' }),
    s('B key', 0),
    none(),
  ],
  // FM Drum: body C with a pitch sweep, A and B for the FM, a wavefolder, noise and a transient
  [
    s('tune', 0, -24, 24, { fmt: 'st' }),
    s('sweep t', 30, 0, 127, { hint: 'how long the pitch sweep lasts' }),
    s('sweep d', 45, 0, 127, { hint: 'how far above the note the sweep starts' }),
    sp('algo', 0, ['A→C', 'B→A→C', 'A+B→C', 'A→C + B'], { hint: 'algorithm' }),
    s('forma C', 0, 0, 127, { hint: 'waveshape of the body' }),
    sp('A·B', 5, RATIOS.map(r2s), { hint: 'ratio of A and B to the body' }),
    s('forma AB', 0),
    s('fdbk', 0),
    s('fold', 0, 0, 127, { hint: 'wavefolder on the body' }),
    s('dec', 55, 0, 127, { hint: 'body decay' }),
    s('hold', 0, 0, 127, { hint: 'body hold before the decay' }),
    s('A lev', 50),
    s('A dec', 25),
    s('B lev', 0),
    s('B dec', 25),
    sp('trans.', 1, ['—', 'click', 'tick', 'burst', 'zap'], { hint: 'the transient at the attack' }),
    s('t. lev', 60),
    s('rumore', 0),
    s('r. dec', 35),
    s('r. base', 60, 0, 127, { hint: 'noise high pass' }),
    s('r. ampiezza', 127, 0, 127, { hint: 'noise low pass, above the base' }),
    sp('r. tipo', 0, ['bianco', 'metallo', 'granuli']),
    none(),
    none(),
  ],
  // Wavetone: two wavetable oscillators with phase distortion, and noise with its own envelope and filter
  [
    s('onda 1', 0, 0, 127, { hint: 'position in the wavetable, oscillator 1' }),
    s('pd 1', 0, 0, 127, { hint: 'phase distortion, oscillator 1' }),
    s('tono 1', 0, -24, 24, { fmt: 'st' }),
    s('fine 1', 0, -64, 63, { hint: 'linear detune, oscillator 1' }),
    s('liv 1', 110),
    s('onda 2', 40),
    s('pd 2', 0),
    s('tono 2', 12, -24, 24, { fmt: 'st' }),
    s('fine 2', 4, -64, 63),
    s('liv 2', 60),
    sp('modo', 0, ['mix', 'ring', 'sync'], { hint: 'how oscillator 1 treats oscillator 2' }),
    sp('tavola', 0, ['prima', 'seconda'], { hint: 'which wavetable both oscillators read' }),
    s('rumore', 0),
    sp('r. tipo', 0, ['bianco', 'granuli', 'S&H']),
    s('r. base', 0),
    s('r. ampiezza', 127),
    s('r. atk', 0),
    s('r. hold', 0),
    s('r. dec', 40),
    none(),
    none(),
    none(),
    none(),
    none(),
  ],
  // Swarmer: a main oscillator and a swarm of six, detuned and animated
  [
    s('tono', 0, -24, 24, { fmt: 'st' }),
    sp('sciame', 0, WAVES, { hint: 'the swarm’s wave' }),
    s('detune', 40),
    s('mix', 80, 0, 127, { hint: 'from the main oscillator to the swarm' }),
    sp('ottava', 1, ['0', '−1', '−2'], { hint: 'the main oscillator, down' }),
    sp('princ.', 1, WAVES, { hint: 'the main oscillator’s wave' }),
    s('anim.', 20, 0, 127, { hint: 'the swarm drifts: how fast' }),
    s('n. mod', 0, 0, 127, { hint: 'noise modulating the swarm' }),
    s('spazio', 70, 0, 127, { hint: 'how wide the swarm spreads across the stereo field' }),
    none(),
    none(),
    none(),
    none(),
    none(),
    none(),
    none(),
    none(),
    none(),
    none(),
    none(),
    none(),
    none(),
    none(),
    none(),
  ],
];

// ── track parameters ─────────────────────────────────────────────────────────
export const FILTERS = ['multimodo', 'passa-basso 4', 'equalizzatore', 'comb −', 'comb +', 'legacy'];
export const LFO_WAVES = ['tri', 'sin', 'qua', 'sega', 'exp', 'rampa', 'caso'];
export const LFO_MULT = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
export const LFO_MODES = ['libero', 'trig', 'tieni', 'una', 'mezza'];
export const VOICE_MODES = ['poli', 'mono', 'unisono'];

const t = (id: string, label: string, def: number, min = 0, max = 127, extra: Partial<Spec> = {}): Spec => ({ id, label, def, min, max, step: 1, ...extra });
const tp = (id: string, label: string, def: number, pos: string[], extra: Partial<Spec> = {}): Spec => t(id, label, def, 0, pos.length - 1, { pos, ...extra });

/** Destinations an LFO can reach (ids of track parameters). */
export const LFO_DST = [
  '—',
  'pitch',
  ...Array.from({ length: 8 }, (_, i) => `s${i}`),
  'f.freq',
  'f.res',
  'f.morph',
  'f.env',
  'f.base',
  'f.width',
  'a.dec',
  'vol',
  'pan',
  'od',
  'bits',
  'srr',
  'cho',
  'del',
  'rev',
  'l2.spd',
  'l2.dep',
  'l3.spd',
  'l3.dep',
];

export const TPARAMS: Spec[] = [
  tp('mach', 'macchina', 0, [...MACHINES]),
  ...Array.from({ length: SLOTS }, (_, i) => t(`s${i}`, `syn ${i + 1}`, 0, -64, 127)),
  t('note', 'nota', 60, 0, 127, { fmt: 'note' }),
  t('tune', 'intonazione', 0, -24, 24, { fmt: 'st' }),
  t('fine', 'fine', 0, -64, 63, { fmt: 'cent' }),
  tp('vmode', 'voce', 0, VOICE_MODES),
  t('porta', 'portamento', 0),
  tp('f.type', 'filtro', 0, FILTERS),
  t('f.freq', 'freq', 100),
  t('f.res', 'res', 20),
  t('f.morph', 'tipo', 0, 0, 127, { hint: 'multimode: low pass → band → high; EQ: gain; legacy: LP below 64, HP above' }),
  t('f.env', 'inv.', 0, -64, 63),
  t('f.edel', 'ritardo', 0),
  t('f.key', 'tastiera', 0),
  t('f.base', 'base', 0, 0, 127, { hint: 'a second filter: high pass' }),
  t('f.width', 'ampiezza', 127, 0, 127, { hint: 'the second filter’s low pass, above the base' }),
  t('f.atk', 'atk', 0),
  t('f.dec', 'dec', 50),
  t('f.sus', 'sus', 0),
  t('f.rel', 'rel', 40),
  t('a.atk', 'atk', 0),
  t('a.hold', 'hold', 0),
  t('a.dec', 'dec', 64),
  t('a.sus', 'sus', 90),
  t('a.rel', 'rel', 45),
  tp('a.mode', 'inviluppo', 0, ['ADSR', 'AHD']),
  t('pan', 'pan', 0, -64, 63),
  t('vol', 'volume', 100),
  t('vel', 'velocità→vol', 64),
  t('od', 'overdrive', 0),
  tp('odpos', 'posizione', 0, ['pre', 'post'], { hint: 'overdrive before or after the filter' }),
  t('bits', 'bit', 0, 0, 127, { hint: 'bit reduction: 0 is off' }),
  t('srr', 'SRR', 0, 0, 127, { hint: 'sample-rate reduction: 0 is off' }),
  t('cho', 'chorus', 0),
  t('del', 'delay', 0),
  t('rev', 'riverbero', 0),
  ...[1, 2, 3].flatMap((k) => [
    tp(`l${k}.wav`, 'onda', 0, LFO_WAVES),
    t(`l${k}.spd`, 'speed', 16, -64, 63),
    tp(
      `l${k}.mult`,
      'mult',
      2,
      LFO_MULT.map((m) => (m >= 1024 ? `${m / 1024}k` : String(m))),
    ),
    t(`l${k}.fade`, 'fade', 0, -64, 63),
    t(`l${k}.sph`, 'fase', 0),
    tp(`l${k}.mode`, 'modo', 0, LFO_MODES),
    tp(`l${k}.dst`, 'dest.', 0, LFO_DST),
    t(`l${k}.dep`, 'depth', 0, -64, 63),
  ]),
];
export const TIDX: Record<string, number> = Object.fromEntries(TPARAMS.map((s, i) => [s.id, i]));
export const tspec = (id: string) => TPARAMS[TIDX[id]];
export const TN = TPARAMS.length;
export const SLOT0 = TIDX.s0;

/** The spec of a track parameter for a given machine (machine slots have their own names and ranges). */
export function trackSpec(i: number, machine: number): Spec {
  const base = TPARAMS[i];
  if (i >= SLOT0 && i < SLOT0 + SLOTS) {
    const sl = MACHINE_SLOTS[machine]?.[i - SLOT0];
    if (!sl || !sl.label) return { ...base, label: '', min: 0, max: 0, def: 0 };
    return { ...base, label: sl.label, def: sl.def, min: sl.min, max: sl.max, pos: sl.pos, fmt: sl.fmt, hint: sl.hint };
  }
  return base;
}
/** A fresh sound for a machine. */
export function defaultSound(machine = 0): number[] {
  const v = TPARAMS.map((s) => s.def);
  v[0] = machine;
  MACHINE_SLOTS[machine].forEach((sl, i) => (v[SLOT0 + i] = sl.def));
  return v;
}
/** Switch a sound to another machine: the machine page is reset, the rest stays. */
export function setMachine(v: number[], machine: number) {
  v[0] = machine;
  MACHINE_SLOTS[machine].forEach((sl, i) => (v[SLOT0 + i] = sl.def));
}

/** Pages of eight, the way Elektron lays out its data-entry knobs. */
export const PAGES: { id: string; name: string; ids: (string | null)[] }[] = [
  { id: 'syn1', name: 'SYN 1', ids: ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'] },
  { id: 'syn2', name: 'SYN 2', ids: ['s8', 's9', 's10', 's11', 's12', 's13', 's14', 's15'] },
  { id: 'syn3', name: 'SYN 3', ids: ['s16', 's17', 's18', 's19', 's20', 's21', 's22', 's23'] },
  { id: 'fltr', name: 'FLTR', ids: ['f.freq', 'f.res', 'f.morph', 'f.env', 'f.edel', 'f.key', 'f.base', 'f.width'] },
  { id: 'fenv', name: 'F.ENV', ids: ['f.atk', 'f.dec', 'f.sus', 'f.rel', 'f.type', 'tune', 'fine', 'note'] },
  { id: 'amp', name: 'AMP', ids: ['a.atk', 'a.hold', 'a.dec', 'a.sus', 'a.rel', 'a.mode', 'pan', 'vol'] },
  { id: 'fx', name: 'FX', ids: ['od', 'odpos', 'bits', 'srr', 'cho', 'del', 'rev', 'vel'] },
  { id: 'voice', name: 'VOCE', ids: ['vmode', 'porta', null, null, null, null, null, null] },
  { id: 'lfo1', name: 'LFO 1', ids: ['l1.spd', 'l1.mult', 'l1.fade', 'l1.dst', 'l1.wav', 'l1.sph', 'l1.mode', 'l1.dep'] },
  { id: 'lfo2', name: 'LFO 2', ids: ['l2.spd', 'l2.mult', 'l2.fade', 'l2.dst', 'l2.wav', 'l2.sph', 'l2.mode', 'l2.dep'] },
  { id: 'lfo3', name: 'LFO 3', ids: ['l3.spd', 'l3.mult', 'l3.fade', 'l3.dst', 'l3.wav', 'l3.sph', 'l3.mode', 'l3.dep'] },
];

export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteName = (m: number) => `${NOTE_NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;
