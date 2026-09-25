/**
 * Melencolia: the panel. Microphone, feedback guard, readouts, the sad
 * harmony's reasons, the sadness index, and the recorder.
 */
import { VocEngine, renderOffline } from './engine';
import { VPARAMS, vdefaults, vspec, type FromVoc, type VChord, type VMon } from './params';
import { DURER_LINES, NAMES, SAD_METHODS, sadInterval, sadnessIndex } from './melancholy';
import { makeTake, takesList, fmtTime } from '../audio/recorder';
import { toast } from '../ui/nav';

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
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
      /* private mode: fine */
    }
  },
};
type KnobEl = HTMLElement & { show?: () => void };

export function mountMelencolia() {
  const found = document.querySelector<HTMLElement>('[data-melencolia]');
  if (!found || found.dataset.ready) return;
  found.dataset.ready = '1';
  const root: HTMLElement = found;
  const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const $$ = <T extends Element = HTMLElement>(s: string) => [...root.querySelectorAll<T>(s)];
  const status = (t: string) => ($('[data-status]').textContent = t);

  const p = vdefaults();
  let sad = 0.7;
  try {
    const saved = JSON.parse(store.get('melencolia:p') ?? 'null');
    if (saved?.p) for (const s of VPARAMS) if (typeof saved.p[s.id] === 'number') p[s.id] = clamp(saved.p[s.id], s.min, s.max);
    if (typeof saved?.sad === 'number') sad = clamp(saved.sad);
  } catch {
    /* ignore */
  }
  p['car.solo'] = 0;
  let saveT = 0;
  const persist = () => {
    clearTimeout(saveT);
    saveT = window.setTimeout(() => store.set('melencolia:p', JSON.stringify({ p, sad })), 600);
  };

  const engine = new VocEngine();
  let monitorOn = true;
  async function boot() {
    if (engine.ready) return true;
    status('waking up…');
    try {
      await engine.boot(p);
      await engine.resume();
      engine.onMsg = onMsg;
      engine.setMonitor(monitorOn);
      return true;
    } catch (e) {
      console.error(e);
      status('this browser cannot run the vocoder (AudioWorklet is missing)');
      return false;
    }
  }

  // ── parameters ─────────────────────────────────────────────────────────
  const knobs = new Map<string, KnobEl>();
  function fmt(id: string, v: number) {
    const s = vspec(id);
    if (s.pos) return s.pos[Math.round(v)] ?? '';
    switch (s.fmt) {
      case 'bpm':
      case 'int':
        return `${Math.round(v)}`;
      case 'db':
        return id === 'in.gain' ? `${Math.round(-12 + 42 * v)} dB` : `${Math.round(-80 + 60 * v)} dB`;
      case 'ms':
        return `${Math.round(id === 'vc.atk' ? 1 * Math.pow(80, v) : 15 * Math.pow(800 / 15, v))} ms`;
      case 'st':
        return `${v > 0 ? '+' : ''}${v} st`;
      case 'oct':
        return v > 0 ? `+${v}` : `${v}`;
      default:
        return `${Math.round(v * 100)}`;
    }
  }
  function setParam(id: string, v: number, quiet = false) {
    const s = vspec(id);
    v = clamp(Math.round(v / s.step) * s.step, s.min, s.max);
    p[id] = v;
    engine.param(id, v);
    knobs.get(id)?.show?.();
    syncSwitches(id);
    if (!quiet) persist();
    if (id === 'g.bpm' && v === 34) status('34: every row, every column, every diagonal of the square');
  }
  $$<KnobEl>('[data-knob]').forEach((el) => {
    const id = el.dataset.knob!;
    const s = vspec(id);
    if (!s) return;
    knobs.set(id, el);
    const pointer = el.querySelector('.knob__pointer')!;
    const valueEl = el.querySelector<HTMLElement>('[data-knob-value]')!;
    el.show = () => {
      const v = p[id];
      pointer.setAttribute('transform', `rotate(${-135 + ((v - s.min) / (s.max - s.min)) * 270})`);
      el.setAttribute('aria-valuenow', String(v));
      el.setAttribute('aria-valuetext', fmt(id, v));
      valueEl.textContent = fmt(id, v);
    };
    el.show();
    bindDrag(el, () => p[id], (v) => setParam(id, v), s.min, s.max, s.step, () => setParam(id, s.def));
  });
  function bindDrag(el: HTMLElement, get: () => number, set: (v: number) => void, min: number, max: number, step: number, reset: () => void) {
    let drag: { y: number; v: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      drag = { y: e.clientY, v: get() };
      el.setPointerCapture(e.pointerId);
      el.classList.add('is-turning');
    });
    el.addEventListener('pointermove', (e) => drag && set(drag.v + ((drag.y - e.clientY) / (e.shiftKey ? 700 : 170)) * (max - min)));
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
        set(get() - Math.sign(e.deltaY) * Math.max(step, (max - min) / 60));
      },
      { passive: false },
    );
    el.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      set(get() + d * Math.max(step, (max - min) / (e.shiftKey ? 100 : 20)));
    });
    el.addEventListener('dblclick', reset);
  }
  const switches = $$<HTMLButtonElement>('[data-switch]');
  const segs = $$<HTMLButtonElement>('[data-seg]');
  function syncSwitches(only?: string) {
    for (const b of switches) if (!only || b.dataset.switch === only) b.setAttribute('aria-pressed', String(p[b.dataset.switch!] > 0));
    for (const b of segs) if (!only || b.dataset.seg === only) b.setAttribute('aria-pressed', String(p[b.dataset.seg!] === Number(b.dataset.v)));
    if (!only || only === 'h.method') $$<HTMLButtonElement>('[data-method]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.method) === p['h.method'])));
  }
  switches.forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.switch!;
      if (id === 'car.solo' && !(await boot())) return;
      setParam(id, p[id] > 0 ? 0 : 1);
      if (id === 'car.solo' && p[id]) status('no voice: every band open, the sad chords as a pad');
    }),
  );
  segs.forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.seg!;
      setParam(id, Number(b.dataset.v));
      if (id === 'in.mode' && engine.micOpen) {
        await openMic();
      }
    }),
  );
  $$<HTMLButtonElement>('[data-method]').forEach((b) =>
    b.addEventListener('click', () => {
      setParam('h.method', Number(b.dataset.method));
      $('[data-cite]').textContent = SAD_METHODS[Number(b.dataset.method)].cite;
      durerCount = 0;
    }),
  );
  const tonicSel = $<HTMLSelectElement>('[data-tonic]');
  tonicSel.value = String(p['h.tonic']);
  tonicSel.addEventListener('change', () => {
    setParam('h.tonic', Number(tonicSel.value));
    durerCount = 0;
  });
  $('[data-next]').addEventListener('click', async () => {
    if (!(await boot())) return;
    engine.cmd('next');
  });

  // the tristezza macro: one knob that moves every cue toward the sad end
  const macro = $('[data-sad-macro]');
  const macroPtr = macro.querySelector('.knob__pointer')!;
  const showMacro = () => {
    macroPtr.setAttribute('transform', `rotate(${-135 + sad * 270})`);
    $('[data-sad-macro-value]').textContent = String(Math.round(sad * 100));
    macro.setAttribute('aria-valuenow', sad.toFixed(2));
  };
  function applySad(s: number) {
    sad = clamp(s);
    showMacro();
    const set: Record<string, number> = {
      'g.bpm': Math.round(100 - 44 * sad),
      'vc.dark': 0.2 + 0.65 * sad,
      'car.oct': sad > 0.6 ? -1 : 0,
      'h.tears': 0.15 + 0.75 * sad,
      'car.bend': 0.08 + 0.55 * sad,
      'car.glide': 0.2 + 0.55 * sad,
      'vc.atk': 0.15 + 0.45 * sad,
      'fx.verb': 0.15 + 0.45 * sad,
      'fx.tape': 0.08 + 0.5 * sad,
    };
    for (const [id, v] of Object.entries(set)) setParam(id, v, true);
    persist();
  }
  bindDrag(macro, () => sad, applySad, 0, 1, 0.01, () => applySad(0.7));
  showMacro();

  // ── microphone, monitor, the room ──────────────────────────────────────────
  const micBtn = $<HTMLButtonElement>('[data-mic]');
  async function openMic() {
    if (!(await boot())) return;
    const speakers = p['in.mode'] === 1;
    try {
      await engine.micOn(speakers);
    } catch {
      status('no microphone: permission was refused, or there is none');
      toast('The browser did not give access to a microphone.');
      return;
    }
    micBtn.setAttribute('aria-pressed', 'true');
    $('[data-mic-label]').textContent = 'chiudi il microfono';
    if (monitorOn) {
      status('measuring the room: a moment of silence, then a soft hiss…');
      engine.cmd('calibrate');
    } else status('listening (monitor off: nothing reaches the speakers)');
  }
  micBtn.addEventListener('click', async () => {
    if (engine.micOpen) {
      engine.micOff();
      micBtn.setAttribute('aria-pressed', 'false');
      $('[data-mic-label]').textContent = 'apri il microfono';
      status('microphone closed');
      return;
    }
    await openMic();
  });
  $('[data-calibrate]').addEventListener('click', async () => {
    if (!(await boot())) return;
    if (!engine.micOpen) await openMic();
    else {
      status('measuring the room: a moment of silence, then a soft hiss…');
      engine.cmd('calibrate');
    }
  });
  const monBtn = $<HTMLButtonElement>('[data-monitor]');
  monBtn.addEventListener('click', () => {
    monitorOn = !monitorOn;
    monBtn.setAttribute('aria-pressed', String(monitorOn));
    engine.setMonitor(monitorOn);
    status(monitorOn ? 'monitor on' : 'monitor off: silent, but the vocoder still records');
  });
  const lamp = $('[data-lamp]');
  const flash = (cls: string) => {
    lamp.classList.remove('is-warn', 'is-ok');
    void lamp.offsetWidth;
    lamp.classList.add(cls);
  };

  // ── messages from the audio thread ──────────────────────────────────────────
  let mon: VMon | null = null;
  const chords: VChord[] = [];
  /** the audio thread walks the square's ten lines in order; count along with it */
  let durerCount = 0;
  function onMsg(m: FromVoc) {
    if (m.t === 'mon') mon = m;
    else if (m.t === 'chord') showChord(m);
    else if (m.t === 'howl') {
      flash('is-warn');
      status(`feedback at ${m.hz} Hz: output ducked, that band notched. Headphones, a lower volume, or “casse” mode will stop it.`);
    } else if (m.t === 'loop') {
      p['in.mode'] = 1;
      syncSwitches('in.mode');
      flash('is-warn');
      status('the microphone was hearing the speakers: speaker protection is on');
      if (engine.micOpen) engine.micOn(true);
    } else if (m.t === 'cal') {
      $('[data-couple]').textContent = `stanza ${m.db} dB`;
      if (m.db > -30 && p['in.mode'] === 0) {
        setParam('in.mode', 1);
        engine.micOn(true);
        flash('is-warn');
        status(`the microphone hears the speakers (${m.db} dB): switched to “casse”, with echo suppression`);
      } else {
        flash('is-ok');
        status(p['in.mode'] === 1 ? `room measured (${m.db} dB): each band opens only above what the room gives back` : `room measured (${m.db} dB): sing`);
      }
    }
  }

  const chordEl = $('[data-chord]'),
    romanEl = $('[data-roman]'),
    whyEl = $('[data-why]');
  const cells = $$('[data-cell]');
  function showChord(c: VChord) {
    chords.push(c);
    if (chords.length > 8) chords.shift();
    chordEl.textContent = c.name;
    romanEl.textContent = c.roman;
    whyEl.innerHTML = c.why.map((w) => `<li>${w}</li>`).join('');
    cells.forEach((el) => el.classList.remove('is-on', 'is-line'));
    if (c.cell !== null) {
      const line = DURER_LINES[Math.floor(durerCount++ / 4) % DURER_LINES.length];
      cells.forEach((el, i) => el.classList.toggle('is-line', line.includes(i)));
      cells[c.cell].classList.add('is-on');
    }
  }

  // ── the index, and your voice ─────────────────────────────────────────────
  const cuesEl = $('[data-cues]'),
    voiceCuesEl = $('[data-voice-cues]');
  const bar = (n: string, v: number, cite: string) => `<p class="cue" title="${cite}"><span>${n}</span><i><b style="width:${Math.round(v * 100)}%"></b></i></p>`;
  function drawIndex() {
    const minorShare = chords.length ? chords.filter((c) => c.minor).length / chords.length : 0.5;
    const motion = chords.length > 1 ? chords.slice(1).reduce((s, c) => s + c.motion, 0) / (chords.length - 1) : 2;
    const level = mon ? clamp((mon.outDb + 60) / 60) : 0.4;
    const { cues, total } = sadnessIndex({
      minorShare,
      bpm: p['g.bpm'],
      register: p['car.oct'],
      darkness: p['vc.dark'],
      motion,
      level,
      attack: (p['vc.atk'] + p['car.glide']) / 2,
      bend: p['car.bend'],
    });
    cuesEl.innerHTML = cues.map((c) => bar(`${c.n} · ${Math.round(c.w * 100)}%`, c.v, c.cite)).join('');
    $('[data-index]').textContent = `${Math.round(total * 100)}%`;
  }
  const pitches: Array<{ t: number; st: number }> = [];
  const intervals: boolean[] = [];
  let stable: { st: number; since: number; f0: number } | null = null;
  let lastNote: number | null = null;
  function drawVoice(now: number) {
    if (!mon) return;
    const f0 = mon.f0;
    $('[data-f0]').textContent = f0 > 0 ? `${Math.round(f0)} Hz · ${noteName(f0)}` : '—';
    if (f0 > 0) {
      const st = 12 * Math.log2(f0 / 440);
      pitches.push({ t: now, st });
      // a note is a pitch held within half a semitone for a quarter of a second
      if (stable && Math.abs(st - stable.st) < 0.5) {
        if (now - stable.since > 250 && lastNote !== stable.since) {
          lastNote = stable.since;
          if (prevNoteF0) {
            const iv = sadInterval(prevNoteF0, stable.f0);
            if (iv.st !== 0) {
              intervals.push(iv.sad);
              if (intervals.length > 8) intervals.shift();
              $('[data-interval]').textContent = `${iv.name} ${iv.st > 0 ? '↑' : '↓'}${iv.sad ? ' · the interval of sad speech' : ''}`;
            }
          }
          prevNoteF0 = stable.f0;
        }
      } else stable = { st, since: now, f0 };
    }
    while (pitches.length && now - pitches[0].t > 4000) pitches.shift();
    if (mon.gate < 0.5) return;
    const sts = pitches.map((x) => x.st);
    const mean = sts.reduce((a, b) => a + b, 0) / Math.max(1, sts.length);
    const sd = Math.sqrt(sts.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, sts.length));
    const cues = [
      { n: 'poca escursione', v: sts.length > 5 ? clamp(1 - sd / 4) : 0, c: 'Huron 2008; Juslin & Laukka 2003' },
      { n: 'voce piano', v: clamp((-18 - mon.inDb) / 30), c: 'Juslin & Laukka 2003' },
      { n: 'timbro scuro', v: clamp((1800 - mon.centroid) / 1400), c: 'Juslin & Laukka 2003' },
      { n: 'intervalli tristi', v: intervals.length ? intervals.filter(Boolean).length / intervals.length : 0, c: 'Curtis & Bharucha 2010; Zeloni & Pavani 2022' },
    ];
    voiceCuesEl.innerHTML = cues.map((c) => bar(c.n, c.v, c.c)).join('');
    $('[data-voice-score]').textContent = `${Math.round((cues.reduce((s, c) => s + c.v, 0) / cues.length) * 100)}% malinconica`;
  }
  let prevNoteF0 = 0;
  const noteName = (f: number) => {
    const m = Math.round(69 + 12 * Math.log2(f / 440));
    return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
  };

  // ── bands, meters ─────────────────────────────────────────────────────────
  const bandsCv = $<HTMLCanvasElement>('[data-bands]');
  const bctx = bandsCv.getContext('2d')!;
  const meterIn = $('[data-meter-in]'),
    meterOut = $('[data-meter-out]');
  function drawBands() {
    const w = (bandsCv.width = bandsCv.clientWidth * 2),
      h = (bandsCv.height = bandsCv.clientHeight * 2);
    bctx.fillStyle = '#ddd3bb';
    bctx.fillRect(0, 0, w, h);
    if (!mon) return;
    const b = mon.bands;
    const bw = w / Math.max(1, b.length);
    for (let j = 0; j < b.length; j++) {
      const v = clamp(Math.sqrt(b[j]) * 1.4);
      bctx.fillStyle = mon.echo > 0.5 ? '#6a2fcf' : '#16140f';
      bctx.fillRect(j * bw + 2, h - v * h, bw - 4, v * h);
    }
    bctx.fillStyle = mon.gate > 0.5 ? '#2f6b00' : '#cfc3a6';
    bctx.fillRect(0, 0, w, 6);
    meterIn.style.width = `${clamp((mon.inDb + 70) / 70) * 100}%`;
    meterOut.style.width = `${clamp((mon.outDb + 60) / 60) * 100}%`;
  }

  // ── the recorder ─────────────────────────────────────────────────────────
  let takeN = 0;
  let playing: HTMLElement | null = null;
  const takes = takesList($('[data-takes]'), {
    file: 'melencolia',
    info: { title: 'Melencolia I', artist: 'gpojani.me', software: 'Melencolia I, gpojani.me/vocoder', date: new Date().toISOString().slice(0, 10) },
    empty: 'no takes yet: press registra, or load an audio file',
    actions: [
      {
        label: 'applica il vocoder',
        title: 'Render this voice through the vocoder, offline, with the current settings',
        when: (t) => t.kind.startsWith('voce'),
        run: async (t) => {
          status(`rendering ${t.name} through the vocoder…`);
          try {
            const out = await renderOffline(t.channels, t.sampleRate, p);
            takes.add(makeTake(out, t.sampleRate, `${t.name.split(' · ')[0]} · vocoder reso`, 'vocoder (reso)'));
            status(`rendered: ${fmtTime(out[0].length / t.sampleRate)} of vocoder, ready to download`);
          } catch (e) {
            console.error(e);
            status('offline rendering is not available in this browser');
          }
        },
      },
      {
        label: 'suona nel vocoder',
        title: 'Play this voice through the vocoder live, while you turn the knobs',
        when: (t) => t.kind.startsWith('voce'),
        run: async (t, el) => {
          if (!(await boot())) return;
          if (playing === el) {
            engine.stopPlay();
            return;
          }
          playing = el;
          el.classList.add('is-playing');
          status(`${t.name} is singing through the vocoder`);
          engine.playThrough(t.channels, t.sampleRate, () => {
            el.classList.remove('is-playing');
            if (playing === el) playing = null;
          });
        },
      },
    ],
  });
  const recBtn = $<HTMLButtonElement>('[data-rec]');
  const recDry = $<HTMLInputElement>('[data-rec-dry]'),
    recWet = $<HTMLInputElement>('[data-rec-wet]');
  let recording: { dry: boolean; wet: boolean } | null = null;
  recBtn.addEventListener('click', async () => {
    if (recording) {
      const r = recording;
      recording = null;
      recBtn.setAttribute('aria-pressed', 'false');
      $('[data-rec-label]').textContent = 'registra';
      const [dry, wet] = await Promise.all([r.dry ? engine.dryTap.stop() : Promise.resolve([]), r.wet ? engine.wetTap.stop() : Promise.resolve([])]);
      const sr = engine.ctx!.sampleRate;
      takeN++;
      if (dry.length && dry[0].length) takes.add(makeTake(dry, sr, `ripresa ${takeN} · voce`, 'voce'));
      if (wet.length && wet[0].length) takes.add(makeTake(wet, sr, `ripresa ${takeN} · vocoder`, 'vocoder'));
      status('take saved below: listen, download, or put the voice through again');
      return;
    }
    if (!(await boot())) return;
    const dry = recDry.checked && engine.micOpen;
    const wet = recWet.checked;
    if (!dry && !wet) return void toast(recDry.checked ? 'Open the microphone to record the voice, or tick “vocoder”.' : 'Tick “voce”, “vocoder” or both.');
    if (dry) engine.dryTap.start();
    if (wet) engine.wetTap.start();
    recording = { dry, wet };
    recBtn.setAttribute('aria-pressed', 'true');
    $('[data-rec-label]').textContent = 'ferma';
    status(`recording ${[dry && 'the voice', wet && 'the vocoder'].filter(Boolean).join(' and ')}`);
  });
  $<HTMLInputElement>('[data-upload]').addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    if (!(await boot())) return;
    try {
      const buf = await engine.ctx!.decodeAudioData(await f.arrayBuffer());
      const ch = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice());
      takes.add(makeTake(ch, buf.sampleRate, f.name.replace(/\.[^.]+$/, '').slice(0, 40), 'voce (file)'));
      status('file loaded: put it through the vocoder with “applica” or “suona”');
    } catch {
      toast('The browser could not decode that file.');
    }
    (e.target as HTMLInputElement).value = '';
  });
  const recTime = $('[data-rec-time]');

  // ── the frame loop ───────────────────────────────────────────────────────
  let raf = 0,
    last = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (recording) recTime.textContent = fmtTime(Math.max(engine.wetTap?.seconds ?? 0, engine.dryTap?.seconds ?? 0));
    if (now - last < 45) return;
    last = now;
    drawBands();
    drawVoice(now);
    drawIndex();
  };
  raf = requestAnimationFrame(frame);

  // ── keyboard: space opens/closes the microphone, N next chord ─────────────────
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!document.body.contains(root) || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || document.querySelector('dialog[open]')) return;
    if (e.key === ' ' && !t.closest('button, [role=slider]')) {
      e.preventDefault();
      micBtn.click();
    }
  };
  addEventListener('keydown', onKey);

  syncSwitches();
  document.addEventListener(
    'astro:before-swap',
    () => {
      removeEventListener('keydown', onKey);
      cancelAnimationFrame(raf);
      takes.dispose();
      engine.dispose();
    },
    { once: true },
  );
}
