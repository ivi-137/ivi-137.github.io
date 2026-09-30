/**
 * Factory sounds for Operatori, and the project the page opens with: a slow
 * pattern in A minor that shows off the sequencer (per-track lengths,
 * chords, micro timing, conditions, a retrig, a slide, the arpeggiator).
 */
import { BPAIRS, LFO_DST, MACHINE_SLOTS, RATIOS, SLOT0, TIDX, defaultSound } from './params';
import { PATTERNS, newPattern, newTrig, type Pattern, type Project, type Trig } from './seq';

const ratio = (r: number) => RATIOS.indexOf(r);
const pair = (a: number, b: number) => BPAIRS.findIndex(([x, y]) => x === a && y === b);

export interface Sound {
  name: string;
  m: number;
  syn: Record<string, number>;
  tp: Record<string, number>;
}
export function build(s: Sound): number[] {
  const v = defaultSound(s.m);
  const slots = MACHINE_SLOTS[s.m];
  for (const [label, val] of Object.entries(s.syn)) {
    const i = slots.findIndex((x) => x.label === label);
    if (i < 0) throw new Error(`no slot "${label}" on machine ${s.m}`);
    v[SLOT0 + i] = val;
  }
  for (const [id, val] of Object.entries(s.tp)) {
    if (TIDX[id] === undefined) throw new Error(`no track parameter ${id}`);
    v[TIDX[id]] = val;
  }
  return v;
}
const drum = { 'a.mode': 1, 'a.atk': 0, 'a.hold': 0, 'a.dec': 100, 'f.freq': 127, 'f.res': 0 };
const lfo = (k: number, dst: string, spd: number, mult: number, dep: number, wav = 1) => ({
  [`l${k}.dst`]: LFO_DST.indexOf(dst),
  [`l${k}.spd`]: spd,
  [`l${k}.mult`]: mult,
  [`l${k}.dep`]: dep,
  [`l${k}.wav`]: wav,
});

export const SOUNDS: Sound[] = [
  {
    name: 'cassa',
    m: 1,
    syn: { 'sweep t': 34, 'sweep d': 62, 'A·B': ratio(1), 'A lev': 26, 'A dec': 14, dec: 62, fold: 8, 'trans.': 1, 't. lev': 45 },
    tp: { ...drum, note: 36, vol: 118 },
  },
  {
    name: 'cassa lunga',
    m: 1,
    syn: { 'sweep t': 50, 'sweep d': 40, 'A·B': ratio(0.5), 'A lev': 10, dec: 88, hold: 20, 'trans.': 2, 't. lev': 30 },
    tp: { ...drum, note: 31, vol: 115, od: 30 },
  },
  {
    name: 'rullante',
    m: 1,
    syn: {
      'sweep t': 18,
      'sweep d': 34,
      algo: 2,
      'A·B': ratio(1.5),
      'A lev': 55,
      'A dec': 20,
      'B lev': 35,
      'B dec': 30,
      dec: 38,
      'trans.': 3,
      't. lev': 55,
      rumore: 92,
      'r. dec': 52,
      'r. base': 76,
      'r. ampiezza': 90,
    },
    tp: { ...drum, note: 50, vol: 104, rev: 25 },
  },
  {
    name: 'charleston',
    m: 1,
    syn: { dec: 6, 'A lev': 0, 'trans.': 2, 't. lev': 25, rumore: 118, 'r. dec': 24, 'r. base': 104, 'r. ampiezza': 70, 'r. tipo': 1 },
    tp: { ...drum, note: 72, vol: 92, pan: 12 },
  },
  {
    name: 'charleston aperto',
    m: 1,
    syn: { dec: 6, 'A lev': 0, rumore: 118, 'r. dec': 70, 'r. base': 100, 'r. ampiezza': 80, 'r. tipo': 1 },
    tp: { ...drum, note: 72, vol: 80, pan: 12 },
  },
  {
    name: 'tom',
    m: 1,
    syn: { 'sweep t': 40, 'sweep d': 30, 'A·B': ratio(2), 'A lev': 22, 'A dec': 28, dec: 66, 'trans.': 1, 't. lev': 30 },
    tp: { ...drum, note: 45, vol: 108 },
  },
  {
    name: 'clap di legno',
    m: 1,
    syn: {
      dec: 10,
      algo: 3,
      'A·B': ratio(3.5),
      'A lev': 70,
      'A dec': 8,
      'B lev': 60,
      'B dec': 10,
      'trans.': 3,
      't. lev': 70,
      rumore: 80,
      'r. dec': 30,
      'r. base': 80,
      'r. ampiezza': 60,
      'r. tipo': 2,
    },
    tp: { ...drum, note: 60, vol: 100, rev: 30 },
  },
  {
    name: 'basso FM',
    m: 0,
    syn: { C: ratio(0.5), A: ratio(1), 'A lev': 72, 'A dec': 42, 'A end': 16, fdbk: 18 },
    tp: { 'f.type': 1, 'f.freq': 74, 'f.res': 28, 'f.env': 22, 'f.dec': 52, 'a.dec': 70, 'a.sus': 96, 'a.rel': 22, vmode: 1, porta: 12, vol: 108 },
  },
  {
    name: 'basso gomma',
    m: 0,
    syn: { algo: 2, C: ratio(1), A: ratio(2), 'A lev': 50, 'A dec': 30, 'A end': 0, B: pair(1, 1), 'B lev': 0 },
    tp: { 'f.type': 1, 'f.freq': 58, 'f.res': 45, 'f.env': 30, 'f.dec': 40, vmode: 1, porta: 20, 'a.sus': 110 },
  },
  {
    name: 'piano elettrico',
    m: 0,
    syn: { algo: 2, C: ratio(1), A: ratio(1), 'A lev': 44, 'A dec': 58, 'A end': 0, B: pair(13, 5), 'B lev': 26, 'B dec': 30, 'B end': 0, mix: 0 },
    tp: { 'f.freq': 108, 'a.dec': 96, 'a.sus': 30, 'a.rel': 58, cho: 40, rev: 35, vol: 96 },
  },
  {
    name: 'campana',
    m: 0,
    syn: { algo: 6, C: ratio(1), A: ratio(3.5), 'A lev': 40, 'A dec': 92, 'A end': 0, B: pair(5, 2), 'B lev': 70, 'B dec': 100, mix: -10 },
    tp: { 'a.mode': 1, 'a.dec': 108, rev: 70, del: 45, vol: 88 },
  },
  {
    name: 'arpa',
    m: 0,
    syn: { algo: 0, C: ratio(1), A: ratio(2), 'A lev': 48, 'A dec': 34, 'A end': 0, B: pair(1, 3), 'B lev': 14, 'B dec': 20 },
    tp: { 'a.mode': 1, 'a.dec': 70, 'f.freq': 100, del: 50, rev: 40, vol: 90, pan: -14 },
  },
  {
    name: 'ottoni',
    m: 0,
    syn: { algo: 1, C: ratio(1), A: ratio(1), 'A atk': 30, 'A lev': 60, 'A dec': 60, 'A end': 50, fdbk: 40 },
    tp: { 'a.atk': 30, 'a.sus': 110, 'f.freq': 88, 'f.env': 20, 'f.atk': 40, vol: 96 },
  },
  {
    name: 'organo',
    m: 0,
    syn: { algo: 7, C: ratio(1), A: ratio(2), B: pair(3, 4), 'A lev': 0, 'B lev': 0, mix: 0 },
    tp: { 'a.sus': 127, 'a.rel': 30, cho: 60, vol: 90, ...lfo(1, 'pitch', 40, 4, 1) },
  },
  {
    name: 'vetro',
    m: 2,
    syn: { 'onda 1': 90, 'pd 1': 60, 'onda 2': 110, 'tono 2': 19, 'liv 2': 50, tavola: 1 },
    tp: { 'a.atk': 10, 'a.dec': 90, 'a.sus': 40, 'a.rel': 70, rev: 80, del: 30, vol: 84 },
  },
  {
    name: 'tappeto',
    m: 2,
    syn: { 'onda 1': 40, 'pd 1': 34, 'onda 2': 64, 'tono 2': 12, 'fine 2': 7, 'liv 2': 70 },
    tp: { 'a.atk': 66, 'a.dec': 90, 'a.sus': 100, 'a.rel': 70, 'f.freq': 76, 'f.res': 18, cho: 64, rev: 70, vol: 84, ...lfo(1, 'f.freq', 8, 4, 18) },
  },
  {
    name: 'voce di vetro',
    m: 2,
    syn: { 'onda 1': 10, 'pd 1': 80, tavola: 1, 'onda 2': 20, 'liv 2': 40, 'tono 2': 7 },
    tp: { 'a.atk': 50, 'a.sus': 110, 'a.rel': 70, 'f.type': 2, 'f.freq': 80, 'f.morph': 100, 'f.res': 60, rev: 60, ...lfo(1, 's0', 6, 4, 24, 0) },
  },
  {
    name: 'ring',
    m: 2,
    syn: { 'onda 1': 30, modo: 1, 'onda 2': 0, 'tono 2': 7, 'fine 2': 20, 'liv 2': 90 },
    tp: { 'a.mode': 1, 'a.dec': 80, del: 60, rev: 40 },
  },
  {
    name: 'sega sincronizzata',
    m: 2,
    syn: { 'onda 1': 18, 'onda 2': 18, modo: 2, 'tono 2': 19, 'liv 1': 0, 'liv 2': 110 },
    tp: { 'f.type': 1, 'f.freq': 84, 'f.res': 40, ...lfo(1, 's7', 10, 4, 20, 0), vmode: 1, porta: 30 },
  },
  {
    name: 'respiro',
    m: 2,
    syn: { 'liv 1': 0, 'liv 2': 0, rumore: 110, 'r. base': 50, 'r. ampiezza': 50, 'r. atk': 60, 'r. dec': 90 },
    tp: { 'a.atk': 60, 'a.sus': 100, 'a.rel': 80, rev: 90 },
  },
  {
    name: 'archi',
    m: 3,
    syn: { detune: 46, mix: 96, ottava: 1, 'anim.': 24, spazio: 96 },
    tp: { 'a.atk': 58, 'a.sus': 110, 'a.rel': 72, 'f.freq': 78, 'f.env': 8, 'f.atk': 60, cho: 30, rev: 64, vol: 86 },
  },
  {
    name: 'supersega',
    m: 3,
    syn: { detune: 70, mix: 110, ottava: 0, 'anim.': 40, spazio: 120 },
    tp: { 'a.sus': 120, 'f.type': 1, 'f.freq': 96, 'f.res': 20, rev: 40, vol: 84 },
  },
  {
    name: 'sciame quadro',
    m: 3,
    syn: { sciame: 1, 'princ.': 1, detune: 30, mix: 64, ottava: 2, 'anim.': 10, 'n. mod': 20 },
    tp: { 'f.type': 0, 'f.freq': 70, 'f.res': 50, 'f.env': 30, 'f.dec': 60, 'a.sus': 100 },
  },
];

const T = (n: number | number[], extra: Partial<Trig> = {}): Trig => ({ ...newTrig(Array.isArray(n) ? n[0] : n), n: Array.isArray(n) ? n : [n], ...extra });

export function demoPattern(): Pattern {
  const p = newPattern();
  p.name = 'Primo';
  p.mode = 1;
  p.ml = 64;
  const kit = [
    'cassa',
    'rullante',
    'charleston',
    'charleston aperto',
    'basso FM',
    'piano elettrico',
    'tappeto',
    'archi',
    'campana',
    'arpa',
    'tom',
    'clap di legno',
    'vetro',
    'organo',
    'supersega',
    'ring',
  ];
  kit.forEach((name, k) => (p.tracks[k].snd = build(SOUNDS.find((s) => s.name === name)!)));
  const put = (k: number, step: number, trig: Trig) => (p.tracks[k].steps[step] = trig);
  // drums: a relaxed beat, sixteen steps
  for (const k of [0, 1, 2, 3]) p.tracks[k].len = 16;
  [0, 7, 10].forEach((s) => put(0, s, T(36, { v: s ? 104 : 120 })));
  put(1, 4, T(50, { v: 110 }));
  put(1, 12, T(50, { v: 112 }));
  put(1, 15, T(50, { v: 44, c: 11 })); // a ghost, half the time
  for (let s = 0; s < 16; s += 2) put(2, s, T(72, { v: s % 4 ? 70 : 96, mt: s % 4 ? 3 : 0 }));
  put(2, 14, T(72, { v: 84, rt: 12, rl: 1, rv: -0.6 })); // a retrig at 1/32, fading
  put(3, 6, T(72, { v: 80, c: 30 })); // the open hat, every other bar (1:2)
  // the bass, two bars
  p.tracks[4].len = 32;
  const bass: [number, number, number, number?][] = [
    [0, 33, 3],
    [3, 33, 1],
    [6, 36, 2],
    [10, 28, 3],
    [14, 31, 2, 1],
    [16, 29, 3],
    [19, 29, 1],
    [22, 33, 2],
    [26, 31, 3],
    [30, 28, 2, 1],
  ];
  for (const [s, n, l, sl] of bass) put(4, s, T(n, { l, v: 100, sl: sl ? 1 : 0 }));
  // the chords, four bars
  p.tracks[5].len = 64;
  const chords = [
    [57, 60, 64, 71],
    [53, 57, 60, 64],
    [48, 55, 59, 64],
    [47, 55, 59, 62],
  ];
  chords.forEach((ch, i) => {
    put(5, i * 16, T(ch, { l: 6, v: 84 }));
    put(5, i * 16 + 10, T(ch, { l: 3, v: 60, mt: 6 }));
    put(
      6,
      i * 16,
      T(
        ch.slice(0, 3).map((n) => n - 12),
        { l: 15, v: 70 },
      ),
    );
  });
  p.tracks[6].len = 64;
  // the bell: sparse, and not always
  p.tracks[8].len = 16;
  put(8, 3, T(76, { v: 70, c: 11, mt: 8 }));
  put(8, 11, T(81, { v: 60, c: 31 }));
  // the harp's arpeggio: one trig a bar, the arpeggiator does the rest
  p.tracks[9].len = 64;
  p.tracks[9].arp = { m: 4, sp: 2, r: 2, nl: 0.5, len: 8, mask: 0b11011101, ofs: [0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
  chords.forEach((ch, i) => put(9, i * 16 + 8, T(ch.slice(0, 3), { l: 8, v: 64 })));
  // the others wait, empty, with their sounds ready
  for (const k of [7, 10, 11, 12, 13, 14, 15]) p.tracks[k].len = 16;
  return p;
}

export function demoProject(): Project {
  const pats: (Pattern | null)[] = new Array(PATTERNS).fill(null);
  pats[0] = demoPattern();
  return { v: 1, pats, cur: 0, song: [{ p: 0, r: 4 }], root: 9, scale: 1 };
}
