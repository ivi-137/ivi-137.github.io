/**
 * Il nastro, on the panel: the reel drawn with its splices, gene and heads;
 * the Morphagene's three buttons with their held combinations; reel slots
 * kept in the browser; files in and out; the scrub strip.
 */
import type { Ctx } from './ui-kit';
import { clamp, fmtGlobal, fmtTime, flash, capture } from './ui-kit';
import type { FromG, ReelButton } from './msg';
import { encodeReel, readCues, wavRate } from './tape';
import { decodeFile, resample } from './engine';
import { loadReel, reelIndex, saveReel } from './store';
import { download } from '../audio/recorder';
import { toast } from '../ui/nav';

const HOLD_MS = 3000;
const CLOCK_IT: Record<string, string> = { shift: 'sposta il gene', sync: 'riavvia il gene', stretch: 'stira la giunta' };

export function mountReel(ctx: Ctx) {
  const { $, $$, engine } = ctx;
  let ov: Float32Array = new Float32Array(0),
    sov: Float32Array = new Float32Array(0);
  const btn = (b: ReelButton) => engine.send({ t: 'btn', b });
  const act = async (b: ReelButton, say?: string) => {
    if (!(await ctx.boot())) return;
    btn(b);
    if (say) ctx.status(say);
  };

  // ── the picture ──────────────────────────────────────────────────────────
  const cv = $<HTMLCanvasElement>('[data-reel]');
  const g = cv.getContext('2d')!;
  const empty = $('[data-reel-empty]');
  const ink = { paper: '#ddd3bb', ink: '#16140f', faint: 'rgba(22,20,15,0.38)', verm: '#ff4b1f', cobalt: '#2f45ff', acid: '#c6ff3d' };
  function drawReel() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(10, Math.round(cv.clientWidth * dpr)),
      h = Math.max(10, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    g.fillStyle = ink.paper;
    g.fillRect(0, 0, w, h);
    const r = ctx.reel,
      m = ctx.mon?.reel;
    const len = Math.max(r.len, m?.len ?? 0);
    empty.hidden = len > 0;
    if (!len) return;
    const X = (pos: number) => (pos / len) * w;
    const top = 18 * dpr,
      mid = top + (h - top - 14 * dpr) / 2,
      amp = (h - top - 14 * dpr) / 2;
    const cur = m?.cur ?? r.cur;
    const marks = r.marks;
    const end = (k: number) => (k + 1 < marks.length ? marks[k + 1] : len);
    // the current splice, tinted; the one Organize is waiting for, outlined
    g.fillStyle = 'rgba(255,75,31,0.13)';
    g.fillRect(X(marks[cur] ?? 0), top, X(end(cur)) - X(marks[cur] ?? 0), h - top);
    if (m && m.pending >= 0 && m.pending !== cur) {
      g.setLineDash([4 * dpr, 3 * dpr]);
      g.strokeStyle = ink.verm;
      g.lineWidth = 1.5 * dpr;
      g.strokeRect(X(marks[m.pending]) + 1, top + 1, X(end(m.pending)) - X(marks[m.pending]) - 2, h - top - 2);
      g.setLineDash([]);
    }
    // the audio
    const n = ov.length;
    if (n) {
      const bw = w / n;
      const s0 = marks[cur] ?? 0,
        s1 = end(cur);
      for (let i = 0; i < n; i++) {
        const pos = ((i + 0.5) / n) * len;
        g.fillStyle = pos >= s0 && pos < s1 ? ink.ink : ink.faint;
        const a = Math.max(0.5 * dpr, Math.min(1, ov[i]) * amp);
        g.fillRect(i * bw, mid - a, Math.max(1, bw - 0.4), 2 * a);
      }
    }
    // markers and their numbers
    g.font = `${10 * dpr}px "JetBrains Mono", monospace`;
    g.textBaseline = 'top';
    for (let k = 0; k < marks.length; k++) {
      const x = X(marks[k]);
      g.fillStyle = k === cur ? ink.verm : ink.ink;
      g.fillRect(x, 0, Math.max(1, 1.5 * dpr), h);
      if (X(end(k)) - x > 14 * dpr || k === cur) g.fillText(String(k + 1), x + 3 * dpr, 3 * dpr);
    }
    if (!m) return;
    // the gene: a band along the bottom
    if (m.geneLen > 0 && marks.length) {
      const s0 = marks[cur] ?? 0,
        s1 = end(cur);
      const a = m.geneStart,
        b = a + m.geneLen;
      g.fillStyle = 'rgba(47,69,255,0.75)';
      const y = h - 9 * dpr;
      if (b <= s1) g.fillRect(X(a), y, Math.max(2, X(b) - X(a)), 6 * dpr);
      else {
        g.fillRect(X(a), y, X(s1) - X(a), 6 * dpr);
        g.fillRect(X(s0), y, Math.max(2, X(s0 + (b - s1)) - X(s0)), 6 * dpr);
      }
    }
    // the play heads (one per sounding gene), the record head, the hand
    for (let i = 0; i < m.grains.length; i += 2) {
      g.globalAlpha = 0.25 + 0.75 * clamp(m.grains[i + 1]);
      g.fillStyle = ink.cobalt;
      g.fillRect(X(m.grains[i]) - dpr, top, 2.5 * dpr, h - top);
    }
    g.globalAlpha = 1;
    if (m.rec) {
      g.fillStyle = ink.verm;
      g.fillRect(X(Math.min(len, m.recHead)) - 1.5 * dpr, 0, 3 * dpr, h);
    }
    if (m.scrub >= 0) {
      g.fillStyle = ink.ink;
      g.fillRect(X(m.scrub) - 2 * dpr, 0, 4 * dpr, h);
      g.fillStyle = ink.acid;
      g.fillRect(X(m.scrub) - dpr, 0, 2 * dpr, h);
    }
  }
  cv.addEventListener('click', async (e) => {
    const len = ctx.reel.len;
    if (!len || !(await ctx.boot())) return;
    const rect = cv.getBoundingClientRect();
    const pos = ((e.clientX - rect.left) / rect.width) * len;
    const marks = ctx.reel.marks;
    let k = 0;
    while (k + 1 < marks.length && marks[k + 1] <= pos) k++;
    engine.send({ t: 'select', k });
    ctx.status(`giunta ${k + 1}`);
  });

  // ── readouts ──────────────────────────────────────────────────────────────
  const read = Object.fromEntries($$('[data-r]').map((el) => [el.dataset.r!, el]));
  function readouts() {
    const m = ctx.mon?.reel,
      r = ctx.reel;
    const count = m?.count ?? r.count;
    read.splice.textContent = count ? `${(m?.cur ?? r.cur) + 1} / ${count}${m && m.pending >= 0 && m.pending !== m.cur ? ` → ${m.pending + 1}` : ''}` : '—';
    read.gene.textContent = m && m.geneLen ? fmtTime(m.geneLen / r.sr).replace(/^0:0?/, '') + ' s' : '—';
    read.speed.textContent = m ? (Math.abs(m.spd) < 0.004 ? 'fermo' : `${m.spd < 0 ? '◀ ' : ''}${Math.abs(m.spd).toFixed(2)}×`) : '—';
    read.morph.textContent = fmtGlobal('n.morph', ctx.get('n.morph'));
    read.mode.textContent = m?.clock ? CLOCK_IT[m.clock] : '—';
    read.time.textContent = `${fmtTime((m?.len ?? r.len) / r.sr)} / ${fmtTime(r.cap / r.sr)}`;
  }

  // ── the buttons, with the Morphagene's held combinations ──────────────────────────
  const combo = $('[data-combo]');
  const B = Object.fromEntries($$<HTMLButtonElement>('[data-rb]').map((b) => [b.dataset.rb!, b]));
  const held = { rec: false, splice: false, shift: false };
  let used = { rec: false, shift: false };
  let timer = 0;
  let timerFor = '';
  const say = () => {
    combo.textContent = held.shift
      ? 'SHIFT held: SPLICE joins this splice with the next (hold 3 s: every marker goes) · REC cuts this splice out (hold 3 s: empty reel)'
      : held.rec
        ? 'REC held: press SPLICE to record a new splice at the end of the reel'
        : 'REC records · SPLICE marks · SHIFT moves on · hold SHIFT for the rest';
    B.shift.classList.toggle('is-held', held.shift);
    B.rec.classList.toggle('is-held', held.rec);
  };
  function hold(what: 'delMarkers' | 'clearReel', btnEl: HTMLElement) {
    clearTimeout(timer);
    timerFor = what;
    btnEl.classList.add('is-arming');
    timer = window.setTimeout(async () => {
      timerFor = 'done';
      btnEl.classList.remove('is-arming');
      await act(what, what === 'clearReel' ? 'the reel is empty' : 'every marker removed: one splice');
    }, HOLD_MS);
  }
  function unhold(btnEl: HTMLElement) {
    clearTimeout(timer);
    btnEl.classList.remove('is-arming');
    const was = timerFor;
    timerFor = '';
    return was;
  }
  async function down(which: 'rec' | 'splice' | 'shift') {
    if (!(await ctx.boot())) return;
    held[which] = true;
    if (which === 'shift') used.shift = false;
    if (which === 'rec') {
      used.rec = false;
      if (held.shift) hold('clearReel', B.rec);
    }
    if (which === 'splice') {
      if (held.shift) hold('delMarkers', B.splice);
      else if (held.rec) {
        used.rec = true;
        btn('recNew');
        ctx.status('recording a new splice at the end of the reel');
      }
    }
    say();
  }
  function up(which: 'rec' | 'splice' | 'shift') {
    if (!held[which]) return;
    held[which] = false;
    if (which === 'shift') {
      if (!used.shift) {
        btn('shift');
        ctx.status('next splice');
      }
    } else if (which === 'rec') {
      const t = unhold(B.rec);
      if (held.shift) {
        used.shift = true;
        if (t === 'clearReel') {
          btn('delSplice');
          ctx.status('splice cut out of the reel');
        }
      } else if (!used.rec) btn('rec');
    } else {
      const t = unhold(B.splice);
      if (held.shift) {
        used.shift = true;
        if (t === 'delMarkers') {
          btn('delMarker');
          ctx.status('joined with the next splice');
        }
      } else if (!held.rec) {
        btn('splice');
        flash(B.splice, 'is-blink');
      }
    }
    say();
  }
  for (const w of ['rec', 'splice', 'shift'] as const) {
    const el = B[w];
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      capture(el, e.pointerId);
      down(w);
    });
    el.addEventListener('pointerup', () => up(w));
    el.addEventListener('pointercancel', () => up(w));
    el.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        down(w);
      }
    });
    el.addEventListener('keyup', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        up(w);
      }
    });
    el.addEventListener('click', (e) => e.preventDefault());
  }
  B.play.addEventListener('click', async () => {
    if (!(await ctx.boot())) return;
    ctx.setParam('n.play', ctx.get('n.play') > 0.5 ? 0 : 1);
  });
  ctx.watch((id, v) => {
    if (id === 'n.play') B.play.setAttribute('aria-pressed', String(v > 0.5));
  });
  B.play.setAttribute('aria-pressed', String(ctx.get('n.play') > 0.5));
  // keys I O P: REC, SPLICE, SHIFT
  const keyMap: Record<string, 'rec' | 'splice' | 'shift'> = { i: 'rec', o: 'splice', p: 'shift' };
  const typing = (t: EventTarget | null) => t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
  const onKey = (e: KeyboardEvent) => {
    const w = keyMap[e.key.toLowerCase()];
    if (!w || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'keydown') {
      if (!e.repeat) down(w);
    } else up(w);
  };
  addEventListener('keydown', onKey, { capture: true });
  addEventListener('keyup', onKey, { capture: true });
  ctx.cleanup(() => {
    removeEventListener('keydown', onKey, { capture: true });
    removeEventListener('keyup', onKey, { capture: true });
  });

  $$<HTMLButtonElement>('[data-ra]').forEach((b) =>
    b.addEventListener('click', async () => {
      const a = b.dataset.ra as ReelButton;
      if (a === 'clearReel' && b.dataset.sure !== '1') {
        b.dataset.sure = '1';
        b.textContent = 'sicuro? di nuovo';
        setTimeout(() => {
          delete b.dataset.sure;
          b.textContent = 'svuota la bobina';
        }, 2500);
        return;
      }
      if (a === 'clearReel') {
        delete b.dataset.sure;
        b.textContent = 'svuota la bobina';
      }
      const words: Partial<Record<ReelButton, string>> = {
        recNew: 'recording a new splice at the end (press REC to stop)',
        delMarker: 'joined with the next splice',
        delMarkers: 'every marker removed',
        delSplice: 'splice cut out of the reel',
        clearReel: 'the reel is empty',
      };
      if (a === 'arm') {
        const bars = [0, 1, 2, 4][ctx.get('n.qrec')] || 1;
        const m = ctx.mon;
        if (!m?.playing) ctx.status(`armed: ${bars} bar${bars > 1 ? 's' : ''} from the next downbeat (press ▶)`);
        else ctx.status(m.reel.armed || m.reel.rec ? 'disarmed' : `armed: ${bars} bar${bars > 1 ? 's' : ''} from the next downbeat`);
        await act('arm');
        return;
      }
      await act(a, words[a]);
    }),
  );
  $$<HTMLButtonElement>('[data-divide]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await ctx.boot())) return;
      engine.send({ t: 'divide', n: Number(b.dataset.divide) });
      ctx.status(`splice cut into ${b.dataset.divide}`);
    }),
  );

  // ── reel slots, files ─────────────────────────────────────────────────────────
  let slot = 1;
  try {
    slot = clamp(Number(localStorage.getItem('genoma:slot')) || 1, 1, 8);
  } catch {
    /* fine */
  }
  const slots = $$<HTMLButtonElement>('[data-slot]');
  const savedEl = $('[data-reel-saved]');
  async function showIndex() {
    const idx = await reelIndex();
    slots.forEach((b) => {
      const n = Number(b.dataset.slot);
      b.setAttribute('aria-pressed', String(n === slot));
      b.classList.toggle('has-audio', (idx[n] ?? 0) > 0);
    });
    savedEl.textContent = idx[slot] ? `${fmtTime(idx[slot])} salvati` : 'vuota';
  }
  let saveT = 0,
    saving = Promise.resolve();
  async function saveNow() {
    clearTimeout(saveT);
    const d = await engine.dump();
    const ok = await saveReel(slot, { L: d.L, R: d.R, marks: d.marks, sr: d.sr, date: Date.now() });
    if (!ok) savedEl.textContent = 'non salvata (spazio?)';
    await showIndex();
  }
  const scheduleSave = () => {
    clearTimeout(saveT);
    saveT = window.setTimeout(() => (saving = saveNow()), 1200);
  };
  async function loadSlot(n: number) {
    const r = await loadReel(n);
    const sr = engine.ctx!.sampleRate;
    if (r && r.L.length) {
      const k = r.sr / sr;
      const { L, R } = await resample(r.L, r.R, r.sr, sr);
      engine.send({ t: 'load', L, R, marks: r.marks.map((m) => Math.round(m / k)), append: false }, [L.buffer, R.buffer]);
    } else engine.send({ t: 'load', L: new Float32Array(0), R: new Float32Array(0), marks: [0], append: false });
  }
  slots.forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await ctx.boot())) return;
      const n = Number(b.dataset.slot);
      if (n === slot) return;
      await saving;
      await saveNow();
      slot = n;
      try {
        localStorage.setItem('genoma:slot', String(n));
      } catch {
        /* fine */
      }
      await loadSlot(n);
      await showIndex();
      ctx.status(`bobina ${n}`);
    }),
  );
  showIndex();

  async function readFile(f: File, append: boolean) {
    if (!(await ctx.boot())) return;
    try {
      const buf = await f.arrayBuffer();
      const cues = readCues(buf),
        rate = wavRate(buf);
      const sr = engine.ctx!.sampleRate;
      const { L, R } = await decodeFile(engine.ctx!, buf);
      const marks = cues.map((c) => Math.round((c * sr) / (rate || sr)));
      engine.send({ t: 'load', L, R, marks: [0, ...marks], append }, [L.buffer, R.buffer]);
      const secs = L.length / sr;
      ctx.status(
        `${f.name}: ${fmtTime(secs)}${marks.length ? `, ${marks.length + 1} splices from its cue points` : ''}${secs > ctx.reel.cap / sr ? ' (cut to the reel’s 2:54)' : ''}`,
      );
    } catch (e) {
      console.error(e);
      toast('The browser could not decode that file.');
    }
  }
  $<HTMLInputElement>('[data-reel-file]').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) readFile(f, false);
    input.value = '';
  });
  $<HTMLInputElement>('[data-reel-add]').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) readFile(f, true);
    input.value = '';
  });
  const screen = $('.reel__screen');
  screen.addEventListener('dragover', (e) => {
    e.preventDefault();
    screen.classList.add('is-drop');
  });
  screen.addEventListener('dragleave', () => screen.classList.remove('is-drop'));
  screen.addEventListener('drop', (e) => {
    e.preventDefault();
    screen.classList.remove('is-drop');
    const f = e.dataTransfer?.files?.[0];
    if (f) readFile(f, true);
  });
  $('[data-reel-wav]').addEventListener('click', async () => {
    if (!(await ctx.boot())) return;
    const d = await engine.dump();
    if (!d.L.length) return void toast('The reel is empty.');
    ctx.status('writing the reel…');
    const { L, R } = await resample(d.L, d.R, d.sr, 48000);
    const marks = d.marks.map((m) => Math.round((m * 48000) / d.sr));
    download(new Blob([encodeReel(L, R, 48000, marks)], { type: 'audio/wav' }), `mg${slot}.wav`);
    ctx.status(`mg${slot}.wav: ${fmtTime(L.length / 48000)}, ${marks.length} splice${marks.length > 1 ? 's' : ''}`);
  });

  // ── the scrub strip ───────────────────────────────────────────────────────────
  const sc = $<HTMLCanvasElement>('[data-scrub]');
  const sg = sc.getContext('2d')!;
  let scrubX = -1;
  function drawScrub() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(10, Math.round(sc.clientWidth * dpr)),
      h = Math.max(10, Math.round(sc.clientHeight * dpr));
    if (sc.width !== w || sc.height !== h) {
      sc.width = w;
      sc.height = h;
    }
    sg.fillStyle = '#ece5d3';
    sg.fillRect(0, 0, w, h);
    const n = sov.length;
    if (!n || !ctx.reel.len) {
      sg.fillStyle = 'rgba(22,20,15,0.5)';
      sg.font = `${11 * dpr}px "JetBrains Mono", monospace`;
      sg.fillText('the reel is empty', 10 * dpr, h / 2 + 4 * dpr);
      return;
    }
    const bw = w / n;
    sg.fillStyle = '#2336d6';
    for (let i = 0; i < n; i++) {
      const a = Math.max(0.5 * dpr, Math.min(1, sov[i]) * h * 0.45);
      sg.fillRect(i * bw, h / 2 - a, Math.max(1, bw - 0.3), 2 * a);
    }
    const m = ctx.mon?.reel;
    const marks = ctx.reel.marks;
    const cur = m?.cur ?? ctx.reel.cur;
    const s0 = marks[cur] ?? 0,
      s1 = cur + 1 < marks.length ? marks[cur + 1] : ctx.reel.len;
    const X = (p: number) => ((p - s0) / Math.max(1, s1 - s0)) * w;
    if (m && m.scrub >= 0) {
      sg.fillStyle = '#16140f';
      sg.fillRect(X(m.scrub) - 2 * dpr, 0, 4 * dpr, h);
    } else if (m)
      for (let i = 0; i < m.grains.length; i += 2) {
        sg.globalAlpha = 0.3 + 0.7 * clamp(m.grains[i + 1]);
        sg.fillStyle = '#ff4b1f';
        sg.fillRect(X(m.grains[i]) - dpr, 0, 2 * dpr, h);
      }
    sg.globalAlpha = 1;
  }
  const scrubTo = (x: number, on: boolean) => {
    scrubX = clamp(x);
    engine.send({ t: 'scrub', on, x: scrubX });
    sc.setAttribute('aria-valuenow', String(Math.round(scrubX * 100)));
  };
  let scrubbing = false;
  sc.addEventListener('pointerdown', async (e) => {
    if (!(await ctx.boot())) return;
    scrubbing = true;
    capture(sc, e.pointerId);
    const r = sc.getBoundingClientRect();
    scrubTo((e.clientX - r.left) / r.width, true);
  });
  sc.addEventListener('pointermove', (e) => {
    if (!scrubbing) return;
    const r = sc.getBoundingClientRect();
    scrubTo((e.clientX - r.left) / r.width, true);
  });
  const stop = () => {
    if (!scrubbing) return;
    scrubbing = false;
    engine.send({ t: 'scrub', on: false, x: scrubX });
  };
  sc.addEventListener('pointerup', stop);
  sc.addEventListener('pointercancel', stop);
  let keyT = 0;
  sc.addEventListener('keydown', async (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d || !(await ctx.boot())) return;
    e.preventDefault();
    scrubTo((scrubX < 0 ? 0 : scrubX) + d * (e.shiftKey ? 0.005 : 0.02), true);
    clearTimeout(keyT);
    keyT = window.setTimeout(() => engine.send({ t: 'scrub', on: false, x: scrubX }), 350);
  });

  // ── messages ──────────────────────────────────────────────────────────────────
  function onMsg(m: FromG) {
    if (m.t === 'reel') {
      ov = m.ov;
      sov = m.sov;
      Object.assign(ctx.reel, { sr: m.sr, len: m.len, count: m.len ? m.marks.length : 0, cur: m.cur, marks: m.marks, cap: m.cap });
    } else if (m.t === 'dirty') scheduleSave();
    else if (m.t === 'full') {
      ctx.status('the reel is full: 2:54 of tape. Cut a splice out (SHIFT + REC) or start another reel');
      toast('The reel is full.');
    }
  }
  function onMon() {
    const m = ctx.mon!.reel;
    ctx.reel.geneLen = m.geneLen;
    B.rec.classList.toggle('is-rec', m.rec === 1);
    B.rec.classList.toggle('is-new', m.rec === 2);
    B.rec.classList.toggle('is-armed', !!m.armed && !m.rec);
    B.play.classList.toggle('is-on', m.play);
  }
  ctx.onMon(onMon);
  ctx.onFrame(() => {
    drawReel();
    drawScrub();
    readouts();
  });
  return {
    onMsg,
    /** load this browser's reel into the worklet (after boot) */
    async restore() {
      await loadSlot(slot);
    },
    async flush() {
      if (saveT) await saveNow();
    },
  };
}
