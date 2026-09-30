/**
 * Operatori on the panel: banks and patterns, tracks, the step grid, the trig
 * editor with parameter locks, the sound pages, the arpeggiator, the Euclidean
 * generator, the keyboard (with live recording), and song mode.
 */
import type { Ctx } from './ui-kit';
import { bindDrag, clamp, paintKnob, capture } from './ui-kit';
import type { FromG } from './msg';
import { LFO_DST, MACHINE_ABBR, MACHINE_SLOTS, PAGES, TIDX, noteName, setMachine, trackSpec } from './params';
import {
  CONDS,
  PAGE,
  STEPS,
  TRACKS,
  euclidTrack,
  lenName,
  masterLen,
  newPattern,
  newTrig,
  patName,
  trackLen,
  type Pattern,
  type Project,
  type Trig,
} from './seq';
import { SOUNDS, build } from './demo';
import { saveProject } from './store';

const SCALE_STEPS = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  [0, 2, 3, 5, 7, 8, 10],
  [0, 2, 4, 5, 7, 9, 11],
  [0, 2, 3, 5, 7, 9, 10],
  [0, 3, 5, 7, 10],
  [0, 1, 3, 5, 7, 8, 10],
];
const KEYMAP = 'awsedftgyhujk';

export function mountOper(ctx: Ctx, proj: Project) {
  const { $, $$, engine } = ctx;
  let k = 0,
    page = 0,
    sel: number | null = null,
    spage = 'syn1',
    oct = 3,
    queued = -1,
    liveRec = false,
    fillLatch = false;
  const mute = new Array(TRACKS).fill(false),
    solo = new Array(TRACKS).fill(false);
  let clip: string | null = null;
  const undo: string[] = [];
  let lastSnap = 0;

  const pat = (): Pattern => (proj.pats[proj.cur] ??= newPattern());
  const trk = () => pat().tracks[k];
  const len = () => trackLen(pat(), k);
  const machine = () => trk().snd[0] | 0;

  // ── sending and keeping ─────────────────────────────────────────────────────────
  let sendT = 0,
    saveT = 0;
  function changed(fast = false) {
    clearTimeout(sendT);
    sendT = window.setTimeout(() => engine.send({ t: 'pat', i: proj.cur, pat: pat() }), fast ? 0 : 60);
    clearTimeout(saveT);
    saveT = window.setTimeout(() => saveProject(proj), 800);
  }
  function snap() {
    const now = performance.now();
    if (now - lastSnap < 600) return;
    lastSnap = now;
    undo.push(JSON.stringify(pat()));
    if (undo.length > 40) undo.shift();
  }
  const sendMutes = () => {
    const any = solo.some(Boolean);
    engine.send({ t: 'mutes', m: mute.map((m, i) => (any ? (solo[i] ? 0 : 1) : m ? 1 : 0)) });
  };

  // ── patterns ─────────────────────────────────────────────────────────────────────
  const banks = $$<HTMLButtonElement>('[data-bank]');
  const pats = $$<HTMLButtonElement>('[data-pat]');
  let bank = Math.floor(proj.cur / 16);
  const hasTrigs = (p: Pattern | null) => !!p && p.tracks.some((t) => t.steps.some(Boolean));
  function renderPats() {
    banks.forEach((b, i) => b.setAttribute('aria-pressed', String(i === bank)));
    pats.forEach((b, i) => {
      const idx = bank * 16 + i;
      b.classList.toggle('has-data', hasTrigs(proj.pats[idx]));
      b.classList.toggle('is-cur', idx === proj.cur);
      b.classList.toggle('is-queued', idx === queued);
      b.setAttribute('aria-pressed', String(idx === proj.cur));
      b.setAttribute('aria-label', `pattern ${patName(idx)}${idx === proj.cur ? ' (playing)' : ''}`);
    });
    $('[data-patname]').textContent = `${patName(proj.cur)}${queued >= 0 ? ` → ${patName(queued)}` : ''}`;
  }
  banks.forEach((b) =>
    b.addEventListener('click', () => {
      bank = Number(b.dataset.bank);
      renderPats();
    }),
  );
  pats.forEach((b) =>
    b.addEventListener('click', async (e) => {
      const idx = bank * 16 + Number(b.dataset.pat);
      if (!proj.pats[idx]) {
        proj.pats[idx] = newPattern(pat());
        engine.send({ t: 'pat', i: idx, pat: proj.pats[idx] });
      }
      const playing = !!ctx.mon?.playing;
      if (playing && !e.shiftKey) {
        queued = idx;
        engine.send({ t: 'queue', i: idx });
        ctx.status(`${patName(idx)} is cued: it starts when ${patName(proj.cur)} ends (shift-click to jump)`);
      } else {
        proj.cur = idx;
        queued = -1;
        sel = null;
        engine.send({ t: 'queue', i: idx });
        if (playing) engine.send({ t: 'play' });
        saveProject(proj);
      }
      renderAll();
    }),
  );
  $$<HTMLButtonElement>('[data-pact]').forEach((b) => b.addEventListener('click', () => patAction(b.dataset.pact!)));
  function patAction(a: string) {
    if (a === 'copy') {
      clip = JSON.stringify(pat());
      ctx.status(`${patName(proj.cur)} copied`);
    } else if (a === 'paste') {
      if (!clip) return ctx.status('nothing copied yet');
      snap();
      lastSnap = 0;
      proj.pats[proj.cur] = JSON.parse(clip);
      ctx.status(`pasted into ${patName(proj.cur)}`);
    } else if (a === 'clear') {
      snap();
      lastSnap = 0;
      pat().tracks.forEach((t) => t.steps.fill(null));
      sel = null;
      ctx.status(`${patName(proj.cur)} cleared (the sounds stay; annulla brings the trigs back)`);
    } else if (a === 'undo') {
      const u = undo.pop();
      if (!u) return ctx.status('nothing to undo');
      proj.pats[proj.cur] = JSON.parse(u);
      sel = null;
      ctx.status('undone');
    }
    changed(true);
    renderAll();
  }

  // ── tracks ──────────────────────────────────────────────────────────────────────
  const trkBtns = $$<HTMLButtonElement>('[data-trk]');
  function renderTracks() {
    trkBtns.forEach((b, i) => {
      b.setAttribute('aria-checked', String(i === k));
      const t = pat().tracks[i];
      $(`[data-trk-m="${i}"]`).textContent = MACHINE_ABBR[t.snd[0] | 0];
      b.classList.toggle('has-trigs', t.steps.some(Boolean) || !!t.eu.on);
    });
    $$<HTMLButtonElement>('[data-mute]').forEach((b, i) => b.setAttribute('aria-pressed', String(mute[i])));
    $$<HTMLButtonElement>('[data-solo]').forEach((b, i) => b.setAttribute('aria-pressed', String(solo[i])));
  }
  trkBtns.forEach((b) =>
    b.addEventListener('click', () => {
      k = Number(b.dataset.trk);
      sel = null;
      if (page * PAGE >= len()) page = 0;
      renderAll();
    }),
  );
  $$<HTMLButtonElement>('[data-mute]').forEach((b, i) =>
    b.addEventListener('click', () => {
      mute[i] = !mute[i];
      sendMutes();
      renderTracks();
    }),
  );
  $$<HTMLButtonElement>('[data-solo]').forEach((b, i) =>
    b.addEventListener('click', () => {
      solo[i] = !solo[i];
      sendMutes();
      renderTracks();
    }),
  );

  // ── the grid ─────────────────────────────────────────────────────────────────────
  const steps = $$<HTMLButtonElement>('[data-sq]');
  const pageBtns = $$<HTMLButtonElement>('[data-page]');
  function renderSteps() {
    const t = trk();
    const L = len();
    const eu = t.eu.on ? euclidTrack(t.eu, L) : null;
    pageBtns.forEach((b, i) => {
      b.disabled = i * PAGE >= L;
      b.setAttribute('aria-pressed', String(i === page));
    });
    steps.forEach((b, i) => {
      const s = page * PAGE + i;
      const tr = t.steps[s];
      const inside = s < L;
      const pulse = eu ? eu[s] : false;
      b.disabled = !inside;
      b.classList.toggle('is-note', inside && (tr?.k === 1 || (!!eu && pulse)));
      b.classList.toggle('is-lock', inside && tr?.k === 2);
      b.classList.toggle('is-eu', inside && !!eu && pulse);
      b.classList.toggle('is-sel', s === sel);
      b.classList.toggle('is-beat', i % 4 === 0);
      b.setAttribute('aria-pressed', String(!!tr || (!!eu && pulse)));
      const note = tr?.k === 1 ? tr.n.map(noteName).join(' ') : tr?.k === 2 ? 'lock' : eu && pulse ? noteName(t.snd[TIDX.note]) : '';
      b.querySelector<HTMLElement>('[data-sq-note]')!.textContent = inside ? note : '';
      b.classList.toggle('has-cond', !!tr && tr.c > 0);
      b.classList.toggle('has-lock', !!tr?.lk && Object.keys(tr.lk).length > 0);
      b.classList.toggle('has-rt', !!tr && tr.rt >= 0);
      b.classList.toggle('has-mt', !!tr && tr.mt !== 0);
      b.setAttribute('aria-label', `step ${s + 1}${note ? `: ${note}` : ''}${tr && tr.c ? `, ${CONDS[tr.c].label}` : ''}`);
      b.title = tr
        ? `${tr.k === 1 ? tr.n.map(noteName).join(' ') : 'lock trig'} · vel ${tr.v} · ${lenName(tr.l)} step${tr.c ? ` · ${CONDS[tr.c].label}` : ''}${tr.mt ? ` · micro ${tr.mt > 0 ? '+' : ''}${tr.mt}/24` : ''}${tr.rt >= 0 ? ' · retrig' : ''}`
        : '';
    });
    // the head: length, speed, modes
    const p = pat();
    $<HTMLSelectElement>('[data-tlen]').value = String(p.mode === 0 ? p.len : trk().len);
    $<HTMLSelectElement>('[data-tscale]').value = String(p.mode === 0 ? p.sc : trk().sc);
    $<HTMLSelectElement>('[data-pmode]').value = String(p.mode);
    $<HTMLSelectElement>('[data-pml]').value = String(p.ml);
    $('[data-ml-wrap]').hidden = p.mode === 0;
    $('[data-eu-on]').setAttribute('aria-pressed', String(!!t.eu.on));
    $('[data-eu]').hidden = !t.eu.on;
    $$<HTMLInputElement>('[data-eu-f]').forEach((inp) => {
      const f = inp.dataset.euF as 'p1' | 'p2' | 'r1' | 'r2' | 'tr';
      inp.max = String(L);
      inp.value = String(t.eu[f]);
    });
    $<HTMLSelectElement>('[data-eu-op]').value = String(t.eu.op);
  }
  pageBtns.forEach((b) =>
    b.addEventListener('click', () => {
      page = Number(b.dataset.page);
      renderSteps();
    }),
  );
  function toggleStep(s: number, lock: boolean) {
    snap();
    const t = trk();
    if (t.steps[s]) {
      t.steps[s] = null;
      if (sel === s) sel = null;
    } else {
      const tr = newTrig(t.snd[TIDX.note]);
      if (lock) {
        tr.k = 2;
        sel = s;
      }
      t.steps[s] = tr;
    }
    changed(true);
    renderSteps();
    renderTrig();
    renderSound();
    renderTracks();
  }
  function select(s: number) {
    sel = sel === s ? null : s;
    renderSteps();
    renderTrig();
    renderSound();
    if (sel !== null) ctx.status(`step ${s + 1} selected: turn any sound knob to lock it on this step; esc to let go`);
  }
  steps.forEach((b, i) => {
    let press = 0,
      long = false;
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      long = false;
      press = window.setTimeout(() => {
        long = true;
        select(page * PAGE + i);
      }, 450);
    });
    const cancel = () => clearTimeout(press);
    b.addEventListener('pointerleave', cancel);
    b.addEventListener('pointercancel', cancel);
    b.addEventListener('click', (e) => {
      clearTimeout(press);
      if (long) return;
      const s = page * PAGE + i;
      if (e.shiftKey) select(s);
      else toggleStep(s, e.altKey);
    });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  $<HTMLSelectElement>('[data-tlen]').addEventListener('change', (e) => {
    snap();
    const v = Number((e.target as HTMLSelectElement).value);
    if (pat().mode === 0) pat().len = v;
    else trk().len = v;
    if (page * PAGE >= v) page = 0;
    changed();
    renderSteps();
  });
  $<HTMLSelectElement>('[data-tscale]').addEventListener('change', (e) => {
    const v = Number((e.target as HTMLSelectElement).value);
    if (pat().mode === 0) pat().sc = v;
    else trk().sc = v;
    changed();
  });
  $<HTMLSelectElement>('[data-pmode]').addEventListener('change', (e) => {
    const p = pat();
    const v = Number((e.target as HTMLSelectElement).value) as 0 | 1;
    if (v === 1 && p.mode === 0) {
      p.tracks.forEach((t) => {
        t.len = p.len;
        t.sc = p.sc;
      });
      p.ml = Math.round(masterLen(p));
    }
    if (v === 0 && p.mode === 1) {
      p.len = p.tracks[k].len;
      p.sc = p.tracks[k].sc;
    }
    p.mode = v;
    changed();
    renderSteps();
  });
  $<HTMLSelectElement>('[data-pml]').addEventListener('change', (e) => {
    pat().ml = Number((e.target as HTMLSelectElement).value);
    changed();
  });
  $('[data-eu-on]').addEventListener('click', () => {
    snap();
    const t = trk();
    t.eu.on = t.eu.on ? 0 : 1;
    changed(true);
    renderSteps();
    renderTracks();
    ctx.status(t.eu.on ? 'Euclidean mode: the trigs come from the generators below; placed trigs still give their notes and locks' : 'Euclidean mode off');
  });
  $$<HTMLInputElement>('[data-eu-f]').forEach((inp) =>
    inp.addEventListener('input', () => {
      const f = inp.dataset.euF as 'p1' | 'p2' | 'r1' | 'r2' | 'tr';
      trk().eu[f] = clamp(Math.round(Number(inp.value) || 0), 0, len());
      changed();
      renderSteps();
    }),
  );
  $<HTMLSelectElement>('[data-eu-op]').addEventListener('change', (e) => {
    trk().eu.op = Number((e.target as HTMLSelectElement).value);
    changed();
    renderSteps();
  });

  // ── the trig editor ───────────────────────────────────────────────────────────────
  const trigEl = $('[data-trig]');
  const tsel = (n: string) => $<HTMLSelectElement | HTMLInputElement>(n);
  function curTrig(): Trig | null {
    return sel === null ? null : trk().steps[sel];
  }
  function renderTrig() {
    const tr = curTrig();
    trigEl.hidden = sel === null;
    $('[data-lockhint]').hidden = sel === null;
    if (sel === null) return;
    $('[data-trig-title]').textContent = `traccia ${k + 1} · passo ${sel + 1}${tr ? '' : ' (vuoto: una manopola crea un lock)'}`;
    const t = tr ?? newTrig(trk().snd[TIDX.note]);
    $$<HTMLButtonElement>('[data-tk]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.tk) === (tr ? tr.k : 1))));
    for (let i = 0; i < 4; i++) tsel(`[data-tn="${i}"]`).value = String(t.n[i] ?? -1);
    tsel('[data-tv]').value = String(t.v);
    $('[data-tv-o]').textContent = String(t.v);
    tsel('[data-tl]').value = String(t.l);
    tsel('[data-tmt]').value = String(t.mt);
    $('[data-tmt-o]').textContent = `${t.mt > 0 ? '+' : ''}${t.mt}`;
    tsel('[data-tc]').value = String(t.c);
    tsel('[data-trt]').value = String(t.rt);
    tsel('[data-trl]').value = String(t.rl);
    tsel('[data-trv]').value = String(Math.round(t.rv * 100));
    $('[data-trv-o]').textContent = `${Math.round(t.rv * 100)}`;
    ($('[data-tsl]') as HTMLInputElement).checked = !!t.sl;
    const lk = t.lk ? Object.entries(t.lk) : [];
    $('[data-locks]').textContent = lk.length
      ? `locks: ${lk.map(([i, v]) => `${trackSpec(+i, machine()).label || i} ${fmtT(+i, v)}`).join(' · ')}`
      : 'no locks: turn a knob below while this step is selected';
  }
  function editTrig(f: (t: Trig) => void) {
    if (sel === null) return;
    snap();
    const t = trk();
    t.steps[sel] ??= newTrig(t.snd[TIDX.note]);
    f(t.steps[sel]!);
    changed(true);
    renderSteps();
    renderTrig();
  }
  $$<HTMLButtonElement>('[data-tk]').forEach((b) => b.addEventListener('click', () => editTrig((t) => (t.k = Number(b.dataset.tk) as 1 | 2))));
  for (let i = 0; i < 4; i++)
    tsel(`[data-tn="${i}"]`).addEventListener('change', (e) =>
      editTrig((t) => {
        const v = Number((e.target as HTMLSelectElement).value);
        const n = [...t.n];
        if (v < 0) n.splice(i, 1);
        else n[i] = v;
        t.n = n.filter((x) => x !== undefined && x >= 0).slice(0, 4);
        if (!t.n.length) t.n = [trk().snd[TIDX.note]];
        audition(t.n);
      }),
    );
  const onInput = (sel2: string, f: (t: Trig, v: number) => void, ev = 'change') =>
    tsel(sel2).addEventListener(ev, (e) => editTrig((t) => f(t, Number((e.target as HTMLInputElement).value))));
  onInput('[data-tv]', (t, v) => (t.v = v), 'input');
  onInput('[data-tl]', (t, v) => (t.l = v));
  onInput('[data-tmt]', (t, v) => (t.mt = v), 'input');
  onInput('[data-tc]', (t, v) => (t.c = v));
  onInput('[data-trt]', (t, v) => (t.rt = v));
  onInput('[data-trl]', (t, v) => (t.rl = v));
  onInput('[data-trv]', (t, v) => (t.rv = v / 100), 'input');
  $('[data-tsl]').addEventListener('change', (e) => editTrig((t) => (t.sl = (e.target as HTMLInputElement).checked ? 1 : 0)));
  $('[data-clear-locks]').addEventListener('click', () => {
    editTrig((t) => (t.lk = null));
    renderSound();
  });
  $('[data-trig-close]').addEventListener('click', () => select(sel!));

  // ── the sound: pages of eight knobs ─────────────────────────────────────────────────
  const spagesEl = $('[data-spages]');
  const pknobs = $$<HTMLElement & { idx?: number }>('[data-pk]');
  function pageList() {
    const slots = MACHINE_SLOTS[machine()];
    return PAGES.filter((p) => !p.id.startsWith('syn') || p.ids.some((id) => id && slots[Number(id.slice(1))]?.label));
  }
  function fmtT(i: number, v: number) {
    const s = trackSpec(i, machine());
    if (s.id.endsWith('.dst')) {
      const name = LFO_DST[Math.round(v)] ?? '—';
      const m = /^s(\d+)$/.exec(name);
      return m ? MACHINE_SLOTS[machine()][Number(m[1])]?.label || name : name;
    }
    if (s.pos) return s.pos[Math.round(v)] ?? '';
    if (s.fmt === 'st') return `${v > 0 ? '+' : ''}${Math.round(v)} st`;
    if (s.fmt === 'note') return noteName(v);
    if (s.fmt === 'cent') return `${v > 0 ? '+' : ''}${Math.round(v)}¢`;
    return String(Math.round(v));
  }
  function renderSound() {
    $<HTMLSelectElement>('[data-mach]').value = String(machine());
    const list = pageList();
    if (!list.some((p) => p.id === spage)) spage = list[0].id;
    spagesEl.innerHTML = list
      .map((p) => `<button type="button" role="tab" class="spage" data-spage="${p.id}" aria-selected="${p.id === spage}">${p.name}</button>`)
      .join('');
    const pg = PAGES.find((p) => p.id === spage)!;
    const tr = curTrig();
    pknobs.forEach((el, i) => {
      const id = pg.ids[i];
      const idx = id ? TIDX[id] : -1;
      const s = idx >= 0 ? trackSpec(idx, machine()) : null;
      const live = !!s && !!s.label && s.max > s.min;
      el.hidden = !live;
      el.idx = live ? idx : -1;
      if (!live || !s) return;
      const locked = tr?.lk?.[idx];
      const v = locked ?? trk().snd[idx];
      el.classList.toggle('is-locked', locked !== undefined);
      el.setAttribute('aria-label', `${s.label}${s.hint ? `: ${s.hint}` : ''}`);
      el.setAttribute('aria-valuemin', String(s.min));
      el.setAttribute('aria-valuemax', String(s.max));
      el.title = s.hint ?? '';
      el.querySelector('[data-pk-label]')!.textContent = s.label;
      paintKnob(el, v, s.min, s.max, fmtT(idx, v));
    });
  }
  spagesEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-spage]');
    if (!b) return;
    spage = b.dataset.spage!;
    renderSound();
  });
  function setTrackParam(idx: number, v: number) {
    const s = trackSpec(idx, machine());
    v = clamp(Math.round(v), s.min, s.max);
    const t = trk();
    if (sel !== null) {
      // a parameter lock on the selected step
      t.steps[sel] ??= { ...newTrig(t.snd[TIDX.note]), k: 2 };
      const tr = t.steps[sel]!;
      tr.lk = { ...(tr.lk ?? {}), [idx]: v };
      changed(true);
      renderSteps();
      renderTrig();
    } else {
      t.snd[idx] = v;
      engine.send({ t: 'tp', k, i: idx, v });
      if (liveRec && ctx.mon?.playing) {
        // live recording: knob moves become locks on the step playing now
        const s2 = ctx.mon.steps[k];
        if (s2 >= 0) {
          t.steps[s2] ??= { ...newTrig(t.snd[TIDX.note]), k: 2 };
          const tr = t.steps[s2]!;
          tr.lk = { ...(tr.lk ?? {}), [idx]: v };
          renderSteps();
        }
      }
      changed();
    }
    renderSound();
  }
  pknobs.forEach((el) => {
    const get = () => {
      const idx = el.idx ?? -1;
      if (idx < 0) return 0;
      return curTrig()?.lk?.[idx] ?? trk().snd[idx];
    };
    const spec = () => trackSpec(el.idx ?? 0, machine());
    bindDrag(
      el,
      get,
      (v) => (el.idx ?? -1) >= 0 && setTrackParam(el.idx!, v),
      () => spec().min,
      () => spec().max,
      1,
      () => {
        const idx = el.idx ?? -1;
        if (idx < 0) return;
        const tr = curTrig();
        if (tr?.lk && tr.lk[idx] !== undefined) {
          const rest = { ...tr.lk };
          delete rest[idx];
          tr.lk = Object.keys(rest).length ? rest : null;
          changed(true);
          renderSteps();
          renderTrig();
          renderSound();
        } else setTrackParam(idx, spec().def);
      },
    );
  });
  $<HTMLSelectElement>('[data-mach]').addEventListener('change', (e) => {
    snap();
    setMachine(trk().snd, Number((e.target as HTMLSelectElement).value));
    spage = 'syn1';
    changed(true);
    renderSound();
    renderTracks();
  });
  $<HTMLSelectElement>('[data-preset]').addEventListener('change', (e) => {
    const s = (e.target as HTMLSelectElement).value;
    if (s === '') return;
    snap();
    const sound = SOUNDS[Number(s)];
    trk().snd = build(sound);
    changed(true);
    renderSound();
    renderTracks();
    ctx.status(`traccia ${k + 1}: ${sound.name}`);
    (e.target as HTMLSelectElement).value = '';
    audition([trk().snd[TIDX.note]]);
  });

  // ── arpeggiator ────────────────────────────────────────────────────────────────────
  function renderArp() {
    const a = trk().arp;
    $$<HTMLSelectElement>('[data-arp-f]').forEach((s) => (s.value = String(a[s.dataset.arpF as 'm' | 'sp' | 'r' | 'nl' | 'len'])));
    $$<HTMLButtonElement>('[data-arp-bit]').forEach((b, i) => {
      b.setAttribute('aria-pressed', String(!!((a.mask >> i) & 1)));
      b.disabled = i >= a.len;
    });
    $$<HTMLInputElement>('[data-arp-ofs]').forEach((inp, i) => {
      inp.value = String(a.ofs[i] ?? 0);
      inp.disabled = i >= a.len;
    });
    $('[data-arp-state]').textContent = a.m ? `${['off', 'vero', 'su', 'giù', 'ciclo', 'mescola', 'caso'][a.m]} · traccia ${k + 1}` : 'off';
  }
  $$<HTMLSelectElement>('[data-arp-f]').forEach((s) =>
    s.addEventListener('change', () => {
      const a = trk().arp;
      a[s.dataset.arpF as 'm' | 'sp' | 'r' | 'nl' | 'len'] = Number(s.value);
      changed();
      renderArp();
    }),
  );
  $$<HTMLButtonElement>('[data-arp-bit]').forEach((b, i) =>
    b.addEventListener('click', () => {
      trk().arp.mask ^= 1 << i;
      changed();
      renderArp();
    }),
  );
  $$<HTMLInputElement>('[data-arp-ofs]').forEach((inp, i) =>
    inp.addEventListener('input', () => {
      trk().arp.ofs[i] = clamp(Math.round(Number(inp.value) || 0), -24, 24);
      changed();
    }),
  );

  // ── the keyboard ───────────────────────────────────────────────────────────────────
  const keyEls = $$<HTMLButtonElement>('[data-key]');
  const scaleSel = $<HTMLSelectElement>('[data-kb-scale]'),
    rootSel = $<HTMLSelectElement>('[data-kb-root]');
  scaleSel.value = String(proj.scale ?? 0);
  rootSel.value = String(proj.root ?? 0);
  const inScale = (n: number) => SCALE_STEPS[Number(scaleSel.value)].includes((((n - Number(rootSel.value)) % 12) + 12) % 12);
  const snapNote = (n: number) => {
    let m = n;
    while (!inScale(m) && m > n - 12) m--;
    return m;
  };
  const base = () => 12 * (oct + 1);
  function renderKeys() {
    $('[data-oct-read]').textContent = `C${oct}`;
    keyEls.forEach((b, i) => {
      const n = base() + i;
      b.classList.toggle('is-out', !inScale(n));
      b.setAttribute('aria-label', noteName(n));
    });
  }
  const sounding = new Map<number, number>();
  async function noteOn(n: number, id: number) {
    if (!(await ctx.boot())) return;
    n = snapNote(n);
    sounding.set(id, n);
    const rec = liveRec && !!ctx.mon?.playing;
    engine.send({ t: 'key', k, n, v: 100, on: true, rec });
    keyEls[n - base()]?.classList.add('is-down');
    if (sel !== null && !rec) {
      editTrig((t) => {
        if (shiftDown && t.n.length < 4 && !t.n.includes(n)) t.n = [...t.n, n];
        else t.n = [n];
        t.k = 1;
      });
    }
  }
  function noteOff(id: number) {
    const n = sounding.get(id);
    if (n === undefined) return;
    sounding.delete(id);
    engine.send({ t: 'key', k, n, v: 0, on: false, rec: liveRec && !!ctx.mon?.playing });
    keyEls[n - base()]?.classList.remove('is-down');
  }
  function audition(ns: number[]) {
    if (!ctx.mon) return;
    for (const n of ns) engine.send({ t: 'key', k, n, v: 90, on: true, rec: false });
    setTimeout(() => ns.forEach((n) => engine.send({ t: 'key', k, n, v: 0, on: false, rec: false })), 260);
  }
  keyEls.forEach((b, i) => {
    b.addEventListener('pointerdown', (e) => {
      capture(b, e.pointerId);
      noteOn(base() + i, 1000 + e.pointerId);
    });
    const up = (e: PointerEvent) => noteOff(1000 + e.pointerId);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        noteOn(base() + i, 2000 + i);
      }
    });
    b.addEventListener('keyup', (e) => {
      if (e.key === 'Enter' || e.key === ' ') noteOff(2000 + i);
    });
  });
  $$<HTMLButtonElement>('[data-oct]').forEach((b) =>
    b.addEventListener('click', () => {
      oct = clamp(oct + Number(b.dataset.oct), 0, 8);
      renderKeys();
    }),
  );
  scaleSel.addEventListener('change', () => {
    proj.scale = Number(scaleSel.value);
    renderKeys();
    saveProject(proj);
  });
  rootSel.addEventListener('change', () => {
    proj.root = Number(rootSel.value);
    renderKeys();
    saveProject(proj);
  });
  const quant = $<HTMLInputElement>('[data-kb-quant]');

  // ── transport: play, live rec, fill, song ─────────────────────────────────────────────
  const playBtn = $('[data-op-play]');
  async function playStop() {
    if (!(await ctx.boot())) return;
    if (ctx.mon?.playing) {
      engine.send({ t: 'stop' });
      ctx.status('stopped');
    } else {
      engine.send({ t: 'play' });
      ctx.status(`playing ${patName(proj.cur)}`);
    }
  }
  playBtn.addEventListener('click', playStop);
  const recBtn = $('[data-op-rec]');
  const toggleRec = () => {
    liveRec = !liveRec;
    recBtn.setAttribute('aria-pressed', String(liveRec));
    ctx.status(liveRec ? `live recording into track ${k + 1}: play the keys; knob moves become locks` : 'live recording off');
  };
  recBtn.addEventListener('click', toggleRec);
  const fillBtn = $('[data-op-fill]');
  const setFill = (on: boolean) => {
    engine.send({ t: 'fill', on });
    fillBtn.setAttribute('aria-pressed', String(on));
  };
  fillBtn.addEventListener('pointerdown', async () => {
    if (!(await ctx.boot())) return;
    setFill(true);
  });
  fillBtn.addEventListener('pointerup', () => !fillLatch && setFill(false));
  fillBtn.addEventListener('pointerleave', () => !fillLatch && fillBtn.getAttribute('aria-pressed') === 'true' && setFill(false));
  fillBtn.addEventListener('dblclick', () => {
    fillLatch = !fillLatch;
    setFill(fillLatch);
    ctx.status(fillLatch ? 'FILL latched: double-click again to release' : 'FILL released');
  });

  // ── song ───────────────────────────────────────────────────────────────────────────
  const songBtn = $('[data-op-song]');
  const rowsEl = $('[data-song-rows]');
  let songOn = false;
  function renderSong() {
    const row = ctx.mon?.songRow ?? 0;
    rowsEl.innerHTML = proj.song
      .map(
        (r, i) => `<li class="song__row${songOn && i === row ? ' is-now' : ''}">
        <select data-srow-p="${i}" aria-label="pattern for row ${i + 1}">${proj.pats
          .map((p, j) => (p || j === r.p ? `<option value="${j}"${j === r.p ? ' selected' : ''}>${patName(j)}</option>` : ''))
          .join('')}</select>
        <label>× <input type="number" min="1" max="64" value="${r.r}" data-srow-r="${i}" aria-label="repeats for row ${i + 1}" /></label>
        <button type="button" class="chip" data-srow-up="${i}" aria-label="move row ${i + 1} up">↑</button>
        <button type="button" class="chip" data-srow-del="${i}" aria-label="delete row ${i + 1}">✕</button></li>`,
      )
      .join('');
    $('[data-song-state]').textContent = songOn ? `on · ${proj.song.length} rows` : `off · ${proj.song.length} rows`;
    songBtn.setAttribute('aria-pressed', String(songOn));
  }
  const sendSong = () => engine.send({ t: 'song', on: songOn, row: 0, rows: proj.song });
  rowsEl.addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t.dataset.srowP) proj.song[+t.dataset.srowP].p = Number((t as HTMLSelectElement).value);
    if (t.dataset.srowR) proj.song[+t.dataset.srowR].r = clamp(Number((t as HTMLInputElement).value) || 1, 1, 64);
    sendSong();
    saveProject(proj);
  });
  rowsEl.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    if (t.dataset.srowDel) proj.song.splice(+t.dataset.srowDel, 1);
    if (t.dataset.srowUp) {
      const i = +t.dataset.srowUp;
      if (i > 0) [proj.song[i - 1], proj.song[i]] = [proj.song[i], proj.song[i - 1]];
    }
    sendSong();
    renderSong();
    saveProject(proj);
  });
  $('[data-song-add]').addEventListener('click', () => {
    proj.song.push({ p: proj.cur, r: 1 });
    sendSong();
    renderSong();
    saveProject(proj);
  });
  songBtn.addEventListener('click', async () => {
    if (!(await ctx.boot())) return;
    if (!proj.song.length) proj.song.push({ p: proj.cur, r: 1 });
    songOn = !songOn;
    sendSong();
    renderSong();
    ctx.status(songOn ? 'song mode: the rows play in order (▶ starts from the first)' : 'song mode off');
  });

  // ── keyboard shortcuts ──────────────────────────────────────────────────────────────
  let shiftDown = false;
  const typing = (t: EventTarget | null) => t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
  const onKey = (e: KeyboardEvent) => {
    shiftDown = e.shiftKey;
    if (typing(e.target) || document.querySelector('dialog[open]')) return;
    const key = e.key.toLowerCase();
    const down = e.type === 'keydown';
    // a key this instrument plays is not also a site shortcut (G then H goes home, J and K turn pages)
    const claim = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    if (e.metaKey || e.ctrlKey) {
      if (!down) return;
      if (key === 'z') patAction('undo');
      else if (key === 'c' && !getSelection()?.toString()) patAction('copy');
      else if (key === 'v') patAction('paste');
      else return;
      return claim();
    }
    if (e.altKey) return;
    if (key === ' ') {
      const t = e.target as HTMLElement;
      if (t.closest('button, [role=slider], [role=application], [role=button], summary, a')) return;
      claim();
      if (down && !e.repeat) playStop();
      return;
    }
    if (key === 'escape') {
      if (down && sel !== null) {
        claim();
        select(sel);
      }
      return;
    }
    if (key === 'q') {
      claim();
      if (down && !e.repeat) setFill(true);
      else if (!down && !fillLatch) setFill(false);
      return;
    }
    if (key === '.') {
      claim();
      if (down && !e.repeat) toggleRec();
      return;
    }
    if (key === 'z' || key === 'x') {
      claim();
      if (down) {
        oct = clamp(oct + (key === 'z' ? -1 : 1), 0, 8);
        renderKeys();
      }
      return;
    }
    const i = KEYMAP.indexOf(key);
    if (i < 0) return;
    claim();
    if (down && !e.repeat) noteOn(base() + i, 3000 + i);
    else if (!down) noteOff(3000 + i);
  };
  addEventListener('keydown', onKey, { capture: true });
  addEventListener('keyup', onKey, { capture: true });
  ctx.cleanup(() => {
    removeEventListener('keydown', onKey, { capture: true });
    removeEventListener('keyup', onKey, { capture: true });
  });

  // ── messages, frames ──────────────────────────────────────────────────────────────────
  function onMsg(m: FromG) {
    if (m.t === 'pat') {
      proj.cur = m.i;
      queued = -1;
      bank = Math.floor(m.i / 16);
      sel = null;
      renderAll();
    } else if (m.t === 'rec') {
      const t = pat().tracks[m.k];
      const s = m.s % trackLen(pat(), m.k);
      const ex = t.steps[s];
      if (ex && ex.k === 1) {
        if (!ex.n.includes(m.n) && ex.n.length < 4) ex.n = [...ex.n, m.n];
      } else t.steps[s] = { ...newTrig(m.n, m.v), l: m.l, mt: quant.checked ? 0 : m.mt, lk: ex?.lk ?? null };
      changed(true);
      if (m.k === k) renderSteps();
      renderTracks();
    }
  }
  let lastStep = -2;
  ctx.onFrame(() => {
    const m = ctx.mon;
    if (!m) return;
    playBtn.setAttribute('aria-pressed', String(m.playing));
    recBtn.classList.toggle('is-live', liveRec && m.playing);
    const s = m.steps[k];
    if (s !== lastStep) {
      lastStep = s;
      steps.forEach((b, i) => b.classList.toggle('is-head', s >= 0 && page * PAGE + i === s));
    }
    m.levels.forEach((v, i) => $(`[data-trk-led="${i}"]`).style.setProperty('--lvl', String(Math.min(1, v * 2))));
    if (songOn) {
      const rows = rowsEl.children;
      for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('is-now', i === m.songRow);
    }
  });

  function renderAll() {
    renderPats();
    renderTracks();
    renderSteps();
    renderTrig();
    renderSound();
    renderArp();
    renderKeys();
    renderSong();
  }
  renderAll();
  return {
    onMsg,
    /** everything the worklet needs to know, once it exists */
    first() {
      return [
        { t: 'proj' as const, pats: proj.pats, cur: proj.cur, song: proj.song },
        { t: 'song' as const, on: false, row: 0, rows: proj.song },
      ];
    },
    flush() {
      saveProject(proj);
    },
    steps: STEPS,
  };
}
