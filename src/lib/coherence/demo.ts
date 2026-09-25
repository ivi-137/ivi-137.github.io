/**
 * The toy experiment, live: the baseline and the Ledger model write the same
 * requested post for the same author, token by token, in your browser.
 *
 *   <div data-ledger-demo data-src="/coherence" data-caption="…"></div>
 */
import { chip, shell, slider } from './figures';
import { loadNet, SLOT_NAME, type Net } from './net';
import { FONT_NAMES, HEAD_NAMES, IMPLICIT, MATH_OPEN, MATH_CLOSE, MONITORS, renderPost, rng, Toy, type Style } from './toy';

const LABEL: Record<string, string> = { font: 'font', heading: 'headings', math: 'maths', why: 'why-section', sources: 'sources last', order: 'order', length: 'length' };

function sample(logits: Float32Array, r: () => number, temp: number, pad: number) {
  let mx = -Infinity;
  for (let i = 0; i < logits.length; i++) if (i !== pad) mx = Math.max(mx, logits[i]);
  let s = 0;
  const p = new Float64Array(logits.length);
  for (let i = 0; i < logits.length; i++) if (i !== pad) s += p[i] = Math.exp((logits[i] - mx) / temp);
  let x = r() * s;
  for (let i = 0; i < p.length; i++) if ((x -= p[i]) < 0) return i;
  return logits.length - 1;
}

/** Write one post. Yields after every token so the page can draw. */
async function* write(net: Net, toy: Toy, prompt: number[], r: () => number, temp = 1, max = 320) {
  net.reset();
  let logits: Float32Array = new Float32Array(0);
  prompt.forEach((t, i) => (logits = net.step(t, i === prompt.length - 1)));
  const y: number[] = [];
  const pad = toy.id['<pad>'];
  while (prompt.length + y.length < max) {
    const tok = sample(logits, r, temp, pad);
    if (tok === toy.EOS) {
      yield { y, done: true, ended: true };
      return;
    }
    y.push(tok);
    yield { y, done: false, ended: false };
    logits = net.step(tok, true);
  }
  yield { y, done: true, ended: false };
}

export function mountDemo(host: HTMLElement) {
  const base = host.dataset.src ?? '/coherence';
  const { fig, stage, bar } = shell(host, 'demo');
  stage.innerHTML = `
    <div class="cd__author mono"></div>
    <div class="cd__cols">
      <section class="cd__col" data-col="base"><header class="mono"><b>baseline</b> <span data-meta></span></header><div class="cd__post" data-post></div><ul class="cd__mon mono" data-mon></ul></section>
      <section class="cd__col" data-col="ledger"><header class="mono"><b>with the Ledger</b> <span data-meta></span></header><div class="cd__post" data-post></div><ul class="cd__mon mono" data-mon></ul><div class="cd__led mono" data-led></div></section>
    </div>
    <p class="cd__tally mono" data-tally></p>`;
  const author = stage.querySelector<HTMLElement>('.cd__author')!;
  const tally = stage.querySelector<HTMLElement>('[data-tally]')!;
  let nets: { base: Net; ledger: Net } | null = null;
  let toy: Toy;
  let style: Style | null = null;
  let k = 9;
  let seed = 1;
  let busy = false;
  const score = { base: { n: 0, ok: 0 }, ledger: { n: 0, ok: 0 } };

  const status = document.createElement('span');
  status.textContent = 'models load when you press write (≈ 0.7 MB)';
  const go = chip(bar, '▶ write', () => run(false));
  const again = chip(bar, 'new author', () => {
    style = null;
    run(false);
  });
  const batch = chip(bar, 'run 20 authors', () => run(true), 'Tally coherence over 20 random authors');
  slider(bar, 'paragraphs', 3, 16, 1, k, String, (v) => (k = v));
  bar.append(status);
  void go;
  void again;

  async function ensure() {
    if (nets) return nets;
    status.textContent = 'loading weights…';
    const [b, l] = await Promise.all([loadNet(base, 'base'), loadNet(base, 'ledger')]);
    toy = new Toy(b.meta);
    nets = { base: b, ledger: l };
    status.textContent = `baseline ${b.meta.n_params.toLocaleString()} parameters · Ledger ${l.meta.n_params.toLocaleString()}`;
    return nets;
  }

  const describe = (st: Style) =>
    `author: font <b>${FONT_NAMES[st.font]}</b> · headings <b>${HEAD_NAMES[st.head]}</b> · maths <b>${MATH_OPEN[st.math]}…${MATH_CLOSE[st.math]}</b> · why-section <b>${st.why ? 'yes' : 'no'}</b> · sources <b>${st.src ? 'yes' : 'no'}</b> · asked for <b>${k}</b> paragraphs. The request itself is written in plain serif with $…$.`;

  function monitors(el: HTMLElement, res: ReturnType<Toy['audit']> | null) {
    el.innerHTML = MONITORS.map((m) => {
      const s = !res ? 'wait' : res.ok[m] ? 'ok' : 'bad';
      return `<li class="is-${s}" title="${IMPLICIT.includes(m) ? 'implicit: read off the posts' : 'explicit: stated in the request'}">${s === 'ok' ? '✓' : s === 'bad' ? '✗' : '·'} ${LABEL[m]}</li>`;
    }).join('');
  }

  function ledgerPanel(el: HTMLElement, net: Net) {
    const v = net.view;
    if (!v) return (el.innerHTML = '');
    const read = `clerk read: font ${FONT_NAMES[v.read.font]}, headings ${HEAD_NAMES[v.read.head]}, maths ${MATH_OPEN[v.read.math]}…${MATH_CLOSE[v.read.math]}, why ${(v.read.why * 100).toFixed(0)}%, sources ${(v.read.src * 100).toFixed(0)}%, ${v.read.k} ¶`;
    const rows = SLOT_NAME.slice(0, 6)
      .map((n, i) => {
        const ty = i < 3 ? 'G' : i === 5 ? '#' : 'F';
        const pend = v.pend[i];
        return `<div class="cd__slot"><span>${ty}</span><span>${n}</span><span class="cd__meter"><i style="width:${(ty === 'G' ? 100 : (1 - pend) * 100).toFixed(0)}%"></i></span><span>${ty === 'G' ? 'in force' : pend > 0.5 ? 'owed' : 'paid'}</span></div>`;
      })
      .join('');
    el.innerHTML = `<p>${read}</p>${rows}<p>p(eos) × ${v.eosFactor < 0.001 ? v.eosFactor.toExponential(0) : v.eosFactor.toFixed(3)}</p>`;
  }

  async function run(many: boolean) {
    if (busy) return;
    busy = true;
    try {
      await ensure();
      const reps = many ? 20 : 1;
      for (let rep = 0; rep < reps; rep++) {
        const r = rng(seed++ * 7919);
        if (!style || many) style = toy.sampleStyle(r);
        const st = style;
        author.innerHTML = describe(st);
        const prompt = toy.prompt(r, st, k);
        const cols = (['base', 'ledger'] as const).map((name) => {
          const col = stage.querySelector<HTMLElement>(`[data-col="${name}"]`)!;
          return { name, col, post: col.querySelector<HTMLElement>('[data-post]')!, mon: col.querySelector<HTMLElement>('[data-mon]')!, meta: col.querySelector<HTMLElement>('[data-meta]')!, led: col.querySelector<HTMLElement>('[data-led]') };
        });
        await Promise.all(
          cols.map(async (c) => {
            const net = nets![c.name];
            const rs = rng(seed * 31 + (c.name === 'base' ? 1 : 2));
            monitors(c.mon, null);
            let last: { y: number[]; ended: boolean } = { y: [], ended: false };
            let n = 0;
            for await (const s of write(net, toy, prompt, rs)) {
              last = s;
              if (!many && (n++ % 3 === 0 || s.done)) {
                c.post.innerHTML = renderPost(toy, s.y);
                if (c.led) ledgerPanel(c.led, net);
                c.post.scrollTop = c.post.scrollHeight;
                await new Promise((res) => setTimeout(res, 16));
              } else if (n++ % 40 === 0) await new Promise((res) => setTimeout(res, 0));
            }
            const res = toy.audit(last.y, st, k, last.ended);
            c.post.innerHTML = renderPost(toy, last.y, res.bad);
            if (c.led) ledgerPanel(c.led, net);
            monitors(c.mon, res);
            c.meta.textContent = `${last.y.length} tokens · ${res.paras} ¶`;
            score[c.name].n++;
            if (IMPLICIT.every((m) => res.ok[m])) score[c.name].ok++;
          }),
        );
        tally.textContent = `coherent so far (all six implicit rules kept): baseline ${score.base.ok}/${score.base.n} · Ledger ${score.ledger.ok}/${score.ledger.n}`;
      }
    } catch (e) {
      status.textContent = `could not load the models: ${(e as Error).message}`;
    } finally {
      busy = false;
    }
  }
  void batch;
  void fig;
}
