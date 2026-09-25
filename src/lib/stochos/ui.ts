import { CONDS, Engine, MAX_STEPS, SPEEDS, emptyPattern, emptyStep, initial, trackColor, type Pattern, type State, type Step } from './engine';
import { brownian, draw, euclid, fibonacciWord, logistic, markovRemix, poissonOnsets, sieve, snapToSieve, type Dist } from './math';
import { Midi } from '../synth/midi';
import { toast } from '../ui/nav';

const KEY = 'stochos:v1';
const LO = 24, HI = 108;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const NOTE = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const nn = (n: number) => `${NOTE[n % 12]}${Math.floor(n / 12) - 1}`;

function loadState(): State {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s?.pats?.length === 16 && s.tracks?.length === 8) return s;
  } catch {
    /* ignore */
  }
  return initial();
}

export function mountStochos() {
  const root = document.querySelector<HTMLElement>('[data-stochos]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  const $ = <T extends HTMLElement>(q: string) => root.querySelector<T>(q)!;
  const $$ = <T extends HTMLElement>(q: string) => [...root.querySelectorAll<T>(q)];

  const s = loadState();
  let sel = 0;
  let lane = 'vel';
  let recPos = -1;
  let clip: Pattern | null = null;
  const undo: Array<{ pat: number; track: number; steps: Step[] }> = [];
  const last = Array(8).fill(-1);

  const midi: Midi = new Midi({
    note: (on, note, vel) => {
      if (!on) return;
      if (recPos >= 0) {
        snapshot();
        Object.assign(steps()[recPos], { on: true, note, vel: Math.max(0.1, vel) });
        recPos = (recPos + 1) % tr().len;
        paint();
      }
      eng.audition(sel, note, vel);
    },
    cc: () => {},
    clock: () => eng.clockIn(),
    start: () => eng.extClock && !eng.playing && togglePlay(),
    stop: () => eng.extClock && eng.playing && togglePlay(),
  });
  const eng: Engine = new Engine(s, midi);

  const pat = () => s.pats[s.cur];
  const tr = () => s.tracks[sel];
  const steps = () => pat().steps[sel];
  const allowed = (i: number) => {
    const e = s.tracks[i].sieve;
    if (!e) return null;
    try {
      return sieve(e, 128);
    } catch {
      return null;
    }
  };
  const snap = (i: number, note: number) => {
    const a = allowed(i);
    return clamp(a ? snapToSieve(Math.round(note), a) : Math.round(note), 0, 127);
  };
  let saveTimer = 0;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(s));
      } catch {
        /* private mode: the session still works */
      }
    }, 600);
  };
  const snapshot = () => {
    undo.push({ pat: s.cur, track: sel, steps: clone(steps()) });
    if (undo.length > 40) undo.shift();
  };

  // ── the page (UPIC) ──────────────────────────────────────────────────────
  const page = $<HTMLCanvasElement>('[data-page]');
  const lanecv = $<HTMLCanvasElement>('[data-lanecv]');
  const view = () => Math.min(MAX_STEPS, Math.max(s.master, tr().len));
  const size = (c: HTMLCanvasElement, h: number) => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = c.clientWidth;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.height = `${h}px`;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  };
  let stroke: Array<[number, number]> = [];

  const paint = () => {
    const H = innerWidth < 700 ? 300 : 440;
    const { g, w, h } = size(page, H);
    const cols = view(), rows = HI - LO;
    const cw = w / cols, rh = h / rows;
    const X = (i: number) => i * cw, Y = (n: number) => (HI - n) * rh;
    // graph paper
    g.fillStyle = '#f4f1e6';
    g.fillRect(0, 0, w, h);
    for (let n = LO; n <= HI; n++) {
      g.strokeStyle = n % 12 === 0 ? 'rgba(58,110,165,0.45)' : 'rgba(58,110,165,0.09)';
      g.lineWidth = n % 12 === 0 ? 1 : 0.5;
      g.beginPath();
      g.moveTo(0, Y(n) + 0.5);
      g.lineTo(w, Y(n) + 0.5);
      g.stroke();
      if (n % 12 === 0) {
        g.fillStyle = 'rgba(58,110,165,0.8)';
        g.font = '9px "JetBrains Mono", monospace';
        g.fillText(nn(n), 2, Y(n) - 2);
      }
    }
    for (let i = 0; i <= cols; i++) {
      g.strokeStyle = i % 16 === 0 ? 'rgba(58,110,165,0.6)' : i % 4 === 0 ? 'rgba(58,110,165,0.28)' : 'rgba(58,110,165,0.1)';
      g.lineWidth = i % 16 === 0 ? 1.2 : 0.5;
      g.beginPath();
      g.moveTo(X(i) + 0.5, 0);
      g.lineTo(X(i) + 0.5, h);
      g.stroke();
      if (i % 16 === 0 && i < cols) {
        g.fillStyle = '#c0392b';
        g.font = '9px "JetBrains Mono", monospace';
        g.fillText(String(i / 16 + 1), X(i) + 3, 10);
      }
    }
    // the tracks: ruled lines between successive notes, then the notes
    const order = [...Array(8).keys()].filter((i) => i !== sel).concat(sel);
    for (const ti of order) {
      const t = s.tracks[ti];
      const st = pat().steps[ti];
      const mine = ti === sel;
      g.globalAlpha = mine ? 1 : 0.22;
      g.strokeStyle = g.fillStyle = trackColor(ti);
      let prev: [number, number] | null = null;
      for (let i = 0; i < cols; i++) {
        const k = i % Math.max(1, t.len);
        const x = st[k];
        if (!x.on) continue;
        const ghost = i >= t.len;
        const cx = X(i), cy = Y(x.note);
        if (prev && mine) {
          g.globalAlpha = ghost ? 0.15 : 0.35;
          g.lineWidth = 0.8;
          g.beginPath();
          g.moveTo(prev[0], prev[1]);
          g.lineTo(cx, cy + rh / 2);
          g.stroke();
        }
        g.globalAlpha = mine ? (ghost ? 0.3 : 0.55 + x.vel * 0.45) : 0.22;
        g.fillRect(cx + 0.5, cy + 0.5, Math.max(2, x.len * cw - 1), Math.max(2, rh - 1));
        prev = [cx + Math.max(2, x.len * cw), cy + rh / 2];
      }
      // playhead
      if (eng.playing && last[ti] >= 0) {
        g.globalAlpha = mine ? 0.9 : 0.35;
        g.fillStyle = mine ? '#c0392b' : trackColor(ti);
        g.fillRect(X(last[ti]), 0, mine ? 2 : 1, h);
      }
    }
    g.globalAlpha = 1;
    if (stroke.length > 1) {
      g.strokeStyle = '#c0392b';
      g.lineWidth = 1.5;
      g.setLineDash([4, 3]);
      g.beginPath();
      stroke.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
      g.setLineDash([]);
    }
    paintLane();
    info();
  };

  const at = (e: PointerEvent) => {
    const r = page.getBoundingClientRect();
    const cols = view(), rows = HI - LO;
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return { x, y, step: clamp(Math.floor((x / r.width) * cols), 0, cols - 1), note: clamp(Math.round(HI - (y / r.height) * rows), LO, HI) };
  };
  let dragMode: 'draw' | 'erase' | 'line' | null = null;
  let start = { step: 0, note: 60 }, lastStep = -1, lastNote = 60, moved = false;
  const setStep = (i: number, note: number) => {
    if (i >= tr().len) return;
    Object.assign(steps()[i], { on: true, note: snap(sel, note) });
  };
  page.addEventListener('pointerdown', (e) => {
    const p = at(e);
    snapshot();
    dragMode = e.shiftKey || e.button === 2 ? 'erase' : e.altKey ? 'line' : 'draw';
    start = p;
    lastStep = p.step;
    lastNote = p.note;
    moved = false;
    stroke = [[p.x, p.y]];
    page.setPointerCapture(e.pointerId);
    if (dragMode === 'erase' && p.step < tr().len) steps()[p.step].on = false;
    paint();
  });
  page.addEventListener('pointermove', (e) => {
    if (!dragMode) return;
    const p = at(e);
    stroke.push([p.x, p.y]);
    if (p.step !== lastStep) moved = true;
    if (dragMode === 'draw' || dragMode === 'erase') {
      const a = Math.min(lastStep, p.step), b = Math.max(lastStep, p.step);
      for (let i = a; i <= b; i++) {
        const tt = b === a ? 1 : (i - lastStep) / (p.step - lastStep);
        if (dragMode === 'draw') setStep(i, lastNote + (p.note - lastNote) * tt);
        else if (i < tr().len) steps()[i].on = false;
      }
      lastStep = p.step;
      lastNote = p.note;
    }
    paint();
  });
  page.addEventListener('pointerup', (e) => {
    const p = at(e);
    if (dragMode === 'line') {
      const a = Math.min(start.step, p.step), b = Math.max(start.step, p.step);
      for (let i = a; i <= b; i++) setStep(i, start.note + ((p.note - start.note) * (i - start.step)) / (p.step - start.step || 1));
    } else if (dragMode === 'draw' && !moved) {
      const st = steps()[p.step];
      if (p.step < tr().len) {
        if (st.on && Math.abs(st.note - p.note) <= 1) st.on = false;
        else {
          setStep(p.step, p.note);
          eng.audition(sel, steps()[p.step].note, steps()[p.step].vel);
        }
      }
    }
    dragMode = null;
    stroke = [];
    paint();
    save();
  });
  page.addEventListener('contextmenu', (e) => e.preventDefault());

  // ── parameter lanes (p-locks) ─────────────────────────────────────────────
  const laneVal = (st: Step) =>
    lane === 'vel' ? st.vel : lane === 'len' ? st.len / 4 : lane === 'prob' ? st.prob : lane === 'micro' ? st.micro / 0.9 + 0.5 : lane === 'cc' ? (st.cc < 0 ? -1 : st.cc / 127) : 0;
  const setLane = (st: Step, v: number, clear: boolean) => {
    v = clamp(v, 0, 1);
    if (lane === 'vel') st.vel = Math.max(0.02, v);
    else if (lane === 'len') st.len = Math.max(0.1, Math.round(v * 40) / 10);
    else if (lane === 'prob') st.prob = v;
    else if (lane === 'micro') st.micro = Math.round((v - 0.5) * 0.9 * 100) / 100;
    else if (lane === 'cc') st.cc = clear ? -1 : Math.round(v * 127);
  };
  function paintLane() {
    const { g, w, h } = size(lanecv, 92);
    const cols = view(), cw = w / cols;
    g.fillStyle = '#ebe6d4';
    g.fillRect(0, 0, w, h);
    const st = steps();
    for (let i = 0; i < cols; i++) {
      const x = st[i % tr().len];
      const ghost = i >= tr().len;
      g.globalAlpha = ghost ? 0.25 : x.on ? 1 : 0.35;
      if (lane === 'cond') {
        g.fillStyle = x.cond ? '#c0392b' : 'rgba(22,20,15,0.35)';
        g.font = `${Math.min(10, cw * 0.8)}px "JetBrains Mono", monospace`;
        g.save();
        g.translate(i * cw + cw * 0.7, h - 4);
        g.rotate(-Math.PI / 2);
        g.fillText(CONDS[x.cond], 0, 0);
        g.restore();
        continue;
      }
      const v = laneVal(x);
      g.fillStyle = trackColor(sel);
      if (lane === 'micro') {
        const y0 = h / 2, y1 = h - v * h;
        g.fillRect(i * cw + 1, Math.min(y0, y1), Math.max(1, cw - 2), Math.abs(y1 - y0) || 1);
      } else if (v >= 0) g.fillRect(i * cw + 1, h - v * h, Math.max(1, cw - 2), v * h);
      else g.fillRect(i * cw + cw / 2 - 1, h - 3, 2, 2);
    }
    g.globalAlpha = 1;
  }
  let laneDrag = false;
  const laneAt = (e: PointerEvent) => {
    const r = lanecv.getBoundingClientRect();
    return { i: clamp(Math.floor(((e.clientX - r.left) / r.width) * view()), 0, view() - 1), v: 1 - (e.clientY - r.top) / r.height };
  };
  lanecv.addEventListener('pointerdown', (e) => {
    const p = laneAt(e);
    if (p.i >= tr().len) return;
    snapshot();
    if (lane === 'cond') {
      const st = steps()[p.i];
      st.cond = (st.cond + (e.shiftKey ? CONDS.length - 1 : 1)) % CONDS.length;
      paintLane();
      return save();
    }
    laneDrag = true;
    lanecv.setPointerCapture(e.pointerId);
    setLane(steps()[p.i], p.v, e.shiftKey);
    paintLane();
  });
  lanecv.addEventListener('pointermove', (e) => {
    if (!laneDrag) return;
    const p = laneAt(e);
    if (p.i < tr().len) setLane(steps()[p.i], p.v, e.shiftKey);
    paintLane();
  });
  lanecv.addEventListener('pointerup', () => ((laneDrag = false), save()));
  $$('[data-lane]').forEach((b) =>
    b.addEventListener('click', () => {
      lane = b.dataset.lane!;
      $$('[data-lane]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      paintLane();
    }),
  );

  // ── tracks ───────────────────────────────────────────────────────────────
  const trackList = $('[data-tracks]');
  const renderTracks = () => {
    trackList.replaceChildren(
      ...s.tracks.map((t, i) => {
        const li = document.createElement('li');
        li.className = `st-track${i === sel ? ' is-sel' : ''}`;
        li.style.setProperty('--c', trackColor(i));
        li.innerHTML = `<button type="button" class="st-track__pick" aria-label="Select track ${i + 1}">${i + 1}</button>
          <input class="st-track__name mono" value="" aria-label="Track name" />
          <label class="mono">ch<select data-k="ch">${[...Array(16).keys()].map((c) => `<option value="${c}">${c + 1}</option>`).join('')}</select></label>
          <label class="mono">len<input type="number" min="1" max="${MAX_STEPS}" data-k="len" /></label>
          <label class="mono">×<select data-k="speed">${SPEEDS.map((v, k) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="mono">CC<input type="number" min="0" max="127" data-k="cc" /></label>
          <button type="button" class="st-ms mono" data-ms="mute" aria-pressed="${t.mute}">M</button>
          <button type="button" class="st-ms mono" data-ms="solo" aria-pressed="${t.solo}">S</button>
          <span class="st-track__flags mono">${t.ca ? `CA ${t.ca}` : ''}${t.sieve ? ' ⋮sieve' : ''}</span>`;
        const name = li.querySelector<HTMLInputElement>('.st-track__name')!;
        name.value = t.name;
        name.addEventListener('change', () => ((t.name = name.value.slice(0, 16)), save()));
        li.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((el) => {
          const k = el.dataset.k as 'ch' | 'len' | 'speed' | 'cc';
          el.value = String(t[k]);
          el.addEventListener('change', () => {
            const lim = { ch: [0, 15], len: [1, MAX_STEPS], speed: [0, SPEEDS.length - 1], cc: [0, 127] }[k];
            t[k] = clamp(Math.round(Number(el.value)), lim[0], lim[1]);
            el.value = String(t[k]);
            paint();
            save();
          });
        });
        li.querySelectorAll<HTMLButtonElement>('[data-ms]').forEach((b) =>
          b.addEventListener('click', () => {
            const k = b.dataset.ms as 'mute' | 'solo';
            t[k] = !t[k];
            b.setAttribute('aria-pressed', String(t[k]));
            save();
          }),
        );
        li.querySelector('.st-track__pick')!.addEventListener('click', () => select(i));
        li.addEventListener('pointerdown', (e) => {
          if (!(e.target as HTMLElement).closest('input, select, button')) select(i);
        });
        return li;
      }),
    );
  };
  const select = (i: number) => {
    sel = i;
    renderTracks();
    paint();
  };

  // ── generators ───────────────────────────────────────────────────────────
  const gv = (k: string) => root.querySelector<HTMLInputElement>(`[data-g="${k}"]`)!.value;
  const gn = (k: string) => Number(gv(k));
  const gens: Record<string, () => void> = {
    sieve: () => {
      const g = sieve(gv('sieveExpr'), tr().len);
      steps().forEach((st, i) => i < tr().len && (st.on = g[i]));
    },
    pitchSieve: () => {
      sieve(gv('pitchSieve'), 12); // validate
      tr().sieve = gv('pitchSieve');
      steps().forEach((st) => (st.note = snap(sel, st.note)));
    },
    cloud: () => {
      const n = tr().len;
      const on = poissonOnsets((gn('lambda') * n) / 16, n);
      const d = gv('dist') as Dist;
      steps().forEach((st, i) => {
        if (i >= n) return;
        st.on = on[i];
        if (on[i]) {
          st.note = snap(sel, gn('center') + draw(d) * gn('spread'));
          st.vel = clamp(0.6 + draw('gaussian') * 0.15, 0.1, 1);
        }
      });
    },
    walk: () => {
      const lo = Math.min(gn('lo'), gn('hi')), hi = Math.max(gn('lo'), gn('hi'));
      const first = steps().find((x) => x.on)?.note ?? (lo + hi) / 2;
      const w = brownian(tr().len, clamp(first, lo, hi), gn('sigma'), lo, hi);
      steps().forEach((st, i) => i < w.length && (st.note = snap(sel, w[i])));
    },
    euclid: () => {
      const g = euclid(gn('k'), tr().len, gn('rot'));
      steps().forEach((st, i) => i < tr().len && (st.on = g[i]));
    },
    fib: () => {
      const g = fibonacciWord(tr().len, gn('rot'));
      steps().forEach((st, i) => i < tr().len && (st.on = g[i]));
    },
    logVel: () => logistic(tr().len, gn('r')).forEach((x, i) => (steps()[i].vel = 0.15 + 0.85 * x)),
    logProb: () => logistic(tr().len, gn('r')).forEach((x, i) => (steps()[i].prob = Math.round((0.2 + 0.8 * x) * 100) / 100)),
    markov: () => {
      const on = steps().slice(0, tr().len).filter((x) => x.on);
      const next = markovRemix(on.map((x) => x.note), on.length);
      on.forEach((x, i) => (x.note = next[i]));
    },
    ca: () => (tr().ca = clamp(Math.round(gn('caRule')), 0, 255)),
  };
  $$('[data-gen]').forEach((b) =>
    b.addEventListener('click', () => {
      snapshot();
      try {
        gens[b.dataset.gen!]();
      } catch (err) {
        return toast(`Sieve: ${(err as Error).message}`);
      }
      renderTracks();
      paint();
      save();
    }),
  );

  // ── toggles, transport, options ────────────────────────────────────────────
  const syncToggles = () => {
    $$('[data-toggle]').forEach((b) => b.setAttribute('aria-pressed', String(!!(s as any)[b.dataset.toggle!])));
    $$('[data-opt]').forEach((b) => b.setAttribute('aria-pressed', String(!!(eng as any)[b.dataset.opt!])));
    $$('[data-bind]').forEach((el) => ((el as HTMLInputElement).value = String((s as any)[el.dataset.bind!])));
  };
  $$('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.toggle as 'songMode' | 'markovSong' | 'nomos';
      s[k] = !s[k];
      syncToggles();
      renderSong();
      save();
    }),
  );
  $$('[data-opt]').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.opt as 'clockOut' | 'extClock' | 'preview';
      eng[k] = !eng[k];
      syncToggles();
      if (k === 'extClock' && eng.playing) eng.stop(), eng.start();
    }),
  );
  $$<HTMLInputElement>('[data-bind]').forEach((el) =>
    el.addEventListener('input', () => {
      const k = el.dataset.bind as 'bpm' | 'swing' | 'master';
      s[k] = k === 'bpm' ? clamp(Number(el.value) || 120, 30, 300) : Number(el.value);
      if (k === 'master') paint();
      save();
    }),
  );
  const playBtn = $<HTMLButtonElement>('[data-play]');
  const togglePlay = async () => {
    if (eng.playing) eng.stop();
    else await eng.start();
    playBtn.setAttribute('aria-pressed', String(eng.playing));
    playBtn.textContent = eng.playing ? '■ stop' : '▶ play';
    $('[data-status]').textContent = eng.playing ? (eng.extClock ? 'waiting for clock' : 'playing') : 'stopped';
    if (!eng.playing) last.fill(-1);
    renderSong();
    renderBank();
    paint();
  };
  playBtn.addEventListener('click', togglePlay);
  const fillBtn = $('[data-fill]');
  const setFill = (on: boolean) => ((s.fill = on), fillBtn.setAttribute('aria-pressed', String(on)));
  fillBtn.addEventListener('pointerdown', () => setFill(true));
  fillBtn.addEventListener('pointerup', () => setFill(false));
  fillBtn.addEventListener('pointerleave', () => setFill(false));

  // ── MIDI ─────────────────────────────────────────────────────────────────
  $('[data-midi]').addEventListener('click', async () => {
    if (!Midi.supported) return toast('This browser has no Web MIDI. Use Chrome, Edge or Opera on the desktop.');
    try {
      await midi.enable();
    } catch {
      return toast('MIDI permission was not granted.');
    }
    const out = $<HTMLSelectElement>('[data-midi-out]'), inp = $<HTMLSelectElement>('[data-midi-in]');
    out.replaceChildren(new Option('MIDI out: none', ''), ...midi.outputs.map((o) => new Option(`out: ${o.name}`, o.id)));
    inp.replaceChildren(new Option('MIDI in: all', 'all'), ...midi.inputs.map((i) => new Option(`in: ${i.name}`, i.id)));
    out.hidden = inp.hidden = false;
    out.onchange = () => {
      midi.selectOutput(out.value);
      if (midi.out) (eng.preview = false), syncToggles();
    };
    inp.onchange = () => midi.selectInput(inp.value);
    if (midi.outputs[0]) (out.value = midi.outputs[0].id), out.onchange(new Event('change'));
    toast(`MIDI: ${midi.outputs.length} outputs, ${midi.inputs.length} inputs.${midi.outputs.length ? '' : ' Create a virtual port (loopMIDI on Windows, IAC on macOS) to reach your DAW.'}`);
  });

  // ── patterns & song ────────────────────────────────────────────────────────
  const renderBank = () =>
    $$('[data-pat]').forEach((b) => {
      const i = Number(b.dataset.pat);
      b.setAttribute('aria-pressed', String(i === s.cur));
      b.classList.toggle('has-notes', s.pats[i].steps.some((t) => t.some((x) => x.on)));
      b.classList.toggle('is-playing', eng.playing && eng.playingPattern === i);
    });
  $$('[data-pat]').forEach((b) =>
    b.addEventListener('click', () => {
      s.cur = Number(b.dataset.pat);
      renderBank();
      paint();
      save();
    }),
  );
  const songBody = $('[data-song]');
  function renderSong() {
    songBody.replaceChildren(
      ...s.song.map((r, i) => {
        const trEl = document.createElement('tr');
        if (eng.playing && s.songMode && eng.songRow === i) trEl.className = 'is-now';
        trEl.innerHTML = `<td>${i + 1}</td>
          <td><select data-r="pat">${[...Array(16).keys()].map((p) => `<option value="${p}">${String(p + 1).padStart(2, '0')}</option>`).join('')}</select></td>
          <td><input type="number" min="1" max="64" data-r="reps" /></td>
          <td class="st-mutes">${[...Array(8).keys()].map((t) => `<button type="button" data-m="${t}" aria-pressed="${!!((r.mutes >> t) & 1)}" style="--c:${trackColor(t)}">${t + 1}</button>`).join('')}</td>
          <td><input type="number" min="-24" max="24" data-r="trans" /></td>
          <td><input type="number" min="0" max="300" data-r="bpm" placeholder="—" /></td>
          <td><button type="button" class="st-del" aria-label="Delete row">×</button></td>`;
        trEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-r]').forEach((el) => {
          const k = el.dataset.r as 'pat' | 'reps' | 'trans' | 'bpm';
          el.value = k === 'bpm' && !r.bpm ? '' : String(r[k]);
          el.addEventListener('change', () => ((r[k] = Number(el.value) || 0), k === 'reps' && (r.reps = Math.max(1, r.reps)), save()));
        });
        trEl.querySelectorAll<HTMLButtonElement>('[data-m]').forEach((b) =>
          b.addEventListener('click', () => {
            r.mutes ^= 1 << Number(b.dataset.m);
            b.setAttribute('aria-pressed', String(!!((r.mutes >> Number(b.dataset.m)) & 1)));
            save();
          }),
        );
        trEl.querySelector('.st-del')!.addEventListener('click', () => {
          if (s.song.length > 1) s.song.splice(i, 1), renderSong(), save();
        });
        return trEl;
      }),
    );
    const bars = s.song.reduce((a, r) => a + r.reps, 0);
    $('[data-song-info]').textContent = `${s.song.length} rows · ${bars} × ${s.master} steps${s.songMode ? ' · song mode on' : ''}${s.markovSong ? ' · stochastic order' : ''}`;
  }
  eng.onRow(() => requestAnimationFrame(() => (renderSong(), renderBank(), paint())));

  const download = (bytes: BlobPart, type: string, name: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const acts: Record<string, () => void> = {
    undo: () => {
      const u = undo.pop();
      if (!u) return toast('Nothing to undo.');
      s.pats[u.pat].steps[u.track] = u.steps;
    },
    clearTrack: () => (snapshot(), (pat().steps[sel] = [...Array(MAX_STEPS)].map(() => emptyStep(36 + sel * 5)))),
    rec: () => {
      recPos = recPos < 0 ? 0 : -1;
      $('[data-act="rec"]').setAttribute('aria-pressed', String(recPos >= 0));
      if (recPos >= 0) toast('Step record: play notes on a MIDI keyboard; each fills the next step of the selected track.');
    },
    copy: () => ((clip = clone(pat())), toast('Pattern copied.')),
    paste: () => clip && (s.pats[s.cur] = clone(clip)),
    clearPat: () => (s.pats[s.cur] = emptyPattern()),
    addRow: () => s.song.push({ pat: s.cur, reps: 1, mutes: 0, trans: 0, bpm: 0 }),
    export: () => download(eng.export() as BlobPart, 'audio/midi', `stochos-${s.songMode ? 'song' : `pattern-${s.cur + 1}`}.mid`),
    save: () => download(JSON.stringify(s), 'application/json', 'stochos.json'),
  };
  $$('[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      acts[b.dataset.act!]();
      renderBank();
      renderSong();
      paint();
      save();
    }),
  );
  $<HTMLInputElement>('[data-load]').addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const next = JSON.parse(await f.text()) as State;
      if (next.pats?.length !== 16 || next.tracks?.length !== 8) throw new Error();
      Object.assign(s, next);
      syncToggles();
      renderTracks();
      renderBank();
      renderSong();
      paint();
      save();
      toast('Loaded.');
    } catch {
      toast('That file is not a Stochos session.');
    }
  });

  // ── clock → screen ─────────────────────────────────────────────────────────
  const pending: Array<{ track: number; step: number; time: number }> = [];
  eng.onFire((f) => pending.push(f));
  let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    if (!eng.playing || !eng.ctx) return;
    let dirty = false;
    while (pending.length && pending[0].time <= eng.ctx.currentTime) {
      const f = pending.shift()!;
      last[f.track] = f.step;
      dirty = true;
    }
    if (dirty) paint();
  };
  raf = requestAnimationFrame(frame);
  function info() {
    const t = tr();
    $('[data-page-info]').textContent = `track ${sel + 1} · ${t.name} · ch ${t.ch + 1} · ${t.len} steps · ×${SPEEDS[t.speed]}${recPos >= 0 ? ` · rec → step ${recPos + 1}` : ''}`;
  }

  // ── keyboard (captured so the site's shortcuts stay out of the way) ─────────
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!document.body.contains(root) || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || document.querySelector('dialog[open]')) return;
    if (e.type === 'keyup') return void ((e.key === 'f' || e.key === 'F') && setFill(false));
    let handled = true;
    if (e.key === ' ' && !t.closest('button')) togglePlay();
    else if (/^[1-8]$/.test(e.key) && !e.ctrlKey && !e.metaKey) select(Number(e.key) - 1);
    else if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) acts.undo(), paint();
    else if ((e.key === 'f' || e.key === 'F') && !e.repeat) setFill(true);
    else handled = false;
    if (handled) e.preventDefault(), e.stopImmediatePropagation();
  };
  addEventListener('keydown', onKey, { capture: true });
  addEventListener('keyup', onKey, { capture: true });
  const ro = new ResizeObserver(() => paint());
  ro.observe(page);
  document.addEventListener(
    'astro:before-swap',
    () => {
      removeEventListener('keydown', onKey, { capture: true });
      removeEventListener('keyup', onKey, { capture: true });
      cancelAnimationFrame(raf);
      ro.disconnect();
      eng.stop();
      eng.ctx?.close();
    },
    { once: true },
  );

  syncToggles();
  renderTracks();
  renderBank();
  renderSong();
  paint();
}
