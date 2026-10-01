/**
 * The GUZEN panel: knobs, selectors and switches bound to the parameter table, the transport, the scope, the
 * lamps for each agent's gate, the strip that shows the 48 bits of the dice, share links, MIDI and recording.
 */
import { Engine } from './engine';
import { PARAMS, PIDX, SEED_MAX, format, fromNorm, parseSeed, seedHex, snap, spec, toNorm, type Mon } from './params';
import { presetValues } from './presets';
import { Midi } from '../synth/midi';
import { toast } from '../ui/nav';
import { fmtTime, makeTake, takesList } from '../audio/recorder';

const DEFAULT_PRESET = 8; // Temple

const randomSeed = () => Math.floor(Math.random() * SEED_MAX);

// ── share links ─────────────────────────────────────────────────────────────

const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

function encode(p: Float64Array, seed: number) {
  return b64(JSON.stringify({ v: 1, s: seedHex(seed), p: Array.from(p, (x) => Math.round(x * 1e5) / 1e5) }));
}

function decode(s: string): { p: Float64Array; seed: number } | null {
  try {
    const o = JSON.parse(unb64(s));
    if (o?.v !== 1 || !Array.isArray(o.p) || o.p.length !== PARAMS.length) return null;
    const p = Float64Array.from(o.p, (x: unknown, i: number) => snap(PARAMS[i], Number(x)));
    return p.every(Number.isFinite) ? { p, seed: parseSeed(String(o.s)) } : null;
  } catch {
    return null;
  }
}

// ── the panel ───────────────────────────────────────────────────────────────

export function mountGuzen() {
  const root = document.querySelector<HTMLElement>('[data-guzen]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const engine = new Engine();

  const fromHash = new URLSearchParams(location.hash.slice(1)).get('g');
  const shared = fromHash ? decode(fromHash) : null;
  const state = {
    p: shared?.p ?? presetValues(DEFAULT_PRESET),
    seed: shared?.seed ?? randomSeed(),
    preset: shared ? -1 : DEFAULT_PRESET,
  };

  const presetSel = $<HTMLSelectElement>('[data-preset]');
  const seedInput = $<HTMLInputElement>('[data-gz-seed]');

  // ── one place for every change ────────────────────────────────────────────
  const shows = new Map<string, () => void>();
  const refresh = (id: string) => shows.get(id)?.();
  const sync = () => engine.ready && engine.sync(state.p, state.seed);

  /** The player turned something: write it, tell the audio thread, and the patch is no longer a preset. */
  function change(id: string, v: number) {
    const s = spec(id);
    const i = PIDX[id];
    v = snap(s, v);
    if (v === state.p[i]) return;
    state.p[i] = v;
    if (engine.ready) engine.param(i, v);
    refresh(id);
    if (state.preset !== -1) {
      state.preset = -1;
      presetSel.value = '-1';
    }
  }

  // ── knobs: they turn in a 0–1 space, and the table maps that to the real value ─────────
  root.querySelectorAll<HTMLElement>('[data-knob]').forEach((el) => {
    const id = el.dataset.knob!;
    const s = spec(id);
    const i = PIDX[id];
    const valueEl = el.querySelector<HTMLElement>('[data-knob-value]')!;
    const pointer = el.querySelector('.knob__pointer')!;
    const show = () => {
      const v = state.p[i];
      const n = toNorm(s, v);
      const text = format(s, v);
      pointer.setAttribute('transform', `rotate(${-135 + n * 270})`);
      el.setAttribute('aria-valuenow', String(Math.round(n * 1000) / 1000));
      el.setAttribute('aria-valuetext', text);
      valueEl.textContent = text;
    };
    shows.set(id, show);
    // whole-number knobs move one step at a time, continuous ones in fractions of a turn
    const stepN = s.kind === 'float' ? 0.04 : 1 / (s.max - s.min);
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
        change(id, fromNorm(s, toNorm(s, state.p[i]) - Math.sign(e.deltaY) * (e.shiftKey ? stepN / 4 : stepN / (s.kind === 'float' ? 2 : 1))));
      },
      { passive: false },
    );
    el.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      change(id, fromNorm(s, toNorm(s, state.p[i]) + d * (e.shiftKey ? stepN / 4 : stepN)));
    });
    el.addEventListener('dblclick', () => change(id, s.def)); // double-click resets
  });

  // ── selectors and switches ────────────────────────────────────────────────
  root.querySelectorAll<HTMLSelectElement>('[data-sel]').forEach((sel) => {
    const id = sel.dataset.sel!;
    shows.set(id, () => (sel.value = String(state.p[PIDX[id]])));
    sel.addEventListener('change', () => change(id, Number(sel.value)));
  });
  root.querySelectorAll<HTMLButtonElement>('[data-flag]').forEach((b) => {
    const id = b.dataset.flag!;
    shows.set(id, () => b.setAttribute('aria-pressed', String(state.p[PIDX[id]] > 0.5)));
    b.addEventListener('click', () => change(id, state.p[PIDX[id]] > 0.5 ? 0 : 1));
  });

  const refreshAll = () => {
    shows.forEach((show) => show());
    presetSel.value = String(state.preset);
    seedInput.value = seedHex(state.seed);
  };

  // ── presets and seeds ─────────────────────────────────────────────────────
  presetSel.addEventListener('change', () => {
    const n = Number(presetSel.value);
    if (n < 0) return;
    state.p.set(presetValues(n));
    state.preset = n;
    refreshAll();
    sync(); // a preset always starts from the beginning, on the current seed
  });
  const setSeed = (n: number) => {
    state.seed = n;
    seedInput.value = seedHex(n);
    if (engine.ready) engine.restart(n);
    else bits.draw(Math.floor(n / 16777216), n % 16777216);
  };
  seedInput.addEventListener('change', () => setSeed(parseSeed(seedInput.value)));
  seedInput.addEventListener('keydown', (e) => e.key === 'Enter' && seedInput.blur());
  $('[data-restart]').addEventListener('click', () => setSeed(state.seed));
  $('[data-reroll]').addEventListener('click', () => setSeed(randomSeed()));

  // ── the dice: 48 cells, one per bit of the generator's state ──────────────────────────
  const bitsCanvas = $<HTMLCanvasElement>('[data-bits]');
  const bits = {
    ctx: bitsCanvas.getContext('2d')!,
    draw(hi: number, lo: number) {
      const w = (bitsCanvas.width = bitsCanvas.clientWidth * 2 || 480);
      const h = (bitsCanvas.height = bitsCanvas.clientHeight * 2 || 40);
      const cw = w / 48;
      this.ctx.clearRect(0, 0, w, h);
      for (let k = 0; k < 48; k++) {
        const on = k < 24 ? (hi >> (23 - k)) & 1 : (lo >> (47 - k)) & 1;
        this.ctx.fillStyle = on ? '#16140f' : 'rgba(22,20,15,0.12)';
        this.ctx.fillRect(k * cw + 1, 2, Math.max(1, cw - 2), h - 4);
      }
    },
  };

  // ── monitor: lamps, dice, scope ───────────────────────────────────────────
  const lamps = [...root.querySelectorAll<HTMLElement>('[data-lamp]')];
  const act = new Float64Array(lamps.length);
  let hi = 0;
  let lo = 0;
  engine.onMon = (m: Mon) => {
    m.act.forEach((a, i) => (act[i] = a));
    hi = m.hi;
    lo = m.lo;
  };
  const scope = $<HTMLCanvasElement>('[data-scope]');
  const sctx = scope.getContext('2d')!;
  let buf: Uint8Array<ArrayBuffer> | null = null;
  let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    lamps.forEach((l, i) => l.style.setProperty('--on', act[i].toFixed(3)));
    bits.draw(hi, lo);
    if (!engine.ready) return;
    const w = (scope.width = scope.clientWidth * 2);
    const h = (scope.height = scope.clientHeight * 2);
    buf ??= new Uint8Array(engine.analyser.fftSize);
    engine.analyser.getByteTimeDomainData(buf);
    sctx.clearRect(0, 0, w, h);
    sctx.strokeStyle = '#16140f';
    sctx.lineWidth = 2.2;
    sctx.beginPath();
    for (let i = 0; i < buf.length; i++) {
      const x = (i / (buf.length - 1)) * w;
      const y = (buf[i] / 255) * h;
      i ? sctx.lineTo(x, y) : sctx.moveTo(x, y);
    }
    sctx.stroke();
  };

  // ── transport ─────────────────────────────────────────────────────────────
  const playBtn = $<HTMLButtonElement>('[data-play]');
  const status = $('[data-status]');
  let playing = false;
  const setPlaying = (on: boolean) => {
    playing = on;
    playBtn.setAttribute('aria-pressed', String(on));
    $('[data-play-label]').textContent = on ? 'pause' : 'play';
    status.textContent = on ? 'the dice are rolling' : 'paused: the dice are held where they stopped';
    cancelAnimationFrame(raf);
    if (on) raf = requestAnimationFrame(frame);
  };
  const toggle = async () => {
    if (!engine.ready) {
      status.textContent = 'waking the audio thread…';
      try {
        await engine.boot(state.p, state.seed);
        await engine.resume();
      } catch {
        status.textContent = 'this browser could not start the audio thread';
        return;
      }
      setPlaying(true);
    } else if (playing) {
      await engine.suspend();
      setPlaying(false);
    } else {
      await engine.resume();
      setPlaying(true);
    }
  };
  playBtn.addEventListener('click', toggle);

  // ── actions ───────────────────────────────────────────────────────────────
  $('[data-share]').addEventListener('click', async () => {
    const url = `${location.origin}/guzen/#g=${encode(state.p, state.seed)}`;
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      toast('Share link copied. It holds every knob and the seed, so it plays the same piece.');
    } catch {
      toast('The link is in the address bar.');
    }
  });

  const midiBtn = $<HTMLButtonElement>('[data-midi]');
  let midi: Midi | null = null;
  midiBtn.addEventListener('click', async () => {
    if (!Midi.supported) return toast('This browser has no Web MIDI.');
    midi ??= new Midi({
      note: (on, note) => on && change('root', note % 12),
      cc() {},
      clock() {},
      start() {},
      stop() {},
    });
    try {
      const access = await midi.enable();
      midiBtn.setAttribute('aria-pressed', 'true');
      toast(access.inputs.size ? 'MIDI on. A note sets the root of the scale; the dice play in that key.' : 'MIDI is on, but no input was found.');
    } catch {
      toast('MIDI access was refused.');
    }
  });

  // ── recording: the master bus, to WAV takes ─────────────────────────────────
  const takesHost = document.querySelector<HTMLElement>('[data-gz-takes]');
  const takes = takesHost
    ? takesList(takesHost, {
        file: 'guzen',
        info: { title: 'Guzen', artist: 'gpojani.me', software: 'Guzen, gpojani.me/guzen', date: new Date().toISOString().slice(0, 10) },
        empty: 'no takes yet: press ● record',
      })
    : null;
  const recBtn = $<HTMLButtonElement>('[data-rec]');
  const recTime = $('[data-rec-time]');
  let recording = false;
  let takeN = 0;
  let recTimer = 0;
  recBtn.addEventListener('click', async () => {
    if (!recording && (!engine.ready || !playing)) await toggle();
    if (!engine.ready) return;
    const tap = await engine.recorder();
    if (recording) {
      recording = false;
      clearInterval(recTimer);
      const channels = await tap.stop();
      recBtn.setAttribute('aria-pressed', 'false');
      recTime.textContent = '';
      if (channels[0]?.length) {
        takes?.add(makeTake(channels, engine.ctx!.sampleRate, `take ${++takeN}`, `guzen · seed ${seedHex(state.seed)}`));
        toast('Take kept under the machine: play it, or download it as WAV.');
      }
      return;
    }
    recording = true;
    tap.start();
    recBtn.setAttribute('aria-pressed', 'true');
    recTimer = window.setInterval(() => (recTime.textContent = fmtTime(tap.seconds)), 100);
  });

  // ── keyboard: space = play / pause ────────────────────────────────────────
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!document.body.contains(root) || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || document.querySelector('dialog[open]')) return;
    if (e.key === ' ' && !t.closest('button, [role=slider]')) {
      e.preventDefault();
      toggle();
    }
  };
  addEventListener('keydown', onKey, { capture: true });
  document.addEventListener(
    'astro:before-swap',
    () => {
      removeEventListener('keydown', onKey, { capture: true });
      cancelAnimationFrame(raf);
      clearInterval(recTimer);
      takes?.dispose();
      engine.dispose();
    },
    { once: true },
  );

  refreshAll();
  bits.draw(Math.floor(state.seed / 16777216), state.seed % 16777216);
  if (shared) toast('Loaded a shared patch: press play to hear the same piece.');
}
