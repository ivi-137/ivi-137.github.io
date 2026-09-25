/**
 * Live figures for "You need coherence". Declared in the post as plain divs,
 * like every other embed in this notebook:
 *
 *   <div data-attention data-caption="…"></div>
 *   <div data-posenc data-caption="…"></div>
 *   <div data-dilution data-caption="…"></div>
 *   <div data-survival data-caption="…"></div>
 */
import { rng } from './toy';

const INK = { paper: '#ece5d3', dim: 'rgba(236,229,211,.35)', faint: 'rgba(236,229,211,.12)', acid: '#c6ff3d', verm: '#ff4b1f', ghost: '#7d8cff', violet: '#9a6bff' };
const MONO = '11px "JetBrains Mono", ui-monospace, monospace';

export function shell(host: HTMLElement, cls: string) {
  const fig = document.createElement('figure');
  fig.className = `embed embed--${cls}`;
  const stage = document.createElement('div');
  stage.className = 'cx__stage';
  const bar = document.createElement('div');
  bar.className = 'embed__bar mono';
  fig.append(stage, bar);
  if (host.dataset.caption) {
    const cap = document.createElement('figcaption');
    cap.textContent = host.dataset.caption;
    fig.append(cap);
  }
  host.replaceWith(fig);
  return { fig, stage, bar };
}

export function slider(bar: HTMLElement, label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, on: (v: number) => void) {
  const wrap = document.createElement('label');
  wrap.className = 'cx__slider';
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

export function chip(bar: HTMLElement, label: string, on: () => void, title?: string) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', on);
  bar.append(b);
  return b;
}

export function canvas(stage: HTMLElement, w: number, h: number) {
  const c = document.createElement('canvas');
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.width = w * dpr;
  c.height = h * dpr;
  c.style.aspectRatio = `${w} / ${h}`;
  stage.append(c);
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  return { c, ctx, w, h };
}

// ── 1. scaled dot-product attention ─────────────────────────────────────

const SENTENCE = ['Every', 'post', 'has', 'a', 'sigil', ',', 'a', 'small', 'automaton', 'grown', 'from', 'its', 'title', '.'];
/** pairs that are related, so the picture is not pure noise */
const LINKS: [number, number][] = [[11, 1], [12, 1], [8, 4], [9, 8], [7, 8], [4, 1], [10, 12], [2, 1]];

function attention(host: HTMLElement) {
  const { stage, bar } = shell(host, 'attn');
  const { ctx, w, h } = canvas(stage, 680, 256);
  let dk = 64, scaled = true, causal = true, query = 11;
  const r = rng(1706);
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const n = SENTENCE.length;
  let Q: number[][] = [], K: number[][] = [];
  const build = () => {
    const rr = rng(1706 + dk);
    const g = () => Math.sqrt(-2 * Math.log(rr() + 1e-12)) * Math.cos(2 * Math.PI * rr());
    // unit-variance components: q·k then has variance d_k, the paper's footnote 4
    K = SENTENCE.map(() => Array.from({ length: dk }, g));
    // each query leans a little towards its own key and towards the words it relates to
    Q = K.map((k) => k.map((x) => 0.2 * x + 0.97 * g()));
    for (const [a, b] of LINKS) Q[a] = Q[a].map((x, i) => x + 0.32 * K[b][i]);
  };
  void gauss;
  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    const q = Q[query];
    const raw = K.map((k) => k.reduce((s, x, i) => s + x * q[i], 0));
    const s = raw.map((x) => (scaled ? x / Math.sqrt(dk) : x));
    const allowed = s.map((_, j) => !causal || j <= query);
    const mx = Math.max(...s.filter((_, j) => allowed[j]));
    const e = s.map((x, j) => (allowed[j] ? Math.exp(x - mx) : 0));
    const Z = e.reduce((a, b) => a + b, 0);
    const a = e.map((x) => x / Z);
    const H = -a.reduce((acc, p) => acc + (p > 0 ? p * Math.log2(p) : 0), 0);
    const cw = (w - 40) / n;
    ctx.font = MONO;
    ctx.textAlign = 'center';
    // tokens
    SENTENCE.forEach((t, j) => {
      const x = 20 + cw * j + cw / 2;
      const y = j % 2 ? 244 : 230;
      ctx.fillStyle = j === query ? INK.acid : allowed[j] ? INK.paper : INK.dim;
      ctx.fillText(t, x, y);
      if (j === query) ctx.fillRect(x - cw / 2 + 4, y + 4, cw - 8, 2);
    });
    // scores
    const smax = Math.max(...s.map(Math.abs), 1);
    ctx.textAlign = 'left';
    ctx.fillStyle = INK.dim;
    ctx.fillText(scaled ? 'scores q·k / √d_k' : 'scores q·k (unscaled)', 20, 16);
    ctx.fillText('weights softmax(·)', 20, 104);
    SENTENCE.forEach((_, j) => {
      const x = 20 + cw * j + 6;
      const bw = cw - 12;
      const v = s[j] / smax;
      ctx.fillStyle = allowed[j] ? INK.ghost : INK.faint;
      const y0 = 62;
      ctx.fillRect(x, v > 0 ? y0 - v * 36 : y0, bw, Math.abs(v * 36));
      ctx.fillStyle = allowed[j] ? INK.acid : INK.faint;
      const hh = a[j] * 90;
      ctx.fillRect(x, 212 - hh, bw, hh);
      if (a[j] > 0.04) {
        ctx.fillStyle = INK.paper;
        ctx.textAlign = 'center';
        ctx.fillText(a[j].toFixed(2), x + bw / 2, 208 - hh);
        ctx.textAlign = 'left';
      }
    });
    ctx.strokeStyle = INK.faint;
    ctx.beginPath();
    ctx.moveTo(20, 62.5);
    ctx.lineTo(w - 20, 62.5);
    ctx.moveTo(20, 212.5);
    ctx.lineTo(w - 20, 212.5);
    ctx.stroke();
    readout.textContent = `max weight ${Math.max(...a).toFixed(2)} · entropy ${H.toFixed(2)} bits · std(q·k) ≈ √${dk} = ${Math.sqrt(dk).toFixed(1)}`;
  };
  const readout = document.createElement('span');
  const canvasEl = stage.querySelector('canvas')!;
  canvasEl.addEventListener('click', (ev) => {
    const rect = canvasEl.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * w;
    query = Math.max(0, Math.min(n - 1, Math.floor((x - 20) / ((w - 40) / n))));
    if (causal && query === 0) query = 0;
    draw();
  });
  slider(bar, 'd_k', 2, 9, 1, 6, (v) => String(2 ** v), (v) => ((dk = 2 ** v), build(), draw()));
  const sc = chip(bar, '÷√d_k on', () => {
    scaled = !scaled;
    sc.textContent = scaled ? '÷√d_k on' : '÷√d_k off';
    draw();
  }, 'Toggle the 1/√d_k scaling');
  const cm = chip(bar, 'causal mask on', () => {
    causal = !causal;
    cm.textContent = causal ? 'causal mask on' : 'causal mask off';
    draw();
  }, 'A decoder may not look at later tokens');
  bar.append(readout);
  build();
  draw();
}

// ── 2. sinusoidal positions ────────────────────────────────────────────

function posenc(host: HTMLElement) {
  const { stage, bar } = shell(host, 'pos');
  const { ctx, w, h } = canvas(stage, 680, 300);
  const D = 128, N = 96;
  let at = 40;
  const pe = (p: number, i: number) => {
    const k = Math.floor(i / 2);
    const ang = p / 10000 ** ((2 * k) / D);
    return i % 2 === 0 ? Math.sin(ang) : Math.cos(ang);
  };
  const img = ctx.createImageData(1, 1);
  void img;
  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    const cw = (w - 40) / D, ch = 170 / N;
    for (let p = 0; p < N; p++)
      for (let i = 0; i < D; i++) {
        const v = pe(p, i);
        ctx.fillStyle = v >= 0 ? `rgba(198,255,61,${v.toFixed(2)})` : `rgba(125,140,255,${(-v).toFixed(2)})`;
        ctx.fillRect(20 + i * cw, 16 + p * ch, cw + 0.5, ch + 0.5);
      }
    ctx.strokeStyle = INK.paper;
    ctx.strokeRect(20, 16 + at * ch, w - 40, ch);
    ctx.font = MONO;
    ctx.fillStyle = INK.dim;
    ctx.fillText('position ↓   dimension →', 20, 11);
    // similarity of position `at` with every other position
    const y0 = 206, hh = 80;
    ctx.fillText(`PE(${at}) · PE(p), normalised, for p = 0 … ${N - 1}`, 20, y0 - 2);
    ctx.strokeStyle = INK.faint;
    ctx.beginPath();
    ctx.moveTo(20, y0 + hh / 2 + 8.5);
    ctx.lineTo(w - 20, y0 + hh / 2 + 8.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = INK.acid;
    for (let p = 0; p < N; p++) {
      let s = 0;
      for (let i = 0; i < D; i++) s += pe(at, i) * pe(p, i);
      s /= D / 2;
      const x = 20 + (p / (N - 1)) * (w - 40), y = y0 + hh / 2 + 8 - s * (hh / 2);
      p ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = INK.verm;
    ctx.fillRect(20 + (at / (N - 1)) * (w - 40) - 1, y0 + 6, 2, hh + 4);
  };
  slider(bar, 'position', 0, N - 1, 1, at, String, (v) => ((at = v), draw()));
  const note = document.createElement('span');
  note.textContent = 'the similarity depends only on the offset: a shifted copy of the same curve';
  bar.append(note);
  draw();
}

// ── 3. dilution ────────────────────────────────────────────────────────

export function dilutionShare(opts: { m: number; n0: number; delta: number; t: number; mode: 'softmax' | 'ssmax' | 'ledger'; K?: number; s?: number }) {
  const { m, n0, delta, t, mode } = opts;
  const n = n0 + t;
  if (mode === 'ledger') {
    const K = opts.K ?? 8;
    return Math.exp(delta) / (Math.exp(delta) + K - 1);
  }
  // m instruction tokens with logit Δ above the n − m others
  const scale = mode === 'ssmax' ? (opts.s ?? 0.43) * Math.log(n) : 1;
  const a = m * Math.exp(delta * scale);
  return a / (a + (n - m));
}

function dilution(host: HTMLElement, measured?: { base?: number[]; ledger?: number[] }) {
  const { stage, bar } = shell(host, 'dil');
  const { ctx, w, h } = canvas(stage, 680, 280);
  let m = 40, n0 = 2000, delta = 3;
  const T = 8000;
  const X = (t: number) => 50 + (Math.log10(1 + t) / Math.log10(1 + T)) * (w - 70);
  const Y = (v: number) => 250 - v * 220;
  const readout = document.createElement('span');
  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    ctx.font = MONO;
    ctx.strokeStyle = INK.faint;
    ctx.fillStyle = INK.dim;
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      ctx.beginPath();
      ctx.moveTo(50, Y(v) + 0.5);
      ctx.lineTo(w - 20, Y(v) + 0.5);
      ctx.stroke();
      ctx.fillText(v.toFixed(2), 12, Y(v) + 4);
    }
    for (const t of [0, 10, 100, 1000, 8000]) ctx.fillText(String(t), X(t) - 6, 268);
    ctx.fillText('tokens written so far →', w - 190, 240);
    const line = (mode: 'softmax' | 'ssmax' | 'ledger', color: string, label: string, dy: number) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      for (let i = 0; i <= 200; i++) {
        const t = Math.round(10 ** ((i / 200) * Math.log10(1 + T)) - 1);
        const y = Y(dilutionShare({ m, n0, delta, t, mode }));
        i ? ctx.lineTo(X(t), y) : ctx.moveTo(X(t), y);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = color;
      ctx.fillText(label, w - 360, 118 + dy);
    };
    line('softmax', INK.verm, 'one softmax over everything', 0);
    line('ssmax', INK.ghost, 'scalable softmax (logits × s·log n)', 14);
    line('ledger', INK.acid, 'ledger read: its own softmax over K = 8 slots', 28);
    const a0 = dilutionShare({ m, n0, delta, t: 0, mode: 'softmax' });
    const a1 = dilutionShare({ m, n0, delta, t: 4000, mode: 'softmax' });
    readout.textContent = `share on the instruction: ${a0.toFixed(3)} at the start, ${a1.toFixed(3)} after 4,000 tokens`;
    if (measured?.base) {
      ctx.fillStyle = INK.paper;
      measured.base.forEach((v, t) => t % 4 === 0 && ctx.fillRect(X(t) - 1.5, Y(v) - 1.5, 3, 3));
    }
  };
  slider(bar, 'instruction tokens m', 5, 200, 5, m, String, (v) => ((m = v), draw()));
  slider(bar, 'prompt n₀', 100, 8000, 100, n0, String, (v) => ((n0 = v), draw()));
  slider(bar, 'logit edge Δ', 0, 8, 0.5, delta, (v) => v.toFixed(1), (v) => ((delta = v), draw()));
  bar.append(readout);
  draw();
}

// ── 4. compounding ─────────────────────────────────────────────────────

function survival(host: HTMLElement) {
  const { stage, bar } = shell(host, 'surv');
  const { ctx, w, h } = canvas(stage, 680, 260);
  let k = 8, p = 0.5, tau = 400;
  const L = 3000;
  const X = (l: number) => 50 + (l / L) * (w - 70);
  const Y = (v: number) => 230 - v * 200;
  const readout = document.createElement('span');
  /**
   * Hazard per token and obligation. Without fading it stays at its opening value h0 = p∞/10.
   * With fading it climbs towards p∞ as h(t) = h0 + (p∞ - h0) t / (t + τ), whose integral is
   * h0 L + (p∞ - h0)(L - τ ln(1 + L/τ)).
   */
  const S = (l: number, fading: boolean) => {
    const hInf = p / 100 / 100, h0 = hInf / 10;
    const cum = fading ? h0 * l + (hInf - h0) * (l - tau * Math.log(1 + l / tau)) : h0 * l;
    return Math.exp(-k * cum);
  };
  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    ctx.font = MONO;
    ctx.fillStyle = INK.dim;
    ctx.strokeStyle = INK.faint;
    for (const v of [0, 0.5, 1]) {
      ctx.beginPath();
      ctx.moveTo(50, Y(v) + 0.5);
      ctx.lineTo(w - 20, Y(v) + 0.5);
      ctx.stroke();
      ctx.fillText(v.toFixed(1), 18, Y(v) + 4);
    }
    for (const l of [0, 1000, 2000, 3000]) ctx.fillText(String(l), X(l) - 10, 250);
    const curve = (dil: boolean, color: string, label: string, dy: number) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      for (let i = 0; i <= 150; i++) {
        const l = (i / 150) * L;
        i ? ctx.lineTo(X(l), Y(S(l, dil))) : ctx.moveTo(X(l), Y(S(l, dil)));
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = color;
      ctx.fillText(label, w - 300, 24 + dy);
    };
    curve(false, INK.acid, 'if attention to the prompt never faded', 0);
    curve(true, INK.verm, 'as it fades: hazard climbs towards p∞', 14);
    readout.textContent = `every obligation kept at 1,300 tokens (≈ 1,000 words): ${(100 * S(1300, false)).toFixed(0)}% without fading, ${(100 * S(1300, true)).toFixed(0)}% with`;
  };
  slider(bar, 'obligations k', 1, 20, 1, k, String, (v) => ((k = v), draw()));
  slider(bar, 'p∞ per 100 tokens', 0.05, 2, 0.05, p, (v) => `${v.toFixed(2)}%`, (v) => ((p = v), draw()));
  slider(bar, 'τ', 50, 2000, 50, tau, String, (v) => ((tau = v), draw()));
  bar.append(readout);
  draw();
}

export function mountFigures(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-attention]').forEach(attention);
  root.querySelectorAll<HTMLElement>('[data-posenc]').forEach(posenc);
  root.querySelectorAll<HTMLElement>('[data-dilution]').forEach((el) => {
    let measured;
    try {
      measured = el.dataset.measured ? JSON.parse(el.dataset.measured) : undefined;
    } catch {}
    dilution(el, measured);
  });
  root.querySelectorAll<HTMLElement>('[data-survival]').forEach(survival);
}
