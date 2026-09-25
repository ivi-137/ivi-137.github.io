import { Life, type Mode } from './engine';

/**
 * Starts the colony once and keeps it alive across view-transition navigations
 * (the canvas is `transition:persist`ed). Each page declares how it wants the
 * colony via <body data-life-mode data-life-seed>.
 */

const INTERACTIVE = 'a, button, input, textarea, select, label, summary, dialog, [data-no-life], .sheet, .card, .hud, .cut--card, .chat, .overlays, [data-lab], [data-atlas], [data-network], .toc, .legend';

let life: Life | null = null;

async function seedTextFontReady() {
  try {
    await Promise.race([document.fonts.load('italic 100px "Instrument Serif"'), new Promise((r) => setTimeout(r, 900))]);
  } catch {
    /* font API unavailable — fall back to Georgia */
  }
}

function start() {
  const canvas = document.getElementById('life') as HTMLCanvasElement | null;
  if (!canvas) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  try {
    life = new Life(canvas, { reducedMotion: reduced });
  } catch (err) {
    console.info('[life] falling back to static background:', err);
    document.documentElement.classList.add('no-life');
    return;
  }
  document.documentElement.classList.add('has-life');
  // shared handle for the terminal, sound, lab links and easter eggs
  (window as any).__life = life;
  window.dispatchEvent(new CustomEvent('life:ready', { detail: life }));
  wireInput(life);
  wireHud(life);
  const l = life;
  const onScroll = () => (l.receded = scrollY > innerHeight * 0.55);
  addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('astro:page-load', onScroll);
}

function applyPage() {
  if (!life) return;
  const { lifeMode, lifeSeed } = document.body.dataset;
  const mode = (lifeMode as Mode) || 'ambient';
  if (lifeSeed) seedTextFontReady().then(() => life!.setMode(mode, lifeSeed));
  else life.setMode(mode);
}

function wireInput(l: Life) {
  let down: { x: number; y: number; dragging: boolean } | null = null;

  addEventListener('pointermove', (e) => {
    l.pointer(e.clientX, e.clientY, e.pointerType === 'mouse' && !(e.target as Element).closest?.(INTERACTIVE));
    if (!down) return;
    if (!down.dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) down.dragging = true;
    if (down.dragging) l.paint(e.clientX, e.clientY);
  });
  addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as Element).closest?.(INTERACTIVE)) return;
    down = { x: e.clientX, y: e.clientY, dragging: false };
  });
  addEventListener('pointerup', (e) => {
    if (!down) return;
    if (!down.dragging) l.dropAt(e.clientX, e.clientY, e.shiftKey ? 'gun' : 'glider');
    down = null;
  });
  document.addEventListener('pointerleave', () => l.pointer(-1e4, -1e4, false));

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === 'p' || e.key === 'P') l.toggle();
    else if (e.key === 'r' || e.key === 'R') l.seed();
    else if (e.key >= '1' && e.key <= '4') l.setRule(Number(e.key) - 1);
    else return;
    e.preventDefault();
  });
}

function wireHud(l: Life) {
  const hud = document.querySelector<HTMLElement>('[data-hud]');
  if (!hud) return;
  const $ = (k: string) => hud.querySelector<HTMLElement>(`[data-hud-${k}]`)!;
  const pause = $('pause');
  hud.hidden = false;
  l.onStats((s) => {
    $('gen').textContent = String(s.gen).padStart(6, '0');
    $('pop').textContent = String(s.pop);
    $('rho').textContent = s.density.toFixed(3);
    $('h').textContent = s.entropy.toFixed(3);
    hud.style.setProperty('--h', String(s.entropy));
    $('rule').textContent = s.rule.code;
    $('rule').title = `${s.rule.name} — click to cycle (keys 1–4)`;
    pause.textContent = s.running ? '❚❚' : '▶';
    pause.setAttribute('aria-label', s.running ? 'Pause automaton' : 'Run automaton');
  });
  $('rule').addEventListener('click', () => l.cycleRule());
  pause.addEventListener('click', () => l.toggle());
  $('reseed').addEventListener('click', () => l.seed());
  $('sound').addEventListener('click', () => window.dispatchEvent(new Event('sound:toggle')));
  addEventListener('sound:change', (e) => $('sound').setAttribute('aria-pressed', String((e as CustomEvent).detail)));
}

start();
// fires on the first load as well as after every client-side navigation
document.addEventListener('astro:page-load', applyPage);
