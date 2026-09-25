/**
 * Melencolia: the parameter table, shared by the panel and the audio thread
 * (same scheme as Orfeo: the panel sends `(index, value)` pairs).
 */
export interface VParam {
  id: string;
  label: string;
  def: number;
  min: number;
  max: number;
  step: number;
  pos?: string[];
  fmt?: 'pct' | 'int' | 'bpm' | 'db' | 'st' | 'ms' | 'div' | 'oct' | 'note';
}
const p = (id: string, label: string, def: number, min = 0, max = 1, step = 0.001, extra: Partial<VParam> = {}): VParam => ({ id, label, def, min, max, step, ...extra });
const sw = (id: string, label: string, def: number, pos: string[]) => p(id, label, def, 0, pos.length - 1, 1, { pos });

/** Echo divisions, in beats. */
export const ECHO = [
  { n: '1/8', beats: 0.5 },
  { n: '1/8.', beats: 0.75 },
  { n: '1/4', beats: 1 },
  { n: '1/4.', beats: 1.5 },
  { n: '1/2', beats: 2 },
];
/** Bars per chord. */
export const BARS = [0.5, 1, 2, 4];

export const VPARAMS: VParam[] = [
  p('g.vol', 'volume', 0.7),
  p('g.bpm', 'tempo', 66, 40, 140, 1, { fmt: 'bpm' }),
  p('g.bars', 'battute', 1, 0, BARS.length - 1, 1, { pos: BARS.map((b) => (b < 1 ? '½' : String(b))) }),

  // the voice (modulator)
  p('in.gain', 'guadagno', 0.45, 0, 1, 0.001, { fmt: 'db' }),
  p('in.gate', 'soglia', 0.4, 0, 1, 0.001, { fmt: 'db' }),
  p('in.sib', 'sibilanti', 0.35),
  p('in.dry', 'voce secca', 0),
  sw('in.mode', 'ascolto', 0, ['cuffie', 'casse']),

  // the filter bank
  p('vc.bands', 'bande', 20, 8, 32, 1, { fmt: 'int' }),
  p('vc.q', 'stretto', 0.5),
  p('vc.atk', 'attacco', 0.3, 0, 1, 0.001, { fmt: 'ms' }),
  p('vc.rel', 'rilascio', 0.45, 0, 1, 0.001, { fmt: 'ms' }),
  p('vc.formant', 'formanti', 0, -12, 12, 1, { fmt: 'st' }),
  sw('vc.freeze', 'congela', 0, ['off', 'on']),
  p('vc.blur', 'sfoca', 0.1),
  p('vc.dark', 'buio', 0.45),

  // the carrier
  sw('car.type', 'portante', 0, ['coro', 'organo', 'vetro', 'sussurro']),
  p('car.oct', 'ottava', 0, -2, 1, 1, { fmt: 'oct' }),
  p('car.detune', 'coro-det.', 0.3),
  p('car.bend', 'flessione', 0.3),
  p('car.glide', 'legato', 0.45),
  sw('car.follow', 'segue', 0, ['accordo', 'voce', 'entrambi']),
  sw('car.harm', 'terza sotto', 0, ['off', 'on']),
  p('car.noise', 'rumore', 0.06),
  sw('car.solo', 'senza voce', 0, ['off', 'on']),

  // the harmony
  sw('h.method', 'metodo', 0, ['cammino', 'lamento', 'cromatico', 'miscela', 'Dürer']),
  p('h.tonic', 'tonica', 9, 0, 11, 1, { fmt: 'note' }),
  p('h.tears', 'lacrime', 0.5),
  p('h.spice', 'spezie', 0.3),
  sw('h.hold', 'tieni', 0, ['off', 'on']),

  // after
  p('fx.tape', 'nastro', 0.3),
  p('fx.echo', 'eco', 0.18),
  p('fx.time', 'tempo eco', 1, 0, ECHO.length - 1, 1, { pos: ECHO.map((e) => e.n) }),
  p('fx.fb', 'ritorno', 0.35),
  p('fx.verb', 'riverbero', 0.35),
  p('fx.size', 'stanza', 0.65),
  p('fx.dark', 'ombra', 0.55),
];

export const VIDX: Record<string, number> = Object.fromEntries(VPARAMS.map((s, i) => [s.id, i]));
export const vspec = (id: string) => VPARAMS[VIDX[id]];
export const vdefaults = () => Object.fromEntries(VPARAMS.map((s) => [s.id, s.def])) as Record<string, number>;

export type ToVoc =
  | { t: 'p'; i: number; v: number }
  | { t: 'all'; p: number[] }
  | { t: 'cmd'; c: 'next' | 'restart' | 'calibrate' };

export interface VMon {
  t: 'mon';
  inDb: number;
  outDb: number;
  gate: number;
  f0: number;
  clarity: number;
  centroid: number;
  unvoiced: number;
  bands: number[];
  echo: number;
  duck: number;
}
export interface VChord {
  t: 'chord';
  at: number;
  name: string;
  roman: string;
  notes: number[];
  why: string[];
  cell: number | null;
  minor: boolean;
  motion: number;
}
export type FromVoc = VMon | VChord | { t: 'howl'; hz: number } | { t: 'cal'; db: number; ok: boolean } | { t: 'loop' };
