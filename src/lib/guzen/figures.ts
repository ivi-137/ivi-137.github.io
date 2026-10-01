/**
 * Live figures for "GUZEN: the dice are a 48-bit number". Declared in the post as plain divs:
 *
 *   <div data-vactrol data-caption="…"></div>   the gate's tail against a plain exponential release
 *   <div data-fold data-caption="…"></div>      the folder's waveform and the harmonics it adds
 *
 * Both evaluate the formulas GUZEN itself uses (LowpassGate.cpp and ComplexOscillator.cpp). The vactrol
 * curve is the closed-form solution of the gate's per-sample recurrence; the two agree to better than
 * one part in ten thousand. The fold figure is the plugin's waveshaper before its 2× oversampling.
 */

const INK = {
  paper: '#ece5d3',
  dim: 'rgba(236,229,211,.45)',
  faint: 'rgba(236,229,211,.12)',
  acid: '#c6ff3d',
  verm: '#ff4b1f',
};
const MONO = '11px "JetBrains Mono", ui-monospace, monospace';

// ── small helpers, in the style of the other figures ──────────────────────

function shell(host: HTMLElement, cls: string) {
  const fig = document.createElement('figure');
  fig.className = `embed embed--${cls}`;
  const stage = document.createElement('div');
  stage.className = 'gz__stage';
  const bar = document.createElement('div');
  bar.className = 'embed__bar mono';
  fig.append(stage, bar);
  if (host.dataset.caption) {
    const cap = document.createElement('figcaption');
    cap.textContent = host.dataset.caption;
    fig.append(cap);
  }
  host.replaceWith(fig);
  return { stage, bar };
}

function slider(bar: HTMLElement, label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, on: (v: number) => void) {
  const wrap = document.createElement('label');
  wrap.className = 'gz__slider';
  const input = document.createElement('input');
  input.type = 'range';
  Object.assign(input, { min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = document.createElement('output');
  out.textContent = fmt(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    on(v);
  });
  wrap.append(`${label} `, input, out);
  bar.append(wrap);
  return input;
}

function chip(bar: HTMLElement, label: string, on: () => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = label;
  b.addEventListener('click', on);
  bar.append(b);
  return b;
}

function canvas(stage: HTMLElement, w: number, h: number, label: string) {
  const c = document.createElement('canvas');
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.width = w * dpr;
  c.height = h * dpr;
  c.style.aspectRatio = `${w} / ${h}`;
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', label);
  stage.append(c);
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

function readout(bar: HTMLElement) {
  const s = document.createElement('span');
  s.className = 'gz__read';
  s.setAttribute('aria-live', 'polite');
  bar.append(s);
  return s;
}

/** Set a slider from code and let its listeners run. */
function setSlider(input: HTMLInputElement, v: number) {
  input.value = String(v);
  input.dispatchEvent(new Event('input'));
}

type Ctx = CanvasRenderingContext2D;

function text(ctx: Ctx, s: string, x: number, y: number, align: CanvasTextAlign = 'left', color: string = INK.dim) {
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
}

function line(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, color: string, width = 1, dash: number[] = []) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ── the gate's tail ───────────────────────────────────────────────────────

/**
 * LowpassGate.cpp, once the control has dropped to zero:
 *     c ← c − c · k · (0.12 + 0.88 c),   k = 1 − e^(−1/(T·fs))
 * In the limit of small steps, dc/dt = −(0.12 c + 0.88 c²)/T. Put u = 1/c and it is linear in u.
 */
const A = 0.12;
const B = 0.88;
const R = B / A; // 22/3

const vactrol = (t: number, T: number) => 1 / ((1 + R) * Math.exp((A * t) / T) - R);
const plain = (t: number, T: number) => Math.exp(-t / T);
const timeVactrol = (level: number, T: number) => (T / A) * Math.log((1 / level + R) / (1 + R));
const timePlain = (level: number, T: number) => -T * Math.log(level);
const toDb = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));

const secs = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(s < 10 ? 2 : 1)} s`);

function mountVactrol(host: HTMLElement) {
  const { stage, bar } = shell(host, 'vactrol');
  const { ctx, w, h } = canvas(stage, 720, 280, 'Gate conductance in decibels against time after the gate closes, for a vactrol and for a plain exponential release');
  const read = readout(bar);

  const M = { l: 48, r: 14, t: 14, b: 34 };
  const DB_MIN = -60;
  const SPAN = 25; // the x axis runs for 25 time constants
  let T = 0.4;

  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    ctx.font = MONO;
    const pw = w - M.l - M.r;
    const ph = h - M.t - M.b;
    const X = (u: number) => M.l + (u / SPAN) * pw; // u in units of T
    const Y = (db: number) => M.t + (db / DB_MIN) * ph;

    for (let d = 0; d >= DB_MIN; d -= 10) {
      line(ctx, M.l, Y(d), w - M.r, Y(d), d === 0 ? INK.dim : INK.faint);
      text(ctx, d === 0 ? '0 dB' : `${d}`, M.l - 8, Y(d) + 4, 'right');
    }
    for (let u = 0; u <= SPAN; u += 5) {
      line(ctx, X(u), M.t + ph, X(u), M.t + ph + 4, INK.dim);
      text(ctx, secs(u * T), X(u), h - 12, u === 0 ? 'left' : u === SPAN ? 'right' : 'center');
    }

    const curve = (f: (t: number) => number, color: string, width: number, dash: number[] = []) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      for (let i = 0; i <= 400; i++) {
        const u = (i / 400) * SPAN;
        const db = toDb(f(u * T));
        if (db < DB_MIN) break;
        i === 0 ? ctx.moveTo(X(u), Y(db)) : ctx.lineTo(X(u), Y(db));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    curve((t) => plain(t, T), INK.verm, 2, [6, 4]);
    curve((t) => vactrol(t, T), INK.acid, 2.5);

    // where each curve crosses −40 dB, which is 1% of full conductance
    const mark = (u: number, color: string, label: string, align: CanvasTextAlign) => {
      line(ctx, X(u), Y(-40), X(u), M.t + ph, color, 1, [2, 3]);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(X(u), Y(-40), 4, 0, Math.PI * 2);
      ctx.fill();
      text(ctx, label, X(u) + (align === 'left' ? 9 : -9), Y(-40) - 8, align, color);
    };
    const tv = timeVactrol(0.01, T);
    const te = timePlain(0.01, T);
    mark(te / T, INK.verm, secs(te), 'left');
    mark(tv / T, INK.acid, secs(tv), 'right');

    text(ctx, 'vactrol, as GUZEN models it', w - M.r - 6, M.t + 16, 'right', INK.acid);
    text(ctx, 'plain exponential, same starting slope', w - M.r - 6, M.t + 32, 'right', INK.verm);

    read.textContent = `to fall 40 dB (to 1%): vactrol ${secs(tv)}, plain exponential ${secs(te)}. The vactrol tail is ${(tv / te).toFixed(1)}× longer.`;
  };

  // VACTROL knob range in the plugin: 0.02 s to 6 s, here on a log scale
  const toT = (v: number) => 0.02 * Math.pow(300, v);
  const fromT = (t: number) => Math.log(t / 0.02) / Math.log(300);
  const knob = slider(bar, 'vactrol', 0, 1, 0.001, fromT(T), (v) => secs(toT(v)), (v) => ((T = toT(v)), draw()));
  chip(bar, 'tick 0.05 s', () => setSlider(knob, fromT(0.05)));
  chip(bar, 'default 0.4 s', () => setSlider(knob, fromT(0.4)));
  chip(bar, 'bell 3 s', () => setSlider(knob, fromT(3)));
  draw();
  void document.fonts?.ready.then(draw);
}

// ── the folder ────────────────────────────────────────────────────────────

/** ComplexOscillator.cpp: closed-form triangle fold, then a soft clip. Equals (2/π)·asin(sin(πx/2)). */
const tri = (x: number) => {
  const t = (x - 1) * 0.25;
  return 1 - 4 * Math.abs(t - Math.floor(t + 0.5));
};
/** A sine of height 1 + 7·fold, shifted by sym·fold, folded, then softened. (FM is off in this figure.) */
const shape = (theta: number, fold: number, sym: number) => Math.tanh(1.3 * tri(Math.sin(theta) * (1 + 7 * fold) + sym * fold)) * 0.82;

const HARMONICS = 24;
const N = 1024;
const FLOOR_DB = -80;

function analyse(fold: number, sym: number) {
  const x = new Float64Array(N);
  for (let n = 0; n < N; n++) x[n] = shape((2 * Math.PI * n) / N, fold, sym);

  const amps: number[] = [];
  for (let k = 1; k <= HARMONICS; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < N; n++) {
      const a = (2 * Math.PI * k * n) / N;
      re += x[n] * Math.cos(a);
      im += x[n] * Math.sin(a);
    }
    amps.push((2 / N) * Math.hypot(re, im));
  }

  // turnarounds: changes of direction around one cycle, on a finer grid
  const M = 4096;
  const v = new Float64Array(M + 1);
  for (let i = 0; i <= M; i++) v[i] = shape((2 * Math.PI * i) / M, fold, sym);
  let turns = 0;
  let prev = 0;
  for (let i = 1; i <= M; i++) {
    const d = Math.abs(v[i] - v[i - 1]) < 1e-9 ? 0 : Math.sign(v[i] - v[i - 1]);
    if (d !== 0) {
      if (prev !== 0 && d !== prev) turns++;
      prev = d;
    }
  }
  return { amps, turns };
}

function mountFold(host: HTMLElement) {
  const { stage, bar } = shell(host, 'fold');
  const { ctx, w, h } = canvas(stage, 720, 290, 'A folded sine wave over two cycles, and the strength of its first 24 harmonics in decibels');
  const read = readout(bar);

  let fold = 0.5;
  let sym = 0;

  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    ctx.font = MONO;
    const { amps, turns } = analyse(fold, sym);

    // left: two cycles of the waveform
    const L = { x: 12, y: 24, w: 330, h: h - 24 - 30 };
    const midY = L.y + L.h / 2;
    text(ctx, 'waveform, two cycles', L.x, 14);
    line(ctx, L.x, L.y, L.x + L.w, L.y, INK.faint);
    line(ctx, L.x, L.y + L.h, L.x + L.w, L.y + L.h, INK.faint);
    line(ctx, L.x, midY, L.x + L.w, midY, INK.dim);
    ctx.strokeStyle = INK.acid;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const steps = 600;
    for (let i = 0; i <= steps; i++) {
      const theta = (i / steps) * 4 * Math.PI;
      const px = L.x + (i / steps) * L.w;
      const py = midY - shape(theta, fold, sym) * (L.h / 2) * 0.96;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();

    // right: harmonics, odd in acid and even in vermilion
    const P = { x: 388, y: 24, w: 320, h: h - 24 - 30 };
    text(ctx, 'harmonics, dB', P.x, 14);
    const barsW = P.w - 30; // the last 30 px hold the dB labels, clear of the bars
    for (let d = 0; d >= FLOOR_DB; d -= 20) {
      const y = P.y + (d / FLOOR_DB) * P.h;
      line(ctx, P.x, y, P.x + barsW, y, d === 0 ? INK.dim : INK.faint);
      text(ctx, `${d}`, P.x + barsW + 6, y + 4, 'left');
    }
    const bw = barsW / HARMONICS;
    amps.forEach((a, i) => {
      const db = Math.max(FLOOR_DB, 20 * Math.log10(Math.max(a, 1e-12)));
      const bh = (db / FLOOR_DB) * P.h; // distance from the top (0 dB)
      ctx.fillStyle = (i + 1) % 2 === 1 ? INK.acid : INK.verm;
      ctx.fillRect(P.x + i * bw + 1, P.y + bh, Math.max(1, bw - 2), P.h - bh);
    });
    for (const k of [1, 6, 12, 18, 24]) text(ctx, String(k), P.x + (k - 0.5) * bw, h - 12, 'center');
    text(ctx, 'odd', P.x + 4, P.y + 14, 'left', INK.acid);
    text(ctx, 'even', P.x + 34, P.y + 14, 'left', INK.verm);

    // the readout
    const dbOf = (a: number) => 20 * Math.log10(Math.max(a, 1e-12));
    const fund = dbOf(amps[0]);
    const evenMax = dbOf(Math.max(...amps.filter((_, i) => (i + 1) % 2 === 0)));
    const even = evenMax < -100 ? 'no even harmonics' : `strongest even harmonic ${evenMax - fund >= 0 ? '+' : ''}${(evenMax - fund).toFixed(0)} dB against the fundamental`;
    read.textContent = `height ${(1 + 7 * fold).toFixed(2)} × the folder's window · ${turns} turnarounds per cycle · ${even}`;
  };

  const foldKnob = slider(bar, 'fold', 0, 1, 0.01, fold, (v) => v.toFixed(2), (v) => ((fold = v), draw()));
  const symKnob = slider(bar, 'symmetry', -1, 1, 0.01, sym, (v) => v.toFixed(2), (v) => ((sym = v), draw()));
  const preset = (f: number, s: number) => () => (setSlider(foldKnob, f), setSlider(symKnob, s));
  chip(bar, 'almost a sine', preset(0, 0));
  chip(bar, 'full fold', preset(1, 0));
  chip(bar, 'lopsided', preset(0.6, 0.5));
  draw();
  void document.fonts?.ready.then(draw);
}

export function mountGuzen(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-vactrol]').forEach(mountVactrol);
  root.querySelectorAll<HTMLElement>('[data-fold]').forEach(mountFold);
}
