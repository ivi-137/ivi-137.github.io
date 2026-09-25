/**
 * A NOT gate made of glider collisions in Conway's Life.
 *
 * Geometry found by scripts/find-not-gate.mts and proven on test sequences by
 * scripts/verify-not-gate.mts (output = NOT input, latency 5 periods of 30
 * generations). Gun A carries the input; the mirrored gun B is the clock.
 * Where the streams cross, each A-glider annihilates its B partner cleanly.
 */
import { Board } from './life/cpu';
import { LIBRARY, parseRle } from './life/rle';

export const GATE = {
  AX: 10,
  AY: 10,
  DX: 61,
  DY: 1,
  W: 170,
  H: 150,
  tap: { box: { x0: 41, y0: 27, x1: 45, y1: 31 }, phase: 6 },
  out: { box: { x0: 32, y0: 68, x1: 36, y1: 72 }, phase: 14 },
  latency: 5,
  warmup: 300,
} as const;

type Box = { x0: number; y0: number; x1: number; y1: number };
const CROSS = { x: 59, y: 45 };

export function mountLogic() {
  const root = document.querySelector<HTMLElement>('[data-logic]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const canvas = $<HTMLCanvasElement>('[data-logic-board]');
  const ctx = canvas.getContext('2d')!;
  const gun = parseRle(LIBRARY.find((l) => l.name === 'Gosper glider gun')!.rle)!;
  const { W, H, AX, AY, DX, DY, tap, out } = GATE;
  const M = 3;
  // the part of the board worth showing
  const view = { x0: 4, y0: 4, x1: 112, y1: 84 };

  let board: Board;
  let running = false;
  let raf = 0, last = 0, acc = 0, speed = 30;
  let queue: number[] = [];
  let sentBits: number[] = [];
  let readBits: number[] = [];
  let live = 1; // input switch when the tape is empty
  let flashTap = 0, flashOut = 0;

  const reset = () => {
    board = new Board(W, H);
    const place = (ox: number, oy: number, flip: boolean) =>
      board.place(gun.cells.map(([x, y]) => [flip ? gun.w - 1 - x : x, y] as [number, number]), ox, oy);
    place(AX, AY, false);
    place(AX + DX, AY + DY, true);
    sentBits = [];
    readBits = [];
    // warm up silently until both streams are established
    for (let t = 0; t < GATE.warmup; t++) step(true);
    render();
  };

  const count = (r: Box) => {
    let n = 0;
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) n += board.cells[y * W + x];
    return n;
  };

  function step(silent = false) {
    board.step();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < M || y < M || x >= W - M || y >= H - M) board.set(x, y, 0);
    if (silent) return;
    const t = board.gen;
    if (t % 30 === tap.phase) {
      const bit = queue.length ? queue.shift()! : live;
      sentBits.push(bit);
      if (!bit) {
        for (let y = tap.box.y0; y <= tap.box.y1; y++) for (let x = tap.box.x0; x <= tap.box.x1; x++) board.set(x, y, 0);
      }
      flashTap = 12;
    }
    if (t % 30 === out.phase) {
      readBits.push(count(out.box) >= 5 ? 1 : 0);
      flashOut = readBits[readBits.length - 1] ? 14 : 0;
    }
  }

  const tapes = () => {
    // align output with the input that caused it (pipeline latency)
    const aligned = sentBits.map((_, i) => readBits[i + GATE.latency]);
    const fmt = (arr: Array<number | undefined>) => arr.slice(-24).map((b) => (b === undefined ? '·' : String(b))).join(' ');
    $('[data-logic-in]').textContent = fmt(sentBits) || '·';
    $('[data-logic-out]').textContent = fmt(aligned) || '·';
    $('[data-logic-queue]').textContent = queue.length ? queue.join('') : 'empty: using the switch';
    $('[data-logic-gen]').textContent = String(board.gen);
    const lamp = $('[data-logic-lamp]');
    lamp.classList.toggle('is-on', flashOut > 0);
  };

  const render = () => {
    const cw = view.x1 - view.x0, ch = view.y1 - view.y0;
    const px = Math.min(760, canvas.parentElement!.clientWidth);
    const cell = px / cw;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(px * dpr)) {
      canvas.width = Math.round(px * dpr);
      canvas.height = Math.round(ch * cell * dpr);
      canvas.style.width = `${px}px`;
      canvas.style.height = `${ch * cell}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0a0b';
    ctx.fillRect(0, 0, px, ch * cell);
    // lanes and boxes
    const box = (r: Box, color: string, label: string, lit: boolean) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lit ? 2.5 : 1;
      ctx.setLineDash(lit ? [] : [4, 3]);
      ctx.strokeRect((r.x0 - view.x0) * cell, (r.y0 - view.y0) * cell, (r.x1 - r.x0 + 1) * cell, (r.y1 - r.y0 + 1) * cell);
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = `${Math.max(10, cell * 1.6)}px "JetBrains Mono", monospace`;
      ctx.fillText(label, (r.x1 - view.x0 + 1.5) * cell, (r.y0 - view.y0 + 2) * cell);
    };
    const gap = cell > 5 ? 1 : 0;
    for (let y = view.y0; y < view.y1; y++)
      for (let x = view.x0; x < view.x1; x++) {
        if (!board.cells[y * W + x]) continue;
        const inGunA = x < AX + gun.w + 1 && y < AY + gun.h + 1;
        const inGunB = x >= AX + DX - 1 && y < AY + DY + gun.h + 1;
        // input lane x − y = 14 meets the clock lane x + y = 104 at (59, 45)
        const inputSide = x < CROSS.x && y < CROSS.y;
        ctx.fillStyle = inGunA || inGunB ? '#ece5d3' : inputSide ? '#c6ff3d' : '#7d8cff';
        ctx.fillRect((x - view.x0) * cell + gap, (y - view.y0) * cell + gap, cell - gap * 2, cell - gap * 2);
      }
    box(tap.box, '#c6ff3d', 'input tap', flashTap > 0);
    box(out.box, '#ff4b1f', 'output', flashOut > 0);
    ctx.fillStyle = 'rgba(236,229,211,0.75)';
    ctx.fillText('gun A · input', (AX - view.x0) * cell, (AY - view.y0 - 1.2) * cell + 10);
    ctx.fillText('gun B · clock', (AX + DX - view.x0) * cell, (AY + DY - view.y0 - 1.2) * cell + 10);
    if (flashTap > 0) flashTap--;
    if (flashOut > 0) flashOut--;
    tapes();
  };

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    acc += ((now - last) / 1000) * speed;
    last = now;
    let n = 0;
    while (acc >= 1 && n++ < 8) step(), (acc -= 1);
    if (n) render();
  };
  const play = (on = !running) => {
    running = on;
    $('[data-logic-play]').textContent = running ? '❚❚ pause' : '▶ run';
    cancelAnimationFrame(raf);
    if (running) {
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
  };

  $('[data-logic-play]').addEventListener('click', () => play());
  $('[data-logic-reset]').addEventListener('click', () => {
    queue = [];
    reset();
  });
  $<HTMLInputElement>('[data-logic-speed]').addEventListener('input', (e) => (speed = Number((e.target as HTMLInputElement).value)));
  const sw = $<HTMLButtonElement>('[data-logic-switch]');
  sw.addEventListener('click', () => {
    live = 1 - live;
    sw.setAttribute('aria-pressed', String(!!live));
    sw.textContent = `input switch: ${live}`;
  });
  $<HTMLFormElement>('[data-logic-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $<HTMLInputElement>('[data-logic-bits]').value.replace(/[^01]/g, '').slice(0, 32);
    queue.push(...[...v].map(Number));
    if (!running) play(true);
  });
  document.addEventListener('astro:before-swap', () => play(false), { once: true });
  new ResizeObserver(() => board && render()).observe(canvas.parentElement!);
  reset();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    new IntersectionObserver(([e], io) => {
      if (e.isIntersecting) {
        io.disconnect();
        queue.push(1, 0, 1, 1, 0, 0, 1, 0);
        play(true);
      }
    }, { threshold: 0.4 }).observe(canvas);
  }
}
