/** What every part of Genoma's panel shares: the context, knob gestures, value formats. */
import type { GenomaEngine } from './engine';
import type { Mon } from './msg';
import { gspec, CMP_RATIOS, type Spec } from './params';
import { speedSemitones, overlap, randomness } from './reel';
import { cocoHz, COCO_MEM } from './coco';
import { expMap } from './fx';

export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
/** Pointer capture that never throws (synthetic or already-released pointers). */
export function capture(el: Element, id: number) {
  try {
    el.setPointerCapture(id);
  } catch {
    /* nothing to capture */
  }
}

export interface ReelInfo {
  sr: number;
  len: number;
  count: number;
  cur: number;
  marks: number[];
  cap: number;
  geneLen: number;
}

export interface Ctx {
  root: HTMLElement;
  $: <T extends Element = HTMLElement>(s: string) => T;
  $$: <T extends Element = HTMLElement>(s: string) => T[];
  engine: GenomaEngine;
  /** global parameter values, by index */
  p: number[];
  get(id: string): number;
  setParam(id: string, v: number, quiet?: boolean): void;
  /** listeners for parameter changes (from knobs, scenes, cables) */
  watch(fn: (id: string, v: number) => void): void;
  status(t: string): void;
  boot(): Promise<boolean>;
  mon: Mon | null;
  reel: ReelInfo;
  onMon(fn: (m: Mon) => void): void;
  onFrame(fn: (now: number) => void): void;
  cleanup(fn: () => void): void;
}

type Num = number | (() => number);
const val = (x: Num) => (typeof x === 'function' ? x() : x);

/** Vertical drag (shift for fine), wheel, arrow keys, Home/End, double-click to reset: every knob on the page. Ranges may be live. */
export function bindDrag(el: HTMLElement, get: () => number, set: (v: number) => void, min: Num, max: Num, step: Num, reset: () => void, onStart?: () => void) {
  let drag: { y: number; v: number } | null = null;
  const span = () => val(max) - val(min);
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { y: e.clientY, v: get() };
    capture(el, e.pointerId);
    el.classList.add('is-turning');
    onStart?.();
  });
  el.addEventListener('pointermove', (e) => drag && set(drag.v + ((drag.y - e.clientY) / (e.shiftKey ? 700 : 170)) * span()));
  const end = () => {
    drag = null;
    el.classList.remove('is-turning');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      onStart?.();
      set(get() - Math.sign(e.deltaY) * Math.max(val(step), span() / 60));
    },
    { passive: false },
  );
  el.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      onStart?.();
      set(e.key === 'Home' ? val(min) : val(max));
      return;
    }
    if (!d) return;
    e.preventDefault();
    onStart?.();
    set(get() + d * Math.max(val(step), span() / (e.shiftKey ? 100 : 20)));
  });
  el.addEventListener('dblclick', () => {
    onStart?.();
    reset();
  });
}

/** Draw a knob's pointer and value. */
export function paintKnob(el: HTMLElement, v: number, min: number, max: number, text: string) {
  const ptr = el.querySelector('.knob__pointer');
  const u = max > min ? (v - min) / (max - min) : 0;
  ptr?.setAttribute('transform', `rotate(${-135 + clamp(u) * 270})`);
  el.setAttribute('aria-valuenow', String(v));
  el.setAttribute('aria-valuetext', text);
  const val = el.querySelector<HTMLElement>('[data-knob-value], [data-pk-value]');
  if (val) val.textContent = text;
}

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const ms = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(s < 10 ? 2 : 1)} s`);

/** A global parameter's value as the panel shows it. */
export function fmtGlobal(id: string, v: number, reel?: ReelInfo): string {
  const s: Spec = gspec(id);
  if (s.pos) return s.pos[Math.round(v)] ?? '';
  switch (s.fmt) {
    case 'speed': {
      const st = speedSemitones(v);
      if (Number.isNaN(st)) return 'fermo';
      const dir = v < 0 ? '◀' : '▶';
      return st === 0 ? `1× ${dir}` : `${st > 0 ? '+' : '−'}${Math.abs(st).toFixed(1)} ${dir}`;
    }
    case 'gene': {
      if (v < 0.002) return 'giunta';
      if (reel && reel.geneLen > 0) return ms(reel.geneLen / reel.sr);
      return `${Math.round((1 - v) * 100)}%`;
    }
    case 'morph': {
      const r = overlap(v);
      const a = randomness(v);
      if (a > 0) return `3/1 · caso ${Math.round(a * 100)}`;
      if (r < 0.999) return `pause · 1/${(1 / r).toFixed(1)}`;
      return Math.abs(r - 1) < 0.02 ? '1/1' : `${r.toFixed(1)}/1`;
    }
    case 'organize': {
      if (!reel || !reel.count) return '—';
      return `${Math.min(reel.count, Math.floor(v * reel.count) + 1)} / ${reel.count}`;
    }
    case 'sos': {
      const a = Math.min(1, 2 * v),
        b = Math.min(1, 2 * (1 - v));
      return a >= 1 && b >= 1 ? 'nuovo + vecchio' : a < 1 ? `vecchio · ${Math.round(a * 100)}` : `nuovo · ${Math.round(b * 100)}`;
    }
    case 'db': {
      const g = v * v * 2;
      return g < 0.001 ? '−∞' : `${(20 * Math.log10(g)).toFixed(1)} dB`;
    }
    case 'hz': {
      const hz = cocoHz(v);
      return `${(hz / 1000).toFixed(hz < 10000 ? 1 : 0)} kHz · ${ms(COCO_MEM / hz)}`;
    }
    case 'pan':
      return Math.abs(v) < 0.02 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`;
    case 'bpm':
      return v.toFixed(1);
    case 'swing':
      return `${Math.round(v)}%`;
    case 'lfohz':
      return `${expMap(v, 0.05, 6).toFixed(2)} Hz`;
    case 'ms300':
      return `${Math.round(v * 300)} ms`;
    case 't60':
      return ms(0.3 * Math.pow(60, v));
    case 'thr':
      return `${(-36 + 36 * v).toFixed(0)} dB`;
    case 'cmpatk':
      return ms(0.0005 * Math.pow(60, v));
    case 'cmprel':
      return ms(0.02 * Math.pow(50, v));
    case 'make':
      return `+${(v * 18).toFixed(1)} dB`;
    default:
      if (s.min < 0) return `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
      if (s.max > 1) return `${Math.round(v)}`;
      return `${Math.round(v * 100)}`;
  }
}
export const cmpRatio = (i: number) => CMP_RATIOS[i];

/** A short confirmation on the status line. */
export function flash(el: HTMLElement, cls = 'is-flash') {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
