import { Flow, SYSTEMS, Swarm, type SystemId, type V3 } from './chaos';
import { anchorOf, cadence, choose, modalInterchange, render, secondaryDominants, tensionTarget, tritoneSubs, type Link, type NoteEvent } from './progression';
import { NAMES, chord, diatonic, roman, type Chord, type Key } from '../synth/harmony';
import { Midi } from '../synth/midi';
import { smf } from '../stochos/smf';
import { toast } from '../ui/nav';

const LENS = [8, 12, 16, 20, 24, 32];
const BEATS = [1, 2, 4, 8];

export function mountAttrattore() {
  const root = document.querySelector<HTMLElement>('[data-attr]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  const $ = <T extends HTMLElement>(q: string) => root.querySelector<T>(q)!;
  const $$ = <T extends HTMLElement>(q: string) => [...root.querySelectorAll<T>(q)];

  const p = {
    bpm: 92, sys: 'lorenz' as SystemId, k: 28, speed: 8,
    swarm: { count: 60, cohesion: 0.35, alignment: 0.4, separation: 0.3, coupling: 0.6 },
    influence: 0.45, model: 0, tonic: 0, minor: 0, len: 2, beats: 2, curve: 4,
    spice: 0.3, gravity: 0.55, tensionAmt: 0.6, human: 0.25, voicing: 1, ext: 1, pattern: 0, bass: 1, chCh: 0, chBass: 1,
  };
  const t = { evolve: false, cadence: true, clockOut: true, preview: true };
  const key = (): Key => ({ tonic: p.tonic, minor: p.minor === 1 });
  const flow = new Flow(p.sys, p.k);
  const swarm = new Swarm();
  let chain: Link[] = [];
  let events: NoteEvent[] = [];
  let voicings: number[][] = [];
  let now = -1;
  const flashes: Array<{ p: V3; label: string; t: number }> = [];

  // ── the swarm's vote: density near each chord's place on the dial ─────────────
  let bounds = { cx: 0, cy: 0, sx: 20, sy: 20 };
  const norm = (q: V3): [number, number] => [(q[0] - bounds.cx) / bounds.sx, (q[1] - bounds.cy) / bounds.sy];
  const bias = (c: Chord) => {
    if (!swarm.pos.length) return 0;
    const [ax, ay] = anchorOf(c);
    let d = 0;
    for (const q of swarm.pos) {
      const [x, y] = norm(q);
      d += Math.exp(-((x - ax) ** 2 + (y - ay) ** 2) / (2 * 0.18 ** 2));
    }
    return Math.min(1, (d / swarm.pos.length) * 3);
  };
  const nextU = () => {
    for (let guard = 0; guard < 400; guard++) {
      const hits = flow.step(50);
      if (hits.length) {
        flashes.push({ p: [...flow.p] as V3, label: '', t: performance.now() });
        return hits[0];
      }
    }
    return Math.random();
  };

  // ── composing ─────────────────────────────────────────────────────────────
  const pick = (i: number, prev: Chord) => {
    const n = chain.length;
    const u = nextU();
    const r = choose(prev, { model: p.model, key: key(), spice: p.spice, u, target: tensionTarget(p.curve, i, n), tensionAmt: p.tensionAmt, bias, influence: p.influence, gravity: p.gravity });
    if (flashes.length) flashes[flashes.length - 1].label = r.chord.name;
    return { chord: r.chord, locked: false, tension: r.tension, u };
  };
  const compose = () => {
    const n = LENS[p.len];
    chain = [...Array(n)].map((_, i) => chain[i] ?? { chord: diatonic(key(), 1), locked: false, tension: 0, u: 0 });
    let prev = diatonic(key(), 1);
    chain.forEach((l, i) => {
      if (!l.locked) chain[i] = pick(i, prev);
      prev = chain[i].chord;
    });
    if (t.cadence) cadence(chain, key());
    chain.forEach((l) => (l.chord = { ...l.chord, roman: l.chord.roman ?? roman(l.chord, p.tonic) }));
    rerender();
  };
  const rerender = () => {
    const r = render(chain, key(), { beats: BEATS[p.beats], voicing: p.voicing, ext: p.ext, pattern: p.pattern, bass: p.bass, human: p.human });
    events = r.events.sort((a, b) => a.beat - b.beat);
    voicings = r.voicings;
    renderChain();
  };

  // ── the chain strip ──────────────────────────────────────────────────────────
  const chainEl = $('[data-chain]');
  function renderChain() {
    chainEl.replaceChildren(
      ...chain.map((l, i) => {
        const li = document.createElement('li');
        li.className = `attr__link${l.locked ? ' is-locked' : ''}${i === now ? ' is-now' : ''}`;
        li.style.setProperty('--tens', String(l.tension));
        li.innerHTML = `<button type="button" class="attr__chord"><b></b><i class="mono"></i></button>
          <span class="attr__tens" title="measured tension"></span>
          <span class="attr__tools mono"><button type="button" data-lock aria-pressed="${l.locked}" aria-label="Lock">${l.locked ? '🔒' : '🔓'}</button><button type="button" data-reroll aria-label="Re-roll">⟳</button></span>`;
        li.querySelector('b')!.textContent = l.chord.name;
        li.querySelector('i')!.textContent = l.chord.roman ?? '';
        li.querySelector('.attr__chord')!.addEventListener('click', () => audition(i));
        li.querySelector('[data-lock]')!.addEventListener('click', () => ((l.locked = !l.locked), renderChain()));
        li.querySelector('[data-reroll]')!.addEventListener('click', () => {
          chain[i] = pick(i, chain[(i - 1 + chain.length) % chain.length].chord);
          rerender();
          audition(i);
        });
        return li;
      }),
    );
  }

  // ── sound: preview voices, MIDI, clock ──────────────────────────────────────
  let ctx: AudioContext | null = null;
  const ensure = async () => {
    ctx ??= new AudioContext({ latencyHint: 'interactive' });
    await ctx.resume();
    return ctx;
  };
  const midi: Midi = new Midi({ note: () => {}, cc: () => {}, clock: () => {}, start: () => {}, stop: () => {} });
  const perf = (tt: number) => performance.now() + (tt - ctx!.currentTime) * 1000;
  const voiceNote = (ev: { note: number; vel: number; part: 'chord' | 'bass' }, at: number, dur: number) => {
    midi.note(ev.part === 'bass' ? p.chBass : p.chCh, ev.note, ev.vel, perf(at), perf(at + dur));
    if (!t.preview) return;
    const c = ctx!;
    const f = 440 * 2 ** ((ev.note - 69) / 12);
    const g = c.createGain(), lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = ev.part === 'bass' ? 500 : 1600;
    const peak = (ev.part === 'bass' ? 0.22 : 0.07) * ev.vel;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.02);
    g.gain.setValueAtTime(peak, at + Math.max(0.03, dur - 0.05));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.35);
    lp.connect(g).connect(c.destination);
    for (const [type, det] of (ev.part === 'bass' ? [['triangle', 0]] : [['sawtooth', -7], ['triangle', 6]]) as Array<[OscillatorType, number]>) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = det;
      o.connect(lp);
      o.start(at);
      o.stop(at + dur + 0.4);
    }
  };
  const audition = async (i: number) => {
    const c = await ensure();
    const at = c.currentTime + 0.02;
    (voicings[i] ?? []).forEach((n) => voiceNote({ note: n, vel: 0.75, part: 'chord' }, at, 1.4));
  };

  let playing = false, startT = 0, done = 0, clockNext = 0, timer = 0;
  const bounds$ = new Array<{ time: number; i: number }>();
  const spb = () => 60 / p.bpm;
  const schedule = () => {
    const c = ctx!;
    const horizon = (c.currentTime + 0.12 - startT) / spb();
    const beatsPer = BEATS[p.beats], loop = chain.length * beatsPer;
    for (let L = Math.floor(done / loop); L <= Math.floor(horizon / loop); L++) {
      for (const ev of events) {
        const b = L * loop + ev.beat;
        if (b >= done && b < horizon) voiceNote(ev, startT + b * spb(), ev.dur * spb());
      }
      for (let i = 0; i < chain.length; i++) {
        const b = L * loop + i * beatsPer;
        if (b >= done && b < horizon) bounds$.push({ time: startT + b * spb(), i });
      }
    }
    done = horizon;
    if (t.clockOut)
      while (clockNext < c.currentTime + 0.12) {
        midi.clock(perf(clockNext));
        clockNext += spb() / 24;
      }
  };
  const playBtn = $<HTMLButtonElement>('[data-play]');
  const togglePlay = async () => {
    const c = await ensure();
    playing = !playing;
    if (playing) {
      startT = c.currentTime + 0.08;
      clockNext = startT;
      done = 0;
      bounds$.length = 0;
      if (t.clockOut) midi.transport(true);
      timer = window.setInterval(schedule, 25);
      schedule();
    } else {
      clearInterval(timer);
      if (t.clockOut) midi.transport(false);
      midi.panic();
      now = -1;
      renderChain();
    }
    playBtn.setAttribute('aria-pressed', String(playing));
    playBtn.textContent = playing ? '■ stop' : '▶ play';
  };
  playBtn.addEventListener('click', togglePlay);

  // ── controls ─────────────────────────────────────────────────────────────────
  const REcompose = new Set(['model', 'tonic', 'minor', 'len', 'curve', 'spice', 'gravity', 'tensionAmt']);
  const setOut = (b: string, v: number) => {
    const o = root.querySelector<HTMLOutputElement>(`[data-o="${b}"]`);
    if (o) o.textContent = b === 'swarm.count' ? String(v) : v.toFixed(2);
  };
  $$<HTMLInputElement | HTMLSelectElement>('[data-v]').forEach((el) => {
    const b = el.dataset.v!;
    const get = () => (b.startsWith('swarm.') ? (p.swarm as any)[b.slice(6)] : (p as any)[b]);
    if (el.tagName === 'SELECT' && b !== 'sys') el.value = String(get());
    setOut(b, Number(get()));
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
      const v = b === 'sys' ? el.value : Number(el.value);
      if (b.startsWith('swarm.')) (p.swarm as any)[b.slice(6)] = v;
      else (p as any)[b] = v;
      setOut(b, Number(v));
      if (b === 'sys') {
        const S = SYSTEMS[p.sys];
        p.k = S.param.def;
        const k = $<HTMLInputElement>('[data-v="k"]');
        Object.assign(k, { min: String(S.param.min), max: String(S.param.max), value: String(S.param.def) });
        $('[data-klabel]').textContent = S.param.label;
        flow.reset(p.sys, p.k);
        swarm.pos.length = swarm.vel.length = 0;
      }
      if (b === 'k') flow.k = p.k;
      if (REcompose.has(b)) compose();
      else if (['voicing', 'ext', 'pattern', 'bass', 'human', 'beats'].includes(b)) rerender();
    });
  });
  $$('[data-t]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const k = btn.dataset.t as keyof typeof t;
      t[k] = !t[k];
      btn.setAttribute('aria-pressed', String(t[k]));
      if (k === 'cadence' && t.cadence) cadence(chain, key()), rerender();
    }),
  );
  const acts: Record<string, () => void> = {
    compose,
    secdom: () => (secondaryDominants(chain, key()), rerender()),
    tritone: () => (tritoneSubs(chain, key()), rerender()),
    modal: () => (modalInterchange(chain, key()), rerender()),
    export: () => {
      const tr = (part: 'chord' | 'bass', ch: number) =>
        events.filter((e) => e.part === part).flatMap((e) => [
          { tick: Math.round(e.beat * 96), data: [0x90 | ch, e.note, Math.max(1, Math.round(e.vel * 127))] },
          { tick: Math.round((e.beat + e.dur) * 96), data: [0x80 | ch, e.note, 0] },
        ]);
      const bytes = smf([tr('chord', p.chCh), tr('bass', p.chBass)], 96, p.bpm, ['chords', 'bass']);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/midi' }));
      a.download = `attrattore-${NAMES[p.tonic]}${p.minor ? 'm' : ''}-${chain.length}-chords.mid`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },
  };
  $$('[data-act]').forEach((b) => b.addEventListener('click', () => acts[b.dataset.act!]()));
  $('[data-midi]').addEventListener('click', async () => {
    if (!Midi.supported) return toast('No Web MIDI in this browser: use Chrome, Edge or Opera on the desktop.');
    try {
      await midi.enable();
    } catch {
      return toast('MIDI permission was not granted.');
    }
    const out = $<HTMLSelectElement>('[data-midi-out]');
    out.replaceChildren(new Option('MIDI out: none', ''), ...midi.outputs.map((o) => new Option(`out: ${o.name}`, o.id)));
    out.hidden = false;
    out.onchange = () => midi.selectOutput(out.value);
    if (midi.outputs[0]) (out.value = midi.outputs[0].id), midi.selectOutput(out.value);
    toast(midi.outputs.length ? `MIDI out: ${midi.outputs[0].name}` : 'No MIDI outputs. Create a virtual port (loopMIDI on Windows, IAC on macOS).');
  });

  // ── the processor ────────────────────────────────────────────────────────────
  const cv = $<HTMLCanvasElement>('[data-proc]');
  let yaw = 0.6, dragX: number | null = null;
  cv.addEventListener('pointerdown', (e) => ((dragX = e.clientX), cv.setPointerCapture(e.pointerId)));
  cv.addEventListener('pointermove', (e) => dragX !== null && ((yaw += (e.clientX - dragX) * 0.01), (dragX = e.clientX)));
  cv.addEventListener('pointerup', () => (dragX = null));
  let raf = 0, frameN = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    frameN++;
    flow.step(p.speed);
    const S = SYSTEMS[p.sys];
    const center = S.center(p.k);
    if (frameN % 30 === 1 && flow.trail.length > 50) {
      const xs = flow.trail.map((q) => q[0]), ys = flow.trail.map((q) => q[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      bounds = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, sx: Math.max(1, (x1 - x0) / 2), sy: Math.max(1, (y1 - y0) / 2) };
    }
    swarm.seed(Math.round(p.swarm.count), flow.p);
    swarm.update(p.sys, p.k, p.swarm, S.dt * 2.5, flow.p);
    if (dragX === null) yaw += 0.0015;
    // playhead from the clock
    if (playing && ctx) {
      while (bounds$.length && bounds$[0].time <= ctx.currentTime) {
        const b = bounds$.shift()!;
        const leaving = now;
        now = b.i;
        if (t.evolve && leaving >= 0 && !chain[leaving].locked) {
          chain[leaving] = pick(leaving, chain[(leaving - 1 + chain.length) % chain.length].chord);
          if (t.cadence) cadence(chain, key());
          rerender();
        } else renderChain();
      }
    }
    draw(center);
  };
  const draw = (center: V3) => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = cv.clientWidth, H = innerWidth < 700 ? 340 : 480;
    if (cv.width !== Math.round(W * dpr)) (cv.width = Math.round(W * dpr)), (cv.height = Math.round(H * dpr)), (cv.style.height = `${H}px`);
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#07080a';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(198,255,61,0.05)';
    for (let x = 0; x < W; x += 24) g.fillRect(x, 0, 1, H);
    for (let y = 0; y < H; y += 24) g.fillRect(0, y, W, 1);
    const S = SYSTEMS[p.sys];
    const s = H * S.scale * 0.8, pitch = 0.42;
    const proj = (q: V3): [number, number] => {
      const x = q[0] - center[0], y = q[1] - center[1], z = q[2] - center[2];
      const xr = x * Math.cos(yaw) - y * Math.sin(yaw), yr = x * Math.sin(yaw) + y * Math.cos(yaw);
      return [W * 0.42 + xr * s, H / 2 - (z * Math.cos(pitch) + yr * Math.sin(pitch)) * s];
    };
    // Poincaré section
    const plane: V3[] = p.sys === 'lorenz' ? [[-24, -30, p.k - 1], [24, -30, p.k - 1], [24, 30, p.k - 1], [-24, 30, p.k - 1]] : [[0, -14, -2], [0, 0, -2], [0, 0, 22], [0, -14, 22]];
    g.beginPath();
    plane.map(proj).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fillStyle = 'rgba(255,75,31,0.07)';
    g.fill();
    g.strokeStyle = 'rgba(255,75,31,0.4)';
    g.stroke();
    // trajectory
    const tr = flow.trail;
    for (let i = 1; i < tr.length; i += 2) {
      const [x0, y0] = proj(tr[i - 1]), [x1, y1] = proj(tr[i]);
      g.strokeStyle = `rgba(198,255,61,${0.05 + 0.7 * (i / tr.length) ** 2})`;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
    // swarm
    g.fillStyle = 'rgba(125,140,255,0.85)';
    for (const q of swarm.pos) {
      const [x, y] = proj(q);
      g.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    // the moving point and the crossings
    const [px, py] = proj(flow.p);
    g.fillStyle = '#ece5d3';
    g.beginPath();
    g.arc(px, py, 3.5, 0, Math.PI * 2);
    g.fill();
    const tnow = performance.now();
    while (flashes.length && tnow - flashes[0].t > 2600) flashes.shift();
    for (const f of flashes) {
      const a = 1 - (tnow - f.t) / 2600;
      const [x, y] = proj(f.p);
      g.strokeStyle = `rgba(255,75,31,${a})`;
      g.beginPath();
      g.arc(x, y, 6 + (1 - a) * 14, 0, Math.PI * 2);
      g.stroke();
      if (f.label) {
        g.fillStyle = `rgba(236,229,211,${a})`;
        g.font = '12px "JetBrains Mono", monospace';
        g.fillText(f.label, x + 10, y - 8);
      }
    }
    // the dial: circle of fifths, where the swarm votes
    const R = Math.min(90, H * 0.2), dx = W - R - 22, dy = H - R - 22;
    g.strokeStyle = 'rgba(236,229,211,0.25)';
    g.beginPath();
    g.arc(dx, dy, R, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = 'rgba(125,140,255,0.5)';
    for (const q of swarm.pos) {
      const [x, y] = norm(q);
      if (Math.abs(x) < 1.2 && Math.abs(y) < 1.2) g.fillRect(dx + x * R - 1, dy + y * R - 1, 2, 2);
    }
    const cur = now >= 0 ? chain[now]?.chord : null;
    for (let r = 0; r < 12; r++)
      for (const q of ['M', 'm'] as const) {
        const c = chord(r, q);
        const [ax, ay] = anchorOf(c);
        const b = bias(c);
        const on = cur && cur.root === r && (cur.quality === 'm' || cur.quality === 'm7') === (q === 'm');
        g.fillStyle = on ? '#c6ff3d' : `rgba(236,229,211,${0.25 + b * 0.75})`;
        g.beginPath();
        g.arc(dx + ax * R, dy + ay * R, on ? 6 : 2.5 + b * 5, 0, Math.PI * 2);
        g.fill();
        if (q === 'M') {
          g.font = '9px "JetBrains Mono", monospace';
          g.fillText(NAMES[r], dx + ax * R * 1.18 - 5, dy + ay * R * 1.18 + 3);
        }
      }
    g.fillStyle = 'rgba(236,229,211,0.6)';
    g.font = '10px "JetBrains Mono", monospace';
    g.fillText('circle of fifths · swarm vote', dx - R, dy - R - 8);
    $('[data-readout]').textContent = `${S.name} · ${S.param.label} = ${p.k.toFixed(1)} · crossings ${flow.crossings.length} · now ${cur ? `${cur.name} (${cur.roman ?? ''})` : '—'}`;
  };

  const onKey = (e: KeyboardEvent) => {
    const tg = e.target as HTMLElement;
    if (!document.body.contains(root) || /^(INPUT|SELECT|TEXTAREA)$/.test(tg.tagName) || e.key !== ' ' || tg.closest('button')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    togglePlay();
  };
  addEventListener('keydown', onKey, { capture: true });
  document.addEventListener(
    'astro:before-swap',
    () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
      removeEventListener('keydown', onKey, { capture: true });
      if (playing) midi.transport(false), midi.panic();
      ctx?.close();
    },
    { once: true },
  );
  // warm the attractor up, then compose the first chain
  flow.step(3000);
  compose();
  raf = requestAnimationFrame(frame);
}
