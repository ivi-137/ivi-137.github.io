/**
 * Orfeo 32: the panel. Binds every control to the state, the state to the
 * audio engine, and draws what the audio clock is doing when it does it.
 */
import { DIVS, PEDALS, SOURCES, DESTS, spec, type FromDsp } from './params';
import { Engine } from './engine';
import { Sequencer, type ChordInfo, type TickInfo } from './sequencer';
import { Midi } from './midi';
import { STEPS, LANE_INFO, SCALES, TIME_MULT, PRESETS, makeDefault, preset, sanitize, encode, decode, clone, euclid, tuneHz, type OrfeoState, type LaneId, type Pattern } from './state';
import { methodById, NAMES, findKey, counterpoint, checkCounterpoint, expectancyMelody, vossMelody, toneRow, rowForm, Continuator, negateMidi, keyName, mulberry, type RowForm } from './harmony';
import { offer, god, type Offer } from './boons';
import { Sigil, ruleFor } from '../sigil';
import { toast } from '../ui/nav';

const INK: [number, number, number] = [22, 20, 15];
// the site's inks: verm, cobalt, acid, violet, ghost, brass and the class inks
const SRC_HUES = ['#ff4b1f', '#2f45ff', '#c6ff3d', '#9a6bff', '#7d8cff', '#c9a24a', '#2f6b00', '#d8360f', '#2336d6', '#6a2fcf', '#ff4b1f', '#c6ff3d', '#2f45ff', '#c9a24a', '#9a6bff', '#7d8cff', '#2f6b00'];
const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode, quota: the instrument works without it */
    }
  },
};
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
type KnobEl = HTMLElement & { set?: (v: number) => void; show?: () => void };

export function mountOrfeo() {
  const found = document.querySelector<HTMLElement>('[data-orfeo]');
  if (!found || found.dataset.ready) return;
  const root: HTMLElement = found;
  root.dataset.ready = '1';
  const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const $$ = <T extends Element = HTMLElement>(s: string) => [...root.querySelectorAll<T>(s)];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let state: OrfeoState = makeDefault();
  const saved = store.get('orfeo:last');
  if (saved)
    try {
      state = sanitize(JSON.parse(saved));
    } catch {
      /* ignore a broken save */
    }
  const engine = new Engine();
  const seq = new Sequencer(state, engine);
  const cont = new Continuator(4);
  const statusEl = $('[data-status]');
  const status = (t: string) => (statusEl.textContent = t);

  // ── state plumbing ──────────────────────────────────────────────────────
  const undo: string[] = [];
  const redo: string[] = [];
  const snapshot = () => {
    undo.push(JSON.stringify(state));
    if (undo.length > 80) undo.shift();
    redo.length = 0;
  };
  let saveT = 0;
  const persist = () => {
    clearTimeout(saveT);
    saveT = window.setTimeout(() => store.set('orfeo:last', JSON.stringify(state)), 700);
  };
  function setState(next: OrfeoState) {
    state = next;
    seq.state = next;
    if (engine.ready) engine.sync(next);
    refreshAll();
    persist();
  }
  const P = () => state.patterns[state.cur];

  async function boot() {
    if (engine.ready) return true;
    status('waking the lyre…');
    try {
      await engine.boot(state);
      await engine.resume();
      status('the lyre is awake');
      return true;
    } catch (err) {
      console.error(err);
      status('this browser cannot run the AudioWorklet engine');
      toast('Orfeo needs AudioWorklet support (any current Chrome, Firefox or Safari).');
      return false;
    }
  }

  // ── parameters: knobs, switches, segmented controls ────────────────────────
  const knobs = new Map<string, KnobEl>();
  function fmt(id: string, v: number) {
    const sp = spec(id);
    if (!sp) return '';
    if (sp.pos) return sp.pos[Math.round(v)] ?? '';
    switch (sp.fmt) {
      case 'bpm':
      case 'int':
        return `${Math.round(v)}`;
      case 'bi':
        return `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
      case 'cents':
        return `${v > 0 ? '+' : ''}${Math.round(v * 100)}¢`;
      case 'oct':
        return v > 0 ? `+${v}` : `${v}`;
      case 'div':
        return DIVS[Math.round(v)]?.n ?? '';
      default:
        return `${Math.round(v * 100)}`;
    }
  }
  function setParam(id: string, v: number) {
    const sp = spec(id);
    if (!sp) return;
    v = clamp(Math.round(v / sp.step) * sp.step, sp.min, sp.max);
    state.p[id] = v;
    engine.param(id, v);
    knobs.get(id)?.show?.();
    syncSwitches(id);
    if (id === 'g.heat') root.style.setProperty('--heat', String(v));
    secrets.param(id, v);
    persist();
  }
  let learning: string | null = null;
  const learnMap: Record<string, string> = JSON.parse(store.get('orfeo:learn') ?? '{}');

  $$<KnobEl>('[data-knob]').forEach((el) => {
    const id = el.dataset.knob!;
    const sp = spec(id);
    if (!sp) return;
    const { min, max, step } = sp;
    const valueEl = el.querySelector<HTMLElement>('[data-knob-value]')!;
    const pointer = el.querySelector('.knob__pointer')!;
    knobs.set(id, el);
    el.show = () => {
      const v = state.p[id];
      pointer.setAttribute('transform', `rotate(${-135 + ((v - min) / (max - min)) * 270})`);
      el.setAttribute('aria-valuenow', String(v));
      el.setAttribute('aria-valuetext', fmt(id, v));
      valueEl.textContent = fmt(id, v);
    };
    el.set = (v: number) => setParam(id, v);
    el.show();
    let drag: { y: number; v: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      snapshot();
      drag = { y: e.clientY, v: state.p[id] };
      el.setPointerCapture(e.pointerId);
      el.classList.add('is-turning');
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const range = max - min;
      el.set!(drag.v + ((drag.y - e.clientY) / (e.shiftKey ? 700 : 170)) * range);
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
        el.set!(state.p[id] - Math.sign(e.deltaY) * Math.max(step, (max - min) / 60));
      },
      { passive: false },
    );
    el.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      el.set!(state.p[id] + d * Math.max(step, (max - min) / (e.shiftKey ? 100 : 20)));
    });
    el.addEventListener('dblclick', () => {
      snapshot();
      el.set!(sp.def);
    });
    el.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      learning = id;
      el.classList.add('is-learning');
      status(`MIDI learn: move a control on your device for “${sp.label}”`);
      if (!midi.access) await enableMidi();
    });
  });

  const switches = $$<HTMLButtonElement>('[data-switch]');
  const segs = $$<HTMLButtonElement>('[data-seg]');
  function syncSwitches(only?: string) {
    for (const b of switches) {
      const id = b.dataset.switch!;
      if (only && id !== only) continue;
      b.setAttribute('aria-pressed', String(state.p[id] > 0));
    }
    for (const b of segs) {
      const id = b.dataset.seg!;
      if (only && id !== only) continue;
      b.setAttribute('aria-pressed', String(state.p[id] === Number(b.dataset.v)));
    }
  }
  switches.forEach((b) =>
    b.addEventListener('click', () => {
      snapshot();
      const id = b.dataset.switch!;
      const sp = spec(id);
      setParam(id, state.p[id] >= sp.max ? sp.min : state.p[id] + 1);
      if (id === 'rz.on' && state.p[id]) status('Rollz rolling: five pulse trains dividing the bar');
    }),
  );
  segs.forEach((b) =>
    b.addEventListener('click', () => {
      snapshot();
      setParam(b.dataset.seg!, Number(b.dataset.v));
    }),
  );

  // ── transport ───────────────────────────────────────────────────────────
  const playBtn = $<HTMLButtonElement>('[data-play]');
  async function toggle() {
    if (seq.playing) seq.stop();
    else {
      if (!(await boot())) return;
      await engine.resume();
      seq.start();
    }
    playBtn.setAttribute('aria-pressed', String(seq.playing));
    $('[data-play-label]').textContent = seq.playing ? 'ferma' : 'suona';
    root.classList.toggle('is-playing', seq.playing);
    animatePatternSigils();
  }
  playBtn.addEventListener('click', toggle);
  $('[data-panic]').addEventListener('click', panic);
  function panic() {
    engine.cmd('panic');
    midi.panic();
    held.length = 0;
    $$('[data-plate]').forEach((p) => p.classList.remove('is-down'));
    status('silence');
  }

  // ── the step grid ────────────────────────────────────────────────────────
  let lane: LaneId = 'gate';
  const stepEls = $$('[data-cell]');
  const gateEls = $$<HTMLButtonElement>('[data-gate]');
  const barEls = $$('[data-bar]');
  const grid = $('[data-grid]');
  const noteName = (deg: number) => {
    const { midi } = seq.noteMidi(deg);
    const m = Math.round(midi);
    return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
  };
  function laneLabel(l: LaneId, v: number) {
    switch (l) {
      case 'note':
        return noteName(v);
      case 'ratch':
        return v > 1 ? `×${v}` : '·';
      case 'time':
        return `${TIME_MULT[v]}`;
      case 'prob':
        return `${Math.round(v * 100)}`;
      default:
        return `${Math.round(v * 100)}`;
    }
  }
  function drawGrid() {
    const p = P();
    const info = LANE_INFO[lane];
    grid.dataset.lane = lane;
    for (let i = 0; i < STEPS; i++) {
      const g = p.lanes.gate[i];
      gateEls[i].setAttribute('aria-pressed', String(g > 0));
      gateEls[i].dataset.g = String(g);
      stepEls[i].classList.toggle('step--out', i >= p.len[lane]);
      stepEls[i].classList.toggle('step--gateout', i >= p.len.gate);
      if (lane !== 'gate') {
        const v = p.lanes[lane][i];
        const f = (v - info.min) / (info.max - info.min);
        barEls[i].style.setProperty('--f', String(f));
        barEls[i].querySelector<HTMLElement>('.step__val')!.textContent = laneLabel(lane, v);
      }
    }
    $('[data-len-val]').textContent = String(p.len[lane]);
    $('[data-div-val]').textContent = String(p.div[lane]);
    $$<HTMLButtonElement>('[data-dir]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.dir) === p.dir)));
    $$<HTMLButtonElement>('[data-lane-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.laneTab === lane)));
    $<HTMLButtonElement>('[data-ca]').setAttribute('aria-pressed', String(p.ca.on));
    $<HTMLSelectElement>('[data-ca-rule]').value = String(p.ca.rule);
    const mut = $<HTMLInputElement>('[data-mut]');
    mut.value = String(Math.round(p.mut * 100));
    $('[data-mut-val]').textContent = mut.value;
    drawPatternSigil(state.cur);
  }
  $$<HTMLButtonElement>('[data-lane-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      lane = b.dataset.laneTab as LaneId;
      drawGrid();
    }),
  );
  // gates: touch cycles off → on → slide → off; drag paints the same state across steps
  let paintGate: number | null = null;
  gateEls.forEach((b, i) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      snapshot();
      const p = P();
      const v = (p.lanes.gate[i] + 1) % 3;
      paintGate = v;
      p.lanes.gate[i] = v;
      drawGrid();
      persist();
      if (v === 1 && !seq.playing && engine.ready) audition(p.lanes.note[i]);
    });
    b.addEventListener('pointerenter', () => {
      if (paintGate === null) return;
      P().lanes.gate[i] = paintGate;
      drawGrid();
    });
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      snapshot();
      const p = P();
      p.lanes.gate[i] = (p.lanes.gate[i] + 1) % 3;
      drawGrid();
      persist();
    });
  });
  addEventListener('pointerup', () => (paintGate = null));
  // bars: drag across to draw a lane
  let drawing = false;
  function paintAt(x: number, y: number) {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-bar]');
    if (!el || !grid.contains(el)) return;
    const i = Number(el.dataset.bar);
    const r = el.getBoundingClientRect();
    const f = clamp(1 - (y - r.top) / r.height);
    const info = LANE_INFO[lane];
    let v = info.min + f * (info.max - info.min);
    v = Math.round(v / info.step) * info.step;
    const p = P();
    if (p.lanes[lane][i] !== v) {
      p.lanes[lane][i] = v;
      drawGrid();
      if (lane === 'note' && !seq.playing && engine.ready) audition(v);
    }
  }
  barEls.forEach((el) =>
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      snapshot();
      drawing = true;
      grid.setPointerCapture(e.pointerId);
      paintAt(e.clientX, e.clientY);
    }),
  );
  grid.addEventListener('pointermove', (e) => drawing && paintAt(e.clientX, e.clientY));
  grid.addEventListener('pointerup', () => {
    if (drawing) persist();
    drawing = false;
  });
  function audition(deg: number) {
    const { hz } = seq.noteMidi(deg);
    engine.events([{ k: 'n', at: engine.now + 0.01, hz, vel: 0.8, dur: 0.18, slide: 0, t: 0.5, m: 0.5 }]);
  }
  const nudge = (key: 'len' | 'div', d: number) => {
    snapshot();
    const p = P();
    if (key === 'len') p.len[lane] = clamp(p.len[lane] + d, 1, STEPS);
    else p.div[lane] = clamp(p.div[lane] + d, 1, 8);
    drawGrid();
    persist();
  };
  $$<HTMLButtonElement>('[data-len]').forEach((b) => b.addEventListener('click', () => nudge('len', Number(b.dataset.len))));
  $$<HTMLButtonElement>('[data-div]').forEach((b) => b.addEventListener('click', () => nudge('div', Number(b.dataset.div))));
  $$<HTMLButtonElement>('[data-dir]').forEach((b) =>
    b.addEventListener('click', () => {
      snapshot();
      P().dir = Number(b.dataset.dir);
      if (P().dir === 1) secrets.lookBack();
      drawGrid();
      persist();
    }),
  );

  // tools
  let clipboard: Pattern | null = null;
  function laneTool(tool: string) {
    const p = P();
    const L = p.len[lane];
    const a = p.lanes[lane];
    const info = LANE_INFO[lane];
    const head = a.slice(0, L);
    switch (tool) {
      case 'rand':
        for (let i = 0; i < L; i++) {
          const r = Math.random();
          a[i] =
            lane === 'gate'
              ? r < 0.08
                ? 2
                : r < 0.45
                  ? 1
                  : 0
              : lane === 'note'
                ? 0
                : lane === 'ratch'
                  ? r < 0.8
                    ? 1
                    : 2 + Math.floor(Math.random() * 3)
                  : lane === 'time'
                    ? r < 0.7
                      ? 2
                      : Math.floor(Math.random() * 5)
                    : lane === 'prob'
                      ? r < 0.6
                        ? 1
                        : 0.4 + Math.random() * 0.6
                      : Math.round((info.min + Math.random() * (info.max - info.min)) / info.step) * info.step;
        }
        if (lane === 'note') expectancyMelody(L, Math.random).forEach((d, i) => (a[i] = d));
        break;
      case 'left':
        head.push(head.shift()!);
        head.forEach((v, i) => (a[i] = v));
        break;
      case 'right':
        head.unshift(head.pop()!);
        head.forEach((v, i) => (a[i] = v));
        break;
      case 'rev':
        head.reverse().forEach((v, i) => (a[i] = v));
        break;
      case 'inv':
        for (let i = 0; i < L; i++) a[i] = lane === 'gate' ? (a[i] ? 0 : 1) : lane === 'note' ? 7 - a[i] : info.max + info.min - a[i];
        break;
      case 'clear':
        for (let i = 0; i < STEPS; i++) a[i] = info.def;
        break;
      case 'copy':
        clipboard = clone(p);
        toast('Pattern copied.');
        return;
      case 'paste':
        if (!clipboard) return;
        state.patterns[state.cur] = clone(clipboard);
        break;
    }
  }
  $$<HTMLButtonElement>('[data-tool]').forEach((b) =>
    b.addEventListener('click', () => {
      snapshot();
      laneTool(b.dataset.tool!);
      drawGrid();
      persist();
    }),
  );
  const ek = $<HTMLInputElement>('[data-euclid-k]'),
    er = $<HTMLInputElement>('[data-euclid-r]');
  ek.addEventListener('input', () => ($('[data-euclid-k-val]').textContent = ek.value));
  er.addEventListener('input', () => ($('[data-euclid-r-val]').textContent = er.value));
  $('[data-euclid-apply]').addEventListener('click', () => {
    snapshot();
    const p = P();
    const L = p.len.gate;
    const k = Number(ek.value),
      r = Number(er.value);
    const e = L % 16 === 0 ? euclid(k, 16, r) : euclid(Math.round((k * L) / 16), L, r);
    for (let i = 0; i < STEPS; i++) p.lanes.gate[i] = e[i % e.length] ? (p.lanes.gate[i] === 2 ? 2 : 1) : 0;
    drawGrid();
    persist();
    status(`E(${k},16) rotated by ${r}`);
  });
  $('[data-ca]').addEventListener('click', () => {
    snapshot();
    P().ca.on = !P().ca.on;
    drawGrid();
    persist();
  });
  $<HTMLSelectElement>('[data-ca-rule]').addEventListener('change', (e) => {
    P().ca.rule = Number((e.target as HTMLSelectElement).value);
    persist();
  });
  $<HTMLInputElement>('[data-mut]').addEventListener('input', (e) => {
    P().mut = Number((e.target as HTMLInputElement).value) / 100;
    $('[data-mut-val]').textContent = (e.target as HTMLInputElement).value;
    persist();
  });
  const rootSel = $<HTMLSelectElement>('[data-root]'),
    scaleSel = $<HTMLSelectElement>('[data-scale]'),
    tuneSel = $<HTMLSelectElement>('[data-tuning]');
  rootSel.addEventListener('change', () => {
    snapshot();
    state.root = Number(rootSel.value);
    drawGrid();
    persist();
  });
  scaleSel.addEventListener('change', () => {
    snapshot();
    state.scale = scaleSel.value;
    drawGrid();
    persist();
  });
  tuneSel.addEventListener('change', () => {
    snapshot();
    state.tuning = tuneSel.value;
    persist();
  });
  const colonyBtn = $<HTMLButtonElement>('[data-colony-gates]'),
    feedBtn = $<HTMLButtonElement>('[data-feed]');
  colonyBtn.addEventListener('click', () => {
    state.colonyGates = !state.colonyGates;
    colonyBtn.setAttribute('aria-pressed', String(state.colonyGates));
    persist();
    if (state.colonyGates) toast(life() ? 'At every loop, the row of the colony behind the grid becomes the gates.' : 'No colony to listen to: WebGL2 is unavailable.');
  });
  feedBtn.addEventListener('click', () => {
    state.feed = !state.feed;
    feedBtn.setAttribute('aria-pressed', String(state.feed));
    persist();
    if (state.feed) toast('Every note now drops a glider into the colony behind the page.');
  });

  // ── patterns: slots, sigils, chain ───────────────────────────────────────
  const patBtns = $$<HTMLButtonElement>('[data-pat]');
  const patSigils: Array<Sigil | null> = new Array(8).fill(null);
  const patSeed = (p: Pattern) => (p.lanes.gate.some(Boolean) ? `${p.lanes.gate.join('')}|${p.lanes.note.join(',')}` : 'vuoto');
  const sigilKeys: string[] = new Array(8).fill('');
  function drawPatternSigil(i: number) {
    const seed = patSeed(state.patterns[i]);
    if (sigilKeys[i] === seed && patSigils[i]) return;
    sigilKeys[i] = seed;
    patSigils[i]?.stop();
    const c = root.querySelector<HTMLCanvasElement>(`[data-pat-sigil="${i}"]`)!;
    patSigils[i] = new Sigil(c, seed, ruleFor(seed), 24, 9, INK);
    patBtns[i].classList.toggle('pat--empty', seed === 'vuoto');
  }
  function animatePatternSigils() {
    patSigils.forEach((s, i) => (seq.playing && i === state.cur && !reduced ? s?.play(10) : s?.stop()));
  }
  function drawPatterns() {
    for (let i = 0; i < 8; i++) drawPatternSigil(i);
    patBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === state.cur)));
    $('[data-chain-view]').textContent = state.chain.length ? state.chain.map((i) => 'ΑΒΓΔΕΖΗΘ'[i]).join(' ') : '—';
    animatePatternSigils();
  }
  patBtns.forEach((b, i) =>
    b.addEventListener('click', (e) => {
      if (e.shiftKey) {
        state.chain.push(i);
      } else {
        state.cur = i;
      }
      drawPatterns();
      drawGrid();
      persist();
    }),
  );
  $('[data-chain-add]').addEventListener('click', () => {
    state.chain.push(state.cur);
    drawPatterns();
    persist();
  });
  $('[data-chain-clear]').addEventListener('click', () => {
    state.chain = [];
    drawPatterns();
    persist();
  });

  // ── patchbay ────────────────────────────────────────────────────────────
  const patch = $('[data-patch]');
  const svg = $<SVGSVGElement>('[data-cables]');
  const srcJacks = $$<HTMLButtonElement>('[data-jack-src]');
  const dstJacks = $$<HTMLButtonElement>('[data-jack-dst]');
  const list = $('[data-cable-list]');
  let armed: number | null = null;
  let dragLine: { x: number; y: number } | null = null;
  const center = (el: Element) => {
    const r = el.querySelector('.jack__hole')!.getBoundingClientRect();
    const pr = patch.getBoundingClientRect();
    return { x: r.left + r.width / 2 - pr.left, y: r.top + r.height / 2 - pr.top };
  };
  const cablePath = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const sag = 40 + Math.abs(b.x - a.x) * 0.18;
    return `M${a.x} ${a.y} C${a.x} ${a.y + sag} ${b.x} ${b.y + sag * 0.6} ${b.x} ${b.y}`;
  };
  function drawCables() {
    const pr = patch.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${pr.width} ${pr.height}`);
    svg.setAttribute('width', String(pr.width));
    svg.setAttribute('height', String(pr.height));
    let html = '';
    for (const [s, d, a] of state.cables) {
      const p = cablePath(center(srcJacks[s]), center(dstJacks[d]));
      html += `<path class="cable__ink" d="${p}"/><path class="cable" d="${p}" stroke="${SRC_HUES[s]}" style="opacity:${0.45 + Math.abs(a) * 0.55}"/>`;
    }
    if (armed !== null && dragLine) html += `<path class="cable cable--drag" d="${cablePath(center(srcJacks[armed]), dragLine)}" stroke="${SRC_HUES[armed]}"/>`;
    svg.innerHTML = html;
    srcJacks.forEach((j, i) => j.classList.toggle('is-used', state.cables.some(([s]) => s === i)));
    dstJacks.forEach((j, i) => j.classList.toggle('is-used', state.cables.some(([, d]) => d === i)));
  }
  function drawCableList() {
    list.innerHTML = state.cables.length
      ? state.cables
          .map(
            ([s, d, a], k) =>
              `<div class="cablerow" style="--c:${SRC_HUES[s]}"><span><i></i>${SOURCES[s].n} → ${DESTS[d].n}</span><input type="range" min="-100" max="100" value="${Math.round(a * 100)}" data-cable-amt="${k}" aria-label="${SOURCES[s].n} to ${DESTS[d].n} amount"><b>${Math.round(a * 100)}</b><button type="button" data-cable-del="${k}" aria-label="Remove cable">✕</button></div>`,
          )
          .join('')
      : '<p class="cablerow cablerow--empty">no cables: drag from an uscita to an ingresso</p>';
  }
  function setCables() {
    engine.cables(state.cables);
    drawCables();
    drawCableList();
    persist();
  }
  function connect(s: number, d: number) {
    snapshot();
    const ex = state.cables.find(([a, b]) => a === s && b === d);
    if (!ex) state.cables.push([s, d, SOURCES[s].bi ? 0.25 : 0.4]);
    setCables();
    status(`${SOURCES[s].n} → ${DESTS[d].n}`);
  }
  srcJacks.forEach((j, i) => {
    j.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      armed = i;
      patch.setPointerCapture(e.pointerId);
      const pr = patch.getBoundingClientRect();
      dragLine = { x: e.clientX - pr.left, y: e.clientY - pr.top };
      srcJacks.forEach((x, k) => x.classList.toggle('is-armed', k === i));
      drawCables();
    });
    j.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      armed = i;
      srcJacks.forEach((x, k) => x.classList.toggle('is-armed', k === i));
      status(`${SOURCES[i].n}: now choose an ingresso`);
    });
  });
  patch.addEventListener('pointermove', (e) => {
    if (armed === null || !dragLine) return;
    const pr = patch.getBoundingClientRect();
    dragLine = { x: e.clientX - pr.left, y: e.clientY - pr.top };
    drawCables();
  });
  patch.addEventListener('pointerup', (e) => {
    if (armed === null || !dragLine) return;
    const dst = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-jack-dst]');
    const src = armed;
    dragLine = null;
    if (dst) {
      armed = null;
      srcJacks.forEach((x) => x.classList.remove('is-armed'));
      connect(src, Number(dst.dataset.jackDst));
    } else {
      status(`${SOURCES[src].n}: now choose an ingresso`);
      drawCables();
    }
  });
  dstJacks.forEach((j) =>
    j.addEventListener('click', () => {
      if (armed === null) return;
      const s = armed;
      armed = null;
      srcJacks.forEach((x) => x.classList.remove('is-armed'));
      connect(s, Number(j.dataset.jackDst));
    }),
  );
  list.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (!t.dataset.cableAmt) return;
    const k = Number(t.dataset.cableAmt);
    state.cables[k][2] = Number(t.value) / 100;
    t.nextElementSibling!.textContent = t.value;
    engine.cables(state.cables);
    drawCables();
    persist();
  });
  list.addEventListener('pointerdown', (e) => (e.target as HTMLElement).dataset.cableAmt && snapshot());
  list.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-cable-del]');
    if (!t) return;
    snapshot();
    state.cables.splice(Number(t.dataset.cableDel), 1);
    setCables();
  });
  const ro = new ResizeObserver(() => drawCables());
  ro.observe(patch);

  // ── armonia ─────────────────────────────────────────────────────────────
  const methodBtns = $$<HTMLButtonElement>('[data-method]');
  function drawHarm() {
    const h = state.harm;
    methodBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.method === h.method)));
    const m = methodById(h.method);
    $('[data-method-cite]').textContent = m.cite;
    $<HTMLButtonElement>('[data-harm-on]').setAttribute('aria-pressed', String(h.on));
    $<HTMLSelectElement>('[data-harm-rate]').value = String(h.rate);
    $<HTMLSelectElement>('[data-voicing]').value = h.voicing;
    $<HTMLSelectElement>('[data-arp]').value = String(h.arp);
    $<HTMLSelectElement>('[data-arp-rate]').value = String(h.arpRate);
    $<HTMLInputElement>('[data-spice]').value = String(Math.round(h.spice * 100));
    $('[data-spice-val]').textContent = String(Math.round(h.spice * 100));
    $$<HTMLButtonElement>('[data-follow]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.follow) === h.follow)));
    $<HTMLButtonElement>('[data-negative]').setAttribute('aria-pressed', String(h.negative));
    $<HTMLButtonElement>('[data-cp]').setAttribute('aria-pressed', String(h.cp));
  }
  methodBtns.forEach((b) =>
    b.addEventListener('click', () => {
      snapshot();
      state.harm.method = b.dataset.method!;
      state.harm.on = true;
      drawHarm();
      persist();
      status(`${methodById(b.dataset.method!).name}: ${methodById(b.dataset.method!).blurb}`);
    }),
  );
  const harmToggle = (key: 'on' | 'negative' | 'cp', sel: string) =>
    $(sel).addEventListener('click', () => {
      snapshot();
      state.harm[key] = !state.harm[key];
      drawHarm();
      persist();
    });
  harmToggle('on', '[data-harm-on]');
  harmToggle('negative', '[data-negative]');
  harmToggle('cp', '[data-cp]');
  const harmSelect = (sel: string, fn: (v: string) => void) =>
    $<HTMLSelectElement>(sel).addEventListener('change', (e) => {
      snapshot();
      fn((e.target as HTMLSelectElement).value);
      persist();
    });
  harmSelect('[data-harm-rate]', (v) => (state.harm.rate = Number(v)));
  harmSelect('[data-voicing]', (v) => (state.harm.voicing = v as OrfeoState['harm']['voicing']));
  harmSelect('[data-arp]', (v) => (state.harm.arp = Number(v)));
  harmSelect('[data-arp-rate]', (v) => (state.harm.arpRate = Number(v)));
  $<HTMLInputElement>('[data-spice]').addEventListener('input', (e) => {
    state.harm.spice = Number((e.target as HTMLInputElement).value) / 100;
    $('[data-spice-val]').textContent = (e.target as HTMLInputElement).value;
    persist();
  });
  $$<HTMLButtonElement>('[data-follow]').forEach((b) =>
    b.addEventListener('click', () => {
      snapshot();
      state.harm.follow = Number(b.dataset.follow);
      drawHarm();
      drawGrid();
      persist();
    }),
  );

  /** The sounding steps of the note lane as MIDI notes (scale degrees), with their step indices. */
  function sounding() {
    const p = P();
    const out: Array<{ i: number; midi: number; w: number }> = [];
    const L = Math.min(p.len.gate, p.len.note);
    for (let i = 0; i < L; i++) if (p.lanes.gate[i]) out.push({ i, midi: Math.round(seq.noteMidi(p.lanes.note[i]).midi) - seq.transpose, w: p.lanes.vel[i] + 0.2 });
    return out;
  }
  /** The nearest scale degree to a MIDI note, for writing melodies back into the lane. */
  function degreeOf(midi: number) {
    let best = 0,
      bd = Infinity;
    const saveT = seq.transpose;
    seq.transpose = 0;
    for (let d = -7; d <= 21; d++) {
      const diff = Math.abs(seq.noteMidi(d).midi - midi);
      if (diff < bd) {
        bd = diff;
        best = d;
      }
    }
    seq.transpose = saveT;
    return best;
  }
  const actions: Record<string, () => void | Promise<void>> = {
    async next() {
      if (!(await boot())) return;
      seq.audition();
    },
    key() {
      const notes = sounding();
      if (notes.length < 3) return void toast('Light a few steps first: the key-finder needs notes.');
      const { key, r } = findKey(notes);
      snapshot();
      state.root = key.tonic;
      state.scale = key.minor ? 'min' : 'maj';
      refreshAll();
      status(`Krumhansl–Kessler: ${keyName(key)} (r = ${r.toFixed(2)})`);
    },
    fux() {
      const notes = sounding();
      if (notes.length < 3) return void toast('Light at least three steps: they become the cantus firmus.');
      const sc = SCALES.find((s) => s.id === state.scale)!.iv.map((i) => (i + state.root) % 12);
      const cf = notes.map((n) => n.midi);
      const cp = counterpoint(cf, seq.key, Math.random, sc.length >= 7 ? sc : undefined);
      if (!cp) return void toast('No line above this cantus obeys all of Fux’s rules. Try fewer leaps or a longer phrase.');
      snapshot();
      const p = P();
      p.cp = new Array(STEPS).fill(null);
      notes.forEach((n, k) => (p.cp![n.i] = cp[k]));
      state.harm.cp = true;
      if (state.p['cp.level'] < 0.2) setParam('cp.level', 0.5);
      const r = checkCounterpoint(cf, cp);
      drawHarm();
      persist();
      status(`Fux, first species: ${cp.length} notes, ${r.dissonances} dissonances, ${r.parallels} parallel and ${r.hidden} hidden perfect intervals`);
    },
    huron() {
      snapshot();
      const p = P();
      expectancyMelody(STEPS, Math.random).forEach((d, i) => (p.lanes.note[i] = d));
      state.harm.follow = 0;
      refreshAll();
      status('von Hippel & Huron: small steps, a pull toward the middle, so leaps turn back');
    },
    voss() {
      snapshot();
      const p = P();
      vossMelody(STEPS, Math.random, 4, 12).forEach((d, i) => (p.lanes.note[i] = d));
      state.harm.follow = 0;
      refreshAll();
      status('Voss & Clarke: four dice, re-rolled at the rate of each bit of a counter: 1/f');
    },
    row() {
      snapshot();
      const p = P();
      const forms: RowForm[] = ['P', 'R', 'I', 'RI'];
      const form = forms[Math.floor(Math.random() * 4)];
      const row = rowForm(toneRow(Math.random, true), form);
      for (let i = 0; i < STEPS; i++) p.lanes.note[i] = row[i % 12];
      p.len.note = 12;
      state.harm.follow = 2;
      refreshAll();
      status(`all-interval row, form ${form}: ${row.map((x) => NAMES[(x + state.root) % 12]).join(' ')} (12 notes over ${p.len.gate} steps)`);
    },
    mirror() {
      snapshot();
      const p = P();
      for (let i = 0; i < STEPS; i++) p.lanes.note[i] = degreeOf(negateMidi(seq.noteMidi(p.lanes.note[i]).midi - seq.transpose, state.root));
      refreshAll();
      status('Levy: every note reflected through the axis between the tonic and the dominant');
    },
    cont() {
      if (cont.size < 4) return void toast('Play a few phrases on the obols or a MIDI keyboard first: the Continuator learns from you.');
      snapshot();
      const p = P();
      const { notes, orders } = cont.continue(lastPhrase.length ? lastPhrase : [60], STEPS, Math.random);
      notes.forEach((m, i) => (p.lanes.note[i] = degreeOf(m)));
      state.harm.follow = 0;
      refreshAll();
      status(`Continuator: 32 notes, average context ${(orders.reduce((a, b) => a + b, 0) / orders.length).toFixed(1)} notes deep`);
    },
  };
  $$<HTMLButtonElement>('[data-harm-act]').forEach((b) => b.addEventListener('click', () => actions[b.dataset.harmAct!]?.()));
  let contOn = false;
  const contBtn = $<HTMLButtonElement>('[data-cont]');
  contBtn.addEventListener('click', () => {
    contOn = !contOn;
    contBtn.setAttribute('aria-pressed', String(contOn));
    status(contOn ? 'Continuator listening: play a phrase, then stop' : 'Continuator asleep');
  });

  // chord display, at the moment the chord sounds
  const tris = $$<SVGPolygonElement>('[data-tri]');
  const nodes = $$<SVGGElement>('[data-node]');
  function showChord(c: ChordInfo) {
    const ch = c.chord;
    $('[data-chord-name]').textContent = ch.name;
    $('[data-chord-roman]').textContent = ch.roman ?? (ch.hz ? 'intonazione giusta' : '');
    $('[data-chord-how]').textContent = ch.how ?? '';
    const id = ch.quality === 'M' ? `M-${ch.root}` : ch.quality === 'm' ? `m-${ch.root}` : '';
    tris.forEach((t) => t.classList.toggle('is-on', t.dataset.tri === id));
    nodes.forEach((n) => {
      const pc = Number(n.dataset.node);
      n.classList.toggle('is-tone', ch.pcs.includes(pc));
      n.classList.toggle('is-root', pc === ch.root);
    });
  }

  // ── pedals ──────────────────────────────────────────────────────────────
  const board = $('[data-board]');
  const pedalEls = new Map($$('[data-pedal]').map((el) => [el.dataset.pedal!, el]));
  function drawBoard() {
    for (const id of state.order) board.append(pedalEls.get(id)!);
    for (const b of $$<HTMLButtonElement>('[data-dip]')) {
      const [id, bit] = b.dataset.dip!.split(':');
      b.setAttribute('aria-pressed', String(((state.p[`fx.${id}.dip`] >> Number(bit)) & 1) === 1));
    }
  }
  function move(id: string, to: number) {
    snapshot();
    const from = state.order.indexOf(id);
    state.order.splice(from, 1);
    state.order.splice(clamp(to, 0, state.order.length), 0, id);
    engine.order(state.order);
    drawBoard();
    persist();
    status(`chain: ${state.order.map((x) => PEDALS.find((p) => p.id === x)!.name).join(' → ')}`);
  }
  for (const [id, el] of pedalEls) {
    el.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((b) => b.addEventListener('click', () => move(id, state.order.indexOf(id) + Number(b.dataset.move))));
    el.querySelectorAll<HTMLButtonElement>('[data-flip]').forEach((b) =>
      b.addEventListener('click', () => {
        const face = el.querySelector<HTMLElement>('.pedal__face')!,
          back = el.querySelector<HTMLElement>('.pedal__back')!;
        const showBack = !el.classList.contains('is-flipped');
        back.hidden = !showBack;
        face.hidden = showBack;
        el.classList.toggle('is-flipped', showBack);
      }),
    );
    // only the pedal's name plate starts a drag, so knobs keep turning
    const head = el.querySelector<HTMLElement>('.pedal__head')!;
    head.addEventListener('pointerdown', () => (el.draggable = true));
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', id);
      el.classList.add('is-dragging');
    });
    el.addEventListener('dragend', () => {
      el.draggable = false;
      el.classList.remove('is-dragging');
    });
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = e.dataTransfer?.getData('text/plain');
      if (from && from !== id) move(from, state.order.indexOf(id));
    });
  }
  addEventListener('pointerup', () => pedalEls.forEach((el) => (el.draggable = false)));
  $$<HTMLButtonElement>('[data-dip]').forEach((b) =>
    b.addEventListener('click', () => {
      snapshot();
      const [id, bit] = b.dataset.dip!.split(':');
      const key = `fx.${id}.dip`;
      setParam(key, state.p[key] ^ (1 << Number(bit)));
      drawBoard();
      if (state.p[`fx.${id}.rmode`] === 0 && Number(bit) < 8) status('Dip set. Choose rampa, rimbalzo or soffio for the ramp to move it.');
    }),
  );
  const captureBtn = $<HTMLButtonElement>('[data-capture]');
  captureBtn.addEventListener('click', async () => {
    if (!(await boot())) return;
    if (!state.p['fx.sti.on']) setParam('fx.sti.on', 1);
    const held = captureBtn.getAttribute('aria-pressed') === 'true';
    engine.cmd(held ? 'release' : 'capture');
    status(held ? 'Stige flows again' : 'Stige holds the last bars');
  });

  // ── performance: obols, XY, keyboard, MIDI ────────────────────────────────────
  let plateOct = 0;
  let hold = false;
  let transposeMode = false;
  const held: number[] = [];
  let lastPhrase: number[] = [];
  let phraseT = 0;
  let answerT = 0;
  const plates = $$<HTMLButtonElement>('[data-plate]');
  function learnNote(midi: number) {
    const now = performance.now();
    if (now - phraseT > 1400) lastPhrase = [];
    phraseT = now;
    cont.observe(lastPhrase, midi);
    lastPhrase.push(midi);
    if (lastPhrase.length > 24) lastPhrase.shift();
    clearTimeout(answerT);
    if (contOn)
      answerT = window.setTimeout(() => {
        if (held.length || lastPhrase.length < 3) return;
        const { notes } = cont.continue(lastPhrase, Math.min(16, lastPhrase.length), Math.random);
        const step = 60 / state.p['g.bpm'] / 2;
        const t0 = engine.now + 0.05;
        engine.events(notes.map((m, i) => ({ k: 'n' as const, at: t0 + i * step, hz: tuneHz(m, state.root, state.tuning), vel: 0.75, dur: step * 0.8, slide: 0 as const, t: 0.5, m: 0.5 })));
        status(`the Continuator answers: ${notes.map((m) => NAMES[m % 12]).join(' ')}`);
        lastPhrase = [];
      }, 1100);
  }
  function noteOn(midi: number, vel: number, press = 0.5) {
    if (!engine.ready) return;
    const slide = held.length ? 1 : 0;
    held.push(midi);
    engine.ctl('press', press);
    engine.events([{ k: 'n', at: engine.now + 0.005, hz: tuneHz(midi, state.root, state.tuning), vel, dur: -1, slide, t: press, m: press }]);
    learnNote(midi);
  }
  function noteOff(midi: number) {
    const i = held.lastIndexOf(midi);
    if (i >= 0) held.splice(i, 1);
    if (!engine.ready) return;
    if (held.length) {
      const m = held[held.length - 1];
      engine.events([{ k: 'n', at: engine.now + 0.005, hz: tuneHz(m, state.root, state.tuning), vel: 0.7, dur: -1, slide: 1, t: 0.5, m: 0.5 }]);
    } else engine.events([{ k: 'off', at: engine.now + 0.005 }]);
  }
  const plateMidi = (n: number) => 60 + n + plateOct * 12;
  async function platePress(el: HTMLElement, press: number) {
    const n = Number(el.dataset.plate);
    if (transposeMode) {
      seq.transpose = n === 12 ? 12 : n;
      $('[data-transpose]').textContent = String(seq.transpose);
      plates.forEach((p) => p.classList.toggle('is-trans', p === el));
      drawGrid();
      return;
    }
    if (!(await boot())) return;
    const m = plateMidi(n);
    if (hold && el.classList.contains('is-down')) {
      el.classList.remove('is-down');
      noteOff(m);
      return;
    }
    el.classList.add('is-down');
    noteOn(m, 0.45 + press * 0.55, press);
  }
  function plateRelease(el: HTMLElement) {
    if (hold || transposeMode || !el.classList.contains('is-down')) return;
    el.classList.remove('is-down');
    noteOff(plateMidi(Number(el.dataset.plate)));
  }
  const pressOf = (e: PointerEvent, el: HTMLElement) => {
    if (e.pointerType !== 'mouse' && e.pressure > 0 && e.pressure !== 0.5) return clamp(e.pressure);
    const r = el.getBoundingClientRect();
    return clamp((e.clientY - r.top) / r.height);
  };
  plates.forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      platePress(el, pressOf(e, el));
    });
    el.addEventListener('pointermove', (e) => {
      if (el.classList.contains('is-down') && engine.ready) engine.ctl('press', pressOf(e, el));
    });
    el.addEventListener('pointerup', () => plateRelease(el));
    el.addEventListener('pointercancel', () => plateRelease(el));
  });
  const octVal = $('[data-oct-val]');
  $$<HTMLButtonElement>('[data-oct]').forEach((b) =>
    b.addEventListener('click', () => {
      plateOct = clamp(plateOct + Number(b.dataset.oct), -3, 3);
      octVal.textContent = String(plateOct);
    }),
  );
  const holdBtn = $<HTMLButtonElement>('[data-hold]');
  holdBtn.addEventListener('click', () => {
    hold = !hold;
    holdBtn.setAttribute('aria-pressed', String(hold));
    if (!hold) {
      plates.forEach((p) => p.classList.remove('is-down'));
      held.length = 0;
      if (engine.ready) engine.events([{ k: 'off', at: engine.now }]);
    }
  });
  const transBtn = $<HTMLButtonElement>('[data-transpose-mode]');
  transBtn.addEventListener('click', () => {
    transposeMode = !transposeMode;
    transBtn.setAttribute('aria-pressed', String(transposeMode));
    if (!transposeMode) {
      seq.transpose = 0;
      $('[data-transpose]').textContent = '0';
      plates.forEach((p) => p.classList.remove('is-trans'));
      drawGrid();
    } else status('the obols now transpose the sequence');
  });
  const xy = $('[data-xy]'),
    dot = $('[data-xy-dot]');
  let xyVal = { x: 0.5, y: 0.5 };
  function setXY(x: number, y: number) {
    xyVal = { x: clamp(x), y: clamp(y) };
    dot.style.left = `${xyVal.x * 100}%`;
    dot.style.top = `${(1 - xyVal.y) * 100}%`;
    xy.setAttribute('aria-valuetext', `${xyVal.x.toFixed(2)}, ${xyVal.y.toFixed(2)}`);
    if (engine.ready) {
      engine.ctl('x', xyVal.x);
      engine.ctl('y', xyVal.y);
    }
  }
  const xyFrom = (e: PointerEvent) => {
    const r = xy.getBoundingClientRect();
    setXY((e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height);
  };
  let xyDown = false;
  xy.addEventListener('pointerdown', (e) => {
    xyDown = true;
    xy.setPointerCapture(e.pointerId);
    xyFrom(e);
  });
  xy.addEventListener('pointermove', (e) => xyDown && xyFrom(e));
  xy.addEventListener('pointerup', () => (xyDown = false));
  xy.addEventListener('keydown', (e) => {
    const d = 0.05;
    const m: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] };
    if (!m[e.key]) return;
    e.preventDefault();
    setXY(xyVal.x + m[e.key][0], xyVal.y + m[e.key][1]);
  });
  setXY(0.5, 0.5);

  // MIDI
  const midi = new Midi({
    note(on, n, vel) {
      if (on) noteOn(n, 0.3 + vel * 0.7, vel);
      else noteOff(n);
    },
    cc(cc, v, ch) {
      const key = `${ch}:${cc}`;
      if (learning) {
        learnMap[key] = learning;
        store.set('orfeo:learn', JSON.stringify(learnMap));
        knobs.get(learning)?.classList.remove('is-learning');
        status(`CC ${cc} (ch ${ch + 1}) → ${spec(learning).label}`);
        learning = null;
        return;
      }
      const id = learnMap[key];
      if (!id) return;
      const sp = spec(id);
      setParam(id, sp.min + v * (sp.max - sp.min));
    },
    clock: () => seq.externalClock(),
    start: () => {
      if (seq.external && !seq.playing) toggle();
    },
    stop: () => {
      if (seq.external && seq.playing) toggle();
    },
  });
  seq.midi = midi;
  const midiIn = $<HTMLSelectElement>('[data-midi-in]'),
    midiOut = $<HTMLSelectElement>('[data-midi-out]'),
    midiClock = $<HTMLSelectElement>('[data-midi-clock]');
  async function enableMidi() {
    if (!Midi.supported) return void toast('This browser has no Web MIDI.');
    try {
      await midi.enable();
    } catch {
      return void toast('MIDI access was refused.');
    }
    const fill = () => {
      midiIn.innerHTML = '<option value="all">tutti gli ingressi</option>' + midi.inputs.map((i) => `<option value="${i.id}">${i.name}</option>`).join('');
      midiOut.innerHTML = '<option value="">nessuna uscita</option>' + midi.outputs.map((o) => `<option value="${o.id}">${o.name}</option>`).join('');
    };
    fill();
    midi.access!.addEventListener('statechange', fill);
    [midiIn, midiOut, midiClock].forEach((s) => (s.disabled = false));
    $('[data-midi-enable]').setAttribute('aria-pressed', 'true');
    status(`MIDI: ${midi.inputs.length} in, ${midi.outputs.length} out`);
  }
  $('[data-midi-enable]').addEventListener('click', enableMidi);
  midiIn.addEventListener('change', () => midi.selectInput(midiIn.value));
  midiOut.addEventListener('change', () => midi.selectOutput(midiOut.value));
  midiClock.addEventListener('change', () => {
    const wasPlaying = seq.playing;
    if (wasPlaying) seq.stop();
    seq.external = midiClock.value === 'ext';
    if (wasPlaying && !seq.external) seq.start();
    status(seq.external ? 'following the MIDI clock: start your sequencer' : 'internal clock');
  });

  const micBtn = $<HTMLButtonElement>('[data-mic]');
  micBtn.addEventListener('click', async () => {
    if (!(await boot())) return;
    if (engine.micActive) {
      engine.micOff();
    } else {
      try {
        await engine.micOn();
        if (state.p['src.field'] < 0.1) setParam('src.field', 0.5);
        status('the microphone now runs through the voice (campo)');
      } catch {
        toast('No microphone: access was refused or there is none.');
      }
    }
    micBtn.setAttribute('aria-pressed', String(engine.micActive));
  });

  // ── presets, saving, sharing, recording ────────────────────────────────────
  const presetSel = $<HTMLSelectElement>('[data-preset]');
  const userGroup = $<HTMLOptGroupElement>('[data-user-presets]');
  const userPresets = (): Array<{ n: string; s: OrfeoState }> => {
    try {
      return JSON.parse(store.get('orfeo:presets') ?? '[]');
    } catch {
      return [];
    }
  };
  const fillUser = () => {
    userGroup.innerHTML = userPresets()
      .map((u, i) => `<option value="u${i}">${u.n.replace(/[<&>"]/g, '')}</option>`)
      .join('');
  };
  fillUser();
  presetSel.addEventListener('change', () => {
    snapshot();
    const v = presetSel.value;
    if (v.startsWith('u')) {
      const u = userPresets()[Number(v.slice(1))];
      if (u) setState(sanitize(u.s));
    } else setState(preset(v));
    const p = PRESETS.find((x) => x.id === v);
    status(p ? p.blurb : 'your patch');
  });
  $('[data-save]').addEventListener('click', () => {
    const n = prompt('Name this patch', `Orfeo ${new Date().toISOString().slice(0, 10)}`);
    if (!n) return;
    const list = userPresets();
    list.push({ n: n.slice(0, 40), s: clone(state) });
    store.set('orfeo:presets', JSON.stringify(list.slice(-24)));
    fillUser();
    toast(`Saved “${n}” in this browser.`);
  });
  const download = (blob: Blob, name: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('[data-export]').addEventListener('click', () => download(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }), 'orfeo-32.json'));
  $<HTMLInputElement>('[data-import]').addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      snapshot();
      setState(sanitize(JSON.parse(await f.text())));
      toast('Patch imported.');
    } catch {
      toast('That file is not an Orfeo patch.');
    }
  });
  $('[data-share]').addEventListener('click', async () => {
    const url = `${location.origin}/synth/#s=${await encode(state)}`;
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      toast('Share link copied. It holds the whole instrument: patterns, knobs, cables, pedals.');
    } catch {
      toast('The link is in the address bar.');
    }
  });
  const recBtn = $<HTMLButtonElement>('[data-rec]');
  let stopRec: null | (() => Promise<{ blob: Blob; ext: string }>) = null;
  recBtn.addEventListener('click', async () => {
    if (stopRec) {
      const { blob, ext } = await stopRec();
      stopRec = null;
      recBtn.setAttribute('aria-pressed', 'false');
      recBtn.textContent = '● registra';
      download(blob, `orfeo-32-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`);
      return;
    }
    if (!(await boot())) return;
    if (typeof MediaRecorder === 'undefined') return void toast('This browser cannot record audio.');
    stopRec = engine.record();
    recBtn.setAttribute('aria-pressed', 'true');
    recBtn.textContent = '■ ferma';
  });
  const doUndo = (from: string[], to: string[]) => {
    const s = from.pop();
    if (!s) return;
    to.push(JSON.stringify(state));
    setState(sanitize(JSON.parse(s)));
  };
  $('[data-undo]').addEventListener('click', () => doUndo(undo, redo));
  $('[data-redo]').addEventListener('click', () => doUndo(redo, undo));

  // ── gifts of the gods ────────────────────────────────────────────────────
  const dlg = document.querySelector<HTMLDialogElement>('[data-boon-dialog]')!;
  const cardsEl = dlg.querySelector<HTMLElement>('[data-boon-cards]')!;
  const log = $('[data-boon-log]');
  let offers: Array<Offer & { seed: number }> = [];
  function openBoons() {
    offers = offer().map((o) => ({ ...o, seed: (Math.random() * 2 ** 31) | 0 }));
    cardsEl.innerHTML = offers
      .map((o, k) => {
        const gods = o.boon.gods.map(god);
        const preview = o.boon.apply(clone(state), o.rarity.m, mulberry(o.seed));
        return `<button type="button" class="boon boon--${o.rarity.id}${gods.length > 1 ? ' boon--duo' : ''}" data-take="${k}" style="--god:${gods[0].hue};--god2:${(gods[1] ?? gods[0]).hue}">
          <span class="boon__rarity mono">${gods.length > 1 ? 'Duo · ' : ''}${o.rarity.n}</span>
          <span class="boon__sigil" aria-hidden="true">${gods.map((g) => g.name[0]).join('')}</span>
          <span class="boon__god mono">${gods.map((g) => `${g.name} · ${g.domain}`).join(' + ')}</span>
          <b class="boon__name">${o.boon.name}</b>
          <span class="boon__text">${o.boon.text}</span>
          <span class="boon__fx mono">${preview.map((x) => `<i>${x}</i>`).join('')}</span>
        </button>`;
      })
      .join('');
    dlg.showModal();
  }
  cardsEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-take]');
    if (!b) return;
    const o = offers[Number(b.dataset.take)];
    snapshot();
    const changes = o.boon.apply(state, o.rarity.m, mulberry(o.seed));
    setState(state);
    dlg.close();
    const gods = o.boon.gods.map(god);
    log.querySelector('.gifts__empty')?.remove();
    const li = document.createElement('li');
    li.style.setProperty('--god', gods[0].hue);
    li.innerHTML = `<b>${o.boon.name}</b> <span>${gods.map((g) => g.name).join(' & ')} · ${o.rarity.n}</span> <i>${changes.join(' · ')}</i>`;
    log.prepend(li);
    toast(`${gods.map((g) => g.name).join(' & ')}: ${o.boon.name}. ${changes.join(', ')}.`);
  });
  $$('[data-boon]').forEach((b) => b.addEventListener('click', openBoons));

  // ── the clock made visible ─────────────────────────────────────────────────
  const pendingTicks: TickInfo[] = [];
  const pendingChords: ChordInfo[] = [];
  const pendingNotes: Array<{ midi: number; time: number }> = [];
  seq.onTick = (t) => pendingTicks.push(t);
  seq.onChord = (c) => pendingChords.push(c);
  seq.onNote = (midi, time) => state.feed && pendingNotes.push({ midi, time });
  seq.onLoop = () =>
    requestAnimationFrame(() => {
      secrets.loop();
      drawGrid();
      drawPatterns();
      if (state.colonyGates) status(`the colony wrote: ${P().lanes.gate.slice(0, P().len.gate).map((g) => (g ? 'x' : '.')).join('')}`);
    });
  const life = () => (window as any).__life as { probeRow(y: number): Uint8Array; dropAt(x: number, y: number, k: string): void; onStats(fn: (s: { entropy: number }) => void): () => void } | undefined;
  seq.colonyRow = () => {
    const l = life();
    if (!l) return null;
    const r = grid.getBoundingClientRect();
    const y = r.bottom > 0 && r.top < innerHeight ? r.top + r.height / 2 : innerHeight / 2;
    return l.probeRow(y);
  };
  let offStats: (() => void) | null = null;
  const hookColony = () => {
    const l = life();
    if (!l || offStats) return;
    offStats = l.onStats((s) => engine.ready && engine.ctl('colony', s.entropy));
  };
  hookColony();
  addEventListener('life:ready', hookColony, { once: true });

  let mon: FromDsp | null = null;
  engine.onMon = (m) => (mon = m);
  const srcLeds = $$('[data-src-led]');
  const rampLeds = new Map($$('[data-ramp-led]').map((el) => [el.dataset.rampLed!, el]));
  const loopRing = $('[data-loop-ring]');
  const grainsEl = $('[data-grains]');
  const rollers = $$('[data-roller]');
  let lastPlay = -1;
  let lastLaneIdx = -1;

  // scopes
  const scope = $<HTMLCanvasElement>('[data-scope]');
  const sctx = scope.getContext('2d')!;
  let scopeMode = 'wave';
  $$<HTMLButtonElement>('[data-scope-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      scopeMode = b.dataset.scopeMode!;
      $$<HTMLButtonElement>('[data-scope-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }),
  );
  let tbuf: Float32Array<ArrayBuffer> | null = null,
    fbuf: Uint8Array<ArrayBuffer> | null = null,
    lbuf: Float32Array<ArrayBuffer> | null = null,
    rbuf: Float32Array<ArrayBuffer> | null = null;
  const trins = document.createElement('canvas');
  trins.width = 96;
  trins.height = 54;
  const tctx = trins.getContext('2d')!;
  const timg = tctx.createImageData(96, 54);
  function drawScope() {
    const w = (scope.width = scope.clientWidth * 2),
      h = (scope.height = scope.clientHeight * 2);
    sctx.fillStyle = scopeMode === 'trins' ? '#0a0a0b' : '#ddd3bb';
    sctx.fillRect(0, 0, w, h);
    if (scopeMode !== 'trins') {
      sctx.strokeStyle = 'rgba(22,20,15,0.08)';
      sctx.lineWidth = 1;
      for (let x = 0; x < w; x += 26) sctx.strokeRect(x, -1, 26, h + 2);
      for (let y = 0; y < h; y += 17.5) sctx.strokeRect(-1, y, w + 2, 17.5);
    }
    if (!engine.ready) return;
    const an = engine.analyser;
    tbuf ??= new Float32Array(an.fftSize);
    if (scopeMode === 'wave') {
      an.getFloatTimeDomainData(tbuf);
      // trigger on a rising zero crossing so the wave stands still
      let start = 0;
      for (let i = 1; i < tbuf.length / 2; i++)
        if (tbuf[i - 1] < 0 && tbuf[i] >= 0) {
          start = i;
          break;
        }
      sctx.strokeStyle = '#16140f';
      sctx.lineWidth = 2.2;
      sctx.beginPath();
      const n = tbuf.length / 2;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w,
          y = h / 2 - tbuf[start + i] * h * 0.45;
        i ? sctx.lineTo(x, y) : sctx.moveTo(x, y);
      }
      sctx.stroke();
    } else if (scopeMode === 'spec') {
      fbuf ??= new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(fbuf);
      const bars = 64;
      for (let b = 0; b < bars; b++) {
        const lo = Math.floor(2 ** ((b / bars) * Math.log2(fbuf.length))),
          hi = Math.max(lo + 1, Math.floor(2 ** (((b + 1) / bars) * Math.log2(fbuf.length))));
        let v = 0;
        for (let k = lo; k < hi; k++) v = Math.max(v, fbuf[k]);
        const bh = (v / 255) * h;
        sctx.fillStyle = b % 8 === 0 ? '#ff4b1f' : '#16140f';
        sctx.fillRect((b / bars) * w + 1, h - bh, w / bars - 2, bh);
      }
    } else if (scopeMode === 'xy') {
      lbuf ??= new Float32Array(engine.anL.fftSize);
      rbuf ??= new Float32Array(engine.anR.fftSize);
      engine.anL.getFloatTimeDomainData(lbuf);
      engine.anR.getFloatTimeDomainData(rbuf);
      sctx.strokeStyle = '#2f45ff';
      sctx.lineWidth = 1.6;
      sctx.beginPath();
      for (let i = 0; i < lbuf.length; i++) {
        const x = w / 2 + (lbuf[i] - rbuf[i]) * w * 0.4,
          y = h / 2 - (lbuf[i] + rbuf[i]) * h * 0.4;
        i ? sctx.lineTo(x, y) : sctx.moveTo(x, y);
      }
      sctx.stroke();
    } else {
      // after Gieskes' 3TrinsRGB: three "oscillators" scan the raster, one per colour
      an.getFloatTimeDomainData(tbuf);
      const d = timg.data,
        N = tbuf.length;
      const t = performance.now() / 1000;
      for (let y = 0; y < 54; y++)
        for (let x = 0; x < 96; x++) {
          const i = y * 96 + x;
          const r = tbuf[(i * 3 + Math.floor(t * 40)) % N],
            g = tbuf[(i * 5 + 311) % N],
            b = tbuf[(i * 7 + y * 13) % N];
          const k = i * 4;
          d[k] = r > 0.02 ? 255 : r < -0.02 ? 60 : 0;
          d[k + 1] = Math.abs(g) * 900;
          d[k + 2] = b > 0 ? 200 + b * 200 : 30;
          d[k + 3] = 255;
        }
      tctx.putImageData(timg, 0, 0);
      sctx.imageSmoothingEnabled = false;
      sctx.drawImage(trins, 0, 0, w, h);
    }
  }

  let visible = true;
  const io = new IntersectionObserver((es) => (visible = es[0].isIntersecting));
  io.observe(root);

  let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = engine.now;
    while (pendingTicks.length && pendingTicks[0].time <= now) {
      const t = pendingTicks.shift()!;
      if (lastPlay >= 0) stepEls[lastPlay]?.classList.remove('is-play');
      if (lastLaneIdx >= 0) stepEls[lastLaneIdx]?.classList.remove('is-lane');
      lastPlay = t.idx.gate;
      stepEls[lastPlay]?.classList.add('is-play');
      if (lane !== 'gate' && t.idx[lane] !== t.idx.gate) {
        lastLaneIdx = t.idx[lane];
        stepEls[lastLaneIdx]?.classList.add('is-lane');
      } else lastLaneIdx = -1;
      if (t.fired) {
        const g = gateEls[t.idx.gate];
        g.classList.remove('is-hit');
        void g.offsetWidth;
        g.classList.add('is-hit');
      }
      if (t.pattern !== Number(patBtns.findIndex((b) => b.getAttribute('aria-pressed') === 'true'))) drawPatterns();
    }
    while (pendingChords.length && pendingChords[0].time <= now) showChord(pendingChords.shift()!);
    while (pendingNotes.length && pendingNotes[0].time <= now) {
      const n = pendingNotes.shift()!;
      const r = grid.getBoundingClientRect();
      life()?.dropAt(((n.midi - 36) / 60) * innerWidth, clamp(r.top + Math.random() * r.height, 0, innerHeight), 'glider');
    }
    if (!seq.playing && !pendingTicks.length && lastPlay >= 0) {
      stepEls[lastPlay]?.classList.remove('is-play');
      if (lastLaneIdx >= 0) stepEls[lastLaneIdx]?.classList.remove('is-lane');
      lastPlay = lastLaneIdx = -1;
    }
    if (!visible) return;
    if (mon) {
      mon.s.forEach((v, i) => srcLeds[i]?.style.setProperty('--v', String(Math.min(1, Math.abs(v)))));
      PEDALS.forEach((p, i) => rampLeds.get(p.id)?.style.setProperty('--v', String(state.p[`fx.${p.id}.rmode`] ? mon!.r[i] : 0)));
      loopRing.style.setProperty('--p', String(Math.max(0, mon.loop)));
      loopRing.classList.toggle('is-held', mon.held === 1);
      captureBtn.setAttribute('aria-pressed', String(mon.held === 1));
      grainsEl.textContent = String(mon.grains);
    }
    // the Rollz, drawn as five balls rolling at their own division of the bar
    const bar = (60 / state.p['g.bpm']) * 4;
    rollers.forEach((el, i) => {
      const d = state.p[`rz.d${i + 1}`];
      const ph = d > 0 && state.p['rz.on'] ? ((now / bar) * d) % 1 : 0;
      el.style.setProperty('--ph', String(ph));
      el.classList.toggle('is-off', !(d > 0 && state.p['rz.on']));
    });
    drawScope();
  };
  raf = requestAnimationFrame(frame);

  // ── keyboard ────────────────────────────────────────────────────────────
  const KEYS = 'awsedftgyhujk';
  const keyDown = new Set<string>();
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!document.body.contains(root) || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || document.querySelector('dialog[open]')) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) doUndo(redo, undo);
      else doUndo(undo, redo);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    secrets.key(e.key);
    if (e.key === ' ' && !t.closest('button, [role=slider], [role=tab]')) {
      e.preventDefault();
      toggle();
    } else if (e.key === 'Escape') panic();
    else if (KEYS.includes(k) && k.length === 1) {
      e.preventDefault();
      if ('gjk'.includes(k)) e.stopImmediatePropagation(); // G (go to…), J, K (posts) are the site's too
      if (e.repeat || keyDown.has(k)) return;
      keyDown.add(k);
      const el = plates[KEYS.indexOf(k)];
      platePress(el, 0.6);
    } else if (k === 'z' || k === 'x') {
      e.preventDefault();
      plateOct = clamp(plateOct + (k === 'x' ? 1 : -1), -3, 3);
      octVal.textContent = String(plateOct);
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (!keyDown.has(k)) return;
    keyDown.delete(k);
    plateRelease(plates[KEYS.indexOf(k)]);
  };
  addEventListener('keydown', onKey, { capture: true });
  addEventListener('keyup', onKeyUp, { capture: true });

  // ── secrets ─────────────────────────────────────────────────────────────
  // Not in the manual. Some things only happen if you look back.
  const secrets = (() => {
    const done = new Set<string>();
    const once = (k: string) => (done.has(k) ? false : (done.add(k), true));
    const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    let konami = 0;
    let typed = '';
    let restT = 0;
    let loops = 0;
    const scaleMidi = (deg: number) => seq.noteMidi(deg).midi;
    return {
      /** The site's Konami code wakes the colony; here the lyre answers it. */
      async key(key: string) {
        konami = key === KONAMI[konami] || key.toLowerCase() === KONAMI[konami] ? konami + 1 : key === KONAMI[0] ? 1 : 0;
        if (konami === KONAMI.length) {
          konami = 0;
          if (!(await boot())) return;
          const t0 = engine.now + 0.05;
          engine.events([0, 2, 4, 7, 9, 11, 14, 16].map((d, i) => ({ k: 'c' as const, at: t0 + i * 0.09, hz: tuneHz(scaleMidi(d) + 12, state.root, state.tuning), vel: 0.8, dur: 1.6 - i * 0.1, kind: 1 as const })));
          status('♪ the lyre answers the colony');
        }
        if (key.length === 1 && /[a-z]/i.test(key)) {
          typed = (typed + key.toLowerCase()).slice(-12);
          if (typed.endsWith('orfeo')) this.lament();
        }
      },
      /** Type his name: the lament bass, a minor tetrachord falling from the tonic to the dominant. */
      async lament() {
        if (!(await boot())) return;
        const r = state.root;
        const bar = (60 / state.p['g.bpm']) * 4;
        const t0 = engine.now + 0.1;
        const bass = [0, -2, -4, -5].map((i) => 36 + r + i + 12);
        const chords = [
          [0, 3, 7],
          [-2, 2, 7],
          [-4, 0, 5],
          [-5, -1, 2],
        ];
        const ev: Parameters<typeof engine.events>[0] = [];
        bass.forEach((m, i) => {
          ev.push({ k: 'n', at: t0 + i * bar * 0.5, hz: tuneHz(m, r, state.tuning), vel: 0.8, dur: bar * 0.48, slide: 0, t: 0.3, m: 0.5 });
          for (const iv of chords[i]) ev.push({ k: 'c', at: t0 + i * bar * 0.5, hz: tuneHz(60 + r + iv, r, state.tuning), vel: 0.6, dur: bar * 0.5, kind: 0 });
        });
        engine.events(ev);
        status('Lamento: the descending minor tetrachord, as in Monteverdi’s Lamento della ninfa (1638)');
      },
      /** Rest on 137 (or 110) bpm and the gates start to compute. */
      param(id: string, v: number) {
        if (id === 'g.bpm') {
          clearTimeout(restT);
          if (v === 137 || v === 110)
            restT = window.setTimeout(() => {
              if (state.p['g.bpm'] !== v) return;
              P().ca = { on: true, rule: v };
              drawGrid();
              status(v === 137 ? 'Rule 137 ≅ Rule 110: eight bits that compute everything. The gates are computing now.' : 'Rule 110 at 110 bpm: the gates are Turing-complete now.');
            }, 700);
        }
        if (id === 'g.heat' && v >= 0.999 && once('heat')) {
          life()?.dropAt(innerWidth * (0.2 + Math.random() * 0.6), innerHeight * (0.2 + Math.random() * 0.6), 'gun');
          status('calore massimo: even the colony has caught fire (a glider gun)');
        }
      },
      /** Orpheus turned round at the last moment, and Eurydice went back to the shades. */
      lookBack() {
        if (!engine.ready || !state.harm.on || state.p['co.level'] < 0.05 || !once('look')) return;
        engine.param('co.level', 0);
        status('Orfeo si è voltato. Euridice torna tra le ombre.');
        setTimeout(() => {
          engine.param('co.level', state.p['co.level']);
          status('…and the song goes on anyway.');
        }, 7000);
      },
      /** Song mode through all eight chambers. */
      loop() {
        const all = new Set(state.chain).size === 8;
        loops = all ? loops + 1 : 0;
        if (all && loops >= state.chain.length && once('escape')) status('Eight chambers crossed. The surface is cold; the song goes back down.');
      },
    };
  })();
  if (new Date().getHours() === 0) status('mezzanotte: the gates are open');

  // ── everything at once ──────────────────────────────────────────────────
  function refreshAll() {
    for (const el of knobs.values()) el.show?.();
    syncSwitches();
    root.style.setProperty('--heat', String(state.p['g.heat']));
    rootSel.value = String(state.root);
    scaleSel.value = state.scale;
    tuneSel.value = state.tuning;
    colonyBtn.setAttribute('aria-pressed', String(state.colonyGates));
    feedBtn.setAttribute('aria-pressed', String(state.feed));
    drawGrid();
    drawPatterns();
    drawHarm();
    drawBoard();
    drawCables();
    drawCableList();
  }

  const fromHash = new URLSearchParams(location.hash.slice(1)).get('s');
  if (fromHash)
    decode(fromHash).then((s) => {
      if (s) {
        setState(s);
        status('patch loaded from the link');
      } else toast('That link does not hold an Orfeo patch.');
    });
  refreshAll();

  document.addEventListener(
    'astro:before-swap',
    () => {
      removeEventListener('keydown', onKey, { capture: true });
      removeEventListener('keyup', onKeyUp, { capture: true });
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      offStats?.();
      seq.stop();
      patSigils.forEach((s) => s?.stop());
      engine.dispose();
      dlg.close();
    },
    { once: true },
  );
}
