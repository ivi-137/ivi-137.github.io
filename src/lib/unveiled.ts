import { gsap } from 'gsap';
import { boxDimension, point, side, type Curve } from './curves';
import type { Homeostat, Reading } from './life/homeostat';

/** The whole interpreter the program-length bound charges for. Kept tiny on purpose. */
function run(rule: number, seed: Uint8Array, w: number, rows: number) {
  const out = new Uint8Array(w * rows);
  let row = new Uint8Array(w);
  row.set(seed.subarray(0, w), Math.max(0, (w - seed.length) >> 1));
  for (let t = 0; t < rows; t++) {
    out.set(row, t * w);
    const next = new Uint8Array(w);
    for (let i = 0; i < w; i++) next[i] = (rule >> ((row[(i + w - 1) % w] << 2) | (row[i] << 1) | row[(i + 1) % w])) & 1;
    row = next;
  }
  return out;
}

const bitsOf = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const bits = new Uint8Array(bytes.length * 8);
  bytes.forEach((b, i) => {
    for (let j = 0; j < 8; j++) bits[i * 8 + j] = (b >> (7 - j)) & 1;
  });
  return bits;
};

const pack = (bits: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((v, i) => v && (out[i >> 3] |= 128 >> (i & 7)));
  return out;
};

async function deflateBits(data: Uint8Array): Promise<number> {
  if (typeof CompressionStream === 'undefined') return NaN;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return buf.byteLength * 8;
}

export function mountUnveiled() {
  const root = document.querySelector<HTMLElement>('[data-unveiled]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const canvas = $<HTMLCanvasElement>('[data-unv-canvas]');
  const ctx = canvas.getContext('2d')!;
  const fold = $<HTMLInputElement>('[data-unv-fold]');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let bits = new Uint8Array(0);
  let from = new Float32Array(0); // row-major positions
  let to = new Float32Array(0); // curve positions
  let n = 0;
  let curve: Curve = 'hilbert';
  let interpreterBits = 0;

  const draw = () => {
    const t = Number(fold.value) / 1000;
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; // ease in-out cubic
    const W = canvas.width;
    const cell = W / n;
    ctx.fillStyle = '#0a0a0b';
    ctx.fillRect(0, 0, W, W);
    // the curve itself, faint, once folding begins
    if (e > 0.02) {
      ctx.strokeStyle = `rgba(125,140,255,${0.28 * e})`;
      ctx.lineWidth = Math.max(0.5, cell * 0.18);
      ctx.beginPath();
      for (let d = 0; d < bits.length; d++) {
        const x = (to[d * 2] + 0.5) * cell, y = (to[d * 2 + 1] + 0.5) * cell;
        d ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#c6ff3d';
    const s = cell * 0.82;
    for (let d = 0; d < bits.length; d++) {
      if (!bits[d]) continue;
      const x = from[d * 2] + (to[d * 2] - from[d * 2]) * e;
      const y = from[d * 2 + 1] + (to[d * 2 + 1] - from[d * 2 + 1]) * e;
      ctx.fillRect(x * cell + (cell - s) / 2, y * cell + (cell - s) / 2, s, s);
    }
    $('[data-unv-curve-name]').textContent = `${curve === 'hilbert' ? 'Hilbert' : 'Peano'} fold`;
  };

  const fmt = (b: number) => (Number.isFinite(b) ? `${b.toLocaleString('en')} bits` : 'n/a');

  const measure = async (rule: number, seedBits: Uint8Array) => {
    const N = bits.length;
    const random = crypto.getRandomValues(new Uint8Array(N / 8));
    const [dS, dR] = await Promise.all([deflateBits(pack(bits)), deflateBits(random)]);
    const program = 8 + seedBits.length + Math.ceil(Math.log2(N)) + interpreterBits;
    $('[data-unv-n]').textContent = fmt(N);
    $('[data-unv-deflate]').textContent = fmt(dS);
    $('[data-unv-random]').textContent = fmt(dR);
    $('[data-unv-program]').textContent = fmt(program);
    const bars = $('[data-unv-bars]');
    bars.replaceChildren(
      ...[
        ['raw', N],
        ['deflate', dS],
        ['random', dR],
        ['|p|', program],
      ].map(([label, v]) => {
        const row = document.createElement('div');
        row.className = 'unveiled__bar';
        const l = document.createElement('span');
        l.textContent = String(label);
        const b = document.createElement('i');
        b.style.setProperty('--w', String(Math.min(1, (v as number) / N)));
        if (label === '|p|') b.className = 'is-key';
        row.append(l, b);
        return row;
      }),
    );
    const ratio = dS / program;
    $('[data-unv-verdict]').textContent = Number.isFinite(ratio)
      ? `Rule ${rule}: deflate needs ${ratio.toFixed(0)}× more bits than the program. K(s) ≤ ${program.toLocaleString('en')} bits, out of ${N.toLocaleString('en')}.`
      : '';
  };

  const rebuild = async () => {
    const rule = Number($<HTMLSelectElement>('[data-unv-rule]').value);
    curve = $<HTMLSelectElement>('[data-unv-curve]').value as Curve;
    const seedText = $<HTMLInputElement>('[data-unv-seed]').value || 'gianni';
    const k = curve === 'hilbert' ? 7 : 4;
    n = side(curve, k);
    const seedBits = bitsOf(seedText);
    bits = run(rule, seedBits, n, n);
    from = new Float32Array(bits.length * 2);
    to = new Float32Array(bits.length * 2);
    for (let d = 0; d < bits.length; d++) {
      from[d * 2] = d % n;
      from[d * 2 + 1] = Math.floor(d / n);
      const [x, y] = point(curve, k, d);
      to[d * 2] = x;
      to[d * 2 + 1] = y;
    }
    const px = Math.min(640, canvas.parentElement!.clientWidth);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(px * dpr);
    canvas.height = canvas.width;
    canvas.style.width = canvas.style.height = `${px}px`;
    draw();
    // box counting on the current curve at a cheap order
    const bx = boxDimension(curve, curve === 'hilbert' ? 6 : 4);
    const tbody = root.querySelector('[data-unv-boxes] tbody')!;
    tbody.replaceChildren(
      ...bx.rows.map((r) => {
        const tr = document.createElement('tr');
        for (const v of [`1/${Math.round(1 / r.eps)}`, r.boxes.toLocaleString('en'), (Math.log(r.boxes) / Math.log(1 / r.eps)).toFixed(3)]) {
          const td = document.createElement('td');
          td.textContent = v;
          tr.append(td);
        }
        return tr;
      }),
    );
    await measure(rule, seedBits);
  };

  const play = () => {
    const target = Number(fold.value) > 500 ? 0 : 1000;
    if (reduced) {
      fold.value = String(target);
      return draw();
    }
    gsap.to(fold, { value: target, duration: 3.2, ease: 'none', onUpdate: draw });
  };

  deflateBits(new TextEncoder().encode(run.toString())).then((b) => {
    interpreterBits = b;
    rebuild();
  });
  fold.addEventListener('input', draw);
  $('[data-unv-play]').addEventListener('click', play);
  root.querySelectorAll('select, input[data-unv-seed]').forEach((el) => el.addEventListener('change', rebuild));
  new ResizeObserver(() => bits.length && rebuild()).observe(canvas.parentElement!);

  // fold automatically the first time the figure scrolls into view
  if (!reduced) {
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        io.disconnect();
        setTimeout(play, 600);
      }
    }, { threshold: 0.5 });
    io.observe(canvas);
  }

  // chapter v: live readout of the homeostat
  const bind = (h: Homeostat) => {
    const set = (k: string, v: number, text: string) => {
      const b = root.querySelector<HTMLElement>(`[data-obs-${k}]`);
      const bar = root.querySelector<HTMLElement>(`[data-obs-${k}-bar]`);
      if (b) b.textContent = text;
      bar?.style.setProperty('--v', String(Math.max(0, Math.min(1, v))));
    };
    const off = h.onReading((r: Reading) => {
      set('you', r.you, r.you.toFixed(2));
      set('target', r.target / 0.5, r.target.toFixed(2));
      set('colony', r.colony / 0.5, r.colony.toFixed(2));
      set('tempo', r.tempo / 2.2, `×${r.tempo.toFixed(2)}`);
    });
    document.addEventListener('astro:before-swap', () => off(), { once: true });
  };
  const h = (window as any).__homeostat as Homeostat | undefined;
  if (h) bind(h);
  else addEventListener('life:ready', () => (window as any).__homeostat && bind((window as any).__homeostat), { once: true });
}
