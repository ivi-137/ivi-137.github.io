/**
 * MIDI for Organismo 23, the way the manual describes it: next to each function there is a LRN button; press it, then
 * touch the key or turn the controller you want, and the Pulsar remembers the channel and the key or controller number
 * even when it is switched off. The panel here remembers in the browser's storage, and the computer's keyboard stands in
 * for a MIDI keyboard when there is none.
 *
 * Twelve things can be learned: the triggers of the four voices, the four MIDI-to-CV outputs, and the shape and warp of
 * the bass. Pitch bend and portamento (controller 5) go to the bass on its own channel and cannot be reassigned.
 */
import { Midi } from '../synth/midi';

export type Fn = 'bd' | 'bs' | 'sd' | 'hh' | 'cv0' | 'cv1' | 'cv2' | 'cv3' | 'shape' | 'warp';
export const FNS: Fn[] = ['bd', 'bs', 'sd', 'hh', 'cv0', 'cv1', 'cv2', 'cv3', 'shape', 'warp'];
export const FN_LABEL: Record<Fn, string> = { bd: 'BD', bs: 'BASS', sd: 'SD', hh: 'HHT', cv0: 'KTR', cv1: 'CV 2', cv2: 'CV 3', cv3: 'CV 4', shape: 'SHAPE', warp: 'WARP' };

export interface Learned {
  kind: 'note' | 'cc';
  ch: number;
  n: number;
}

export interface MidiOut {
  /** a voice trigger: 0 to 1, with 0 releasing it */
  trig(ch: number, v: number): void;
  /** a pitched note for the bass */
  note(note: number, vel: number, on: boolean): void;
  cv(i: number, v: number): void;
  /** a bass control from a controller, 0 to 1 */
  param(id: 'bs.shape' | 'bs.warp', v: number): void;
  portamento(v: number): void;
  bend(v: number): void;
  clock(): void;
  start(): void;
  stop(): void;
  /** the learn state changed, or a function was learned */
  learned(): void;
  /** whether the bass is in MIDI mode, so that any key on its channel plays it */
  bassIsMidi(): boolean;
}

/** The computer keyboard as a MIDI keyboard: two rows of piano keys, an octave apart on Z and X. */
const KEYS = 'a w s e d f t g y h u j k o l p'.split(' ');

const STORE = 'organismo.midi';

export class MidiControl {
  map: Partial<Record<Fn, Learned>> = {};
  learning: Fn | null = null;
  private midi: Midi | null = null;
  private octave = 0;
  private held = new Set<string>();
  private out: MidiOut;

  constructor(out: MidiOut) {
    this.out = out;
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) this.map = JSON.parse(raw);
    } catch {
      /* private window: nothing remembered */
    }
  }

  static get supported() {
    return Midi.supported;
  }
  get enabled() {
    return !!this.midi?.access;
  }

  private save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.map));
    } catch {
      /* ignore */
    }
  }

  async enable() {
    this.midi ??= new Midi({
      note: (on, note, vel, ch) => this.note(on, note, vel, ch),
      cc: (cc, v, ch) => this.cc(cc, v, ch),
      clock: () => this.out.clock(),
      start: () => this.out.start(),
      stop: () => this.out.stop(),
      bend: (v) => this.out.bend(v),
    });
    return this.midi.enable();
  }

  learn(fn: Fn | null) {
    this.learning = this.learning === fn ? null : fn;
    this.out.learned();
  }
  clearAll() {
    this.map = {};
    this.learning = null;
    this.save();
    this.out.learned();
  }

  // ── the computer's keyboard ──
  /** Returns true if the key was used. */
  key(e: KeyboardEvent, down: boolean) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const k = e.key.toLowerCase();
    if (down && (k === 'z' || k === 'x')) {
      this.octave = Math.max(-2, Math.min(2, this.octave + (k === 'x' ? 1 : -1)));
      return true;
    }
    const idx = KEYS.indexOf(k);
    if (idx < 0) return false;
    if (down && e.repeat) return true;
    const note = 60 + this.octave * 12 + idx;
    if (down) this.held.add(k);
    else this.held.delete(k);
    this.note(down, note, 0.8, 0);
    return true;
  }

  // ── messages in, from a device or the keyboard ──
  note(on: boolean, note: number, vel: number, ch: number) {
    if (on && this.learning && this.learning !== 'shape' && this.learning !== 'warp') {
      this.map[this.learning] = { kind: 'note', ch, n: note };
      this.learning = null;
      this.save();
      this.out.learned();
      return;
    }
    let used = false;
    for (const fn of FNS) {
      const m = this.map[fn];
      if (!m || m.kind !== 'note' || m.ch !== ch) continue;
      // a learned key triggers its function; the bass, in MIDI mode, answers every key of its channel
      const exact = m.n === note;
      if (fn === 'bs' && this.out.bassIsMidi()) {
        this.out.note(note, vel, on);
        used = true;
      } else if (exact) {
        used = true;
        if (fn === 'bd' || fn === 'bs' || fn === 'sd' || fn === 'hh') this.out.trig(['bd', 'bs', 'sd', 'hh'].indexOf(fn), on ? vel : 0);
        else if (fn.startsWith('cv')) this.out.cv(Number(fn.slice(2)), on ? vel : 0);
      }
    }
    // nothing learned for the bass: in MIDI mode it is simply a chromatic keyboard
    if (!used && !this.map.bs && this.out.bassIsMidi()) this.out.note(note, vel, on);
  }

  cc(cc: number, v: number, ch: number) {
    if (this.learning) {
      this.map[this.learning] = { kind: 'cc', ch, n: cc };
      this.learning = null;
      this.save();
      this.out.learned();
      return;
    }
    const bassCh = this.map.bs?.ch;
    if (cc === 5 && (bassCh === undefined || bassCh === ch)) this.out.portamento(v);
    for (const fn of FNS) {
      const m = this.map[fn];
      if (!m || m.kind !== 'cc' || m.ch !== ch || m.n !== cc) continue;
      if (fn === 'shape') this.out.param('bs.shape', v);
      else if (fn === 'warp') this.out.param('bs.warp', v);
      else if (fn.startsWith('cv')) this.out.cv(Number(fn.slice(2)), v);
      else this.out.trig(['bd', 'bs', 'sd', 'hh'].indexOf(fn), v);
    }
  }

  /** Let go of everything, as the manual's panic button does. */
  panic() {
    for (let i = 0; i < 4; i++) this.out.trig(i, 0);
    for (let i = 0; i < 4; i++) this.out.cv(i, 0);
    this.held.clear();
  }
}
