/** Quinconce on the panel: the Cocos' memory rings, the Quantussy's petals, the piezo plate. */
import type { Ctx } from './ui-kit';
import { clamp, capture } from './ui-kit';

export function mountQuinc(ctx: Ctx) {
  const { $$, engine } = ctx;
  const rings = $$<HTMLCanvasElement>('[data-ring]');
  const petals = $$<SVGGElement>('[data-petal]');
  const trails = [new Float32Array(96), new Float32Array(96)];

  function drawRing(cv: HTMLCanvasElement, w: 0 | 1) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const s = Math.max(10, Math.round(cv.clientWidth * dpr));
    if (cv.width !== s) cv.width = cv.height = s;
    const g = cv.getContext('2d')!;
    const m = ctx.mon;
    const r = s / 2 - 4 * dpr;
    g.clearRect(0, 0, s, s);
    if (r <= 2 || !cv.clientWidth) return;
    g.lineWidth = 2 * dpr;
    g.strokeStyle = '#16140f';
    g.beginPath();
    g.arc(s / 2, s / 2, r, 0, Math.PI * 2);
    g.stroke();
    if (!m) return;
    const where = m.coco[w];
    const lvl = clamp(m.cocoLvl[w] * 1.5);
    // what the loop has sounded like, as a ring of marks behind the head
    const t = trails[w];
    const slot = Math.floor(where * t.length) % t.length;
    t[slot] = Math.max(t[slot] * 0.7, lvl);
    for (let i = 0; i < t.length; i++) {
      const a = (i / t.length) * Math.PI * 2 - Math.PI / 2;
      const len = (0.08 + 0.3 * t[i]) * r;
      g.strokeStyle = `rgba(47,107,0,${0.25 + 0.75 * t[i]})`;
      g.lineWidth = 2 * dpr;
      g.beginPath();
      g.moveTo(s / 2 + Math.cos(a) * (r - len), s / 2 + Math.sin(a) * (r - len));
      g.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r);
      g.stroke();
    }
    const a = where * Math.PI * 2 - Math.PI / 2;
    g.strokeStyle = ctx.get(w ? 'qb.rec' : 'qa.rec') > 0.5 ? '#ff4b1f' : '#16140f';
    g.lineWidth = 3 * dpr;
    g.beginPath();
    g.moveTo(s / 2, s / 2);
    g.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r);
    g.stroke();
  }
  ctx.onFrame(() => {
    rings.forEach((cv, i) => drawRing(cv, i as 0 | 1));
    const m = ctx.mon;
    if (m) petals.forEach((p, i) => p.classList.toggle('is-on', !!m.petals[i]));
  });

  // the Cocos' buttons
  $$<HTMLButtonElement>('[data-coco]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await ctx.boot())) return;
      const w = Number(b.dataset.coco) as 0 | 1;
      const c = b.dataset.c as 'flip' | 'skip' | 'clear';
      engine.send({ t: 'coco', w, c });
      if (c === 'clear') {
        trails[w].fill(0);
        ctx.status(`Coco ${w ? 'B' : 'A'}: memory erased`);
      }
    }),
  );

  // the piezo plate: a tap is a knock, a drag is a scratch
  const plate = ctx.$('[data-piezo]');
  let last: { x: number; y: number; t: number } | null = null;
  const tap = async (v: number) => {
    if (!(await ctx.boot())) return;
    if (ctx.get('q.src') !== 1) {
      ctx.setParam('q.src', 1);
      ctx.status('Quinconce is listening to the piezo');
    }
    engine.send({ t: 'piezo', tap: v });
    plate.classList.remove('is-hit');
    void plate.offsetWidth;
    plate.classList.add('is-hit');
  };
  plate.addEventListener('pointerdown', (e) => {
    capture(plate, e.pointerId);
    last = { x: e.clientX, y: e.clientY, t: performance.now() };
    tap(e.pressure && e.pressure !== 0.5 ? e.pressure : 0.8);
  });
  plate.addEventListener('pointermove', (e) => {
    if (!last) return;
    const now = performance.now();
    const d = Math.hypot(e.clientX - last.x, e.clientY - last.y) / Math.max(1, now - last.t);
    engine.send({ t: 'piezo', rub: clamp(d * 0.8) });
    last = { x: e.clientX, y: e.clientY, t: now };
  });
  const lift = () => {
    last = null;
    engine.send({ t: 'piezo', rub: 0 });
  };
  plate.addEventListener('pointerup', lift);
  plate.addEventListener('pointercancel', lift);
  plate.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      tap(0.7);
    }
  });
}
