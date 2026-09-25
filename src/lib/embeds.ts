/**
 * Live figures inside posts, declared with plain HTML in Markdown:
 *
 *   <div data-automaton="110" data-caption="Rule 110 from one cell"></div>
 *   <div data-life="bo$2bo$3o!" data-rule="B3/S23" data-size="48x28" data-caption="A glider"></div>
 *   <div data-attention data-caption="…"></div>   (and the other figures in ./coherence)
 *
 * Each becomes a figure with its own controls. Nothing runs until it scrolls
 * into view.
 */
import { drawRule } from './atlas';
import { Board } from './life/cpu';
import { parseRule } from './life/engine';
import { parseRle } from './life/rle';

const btn = (label: string, title?: string) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = label;
  if (title) b.title = title;
  return b;
};

function figure(host: HTMLElement, cls: string) {
  const fig = document.createElement('figure');
  fig.className = `embed ${cls}`;
  const canvas = document.createElement('canvas');
  const bar = document.createElement('div');
  bar.className = 'embed__bar mono';
  fig.append(canvas, bar);
  if (host.dataset.caption) {
    const cap = document.createElement('figcaption');
    cap.textContent = host.dataset.caption;
    fig.append(cap);
  }
  host.replaceWith(fig);
  return { fig, canvas, bar };
}

function automaton(host: HTMLElement) {
  let rule = Math.max(0, Math.min(255, Number(host.dataset.automaton) || 110));
  let random = host.dataset.seed === 'random';
  const { canvas, bar } = figure(host, 'embed--eca');
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.max = '255';
  input.value = String(rule);
  input.className = 'mono';
  input.setAttribute('aria-label', 'Rule number');
  const label = document.createElement('label');
  label.append('rule ', input);
  const seed = btn(random ? 'random start' : 'one cell', 'Toggle initial condition');
  const again = btn('rerun');
  const atlas = document.createElement('a');
  atlas.textContent = 'atlas →';
  const draw = () => {
    drawRule(canvas, rule, 181, 72, 3, random);
    atlas.href = `/atlas/#rule=${rule}`;
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    if (Number.isInteger(v) && v >= 0 && v <= 255) (rule = v), draw();
  });
  seed.addEventListener('click', () => {
    random = !random;
    seed.textContent = random ? 'random start' : 'one cell';
    draw();
  });
  again.addEventListener('click', draw);
  bar.append(label, seed, again, atlas);
  draw();
}

function lifeBoard(host: HTMLElement) {
  const [w, h] = (host.dataset.size ?? '48x28').split('x').map(Number);
  const pattern = parseRle(host.dataset.life ?? '') ?? parseRle('bo$2bo$3o!')!;
  const rule = parseRule(host.dataset.rule ?? pattern.rule ?? 'B3/S23') ?? parseRule('B3/S23')!;
  const board = new Board(w, h);
  board.setRule(rule.birth, rule.survive);
  const reset = () => {
    board.clear();
    board.place(pattern.cells, Math.floor((w - pattern.w) / 2), Math.floor((h - pattern.h) / 2));
  };
  reset();
  const { fig, canvas, bar } = figure(host, 'embed--life');
  const ctx = canvas.getContext('2d')!;
  const cell = 10;
  canvas.width = w * cell;
  canvas.height = h * cell;
  const gen = document.createElement('span');
  const draw = () => {
    board.draw(ctx, cell);
    gen.textContent = `${rule.code} · gen ${board.gen}`;
  };
  let raf = 0, last = 0;
  const play = btn('▶ run');
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    play.textContent = '▶ run';
  };
  const run = () => {
    if (raf) return stop();
    play.textContent = '❚❚ pause';
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 1000 / 12) return;
      last = now;
      board.step();
      draw();
    };
    raf = requestAnimationFrame(tick);
  };
  const step = btn('step');
  const again = btn('reset');
  play.addEventListener('click', run);
  step.addEventListener('click', () => (stop(), board.step(), draw()));
  again.addEventListener('click', () => (stop(), reset(), draw()));
  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * w), y = Math.floor(((e.clientY - r.top) / r.height) * h);
    board.set(x, y, board.get(x, y) ? 0 : 1);
    draw();
  });
  const lab = document.createElement('a');
  lab.href = `/lab/#rule=${encodeURIComponent(rule.code)}&rle=${encodeURIComponent(host.dataset.life ?? '')}`;
  lab.textContent = 'open in lab →';
  bar.append(play, step, again, gen, lab);
  draw();
  // autoplay while visible, if asked
  if (host.dataset.autoplay !== undefined && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    new IntersectionObserver(([e]) => (e.isIntersecting ? !raf && run() : raf && stop())).observe(fig);
  }
  document.addEventListener('astro:before-swap', stop, { once: true });
}

const COHERENCE = '[data-attention], [data-posenc], [data-dilution], [data-survival], [data-ledger-demo], [data-audit]';

export function mountEmbeds(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-automaton]').forEach(automaton);
  root.querySelectorAll<HTMLElement>('.prose [data-life]').forEach(lifeBoard);
  // the transformer figures ship only with the post that uses them
  if (root.querySelector(COHERENCE)) void import('./coherence/mount').then((m) => m.mountCoherence(root));
}
