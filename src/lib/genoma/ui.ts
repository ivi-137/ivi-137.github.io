/**
 * Genoma: the panel. It owns the global parameters (knobs, switches, selects),
 * starts the audio, and hands a shared context to each module's panel.
 */
import { GenomaEngine } from './engine';
import { GIDX, GPARAMS, gspec } from './params';
import type { FromG, Mon } from './msg';
import { bindDrag, clamp, fmtGlobal, fmtTime, paintKnob, type Ctx, type ReelInfo } from './ui-kit';
import { loadParams, loadProject, saveParams } from './store';
import { demoProject } from './demo';
import { mountReel } from './ui-reel';
import { mountPad } from './ui-pad';
import { mountQuinc } from './ui-quinc';
import { mountCables } from './ui-cables';
import { mountOper } from './ui-oper';
import { makeTake, takesList } from '../audio/recorder';
import { toast } from '../ui/nav';

export function mountGenoma() {
  const found = document.querySelector<HTMLElement>('[data-genoma]');
  if (!found || found.dataset.ready) return;
  found.dataset.ready = '1';
  const root: HTMLElement = found;
  const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const $$ = <T extends Element = HTMLElement>(s: string) => [...root.querySelectorAll<T>(s)];
  const statusEl = $('[data-status]');
  const dockStatus = $('[data-dock-status]');

  const p = loadParams();
  const engine = new GenomaEngine();
  const watchers: ((id: string, v: number) => void)[] = [];
  const monFns: ((m: Mon) => void)[] = [];
  const frameFns: ((now: number) => void)[] = [];
  const cleanups: (() => void)[] = [];
  const reel: ReelInfo = { sr: 48000, len: 0, count: 0, cur: 0, marks: [0], cap: 174 * 48000, geneLen: 0 };
  let saveT = 0;
  const persist = () => {
    clearTimeout(saveT);
    saveT = window.setTimeout(() => saveParams(p), 500);
  };

  const ctx: Ctx = {
    root,
    $,
    $$,
    engine,
    p,
    get: (id) => p[GIDX[id]],
    setParam(id, v, quiet) {
      const i = GIDX[id];
      if (i === undefined) return;
      const s = GPARAMS[i];
      v = clamp(Math.round(v / s.step) * s.step, s.min, s.max);
      if (s.pos) v = Math.round(v);
      p[i] = v;
      engine.send({ t: 'p', i, v });
      showParam(id);
      for (const w of watchers) w(id, v);
      if (!quiet) persist();
    },
    watch: (fn) => watchers.push(fn),
    status: (t) => {
      statusEl.textContent = t;
      dockStatus.textContent = t;
    },
    boot,
    mon: null,
    reel,
    onMon: (fn) => monFns.push(fn),
    onFrame: (fn) => frameFns.push(fn),
    cleanup: (fn) => cleanups.push(fn),
  };

  // ── global knobs, segments, switches, selects ─────────────────────────────────────
  type KnobEl = HTMLElement & { show?: () => void };
  const knobs = new Map<string, KnobEl>();
  const segs = $$<HTMLButtonElement>('[data-seg]');
  const switches = $$<HTMLButtonElement>('[data-switch]');
  const gsels = $$<HTMLSelectElement>('[data-gsel]');
  function showParam(id: string) {
    knobs.get(id)?.show?.();
    const v = p[GIDX[id]];
    for (const b of segs) if (b.dataset.seg === id) b.setAttribute('aria-pressed', String(v === Number(b.dataset.v)));
    for (const b of switches) if (b.dataset.switch === id) b.setAttribute('aria-pressed', String(v > 0.5));
    for (const s of gsels) if (s.dataset.gsel === id) s.value = String(v);
  }
  $$<KnobEl>('[data-knob]').forEach((el) => {
    const id = el.dataset.knob!;
    const s = gspec(id);
    if (!s) return;
    knobs.set(id, el);
    el.show = () => paintKnob(el, p[GIDX[id]], s.min, s.max, fmtGlobal(id, p[GIDX[id]], reel));
    el.show();
    if (s.hint) el.title = s.hint;
    bindDrag(
      el,
      () => p[GIDX[id]],
      (v) => ctx.setParam(id, v),
      s.min,
      s.max,
      s.step,
      () => ctx.setParam(id, s.def),
      () => boot(),
    );
  });
  segs.forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.seg!;
      ctx.setParam(id, Number(b.dataset.v));
      if (id === 'm.mode' && engine.micOpen) await openMic();
      boot();
    }),
  );
  switches.forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await boot())) return;
      const id = b.dataset.switch!;
      ctx.setParam(id, p[GIDX[id]] > 0.5 ? 0 : 1);
    }),
  );
  gsels.forEach((s) => s.addEventListener('change', () => ctx.setParam(s.dataset.gsel!, Number(s.value))));
  GPARAMS.forEach((s) => showParam(s.id));

  // ── power ────────────────────────────────────────────────────────────────────────
  const power = $<HTMLButtonElement>('[data-power]');
  const proj = loadProject() ?? demoProject();
  const oper = mountOper(ctx, proj);
  const reelUi = mountReel(ctx);
  mountPad(ctx);
  mountQuinc(ctx);
  mountCables(ctx);
  let booted: Promise<boolean> | null = null;
  function boot(): Promise<boolean> {
    booted ??= (async () => {
      ctx.status('accendo…');
      try {
        await engine.boot([...p], oper.first());
        engine.onMsg = onMsg;
        engine.onError = (why) => ctx.status(why);
        await engine.resume();
        await reelUi.restore();
        power.setAttribute('aria-pressed', 'true');
        $('[data-power-label]').textContent = 'acceso';
        ctx.status('on: ▶ plays Operatori (space); REC on the reel records it');
        return true;
      } catch (e) {
        console.error(e);
        ctx.status('this browser cannot run Genoma (AudioWorklet is missing)');
        booted = null;
        return false;
      }
    })();
    return booted.then(async (ok) => {
      if (ok && engine.ctx?.state === 'suspended') await engine.resume();
      return ok;
    });
  }
  power.addEventListener('click', async () => {
    if (engine.ready) {
      if (engine.ctx?.state === 'running') {
        await engine.ctx.suspend();
        power.setAttribute('aria-pressed', 'false');
        $('[data-power-label]').textContent = 'in pausa';
        ctx.status('paused: nothing is lost; press again to carry on');
      } else {
        await engine.resume();
        power.setAttribute('aria-pressed', 'true');
        $('[data-power-label]').textContent = 'acceso';
        ctx.status('on');
      }
      return;
    }
    await boot();
  });

  // ── microphone ────────────────────────────────────────────────────────────────────
  const micBtn = $<HTMLButtonElement>('[data-mic]');
  async function openMic() {
    if (!(await boot())) return;
    try {
      await engine.micOn(ctx.get('m.mode') === 1);
      micBtn.setAttribute('aria-pressed', 'true');
      ctx.status(
        ctx.get('m.voce') > 0.01
          ? 'microphone open, and you can hear it: use headphones'
          : 'microphone open: set a source to “voce” (the reel, the pad or Quinconce), or raise “voce” to hear it (with headphones)',
      );
    } catch {
      ctx.status('no microphone: permission was refused, or there is none');
      toast('The browser did not give access to a microphone.');
    }
  }
  micBtn.addEventListener('click', async () => {
    if (engine.micOpen) {
      engine.micOff();
      micBtn.setAttribute('aria-pressed', 'false');
      ctx.status('microphone closed');
      return;
    }
    await openMic();
  });

  // ── the recorder ──────────────────────────────────────────────────────────────────
  let takeN = 0;
  const takes = takesList($('[data-takes]'), {
    file: 'genoma',
    info: { title: 'Genoma', artist: 'gpojani.me', software: 'Genoma, gpojani.me/sampler', date: new Date().toISOString().slice(0, 10) },
    empty: 'no takes yet: press registra, or load an audio file',
    actions: [
      {
        label: 'nel nastro',
        title: 'Add this take to the reel as a new splice',
        run: async (t) => {
          if (!(await boot())) return;
          const L = Float32Array.from(t.channels[0]);
          const R = Float32Array.from(t.channels[1] ?? t.channels[0]);
          engine.send({ t: 'load', L, R, marks: [0], append: true }, [L.buffer, R.buffer]);
          ctx.status(`${t.name} is on the reel, as a new splice`);
        },
      },
    ],
  });
  const recBtn = $<HTMLButtonElement>('[data-rec]');
  let recording = false;
  recBtn.addEventListener('click', async () => {
    if (!(await boot())) return;
    if (recording) {
      recording = false;
      recBtn.setAttribute('aria-pressed', 'false');
      $('[data-rec-label]').textContent = 'registra';
      const ch = await engine.tap.stop();
      if (ch.length && ch[0].length) takes.add(makeTake(ch, engine.ctx!.sampleRate, `ripresa ${++takeN}`, 'genoma'));
      ctx.status('take saved below: listen, download, or send it to the reel');
      return;
    }
    engine.tap.start();
    recording = true;
    recBtn.setAttribute('aria-pressed', 'true');
    $('[data-rec-label]').textContent = 'ferma';
    ctx.status('recording everything you hear');
  });
  $<HTMLInputElement>('[data-upload]').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f || !(await boot())) return;
    try {
      const buf = await engine.ctx!.decodeAudioData(await f.arrayBuffer());
      const ch = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice());
      takes.add(makeTake(ch, buf.sampleRate, f.name.replace(/\.[^.]+$/, '').slice(0, 40), 'file'));
      ctx.status('file loaded: send it to the reel with “nel nastro”');
    } catch {
      toast('The browser could not decode that file.');
    }
  });
  const recTime = $('[data-rec-time]');

  // the dock follows the top strip
  const dockPlay = $('[data-dock-play]'),
    dockPat = $('[data-dock-pat]'),
    patName = $('[data-patname]');
  dockPlay.addEventListener('click', () => $<HTMLButtonElement>('[data-op-play]').click());
  frameFns.push(() => {
    dockPlay.setAttribute('aria-pressed', String(!!ctx.mon?.playing));
    if (dockPat.textContent !== patName.textContent) dockPat.textContent = patName.textContent;
  });

  // ── messages from the audio thread ───────────────────────────────────────────────
  function onMsg(m: FromG) {
    if (m.t === 'mon') {
      ctx.mon = m;
      for (const f of monFns) f(m);
      return;
    }
    reelUi.onMsg(m);
    oper.onMsg(m);
    if (m.t === 'reel') {
      knobs.get('n.organize')?.show?.();
      knobs.get('n.gene')?.show?.();
    }
  }
  const meters = { l: $('[data-meter-l]'), r: $('[data-meter-r]'), inp: $('[data-meter-in]') };
  const db = (x: number) => clamp((20 * Math.log10(x + 1e-6) + 60) / 60);
  let raf = 0,
    last = 0,
    geneShown = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (recording) recTime.textContent = fmtTime(engine.tap?.seconds ?? 0);
    if (now - last < 30) return;
    last = now;
    const m = ctx.mon;
    if (m) {
      meters.l.style.width = `${db(m.out[0]) * 100}%`;
      meters.r.style.width = `${db(m.out[1]) * 100}%`;
      meters.inp.style.width = `${db(m.inp) * 100}%`;
      if (m.reel.geneLen !== geneShown) {
        geneShown = m.reel.geneLen;
        knobs.get('n.gene')?.show?.();
      }
    }
    for (const f of frameFns) f(now);
  };
  raf = requestAnimationFrame(frame);

  // leaving the page: stop the sound, keep what was made
  document.addEventListener(
    'astro:before-swap',
    () => {
      cancelAnimationFrame(raf);
      oper.flush();
      reelUi.flush();
      saveParams(p);
      for (const c of cleanups) c();
      takes.dispose();
      engine.dispose();
    },
    { once: true },
  );
}
