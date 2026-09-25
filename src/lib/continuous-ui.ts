import { PRESETS, blobRect, seedField, webgl2, webgpu, type Backend, type Kind, type Params } from './life/continuous';

const ABOUT: Record<Kind, string> = {
  lenia:
    'Lenia (Bert Chan, 2019): a smooth ring kernel measures each point’s neighbourhood, and a Gaussian growth curve centred on μ with width σ decides whether it grows or decays. At μ = 0.15, σ = 0.015 it supports gliding organisms such as Orbium.',
  smooth:
    'SmoothLife (Stephan Rafler, 2011): Conway’s rule rebuilt on a continuum. An inner disk decides whether a point counts as alive; an outer annulus plays the role of the eight neighbours, with birth and survival intervals blended smoothly.',
};

export function mountContinuous() {
  const root = document.querySelector<HTMLElement>('[data-lab]');
  const panel = document.querySelector<HTMLElement>('[data-cont]');
  if (!root || !panel || panel.dataset.ready) return;
  panel.dataset.ready = '1';
  const $ = <T extends HTMLElement>(s: string) => panel.querySelector<T>(s)!;
  let canvas = $<HTMLCanvasElement>('[data-cont-canvas]');
  const discrete = root.querySelector<HTMLElement>('[data-discrete]')!;
  const W = 256, H = 256;
  let backend: Backend | null = null;
  let params: Params = { ...PRESETS.lenia };
  let running = true;
  let raf = 0;
  let steps = 0, lastFps = performance.now();

  const syncControls = () => {
    panel.querySelectorAll<HTMLInputElement>('[data-cont-p]').forEach((inp) => {
      const k = inp.dataset.contP as keyof Params;
      inp.value = String(params[k]);
      panel.querySelector(`[data-cont-o="${k}"]`)!.textContent = String(params[k]);
    });
    panel.querySelectorAll<HTMLElement>('[data-only]').forEach((el) => (el.hidden = el.dataset.only !== params.kind));
    $('[data-cont-title]').textContent = params.kind === 'lenia' ? 'Lenia' : 'SmoothLife';
    $('[data-cont-about]').textContent = ABOUT[params.kind];
  };

  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (!backend) return;
    if (running) {
      backend.step(1);
      steps++;
    }
    backend.render();
    const now = performance.now();
    if (now - lastFps > 1000) {
      $('[data-cont-fps]').textContent = String(Math.round((steps * 1000) / (now - lastFps)));
      steps = 0;
      lastFps = now;
    }
  };

  const bindCanvas = (c: HTMLCanvasElement) =>
    c.addEventListener('pointerdown', (e) => {
      if (!backend) return;
      const r = c.getBoundingClientRect();
      const cx = Math.floor(((e.clientX - r.left) / r.width) * W), cy = Math.floor(((e.clientY - r.top) / r.height) * H);
      const b = blobRect(W, H, params, cx, cy);
      backend.stampRect(b.x, b.y, b.size, b.size, b.data);
    });

  const ensure = async () => {
    if (backend) return backend;
    const px = Math.min(640, canvas.parentElement!.clientWidth);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = canvas.height = Math.round(px * dpr);
    canvas.style.width = canvas.style.height = `${px}px`;
    try {
      backend = await webgpu(canvas, W, H);
    } catch (err) {
      console.info('[lab] WebGPU unavailable, falling back to WebGL2:', err);
      backend = null;
    }
    if (!backend) {
      // a canvas that already handed out a webgpu context can't give a webgl2 one: swap in a fresh canvas
      const fresh = canvas.cloneNode() as HTMLCanvasElement;
      canvas.replaceWith(fresh);
      canvas = fresh;
      bindCanvas(fresh);
      backend = webgl2(fresh, W, H);
    }
    if (!backend) {
      $('[data-cont-backend]').textContent = 'needs WebGPU or WebGL2 float textures';
      return null;
    }
    $('[data-cont-backend]').textContent = backend.name;
    backend.setParams(params);
    backend.upload(seedField(W, H, params));
    loop();
    return backend;
  };
  bindCanvas(canvas);

  const setKind = async (kind: Kind) => {
    params = { ...PRESETS[kind] };
    syncControls();
    const b = await ensure();
    if (!b) return;
    b.setParams(params);
    b.upload(seedField(W, H, params));
  };

  root.querySelectorAll<HTMLButtonElement>('[data-lab-tab]').forEach((tab) =>
    tab.addEventListener('click', () => {
      const which = tab.dataset.labTab!;
      root.querySelectorAll('[data-lab-tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      const cont = which !== 'discrete';
      panel.hidden = !cont;
      discrete.hidden = cont;
      running = cont;
      $('[data-cont-play]').textContent = '❚❚ pause';
      if (cont) setKind(which as Kind);
      window.dispatchEvent(new CustomEvent('lab:family', { detail: which }));
    }),
  );

  panel.querySelectorAll<HTMLInputElement>('[data-cont-p]').forEach((inp) =>
    inp.addEventListener('input', () => {
      const k = inp.dataset.contP as 'R' | 'mu' | 'sigma' | 'dt';
      params = { ...params, [k]: Number(inp.value) };
      panel.querySelector(`[data-cont-o="${k}"]`)!.textContent = inp.value;
      backend?.setParams(params);
    }),
  );
  $('[data-cont-play]').addEventListener('click', (e) => {
    running = !running;
    (e.currentTarget as HTMLElement).textContent = running ? '❚❚ pause' : '▶ run';
  });
  $('[data-cont-seed]').addEventListener('click', () => backend?.upload(seedField(W, H, params)));
  $('[data-cont-clear]').addEventListener('click', () => backend?.upload(new Float32Array(W * H)));
  $('[data-cont-preset]').addEventListener('click', () => setKind(params.kind));
  syncControls();

  document.addEventListener(
    'astro:before-swap',
    () => {
      cancelAnimationFrame(raf);
      backend?.destroy();
    },
    { once: true },
  );
}
