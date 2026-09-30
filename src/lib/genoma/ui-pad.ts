/** Posto giusto on the panel: the XY pad, its five effects, and the three set-ups. */
import type { Ctx } from './ui-kit';
import { clamp, capture } from './ui-kit';
import { CV_DST, CV_SRC } from './params';
import { PAD_MODES, SLICE_NAMES, SLICES, whammySt } from './pad';

export function mountPad(ctx: Ctx) {
  const { $, $$, engine } = ctx;
  const pad = $('[data-xy]');
  const cv = $<HTMLCanvasElement>('[data-xy-canvas]');
  const g = cv.getContext('2d')!;
  const readEl = $('[data-xy-read]');
  let x = ctx.get('r.x'),
    y = ctx.get('r.y');
  let on = false;
  const trail: { x: number; y: number; t: number }[] = [];

  const send = () => engine.send({ t: 'pad', on, x, y });
  function describe() {
    const mode = ctx.get('r.mode') | 0;
    let t = '';
    if (mode === 0) t = `cutoff ${Math.round(60 * Math.pow(16000 / 60, x))} Hz · res ${Math.round(y * 100)}`;
    else if (mode === 1) t = `range ${Math.round(x * 100)} · res ${Math.round(y * 100)}`;
    else if (mode === 2)
      t = `slice ${SLICE_NAMES[Math.min(SLICES.length - 1, Math.floor(x * SLICES.length))]} · speed ${Math.pow(2, (y - 0.5) * 2).toFixed(2)}×`;
    else if (mode === 3) t = `window ${Math.round(100 * Math.pow(16, x))} ms · feedback ${Math.round(y * 85)}`;
    else {
      const st = whammySt(x);
      t = `${st > 0 ? '+' : ''}${Number.isInteger(st) ? st : st.toFixed(1)} st · blend ${Math.round(y * 100)}`;
    }
    readEl.textContent = `${PAD_MODES[mode]} · ${t}`;
  }
  async function at(e: PointerEvent, down: boolean) {
    const r = pad.getBoundingClientRect();
    x = clamp((e.clientX - r.left) / r.width);
    y = clamp(1 - (e.clientY - r.top) / r.height);
    if (down) on = true;
    trail.push({ x, y, t: performance.now() });
    send();
    describe();
  }
  pad.addEventListener('pointerdown', async (e) => {
    if (!(await ctx.boot())) return;
    capture(pad, e.pointerId);
    pad.classList.add('is-on');
    at(e, true);
  });
  pad.addEventListener('pointermove', (e) => on && at(e, false));
  const release = () => {
    if (!on) return;
    on = false;
    pad.classList.remove('is-on');
    send();
  };
  pad.addEventListener('pointerup', release);
  pad.addEventListener('pointercancel', release);
  pad.addEventListener('keydown', async (e) => {
    const k = e.key;
    const dx = k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : 0,
      dy = k === 'ArrowUp' ? 1 : k === 'ArrowDown' ? -1 : 0;
    if (k === ' ' || k === 'Enter') {
      e.preventDefault();
      if (!(await ctx.boot())) return;
      on = !on;
      pad.classList.toggle('is-on', on);
      send();
      describe();
      return;
    }
    if (!dx && !dy) return;
    e.preventDefault();
    x = clamp(x + dx * 0.04);
    y = clamp(y + dy * 0.04);
    trail.push({ x, y, t: performance.now() });
    if (ctx.mon) send();
    describe();
  });

  function draw(now: number) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(10, Math.round(cv.clientWidth * dpr)),
      h = Math.max(10, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const eng = ctx.mon?.pad ?? 0;
    g.fillStyle = '#16140f';
    g.fillRect(0, 0, w, h);
    // a lit grid, brighter while the effect is engaged
    g.strokeStyle = `rgba(125,140,255,${0.14 + 0.3 * eng})`;
    g.lineWidth = dpr;
    for (let i = 1; i < 8; i++) {
      g.beginPath();
      g.moveTo((i * w) / 8, 0);
      g.lineTo((i * w) / 8, h);
      g.moveTo(0, (i * h) / 8);
      g.lineTo(w, (i * h) / 8);
      g.stroke();
    }
    if ((ctx.get('r.mode') | 0) === 4) {
      // the whammy's semitones along X
      g.fillStyle = 'rgba(198,255,61,0.4)';
      for (let st = -24; st <= 24; st += 12) g.fillRect(((st + 24) / 48) * w - dpr, 0, 2 * dpr, h);
    }
    while (trail.length && now - trail[0].t > 900) trail.shift();
    for (const p of trail) {
      const a = 1 - (now - p.t) / 900;
      g.fillStyle = `rgba(47,69,255,${a * 0.6})`;
      g.beginPath();
      g.arc(p.x * w, (1 - p.y) * h, Math.max(0.5, 10 * dpr * a), 0, Math.PI * 2);
      g.fill();
    }
    const px = x * w,
      py = (1 - y) * h;
    g.strokeStyle = on || eng > 0.05 ? '#c6ff3d' : 'rgba(236,229,211,0.6)';
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    g.moveTo(px, 0);
    g.lineTo(px, h);
    g.moveTo(0, py);
    g.lineTo(w, py);
    g.stroke();
    g.fillStyle = on || eng > 0.05 ? '#c6ff3d' : '#ece5d3';
    g.beginPath();
    g.arc(px, py, (7 + 8 * eng) * dpr, 0, Math.PI * 2);
    g.fill();
  }
  ctx.onFrame(draw);

  // the five effects
  const modes = $$<HTMLButtonElement>('[data-pad-mode]');
  const syncModes = () => modes.forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.padMode) === (ctx.get('r.mode') | 0))));
  modes.forEach((b) =>
    b.addEventListener('click', () => {
      ctx.setParam('r.mode', Number(b.dataset.padMode));
      describe();
    }),
  );
  modes.forEach((b) =>
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const i = ((ctx.get('r.mode') | 0) + d + modes.length) % modes.length;
      ctx.setParam('r.mode', i);
      modes[i].focus();
      describe();
    }),
  );
  ctx.watch((id, v) => {
    if (id === 'r.mode') syncModes();
    if (id === 'r.x' || id === 'r.y') {
      if (id === 'r.x') x = v;
      else y = v;
      describe();
    }
  });
  syncModes();
  describe();

  // ── three set-ups ─────────────────────────────────────────────────────────────
  const cable = (n: number, src: string, dst: string, amt = 1) => {
    ctx.setParam(`c${n}.src`, CV_SRC.indexOf(src));
    ctx.setParam(`c${n}.dst`, CV_DST.indexOf(dst));
    ctx.setParam(`c${n}.amt`, amt);
  };
  const freeCable = (dst: string) => {
    for (let n = 1; n <= 8; n++) if (ctx.get(`c${n}.dst`) === CV_DST.indexOf(dst)) return n;
    for (let n = 1; n <= 8; n++) if (!ctx.get(`c${n}.src`) || !ctx.get(`c${n}.dst`)) return n;
    return 8;
  };
  $$<HTMLButtonElement>('[data-scene]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await ctx.boot())) return;
      $$('[data-scene]').forEach((x2) => x2.classList.toggle('is-on', x2 === b));
      const s = b.dataset.scene;
      if (s === 'eiirp') {
        const mic = engine.micOpen;
        ctx.setParam('n.src', mic ? 0 : 2);
        ctx.setParam('r.src', 1);
        ctx.setParam('r.mode', 2);
        ctx.setParam('r.mix', 1);
        ctx.setParam('n.gene', 0);
        ctx.setParam('n.morph', 0.15);
        ctx.setParam('n.speed', 0.5);
        ctx.setParam('n.sos', 0.5);
        ctx.setParam('n.play', 1);
        ctx.status(
          mic
            ? 'sing a phrase and press REC (I) twice to catch it; then hold the pad: taglia repeats the last slice. The scrub strip cuts it by hand, rovescio and whammy take it further'
            : 'open the microphone to use your voice (the reel records Operatori until then); press REC twice to catch a phrase, then hold the pad',
        );
      } else if (s === 'gloaming') {
        ctx.setParam('n.src', 2);
        ctx.setParam('n.qrec', 2);
        ctx.setParam('n.gene', 0.45);
        ctx.setParam('n.morph', 0.1);
        ctx.setParam('n.clkdiv', 1);
        ctx.setParam('n.play', 1);
        cable(freeCable('nastro · CLK'), 'orologio', 'nastro · CLK');
        if (!ctx.mon?.playing) engine.send({ t: 'play' });
        engine.send({ t: 'btn', b: 'arm' });
        ctx.status(
          'the reel will sample the band for two bars from the next downbeat, then shift gene by gene on every eighth note. Arm it again for another take',
        );
      } else {
        if ((ctx.reel.count || 0) < 4 && ctx.reel.len > 0) engine.send({ t: 'divide', n: 4 });
        ctx.setParam('n.play', 0);
        ctx.setParam('n.gene', 0);
        ctx.setParam('n.morph', 0.15);
        cable(freeCable('nastro · PLAY'), 'traccia 1', 'nastro · PLAY');
        cable(freeCable('nastro · SHIFT'), 'battuta', 'nastro · SHIFT');
        if (!ctx.mon?.playing) engine.send({ t: 'play' });
        ctx.status(
          ctx.reel.len
            ? 'the reel is cut in four; track 1 (the kick) replays the splice, every bar moves to the next. Record some chords into the reel for the full effect'
            : 'record some chords into the reel first (REC twice while the pads play); then each kick replays a splice and every bar moves on',
        );
      }
    }),
  );
}
