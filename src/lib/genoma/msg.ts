/** What the panel and the audio thread say to each other. */
import type { Pattern, SongRow } from './seq';

export type ReelButton = 'rec' | 'recNew' | 'splice' | 'shift' | 'delMarker' | 'delMarkers' | 'delSplice' | 'clearReel' | 'play' | 'arm';

export type ToG =
  | { t: 'p'; i: number; v: number }
  | { t: 'all'; p: number[] }
  | { t: 'proj'; pats: (Pattern | null)[]; cur: number; song: SongRow[] }
  | { t: 'pat'; i: number; pat: Pattern | null }
  | { t: 'tp'; k: number; i: number; v: number }
  | { t: 'play' }
  | { t: 'stop' }
  | { t: 'queue'; i: number }
  | { t: 'song'; on: boolean; row: number; rows: SongRow[] }
  | { t: 'fill'; on: boolean }
  | { t: 'mutes'; m: number[] }
  | { t: 'key'; k: number; n: number; v: number; on: boolean; rec: boolean }
  | { t: 'btn'; b: ReelButton }
  | { t: 'select'; k: number }
  | { t: 'divide'; n: number }
  | { t: 'scrub'; on: boolean; x: number }
  | { t: 'pad'; on: boolean; x: number; y: number }
  | { t: 'piezo'; tap?: number; rub?: number }
  | { t: 'coco'; w: 0 | 1; c: 'flip' | 'skip' | 'clear' }
  | { t: 'load'; L: Float32Array; R: Float32Array; marks: number[]; append: boolean }
  | { t: 'dump'; id: number };

export interface Mon {
  t: 'mon';
  playing: boolean;
  cur: number;
  songRow: number;
  steps: number[];
  levels: number[];
  reel: {
    len: number;
    count: number;
    cur: number;
    pending: number;
    play: boolean;
    rec: number;
    recHead: number;
    armed: number;
    barsLeft: number;
    geneStart: number;
    geneLen: number;
    grains: number[];
    scrub: number;
    clock: string;
    spd: number;
    cv: number;
    cap: number;
  };
  coco: [number, number];
  cocoLvl: [number, number];
  petals: number[];
  held: number[];
  pad: number;
  out: [number, number];
  inp: number;
  cv: number[];
  gates: number[];
}
export type FromG =
  | Mon
  | { t: 'reel'; ov: Float32Array; sov: Float32Array; marks: number[]; len: number; sr: number; cap: number; cur: number }
  | { t: 'dump'; id: number; L: Float32Array; R: Float32Array; marks: number[]; sr: number }
  | { t: 'pat'; i: number; row: number }
  | { t: 'rec'; k: number; s: number; n: number; v: number; mt: number; l: number }
  | { t: 'full' }
  | { t: 'dirty' };
