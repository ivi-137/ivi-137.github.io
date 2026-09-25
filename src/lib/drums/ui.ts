import { DEFAULT, STEPS, Tamburo, decode, encode, type State, type Tick } from './engine';
import { firstRow } from '../sigil';
import { toast } from '../ui/nav';
import { fmtTime, makeTake, takesList } from '../audio/recorder';

const clone = (s: State): State => JSON.parse(JSON.stringify(s));

export function mountDrums() {
  const root = document.querySelector<HTMLElement>('[data-tamburo]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;

  const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
  const state = (fromHash && decode(fromHash)) || clone(DEFAULT);
  const machine = new Tamburo(state);
  let feed = false;

  // ── knobs ───────────────────────────────────────────────────────────────
  type KnobEl = HTMLElement & { set?: (v: number, emit?: boolean) => void };
  const read = (bind: string): number => {
    const [scope, a, b] = bind.split('.');
    return scope === 'global' ? (state.global as any)[a] : (state.tracks[Number(a)] as any)[b];
  };
  const write = (bind: string, v: number) => {
    const [scope, a, b] = bind.split('.');
    if (scope === 'global') (state.global as any)[a] = v;
    else (state.tracks[Number(a)] as any)[b] = v;
    if (scope === 'global') machine.applyGlobal();
  };
  const fmt = (el: HTMLElement, v: number) => {
    switch (el.dataset.format) {
      case 'bpm':
        return `${Math.round(v)}`;
      case 'int':
        return `${Math.round(v)}`;
      case 'roll':
        return v ? `×${v + 1}` : '·';
      default:
        return `${Math.round(v * 100)}`;
    }
  };
  root.querySelectorAll<KnobEl>('[data-knob]').forEach((el) => {
    const min = Number(el.dataset.min), max = Number(el.dataset.max), step = Number(el.dataset.step);
    const bind = el.dataset.knob!;
    const valueEl = el.querySelector<HTMLElement>('[data-knob-value]')!;
    const pointer = el.querySelector('.knob__pointer')!;
    el.set = (v: number, emit = true) => {
      v = Math.min(max, Math.max(min, Math.round(v / step) * step));
      // the SVG's user origin is the knob's centre, so rotate() pivots exactly there
      pointer.setAttribute('transform', `rotate(${-135 + ((v - min) / (max - min)) * 270})`);
      el.setAttribute('aria-valuenow', String(v));
      el.setAttribute('aria-valuetext', fmt(el, v));
      valueEl.textContent = fmt(el, v);
      if (emit) write(bind, v);
    };
    el.set(read(bind), false);
    let drag: { y: number; v: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      drag = { y: e.clientY, v: read(bind) };
      el.setPointerCapture(e.pointerId);
      el.classList.add('is-turning');
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const range = max - min;
      el.set!(drag.v + ((drag.y - e.clientY) / (e.shiftKey ? 600 : 160)) * range);
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
        el.set!(read(bind) - Math.sign(e.deltaY) * Math.max(step, (max - min) / 50));
      },
      { passive: false },
    );
    el.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      el.set!(read(bind) + d * Math.max(step, (max - min) / (e.shiftKey ? 100 : 20)));
    });
    el.addEventListener('dblclick', () => el.set!(readDefault(bind))); // double-click resets
  });
  function readDefault(bind: string) {
    const [scope, a, b] = bind.split('.');
    return scope === 'global' ? (DEFAULT.global as any)[a] : (DEFAULT.tracks[Number(a)] as any)[b];
  }

  // ── pads & row controls ─────────────────────────────────────────────────
  const syncPads = () => {
    root.querySelectorAll<HTMLButtonElement>('[data-pad]').forEach((p) => {
      const [r, s] = p.dataset.pad!.split('.').map(Number);
      p.setAttribute('aria-pressed', String(!!state.tracks[r].steps[s]));
    });
    root.querySelectorAll<HTMLButtonElement>('[data-drum-ca]').forEach((b) => b.setAttribute('aria-pressed', String(state.tracks[Number(b.dataset.drumCa)].ca)));
    root.querySelectorAll<HTMLButtonElement>('[data-drum-mute]').forEach((b) => b.setAttribute('aria-pressed', String(state.tracks[Number(b.dataset.drumMute)].mute)));
    root.querySelectorAll<HTMLSelectElement>('[data-drum-rule]').forEach((s) => {
      const rule = state.tracks[Number(s.dataset.drumRule)].rule;
      if (![...s.options].some((o) => Number(o.value) === rule)) s.add(new Option(String(rule), String(rule)));
      s.value = String(rule);
    });
  };
  root.querySelectorAll<HTMLButtonElement>('[data-pad]').forEach((p) =>
    p.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const [r, s] = p.dataset.pad!.split('.').map(Number);
      const tr = state.tracks[r];
      tr.steps[s] = tr.steps[s] ? 0 : 1;
      p.setAttribute('aria-pressed', String(!!tr.steps[s]));
      if (tr.steps[s] && !machine.playing) machine.hit(r);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-pad]').forEach((p) =>
    p.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      p.dispatchEvent(new PointerEvent('pointerdown'));
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-drum-hit]').forEach((b) => b.addEventListener('click', () => machine.hit(Number(b.dataset.drumHit))));
  root.querySelectorAll<HTMLButtonElement>('[data-drum-ca]').forEach((b) =>
    b.addEventListener('click', () => {
      const tr = state.tracks[Number(b.dataset.drumCa)];
      tr.ca = !tr.ca;
      b.setAttribute('aria-pressed', String(tr.ca));
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-drum-mute]').forEach((b) =>
    b.addEventListener('click', () => {
      const tr = state.tracks[Number(b.dataset.drumMute)];
      tr.mute = !tr.mute;
      b.setAttribute('aria-pressed', String(tr.mute));
    }),
  );
  root.querySelectorAll<HTMLSelectElement>('[data-drum-rule]').forEach((s) =>
    s.addEventListener('change', () => (state.tracks[Number(s.dataset.drumRule)].rule = Number(s.value))),
  );
  machine.onBar(() => requestAnimationFrame(syncPads));

  // ── transport ───────────────────────────────────────────────────────────
  const playBtn = $<HTMLButtonElement>('[data-drum-play]');
  const toggle = async () => {
    if (machine.playing) machine.stop();
    else await machine.start();
    playBtn.setAttribute('aria-pressed', String(machine.playing));
    $('[data-drum-play-label]').textContent = machine.playing ? 'stop' : 'play';
    if (machine.playing) drawLoop();
  };
  playBtn.addEventListener('click', toggle);

  // ── playhead: draw each step when the audio clock reaches it ──────────────
  const pending: Tick[] = [];
  const leds = [...root.querySelectorAll<HTMLElement>('[data-led]')];
  const pads = [...root.querySelectorAll<HTMLElement>('[data-pad]')];
  machine.onTick((t) => pending.push(t));
  const scope = $<HTMLCanvasElement>('[data-drum-scope]');
  const sctx = scope.getContext('2d')!;
  let buf: Uint8Array<ArrayBuffer> | null = null;
  let raf = 0;
  function drawLoop() {
    cancelAnimationFrame(raf);
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const ctx = machine.ctx;
      if (!ctx) return;
      while (pending.length && pending[0].time <= ctx.currentTime) {
        const t = pending.shift()!;
        leds.forEach((l, i) => l.classList.toggle('is-on', i === t.step));
        pads.forEach((p) => {
          const [r, s] = p.dataset.pad!.split('.').map(Number);
          p.classList.toggle('is-col', s === t.step);
          if (s === t.step && t.fired[r]) {
            p.classList.remove('is-hit');
            void p.offsetWidth; // restart the flash animation
            p.classList.add('is-hit');
          }
        });
        if (feed && t.fired[0]) {
          const life = (window as any).__life;
          life?.dropAt(Math.random() * innerWidth, Math.random() * innerHeight, 'glider');
        }
      }
      // scope: the master bus, drawn as an ink line
      const w = (scope.width = scope.clientWidth * 2), h = (scope.height = scope.clientHeight * 2);
      buf ??= new Uint8Array(machine.analyser.fftSize);
      machine.analyser.getByteTimeDomainData(buf);
      sctx.clearRect(0, 0, w, h);
      sctx.strokeStyle = '#16140f';
      sctx.lineWidth = 2.2;
      sctx.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const x = (i / (buf.length - 1)) * w, y = (buf[i] / 255) * h;
        i ? sctx.lineTo(x, y) : sctx.moveTo(x, y);
      }
      sctx.stroke();
      if (!machine.playing && !pending.length) {
        leds.forEach((l) => l.classList.remove('is-on'));
        pads.forEach((p) => p.classList.remove('is-col'));
      }
    };
    raf = requestAnimationFrame(frame);
  }

  // ── actions ─────────────────────────────────────────────────────────────
  $('[data-drum-random]').addEventListener('click', () => {
    const seed = `${Date.now()}`;
    state.tracks.forEach((tr, i) => {
      const row = firstRow(seed + i, 30, STEPS);
      tr.steps = Array.from(row);
      if (i === 0 && !tr.steps.some(Boolean)) tr.steps[0] = 1;
    });
    syncPads();
  });
  $('[data-drum-clear]').addEventListener('click', () => {
    state.tracks.forEach((tr) => (tr.steps = Array(STEPS).fill(0)));
    syncPads();
  });
  $('[data-drum-share]').addEventListener('click', async () => {
    const url = `${location.origin}/drums/#t=${encode(state)}`;
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      toast('Share link copied. It holds the whole machine: steps, knobs, rules.');
    } catch {
      toast('The link is in the address bar.');
    }
  });
  const feedBtn = $<HTMLButtonElement>('[data-drum-feed]');
  feedBtn.addEventListener('click', () => {
    feed = !feed;
    feedBtn.setAttribute('aria-pressed', String(feed));
    if (feed) toast('Every kick now drops a glider into the colony behind the page.');
  });

  // ── recording: the master bus, to WAV takes ─────────────────────────────────
  const takesHost = document.querySelector<HTMLElement>('[data-drum-takes]');
  const takes = takesHost
    ? takesList(takesHost, {
        file: 'tamburo-8',
        info: { title: 'Tamburo 8', artist: 'gpojani.me', software: 'Tamburo 8, gpojani.me/drums', date: new Date().toISOString().slice(0, 10) },
        empty: 'no takes yet: press ● registra',
      })
    : null;
  const recBtn = $<HTMLButtonElement>('[data-drum-rec]');
  const recTime = $('[data-drum-rec-time]');
  let takeN = 0;
  let recTimer = 0;
  recBtn.addEventListener('click', async () => {
    const tap = await machine.recorder();
    if (tap.recording) {
      clearInterval(recTimer);
      const channels = await tap.stop();
      recBtn.setAttribute('aria-pressed', 'false');
      recTime.textContent = '';
      if (channels[0]?.length) {
        takes?.add(makeTake(channels, machine.ctx!.sampleRate, `ripresa ${++takeN}`, 'tamburo'));
        toast('Take kept under the machine: play it, or download it as WAV.');
      }
      return;
    }
    if (!machine.playing) await toggle();
    tap.start();
    recBtn.setAttribute('aria-pressed', 'true');
    recTimer = window.setInterval(() => (recTime.textContent = fmtTime(tap.seconds)), 100);
  });

  // ── keyboard: space = play, 1–6 = audition ─────────────────────────────────
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!document.body.contains(root) || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || document.querySelector('dialog[open]')) return;
    if (e.key === ' ' && !t.closest('button, [role=slider]')) {
      e.preventDefault();
      toggle();
    } else if (/^[1-6]$/.test(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation(); // don't also switch the background colony's rule
      machine.hit(Number(e.key) - 1);
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
      machine.dispose();
    },
    { once: true },
  );
  syncPads();
}
