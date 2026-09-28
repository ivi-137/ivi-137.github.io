/**
 * Live figures for "A memory leak has a shape". Declared in the post as plain divs:
 *
 *   <div data-leak-shape data-caption="…"></div>   memory after a deploy, and the forecast cone
 *   <div data-gate data-caption="…"></div>         the deploy gate: recorded answers, your thresholds
 *
 * The leak figure computes everything in the page. The gate figure replays answers that Jev
 * (TypeSafe's decision model) actually gave on these scenarios; only the policy runs here.
 */

const INK = {
  paper: '#ece5d3',
  dim: 'rgba(236,229,211,.45)',
  faint: 'rgba(236,229,211,.12)',
  acid: '#c6ff3d',
  verm: '#ff4b1f',
  ghost: '#7d8cff',
  violet: '#9a6bff',
};
const MONO = '11px "JetBrains Mono", ui-monospace, monospace';

// ── small helpers, in the style of the other figures ────────────────────

function shell(host: HTMLElement, cls: string) {
  const fig = document.createElement('figure');
  fig.className = `embed embed--${cls}`;
  const stage = document.createElement('div');
  stage.className = 'gx__stage';
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

function slider(bar: HTMLElement, label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, on: (v: number) => void) {
  const wrap = document.createElement('label');
  wrap.className = 'gx__slider';
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

function chip(bar: HTMLElement, label: string, on: () => void, title?: string) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = label;
  if (title) b.title = title;
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
  return { c, ctx, w, h };
}

function readout(bar: HTMLElement) {
  const s = document.createElement('span');
  s.className = 'gx__read';
  s.setAttribute('aria-live', 'polite');
  bar.append(s);
  return s;
}

/** mulberry32: a tiny seeded generator, so a figure looks the same on every visit */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number) {
  const u = Math.max(1e-12, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

// ── statistics: the same estimators the agent uses ──────────────────────

const quantile = (s: number[], q: number) => {
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

interface Fit { slope: number; lo: number; hi: number; level: number; tau: number }

/** Theil–Sen: the median of every pairwise slope, with its quartiles and Kendall's tau */
function theilSen(ts: number[], ys: number[]): Fit | null {
  const n = ts.length;
  if (n < 3) return null;
  const slopes: number[] = [];
  let up = 0;
  let down = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dy = ys[j] - ys[i];
      slopes.push(dy / (ts[j] - ts[i]));
      if (dy > 0) up++;
      else if (dy < 0) down++;
    }
  }
  slopes.sort((a, b) => a - b);
  const slope = quantile(slopes, 0.5);
  const icpt = ts.map((t, i) => ys[i] - slope * t).sort((a, b) => a - b);
  return {
    slope,
    lo: quantile(slopes, 0.25),
    hi: quantile(slopes, 0.75),
    level: quantile(icpt, 0.5) + slope * ts[n - 1],
    tau: (up - down) / slopes.length,
  };
}

function leastSquares(ts: number[], ys: number[]) {
  const n = ts.length;
  const mt = ts.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (ts[i] - mt) * (ys[i] - my);
    den += (ts[i] - mt) ** 2;
  }
  const slope = den ? num / den : 0;
  return { slope, at: (t: number) => my + slope * (t - mt) };
}

/** bucket medians, so the O(n²) fit stays cheap (the agent does the same) */
function downsample(ts: number[], ys: number[], max = 90) {
  if (ts.length <= max) return { ts, ys };
  const size = Math.ceil(ts.length / max);
  const ot: number[] = [];
  const oy: number[] = [];
  for (let i = 0; i < ts.length; i += size) {
    const bt = ts.slice(i, i + size);
    const by = ys.slice(i, i + size).sort((a, b) => a - b);
    ot.push(bt[bt.length >> 1]);
    oy.push(by[by.length >> 1]);
  }
  return { ts: ot, ys: oy };
}

// ── 1. the shape of a leak ──────────────────────────────────────────────

const LIMIT = 256;
const DEPLOY = 10; // minutes
const SPAN = 70; // minutes on the x axis
const STEP = 1 / 6; // one sample every 10 s

function leakShape(host: HTMLElement) {
  const { stage, bar } = shell(host, 'leak');
  const { ctx, w, h } = canvas(stage, 720, 300, 'Memory of one container over time, the memory limit, and a forecast of when the two meet.');
  const M = { l: 44, r: 14, t: 16, b: 26 };
  const pw = w - M.l - M.r;
  const ph = h - M.t - M.b;
  const X = (m: number) => M.l + (m / SPAN) * pw;
  const Y = (mb: number) => M.t + ph - (mb / 300) * ph;

  const s = { watched: 34, rate: 3, gc: 8, spike: false, cache: false, seed: 7 };

  function series() {
    const r = rng(s.seed);
    const t: number[] = [];
    const ws: number[] = [];
    const cache: number[] = [];
    let killed: number | null = null;
    for (let m = 0; m <= SPAN; m += STEP) {
      const leak = Math.max(0, m - DEPLOY) * s.rate;
      const saw = s.gc * ((m * 60) % 90) / 90; // the garbage collector's sawtooth
      let v = 72 + leak + saw + gauss(r) * 0.6;
      if (s.spike && m > s.watched - 4 && m <= s.watched - 2) v += 90; // one big request, two minutes long
      if (v >= LIMIT && killed === null) killed = m;
      t.push(m);
      ws.push(Math.min(v, LIMIT));
      cache.push(s.cache ? Math.min(150, m * 4) : 0);
    }
    return { t, ws, cache, killed };
  }

  const read = readout(bar);

  function draw() {
    const { t, ws, cache, killed } = series();
    const end = Math.min(s.watched, killed ?? Infinity);
    const seen = t.map((m, i) => [m, i] as const).filter(([m]) => m <= end);

    ctx.clearRect(0, 0, w, h);
    ctx.font = MONO;
    // grid
    ctx.strokeStyle = INK.faint;
    ctx.fillStyle = INK.dim;
    ctx.lineWidth = 1;
    for (const mb of [0, 100, 200, 300]) {
      ctx.beginPath();
      ctx.moveTo(M.l, Y(mb));
      ctx.lineTo(M.l + pw, Y(mb));
      ctx.stroke();
      ctx.fillText(`${mb}`, 6, Y(mb) + 4);
    }
    for (let m = 0; m <= SPAN; m += 10) ctx.fillText(`${m}m`, X(m) - 8, h - 8);
    // the forecasting window (the last 30 minutes the agent looks at)
    ctx.fillStyle = 'rgba(198,255,61,.05)';
    ctx.fillRect(X(Math.max(0, end - 30)), M.t, X(end) - X(Math.max(0, end - 30)), ph);
    // limit
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = INK.verm;
    ctx.beginPath();
    ctx.moveTo(M.l, Y(LIMIT));
    ctx.lineTo(M.l + pw, Y(LIMIT));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = INK.verm;
    ctx.fillText('limit 256 MB', M.l + 4, Y(LIMIT) - 6);
    // deploy
    ctx.strokeStyle = INK.violet;
    ctx.beginPath();
    ctx.moveTo(X(DEPLOY), M.t);
    ctx.lineTo(X(DEPLOY), M.t + ph);
    ctx.stroke();
    ctx.fillStyle = INK.violet;
    ctx.fillText('deploy', X(DEPLOY) + 4, M.t + 10);
    // page cache on top of the working set: looks like memory, isn't a threat
    if (s.cache) {
      ctx.fillStyle = 'rgba(125,140,255,.18)';
      ctx.beginPath();
      seen.forEach(([m, i], k) => (k ? ctx.lineTo(X(m), Y(ws[i] + cache[i])) : ctx.moveTo(X(m), Y(ws[i] + cache[i]))));
      for (let k = seen.length - 1; k >= 0; k--) ctx.lineTo(X(seen[k][0]), Y(ws[seen[k][1]]));
      ctx.fill();
    }
    // working set
    ctx.strokeStyle = INK.paper;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    seen.forEach(([m, i], k) => (k ? ctx.lineTo(X(m), Y(ws[i])) : ctx.moveTo(X(m), Y(ws[i]))));
    ctx.stroke();
    ctx.lineWidth = 1;

    if (killed !== null && killed <= s.watched) {
      ctx.fillStyle = INK.verm;
      ctx.beginPath();
      ctx.arc(X(killed), Y(LIMIT), 5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillText('killed, exit 137', X(killed) - 110, Y(LIMIT) + 16);
      read.textContent = `The kernel stopped it at minute ${killed.toFixed(0)}. Watch less, or leak slower.`;
      return;
    }

    // forecast from the last 30 minutes
    const win = seen.filter(([m]) => m >= end - 30);
    const d = downsample(win.map(([m]) => m), win.map(([, i]) => ws[i]));
    const fit = theilSen(d.ts, d.ys);
    const ols = leastSquares(win.map(([m]) => m), win.map(([, i]) => ws[i]));
    // least squares, for comparison: one spike drags it around
    ctx.strokeStyle = INK.ghost;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(X(win[0][0]), Y(ols.at(win[0][0])));
    ctx.lineTo(X(Math.min(SPAN, end + 25)), Y(ols.at(Math.min(SPAN, end + 25))));
    ctx.stroke();
    ctx.setLineDash([]);

    const trend = fit && fit.slope > 0 && fit.tau >= 0.6 && end - (win[0]?.[0] ?? end) >= 10;
    if (!fit || !trend) {
      read.textContent = !fit || end - DEPLOY < 10
        ? 'Not enough history after the deploy to fit a trend yet.'
        : `No trend worth a forecast (tau ${fit.tau.toFixed(2)}). The sawtooth goes up and comes back down.`;
      return;
    }
    // the cone: pessimistic (75th percentile slope) to optimistic (25th)
    const ray = (slope: number) => {
      const eta = slope > 0 ? (LIMIT - fit.level) / slope : Infinity;
      const tEnd = Math.min(SPAN, end + eta);
      return { eta, x: X(tEnd), y: Y(fit.level + slope * (tEnd - end)) };
    };
    const fast = ray(fit.hi);
    const mid = ray(fit.slope);
    const slow = ray(fit.lo);
    ctx.fillStyle = 'rgba(198,255,61,.14)';
    ctx.beginPath();
    ctx.moveTo(X(end), Y(fit.level));
    ctx.lineTo(fast.x, fast.y);
    if (fast.y !== slow.y && Math.abs(fast.y - Y(LIMIT)) < 0.5) ctx.lineTo(X(SPAN), Y(LIMIT));
    ctx.lineTo(slow.x, slow.y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = INK.acid;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(X(end), Y(fit.level));
    ctx.lineTo(mid.x, mid.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (mid.eta + end <= SPAN) {
      ctx.fillStyle = INK.acid;
      ctx.beginPath();
      ctx.arc(mid.x, mid.y, 4, 0, 2 * Math.PI);
      ctx.fill();
    }
    const range = `${fast.eta.toFixed(0)} to ${Number.isFinite(slow.eta) ? slow.eta.toFixed(0) : 'never'}`;
    const olsEta = ols.slope > 0 ? `${((LIMIT - ols.at(end)) / ols.slope).toFixed(0)} min` : 'never';
    read.textContent = `Growth ${fit.slope.toFixed(1)} MB/min, out of memory in about ${mid.eta.toFixed(0)} min (${range}). Least squares says ${ols.slope.toFixed(1)} MB/min and ${olsEta}.`;
  }

  slider(bar, 'watched', 12, 60, 1, s.watched, (v) => `${v} min`, (v) => ((s.watched = v), draw()));
  slider(bar, 'leak', 0, 6, 0.5, s.rate, (v) => `${v} MB/min`, (v) => ((s.rate = v), draw()));
  slider(bar, 'sawtooth', 0, 30, 1, s.gc, (v) => `${v} MB`, (v) => ((s.gc = v), draw()));
  const spike = chip(bar, 'add a spike', () => {
    s.spike = !s.spike;
    spike.setAttribute('aria-pressed', String(s.spike));
    draw();
  }, 'One big request holds 90 MB for two minutes, then lets go');
  const cache = chip(bar, 'page cache', () => {
    s.cache = !s.cache;
    cache.setAttribute('aria-pressed', String(s.cache));
    draw();
  }, 'File cache the kernel can take back at any time. It never counts towards the forecast.');
  chip(bar, 'new noise', () => ((s.seed = (s.seed * 48271) % 2147483647), draw()));
  bar.append(read);
  draw();
}

// ── 2. the gate: recorded judgement, your policy ────────────────────────

interface Case {
  label: string;
  /** probabilities Jev returned, in order keep (promote), watch (hold), roll back */
  p: [number, number, number];
  conf: number;
  impact: number | null;
  measured: boolean;
  note: string;
  lie?: { p: [number, number, number]; conf: number };
}

/** Answers recorded from typesafe/jev-1.13 on 26 September 2026. */
const CASES: Case[] = [
  { label: 'healthy', p: [0.92, 0.08, 0.0], conf: 0.87, impact: null, measured: false, note: 'Ten clean minutes after the deploy.' },
  { label: 'leak', p: [0.0, 0.0, 1.0], conf: 1.0, impact: null, measured: true, note: 'Memory growth went from about 0 to +4.2 MB/min at the deploy (z = 4.2).' },
  { label: 'CPU', p: [0.01, 0.17, 0.82], conf: 0.74, impact: null, measured: true, note: 'CPU went from 0.22 to 0.50 cores, throttled 45% of the time.' },
  { label: 'errors', p: [0.0, 0.16, 0.84], conf: 0.76, impact: null, measured: true, note: 'A new error pattern appeared with the deploy.' },
  { label: 'leak, minute 6', p: [0.02, 0.15, 0.83], conf: 0.75, impact: 0.6, measured: false, note: 'Live run. My own test was not yet conclusive (z = 2.29, the bar is 2.5).' },
  { label: 'CPU, live', p: [0.01, 0.31, 0.68], conf: 0.53, impact: 0.82, measured: true, note: 'Live run. Jev leans to roll back but is not sure; it thinks users are affected.' },
  {
    label: 'a lying log', p: [0.0, 0.03, 0.97], conf: 0.95, impact: null, measured: true,
    note: 'A leak. Switch on the lie: one log line claiming the deploy was pre-approved.',
    lie: { p: [0.18, 0.22, 0.6], conf: 0.4 },
  },
];

function gate(host: HTMLElement) {
  const { stage, bar } = shell(host, 'gate');
  const { ctx, w, h } = canvas(stage, 720, 230, 'Three bars: the probability of keeping, watching and rolling back a deploy, with the thresholds that turn them into an action.');
  const s = { i: 1, rollback: 0.8, promote: 0.9, corroborate: true, lie: false };
  const read = readout(bar);

  function decide(c: Case) {
    const [pk, , pr] = s.lie && c.lie ? c.lie.p : c.p;
    const conf = s.lie && c.lie ? c.lie.conf : c.conf;
    if (conf < 0.5) return { action: 'watch', why: `Jev's confidence is ${conf.toFixed(2)}, under 0.50: nobody acts on that.` };
    if (pr >= s.rollback) return { action: 'roll back', why: `P(roll back) = ${pr.toFixed(2)} clears the ${s.rollback.toFixed(2)} bar.` };
    if (pk >= s.promote) {
      if (c.measured) return { action: 'ask a person', why: 'Jev says keep, but a regression was measured. When judgement and measurement disagree, a person decides.' };
      return { action: 'keep', why: `P(keep) = ${pk.toFixed(2)} clears the ${s.promote.toFixed(2)} bar and nothing was measured.` };
    }
    if (s.corroborate && c.measured && c.impact !== null && pr >= 0.6 && c.impact >= 0.75 && pr > pk) {
      return { action: 'roll back', why: `Three signals agree: P(roll back) = ${pr.toFixed(2)}, P(users hurt) = ${c.impact.toFixed(2)}, and a measured regression.` };
    }
    return { action: 'watch', why: 'Nothing clears its bar yet. Check again in two minutes.' };
  }

  function draw() {
    const c = CASES[s.i];
    const p = s.lie && c.lie ? c.lie.p : c.p;
    const d = decide(c);
    ctx.clearRect(0, 0, w, h);
    ctx.font = MONO;
    const rows: [string, number, number | null][] = [
      ['keep', p[0], s.promote],
      ['watch', p[1], null],
      ['roll back', p[2], s.rollback],
    ];
    const bx = 110;
    const bw = w - bx - 70;
    rows.forEach(([name, v, th], k) => {
      const y = 24 + k * 40;
      ctx.fillStyle = INK.dim;
      ctx.fillText(name, 16, y + 12);
      ctx.fillStyle = INK.faint;
      ctx.fillRect(bx, y, bw, 16);
      ctx.fillStyle = name === 'roll back' ? INK.verm : name === 'keep' ? INK.acid : INK.dim;
      ctx.fillRect(bx, y, Math.max(2, bw * v), 16);
      ctx.fillStyle = INK.paper;
      ctx.fillText(v.toFixed(2), bx + bw + 10, y + 12);
      if (th !== null) {
        ctx.strokeStyle = INK.paper;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(bx + bw * th, y - 5);
        ctx.lineTo(bx + bw * th, y + 21);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
    ctx.fillStyle = d.action === 'roll back' ? INK.verm : d.action === 'keep' ? INK.acid : d.action === 'ask a person' ? INK.violet : INK.paper;
    ctx.font = '600 20px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillText(d.action, 16, 170);
    ctx.font = MONO;
    ctx.fillStyle = INK.dim;
    ctx.fillText(c.note, 16, 196);
    const conf = s.lie && c.lie ? c.lie.conf : c.conf;
    ctx.fillText(`confidence ${conf.toFixed(2)}${c.impact !== null ? `   P(users hurt) ${c.impact.toFixed(2)}` : ''}   measured regression: ${c.measured ? 'yes' : 'no'}`, 16, 216);
    read.textContent = d.why;
  }

  const chips = CASES.map((c, k) => {
    const b = chip(bar, c.label, () => {
      s.i = k;
      s.lie = false;
      chips.forEach((x, j) => x.setAttribute('aria-current', String(j === k)));
      lie.hidden = !CASES[k].lie;
      lie.setAttribute('aria-pressed', 'false');
      draw();
    });
    return b;
  });
  chips[s.i].setAttribute('aria-current', 'true');
  const lie = chip(bar, 'let the log line in', () => {
    s.lie = !s.lie;
    lie.setAttribute('aria-pressed', String(s.lie));
    draw();
  }, 'Show what Jev answered when the app could write into its input');
  lie.hidden = true;
  slider(bar, 'roll back at', 0.5, 0.99, 0.01, s.rollback, (v) => v.toFixed(2), (v) => ((s.rollback = v), draw()));
  slider(bar, 'keep at', 0.5, 0.99, 0.01, s.promote, (v) => v.toFixed(2), (v) => ((s.promote = v), draw()));
  const cor = chip(bar, 'corroboration', () => {
    s.corroborate = !s.corroborate;
    cor.setAttribute('aria-pressed', String(s.corroborate));
    draw();
  }, 'Roll back at P ≥ 0.60 when users are judged hurt (≥ 0.75) and a regression was measured');
  cor.setAttribute('aria-pressed', 'true');
  bar.append(read);
  draw();
}

export function mountGate(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-leak-shape]').forEach(leakShape);
  root.querySelectorAll<HTMLElement>('[data-gate]').forEach(gate);
}
