/**
 * The Organismo 23 panel: knobs and switches bound to the control table, the patch bay, the touch pads, the tapes that
 * show what each looper remembers, the lamps, MIDI learn, presets, share links and recording.
 */
import { Engine } from './engine';
import { Cables } from './cables';
import { MidiControl, FNS, FN_LABEL, type Fn, type MidiOut } from './midi';
import { PARAMS, PIDX, PINS, LOOP_EVENTS, format, fromNorm, spec, toNorm, defaults, type Cable, type Mon, type ParamSpec } from './params';
import { PRESETS, presetControls, presetLoops } from './presets';
import { toast } from '../ui/nav';
import { fmtTime, makeTake, takesList } from '../audio/recorder';

const DEFAULT_PRESET = 2; // Basic techno

// ── share links ─────────────────────────────────────────────────────────────

const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

const snap = (s: ParamSpec, v: number) => {
  v = Math.min(s.max, Math.max(s.min, v));
  return s.kind === 'float' ? v : Math.round(v);
};

interface Shared {
  p: Float64Array;
  cables: Cable[];
  loops: number[][][];
}

const pinIds = new Set(PINS.map((p) => p.id));

function encode(p: ArrayLike<number>, cables: Cable[], loops: number[][][]) {
  const l: Array<[number, number, number[]]> = [];
  loops.forEach((bank, b) => bank.forEach((r, c) => r?.length > 2 && l.push([b, c, r])));
  return b64(JSON.stringify({ v: 1, p: Array.from(p, (x) => Math.round(x * 1e5) / 1e5), c: cables, l }));
}

function decode(s: string): Shared | null {
  try {
    const o = JSON.parse(unb64(s));
    if (o?.v !== 1 || !Array.isArray(o.p) || o.p.length !== PARAMS.length) return null;
    const p = Float64Array.from(o.p, (x: unknown, i: number) => snap(PARAMS[i], Number(x)));
    if (!p.every(Number.isFinite)) return null;
    const cables: Cable[] = (Array.isArray(o.c) ? o.c : []).filter((c: unknown) => Array.isArray(c) && pinIds.has(c[0]) && pinIds.has(c[1])).slice(0, 400);
    const loops: number[][][] = [0, 1, 2, 3].map(() => [[], [], [], []]);
    for (const e of Array.isArray(o.l) ? o.l : []) {
      const [b, c, r] = e;
      if (b >= 0 && b < 4 && c >= 0 && c < 4 && Array.isArray(r) && r.length <= 60000 && r.every((x: unknown) => Number.isInteger(x))) loops[b][c] = r;
    }
    return { p, cables, loops };
  } catch {
    return null;
  }
}

const noteName = (n: number) => ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][n % 12] + (Math.floor(n / 12) - 1);

// ── the panel ───────────────────────────────────────────────────────────────

export function mountOrganismo() {
  const root = document.querySelector<HTMLElement>('[data-organismo]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const engine = new Engine();

  const fromHash = new URLSearchParams(location.hash.slice(1)).get('o');
  const shared = fromHash ? decode(fromHash) : null;

  const state = {
    p: shared?.p ?? presetControls(DEFAULT_PRESET),
    loops: shared?.loops ?? presetLoops(DEFAULT_PRESET),
    preset: shared ? -1 : DEFAULT_PRESET,
  };
  /** what each tape looks like: [bank][channel] run-length code */
  let tapes: number[][][] = state.loops.map((b) => b.map((r) => r.slice()));
  let bank = 0;

  const presetSel = $<HTMLSelectElement>('[data-preset]');
  const blurb = $('[data-blurb]');
  const status = $('[data-status]');
  const board = $<HTMLElement>('[data-board]');
  const cables = new Cables(board, root.querySelector<SVGSVGElement>('[data-wires]')!);
  cables.set(shared?.cables ?? PRESETS[DEFAULT_PRESET].cables ?? []);

  // ── one place for every change ────────────────────────────────────────────
  const shows = new Map<string, () => void>();
  const showBlurb = () => {
    blurb.textContent = state.preset >= 0 ? PRESETS[state.preset].blurb : shared ? 'A patch from a link: every knob, cable and loop as it was shared.' : 'Your own patch.';
  };
  const edited = () => {
    if (state.preset === -1) return;
    state.preset = -1;
    presetSel.value = '-1';
    showBlurb();
  };
  function change(id: string, v: number) {
    const s = spec(id);
    const i = PIDX[id];
    v = snap(s, v);
    if (v === state.p[i]) return;
    state.p[i] = v;
    if (engine.ready) engine.param(i, v);
    shows.get(id)?.();
    edited();
  }

  // ── knobs: they turn in a 0–1 space, and the table maps that to the real value ─────────
  root.querySelectorAll<HTMLElement>('[data-knob]').forEach((el) => {
    const id = el.dataset.knob!;
    const s = spec(id);
    const i = PIDX[id];
    const valueEl = el.querySelector<HTMLElement>('[data-knob-value]')!;
    const pointer = el.querySelector('.knob__pointer')!;
    shows.set(id, () => {
      const v = state.p[i];
      const n = toNorm(s, v);
      const text = format(s, v);
      pointer.setAttribute('transform', `rotate(${-135 + n * 270})`);
      el.setAttribute('aria-valuenow', String(Math.round(n * 1000) / 1000));
      el.setAttribute('aria-valuetext', text);
      valueEl.textContent = text;
    });
    let drag: { y: number; n: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      drag = { y: e.clientY, n: toNorm(s, state.p[i]) };
      el.setPointerCapture(e.pointerId);
      el.classList.add('is-turning');
    });
    el.addEventListener('pointermove', (e) => {
      if (drag) change(id, fromNorm(s, drag.n + (drag.y - e.clientY) / (e.shiftKey ? 600 : 160)));
    });
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
        change(id, fromNorm(s, toNorm(s, state.p[i]) - Math.sign(e.deltaY) * (e.shiftKey ? 0.01 : 0.04)));
      },
      { passive: false },
    );
    el.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      change(id, fromNorm(s, toNorm(s, state.p[i]) + d * (e.shiftKey ? 0.01 : 0.04)));
    });
    el.addEventListener('dblclick', () => change(id, s.def)); // double-click resets
  });

  // ── switches ──────────────────────────────────────────────────────────────
  root.querySelectorAll<HTMLElement>('[data-seg]').forEach((seg) => {
    const id = seg.dataset.seg!;
    const btns = [...seg.querySelectorAll<HTMLButtonElement>('[data-v]')];
    shows.set(id, () => btns.forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.v) === state.p[PIDX[id]]))));
    btns.forEach((b) =>
      b.addEventListener('click', () => {
        change(id, Number(b.dataset.v));
        b.focus({ preventScroll: true });
      }),
    );
    seg.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      change(id, state.p[PIDX[id]] + (e.key === 'ArrowRight' ? 1 : -1));
      btns[state.p[PIDX[id]]]?.focus();
    });
  });

  // ── the tapes: what each looper remembers ─────────────────────────────────
  const tapeEls = [...root.querySelectorAll<HTMLElement>('[data-tape]')];
  const tapeHeads = tapeEls.map((t) => t.querySelector<HTMLElement>('.tape__head')!);
  const drawTape = (ch: number) => {
    const canvas = tapeEls[ch].querySelector('canvas')!;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = (canvas.width = Math.max(64, Math.round(canvas.clientWidth * dpr)));
    const h = (canvas.height = Math.max(24, Math.round(canvas.clientHeight * dpr)));
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    // bar lines: four bars of four quarters
    g.fillStyle = 'rgba(233,228,210,0.13)';
    for (let q = 0; q < 16; q++) g.fillRect(Math.round((q / 16) * w), 0, q % 4 ? 1 : 2, h);
    const r = tapes[bank]?.[ch] ?? [];
    let at = 0;
    for (let k = 0; k + 1 < r.length; k += 2) {
      const v = r[k] & 3;
      const n = r[k + 1];
      if (v) {
        const hh = [0, 0.35, 0.65, 1][v] * (h - 4);
        const x0 = (at / LOOP_EVENTS) * w;
        const x1 = ((at + n) / LOOP_EVENTS) * w;
        g.fillStyle = ['', '#7d8cff', '#e9e4d2', '#c6ff3d'][v];
        g.fillRect(x0, h - 2 - hh, Math.max(1.5, x1 - x0), hh);
      }
      at += n;
    }
  };
  const drawTapes = () => tapeEls.forEach((_, ch) => drawTape(ch));
  new ResizeObserver(drawTapes).observe(board);

  // ── presets ───────────────────────────────────────────────────────────────
  const refreshAll = () => {
    shows.forEach((show) => show());
    presetSel.value = String(state.preset);
    showBlurb();
    drawTapes();
    refreshLearn();
  };
  function loadPreset(n: number) {
    state.p.set(presetControls(n));
    state.loops = presetLoops(n);
    tapes = state.loops.map((b) => b.map((r) => r.slice()));
    state.preset = n;
    cables.set(PRESETS[n].cables ?? []);
    bank = PRESETS[n].bank ?? 0;
    if (engine.ready) {
      engine.post({ t: 'init', p: Array.from(state.p), cables: cables.cables });
      engine.post({ t: 'loops', data: state.loops });
      engine.bank(bank);
      engine.post({ t: 'rst' });
    }
    refreshAll();
  }
  presetSel.addEventListener('change', () => {
    const n = Number(presetSel.value);
    if (n >= 0) loadPreset(n);
  });
  cables.onChange = (c) => {
    if (engine.ready) engine.cables(c);
    edited();
  };
  $('[data-unpatch]').addEventListener('click', () => {
    if (cables.cables.length) {
      cables.clear();
      toast('Every cable is off. The voices only play when something is joined to their trig pins.');
    }
  });
  $('[data-wipe]').addEventListener('click', () => {
    tapes = [0, 1, 2, 3].map(() => [[], [], [], []]);
    state.loops = [0, 1, 2, 3].map(() => [[], [], [], []]);
    if (engine.ready) engine.post({ t: 'loops', data: state.loops });
    edited();
    drawTapes();
  });

  // ── transport ─────────────────────────────────────────────────────────────
  const powerBtn = $<HTMLButtonElement>('[data-power]');
  let on = false;
  const setOn = (v: boolean) => {
    on = v;
    powerBtn.setAttribute('aria-pressed', String(v));
    $('[data-power-label]').textContent = v ? 'on' : 'power';
    status.textContent = v ? (cables.cables.length ? 'on: the cables are carrying signals' : 'on, and silent: nothing is patched') : 'off: the loops and the patch are kept';
    cancelAnimationFrame(raf);
    if (v) raf = requestAnimationFrame(frame);
  };
  async function power() {
    if (!engine.ready) {
      status.textContent = 'waking the audio thread…';
      try {
        await engine.boot(state.p, cables.cables, state.loops);
        engine.bank(bank);
        await engine.resume();
      } catch {
        status.textContent = 'this browser could not start the audio thread';
        return;
      }
      setOn(true);
    } else if (on) {
      await engine.suspend();
      setOn(false);
    } else {
      await engine.resume();
      setOn(true);
    }
  }
  powerBtn.addEventListener('click', power);

  // ── the hands: looper pads, the recorder control and RST ──────────────────
  const held = new Map<string, () => void>();
  const press = (key: string, el: HTMLElement | null, send: (down: boolean) => void, down: boolean) => {
    if (down === held.has(key)) return;
    if (down && !engine.ready) {
      void power();
      return;
    }
    el?.classList.toggle('is-down', down);
    send(down);
    if (down) held.set(key, () => press(key, el, send, false));
    else held.delete(key);
  };
  const padEls = new Map<string, HTMLElement>();
  const bindPad = (el: HTMLElement, key: string, send: (down: boolean) => void) => {
    padEls.set(key, el);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      press(key, el, send, true);
    });
    const up = () => press(key, el, send, false);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  };
  const sendAdd = (ch: number) => (d: boolean) => engine.button(ch, 'add', d);
  const sendDel = (ch: number) => (d: boolean) => engine.button(ch, 'del', d);
  root.querySelectorAll<HTMLElement>('[data-pad]').forEach((el) => {
    const ch = Number(el.dataset.ch);
    const kind = el.dataset.pad === 'add' ? 'add' : 'del';
    bindPad(el, `${kind}${ch}`, kind === 'add' ? sendAdd(ch) : sendDel(ch));
  });
  root.querySelectorAll<HTMLElement>('[data-rc]').forEach((el) => {
    const b = el.dataset.rc as 'L' | 'M' | 'BANK';
    bindPad(el, `rc${b}`, (d) => engine.rc(b, d));
  });
  const rstBtn = $('[data-rst]');
  const rst = () => {
    if (!engine.ready) return void power();
    engine.post({ t: 'rst' });
    rstBtn.classList.add('is-down');
    setTimeout(() => rstBtn.classList.remove('is-down'), 120);
  };
  rstBtn.addEventListener('click', rst);
  const releaseAll = () => [...held.values()].forEach((f) => f());

  // ── touch sensors ─────────────────────────────────────────────────────────
  root.querySelectorAll<HTMLElement>('[data-sens]').forEach((plate) => {
    const i = Number(plate.dataset.sens);
    const fill = plate.querySelector<HTMLElement>('.sens__fill')!;
    const set = (v: number) => {
      fill.style.height = `${Math.round(v * 100)}%`;
      plate.classList.toggle('is-down', v > 0);
      engine.post({ t: 'sens', i, v });
    };
    // the higher on the plate, the harder the touch
    const at = (e: PointerEvent) => {
      const r = plate.getBoundingClientRect();
      return Math.min(1, Math.max(0.15, 1 - (e.clientY - r.top) / r.height));
    };
    plate.addEventListener('pointerdown', (e) => {
      if (!engine.ready) return void power();
      plate.setPointerCapture(e.pointerId);
      set(at(e));
    });
    plate.addEventListener('pointermove', (e) => plate.hasPointerCapture(e.pointerId) && set(at(e)));
    const up = () => set(0);
    plate.addEventListener('pointerup', up);
    plate.addEventListener('pointercancel', up);
    plate.addEventListener('keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault();
        set(1);
      }
    });
    plate.addEventListener('keyup', (e) => (e.key === ' ' || e.key === 'Enter') && set(0));
  });

  // ── MIDI ──────────────────────────────────────────────────────────────────
  const learnEls = new Map<Fn, HTMLButtonElement>();
  root.querySelectorAll<HTMLButtonElement>('[data-lrn]').forEach((b) => learnEls.set(b.dataset.lrn as Fn, b));
  const midiHint = $('[data-midi-hint]');
  function refreshLearn() {
    for (const f of FNS) {
      const b = learnEls.get(f)!;
      const m = midi.map[f];
      const v = b.querySelector('[data-lrn-val]')!;
      b.classList.toggle('is-learning', midi.learning === f);
      v.textContent = midi.learning === f ? '…' : m ? (m.kind === 'note' ? noteName(m.n) : `cc${m.n}`) + (m.ch ? `·${m.ch + 1}` : '') : '—';
    }
    midiHint.textContent = midi.learning ? `press a key or turn a controller for ${FN_LABEL[midi.learning]}` : 'lrn, then a key or a controller; the keyboard works too';
  }
  const out: MidiOut = {
    trig: (ch, v) => engine.post({ t: 'trig', ch, v }),
    note: (note, vel, onn) => engine.post({ t: 'note', note, vel, on: onn }),
    cv: (i, v) => engine.post({ t: 'cv', i, v }),
    param: (id, v) => change(id, fromNorm(spec(id), v)),
    portamento: (v) => engine.post({ t: 'cc', cc: 5, v }),
    bend: (v) => engine.post({ t: 'bend', v }),
    clock: () => engine.post({ t: 'mclk' }),
    start: () => engine.post({ t: 'mstart' }),
    stop: () => engine.post({ t: 'mstop' }),
    learned: () => refreshLearn(),
    bassIsMidi: () => state.p[PIDX['bs.mode']] === 1,
  };
  const midi = new MidiControl(out);
  learnEls.forEach((b, f) =>
    b.addEventListener('click', () => {
      if (!engine.ready) void power();
      midi.learn(f);
    }),
  );
  const midiBtn = $<HTMLButtonElement>('[data-midi]');
  midiBtn.addEventListener('click', async () => {
    if (!MidiControl.supported) return toast('This browser has no Web MIDI. The computer keyboard still works.');
    try {
      const access = await midi.enable();
      midiBtn.setAttribute('aria-pressed', 'true');
      toast(access.inputs.size ? 'MIDI on. Press LRN beside a function, then a key or a controller.' : 'MIDI is on, but no input was found.');
    } catch {
      toast('MIDI access was refused.');
    }
  });
  $('[data-midi-clear]').addEventListener('click', () => midi.clearAll());

  // ── the microphone ────────────────────────────────────────────────────────
  const micBtn = $<HTMLButtonElement>('[data-mic]');
  micBtn.addEventListener('click', async () => {
    if (!engine.ready) await power();
    if (!engine.ready) return;
    if (engine.micActive) {
      engine.micOff();
      micBtn.setAttribute('aria-pressed', 'false');
      return;
    }
    try {
      await engine.micOn();
      micBtn.setAttribute('aria-pressed', 'true');
      toast('Microphone on M1. Clip M1 to a voice’s ext pin, or to MIX IN. Use headphones, or it will feed back.');
    } catch {
      toast('The microphone was refused.');
    }
  });

  // ── lamps, pins, tapes and scope ──────────────────────────────────────────
  const ledClock = $('[data-led=clock]');
  const ledClip = $('[data-led=clip]');
  const bankLeds = [...root.querySelectorAll<HTMLElement>('[data-bank-led]')];
  const envLeds = [...root.querySelectorAll<HTMLElement>('[data-env]')];
  engine.onTape = (t) => {
    tapes[t.bank][t.ch] = t.r;
    state.loops[t.bank][t.ch] = t.r;
    if (t.bank === bank) drawTape(t.ch);
  };
  engine.onMon = (m: Mon) => {
    cables.light(m.pins);
    ledClock.dataset.on = String(m.led);
    ledClip.classList.toggle('is-on', m.clip);
    envLeds.forEach((l, i) => l.style.setProperty('--on', Math.min(1, m.env[i] ?? 0).toFixed(2)));
    m.head.forEach((h, i) => tapeHeads[i].style.setProperty('--at', String(h / 128)));
    root.classList.toggle('is-stopped', !m.running);
    if (m.bank !== bank) {
      bank = m.bank;
      drawTapes();
    }
    bankLeds.forEach((l, i) => l.classList.toggle('is-on', i === m.bank));
  };
  bankLeds.forEach((l, i) => l.classList.toggle('is-on', i === bank));

  const scope = $<HTMLCanvasElement>('[data-scope]');
  const sctx = scope.getContext('2d')!;
  let buf: Uint8Array<ArrayBuffer> | null = null;
  let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    if (!engine.ready) return;
    const w = (scope.width = scope.clientWidth * 2);
    const h = (scope.height = scope.clientHeight * 2);
    buf ??= new Uint8Array(engine.analyser.fftSize);
    engine.analyser.getByteTimeDomainData(buf);
    sctx.clearRect(0, 0, w, h);
    sctx.strokeStyle = '#c6ff3d';
    sctx.lineWidth = 2.2;
    sctx.beginPath();
    for (let i = 0; i < buf.length; i++) {
      const x = (i / (buf.length - 1)) * w;
      const y = (buf[i] / 255) * h;
      i ? sctx.lineTo(x, y) : sctx.moveTo(x, y);
    }
    sctx.stroke();
  };

  // ── share ─────────────────────────────────────────────────────────────────
  $('[data-share]').addEventListener('click', async () => {
    const loops = engine.ready ? await engine.dump() : [];
    // the audio thread knows the truth; if it did not answer, use what the tapes last showed
    const data = loops.length ? loops : state.loops;
    const url = `${location.origin}/organismo/#o=${encode(state.p, cables.cables, data)}`;
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      toast('Share link copied. It holds every knob, every cable and every loop.');
    } catch {
      toast('The link is in the address bar.');
    }
  });

  // ── recording: the master bus, to WAV takes ─────────────────────────────────
  const takesHost = document.querySelector<HTMLElement>('[data-org-takes]');
  const takes = takesHost
    ? takesList(takesHost, {
        file: 'organismo',
        info: { title: 'Organismo 23', artist: 'gpojani.me', software: 'Organismo 23, gpojani.me/organismo', date: new Date().toISOString().slice(0, 10) },
        empty: 'no takes yet: press ● record',
      })
    : null;
  const recBtn = $<HTMLButtonElement>('[data-rec]');
  const recTime = $('[data-rec-time]');
  let recording = false;
  let takeN = 0;
  let recTimer = 0;
  recBtn.addEventListener('click', async () => {
    if (!recording && (!engine.ready || !on)) await power();
    if (!engine.ready) return;
    const tap = await engine.recorder();
    if (recording) {
      recording = false;
      clearInterval(recTimer);
      const channels = await tap.stop();
      recBtn.setAttribute('aria-pressed', 'false');
      recTime.textContent = '';
      if (channels[0]?.length) {
        takes?.add(makeTake(channels, engine.ctx!.sampleRate, `take ${++takeN}`, `organismo · ${cables.cables.length} cables`));
        toast('Take kept under the machine: play it, or download it as WAV.');
      }
      return;
    }
    recording = true;
    tap.start();
    recBtn.setAttribute('aria-pressed', 'true');
    recTimer = window.setInterval(() => (recTime.textContent = fmtTime(tap.seconds)), 100);
  });

  // ── keyboard ──────────────────────────────────────────────────────────────
  // 1–4 add, 5–8 del, 9 l, 0 m, - bank, = rst, space power; the letters are a MIDI keyboard
  const keyPad = (code: string): string | null => {
    const m = /^Digit([0-9])$/.exec(code);
    if (m) {
      const d = Number(m[1]);
      return d >= 1 && d <= 4 ? `add${d - 1}` : d >= 5 && d <= 8 ? `del${d - 5}` : d === 9 ? 'rcL' : 'rcM';
    }
    return code === 'Minus' ? 'rcBANK' : null;
  };
  const padSend = (key: string) => {
    if (key.startsWith('add')) return sendAdd(Number(key.slice(3)));
    if (key.startsWith('del')) return sendDel(Number(key.slice(3)));
    const b = key.slice(2) as 'L' | 'M' | 'BANK';
    return (d: boolean) => engine.rc(b, d);
  };
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!document.body.contains(root) || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || document.querySelector('dialog[open]')) return;
    const eat = () => {
      e.preventDefault();
      e.stopPropagation(); // the site's own shortcuts (g, j, k, m, c …) must not fire for an instrument key
    };
    if (e.code === 'Space') {
      if (down && !t.closest('button, [role=slider], [role=button], [role=radio]')) {
        eat();
        void power();
      }
      return;
    }
    const pad = keyPad(e.code);
    if (pad) {
      eat();
      if (!e.repeat) press(pad, padEls.get(pad) ?? null, padSend(pad), down);
      return;
    }
    if (e.code === 'Equal') {
      eat();
      if (down && !e.repeat) rst();
      return;
    }
    if (midi.key(e, down)) eat();
  };
  const kd = onKey(true);
  const ku = onKey(false);
  addEventListener('keydown', kd, { capture: true });
  addEventListener('keyup', ku, { capture: true });
  addEventListener('blur', releaseAll);
  document.addEventListener(
    'astro:before-swap',
    () => {
      removeEventListener('keydown', kd, { capture: true });
      removeEventListener('keyup', ku, { capture: true });
      removeEventListener('blur', releaseAll);
      cancelAnimationFrame(raf);
      clearInterval(recTimer);
      midi.panic();
      takes?.dispose();
      engine.dispose();
    },
    { once: true },
  );

  refreshAll();
  setOn(false);
  status.textContent = 'press power or space, then clip two pins together';
  if (shared) toast('Loaded a shared patch: press power to hear it.');
  // dev handle, so the page can be driven from the console
  (root as unknown as { __org: unknown }).__org = { state, cables, engine, defaults, load: loadPreset };
}
