/** Cavi on the panel: eight cables as rows, and jacks on every module that patch by two clicks. */
import type { Ctx } from './ui-kit';
import { CABLES, CABLE_INK, CV_DST, CV_SRC, GATE_DST } from './params';

export function mountCables(ctx: Ctx) {
  const { $$ } = ctx;
  const srcSel = $$<HTMLSelectElement>('[data-csrc]');
  const dstSel = $$<HTMLSelectElement>('[data-cdst]');
  const rows = $$<HTMLElement>('[data-cable]');
  const jin = $$<HTMLButtonElement>('[data-jack-in]');
  const jout = $$<HTMLButtonElement>('[data-jack-out]');

  function paint() {
    for (let c = 0; c < CABLES; c++) {
      const s = ctx.get(`c${c + 1}.src`),
        d = ctx.get(`c${c + 1}.dst`);
      srcSel[c].value = String(s);
      dstSel[c].value = String(d);
      rows[c].classList.toggle('is-live', !!(s && d));
    }
    const inks = (attr: 'src' | 'dst', v: number) => {
      const out: string[] = [];
      for (let c = 0; c < CABLES; c++) if (ctx.get(`c${c + 1}.${attr}`) === v && ctx.get(`c${c + 1}.src`) && ctx.get(`c${c + 1}.dst`)) out.push(CABLE_INK[c]);
      return out;
    };
    for (const j of jin) {
      const ink = inks('dst', Number(j.dataset.jackIn));
      j.classList.toggle('is-patched', ink.length > 0);
      j.style.setProperty('--ink-c', ink[0] ?? '');
    }
    for (const j of jout) {
      const ink = inks('src', Number(j.dataset.jackOut));
      j.classList.toggle('is-patched', ink.length > 0);
      j.style.setProperty('--ink-c', ink[0] ?? '');
    }
  }
  srcSel.forEach((s, c) => s.addEventListener('change', () => ctx.setParam(`c${c + 1}.src`, Number(s.value))));
  dstSel.forEach((s, c) =>
    s.addEventListener('change', () => {
      ctx.setParam(`c${c + 1}.dst`, Number(s.value));
      if (GATE_DST.has(Number(s.value)) && ctx.get(`c${c + 1}.amt`) < 0.5) ctx.setParam(`c${c + 1}.amt`, 1);
    }),
  );
  $$<HTMLButtonElement>('[data-cclear]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = Number(b.dataset.cclear) + 1;
      ctx.setParam(`c${c}.src`, 0);
      ctx.setParam(`c${c}.dst`, 0);
    }),
  );
  ctx.watch((id) => {
    if (/^c\d\.(src|dst)$/.test(id)) paint();
  });
  paint();

  // two clicks: an out jack, then an in jack (or the other way round)
  let armed: { kind: 'out' | 'in'; v: number; el: HTMLElement } | null = null;
  const disarm = () => {
    armed?.el.classList.remove('is-armed');
    document.body.classList.remove('is-patching');
    armed = null;
  };
  function connect(src: number, dst: number) {
    let c = 0;
    for (let k = 1; k <= CABLES; k++)
      if (ctx.get(`c${k}.src`) === src && ctx.get(`c${k}.dst`) === dst) {
        // the same cable again unplugs it
        ctx.setParam(`c${k}.src`, 0);
        ctx.setParam(`c${k}.dst`, 0);
        ctx.status(`unplugged: ${CV_SRC[src]} → ${CV_DST[dst]}`);
        return;
      }
    for (let k = 1; k <= CABLES && !c; k++) if (!ctx.get(`c${k}.src`) || !ctx.get(`c${k}.dst`)) c = k;
    if (!c) {
      ctx.status('all eight cables are in use: unplug one in Cavi');
      return;
    }
    ctx.setParam(`c${c}.src`, src);
    ctx.setParam(`c${c}.dst`, dst);
    ctx.setParam(`c${c}.amt`, GATE_DST.has(dst) ? 1 : 0.5);
    ctx.status(`cable ${c}: ${CV_SRC[src]} → ${CV_DST[dst]}`);
  }
  const click = (kind: 'out' | 'in', v: number, el: HTMLElement) => {
    if (armed && armed.kind !== kind) {
      const src = kind === 'in' ? armed.v : v,
        dst = kind === 'in' ? v : armed.v;
      disarm();
      connect(src, dst);
      return;
    }
    if (armed?.el === el) return disarm();
    disarm();
    armed = { kind, v, el };
    el.classList.add('is-armed');
    document.body.classList.add('is-patching');
    ctx.status(kind === 'out' ? `${CV_SRC[v]}: now click an input jack` : `${CV_DST[v]}: now click an output jack`);
  };
  jout.forEach((j) => j.addEventListener('click', () => click('out', Number(j.dataset.jackOut), j)));
  jin.forEach((j) => j.addEventListener('click', () => click('in', Number(j.dataset.jackIn), j)));
  const esc = (e: KeyboardEvent) => e.key === 'Escape' && armed && disarm();
  addEventListener('keydown', esc);
  ctx.cleanup(() => removeEventListener('keydown', esc));

  // the jacks glow with their signal
  ctx.onFrame(() => {
    const m = ctx.mon;
    if (!m) return;
    for (const j of jout) j.style.setProperty('--glow', String(Math.min(1, m.cv[Number(j.dataset.jackOut)] ?? 0)));
    for (const j of jin) j.style.setProperty('--glow', String(m.gates[Number(j.dataset.jackIn)] ?? 0));
  });
}
