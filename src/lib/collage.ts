import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { fnv1a, mountSigils, stopAllSigils } from './sigil';
import { mountEmbeds } from './embeds';
import { mountGiscus } from './ui/giscus';
import { openPalette } from './ui/palette';
import { openTerminal } from './ui/terminal';
import { toast } from './ui/nav';

gsap.registerPlugin(ScrollTrigger);

const GLYPHS = '⌖⍜⏃⏚⟟⋔⎍⊑⍀⟒⏁⌇⋏⍙⎅⏀⌰⍾⟊⌬⊬⋉⌿⍓⎐';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Deterministic torn-paper edge: jagged top and bottom, straight sides. */
function tear(el: HTMLElement) {
  const r = (() => {
    let s = fnv1a(el.textContent?.slice(0, 40) ?? 'x') || 7;
    return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)) >>> 0) / 4294967296;
  })();
  const pts: string[] = [];
  const steps = 18;
  const amp = Number(el.dataset.tear ?? 7); // px
  for (let i = 0; i <= steps; i++) pts.push(`${(i / steps) * 100}% ${(r() * amp).toFixed(1)}px`);
  for (let i = steps; i >= 0; i--) pts.push(`${(i / steps) * 100}% calc(100% - ${(r() * amp).toFixed(1)}px)`);
  el.style.clipPath = `polygon(${pts.join(',')})`;
}

/** Alien-glyph scramble that resolves into the real text. */
function decode(el: HTMLElement) {
  const text = el.dataset.decodeText ?? el.textContent ?? '';
  el.dataset.decodeText = text;
  el.setAttribute('aria-label', text);
  if (reduced()) return;
  const state = { p: 0 };
  gsap.to(state, {
    p: 1,
    duration: Math.min(1.8, 0.4 + text.length * 0.025),
    ease: 'power2.out',
    delay: Number(el.dataset.decodeDelay ?? 0.15),
    onUpdate() {
      const n = Math.floor(state.p * text.length);
      let out = text.slice(0, n);
      for (let i = n; i < text.length; i++) out += text[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      el.textContent = out;
    },
    onComplete() {
      el.textContent = text;
    },
  });
}

function hero(ctx: gsap.Context) {
  const collage = document.querySelector<HTMLElement>('[data-parallax]');
  if (!collage) return;
  const layers = [...collage.querySelectorAll<HTMLElement>('[data-depth]')];

  const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
  tl.from('.hero__word .ch', { yPercent: 120, rotate: () => gsap.utils.random(-14, 14), opacity: 0, duration: 1.4, stagger: 0.06 }, 0.2)
    .from('.cut--disc', { scale: 0, duration: 1.6 }, 0.1)
    .from('.cut--bar', { scaleX: 0, transformOrigin: 'left center', duration: 1.2 }, 0.35)
    .from('.cut--strip', { xPercent: -30, opacity: 0, rotate: -8, duration: 1.1 }, 0.6)
    .from('.cut--card', { y: 80, rotate: 14, opacity: 0, duration: 1.3 }, 0.75)
    .from('.hero__hint span, .hero__down', { opacity: 0, y: 12, stagger: 0.08, duration: 0.8 }, 1.1);

  // pointer parallax: each layer drifts in proportion to its depth
  const movers = layers.map((el) => ({
    x: gsap.quickTo(el, 'x', { duration: 0.9, ease: 'power3.out' }),
    y: gsap.quickTo(el, 'y', { duration: 0.9, ease: 'power3.out' }),
    d: Number(el.dataset.depth),
  }));
  const onMove = (e: PointerEvent) => {
    const nx = e.clientX / innerWidth - 0.5, ny = e.clientY / innerHeight - 0.5;
    movers.forEach((m) => (m.x(-nx * 60 * m.d), m.y(-ny * 40 * m.d)));
  };
  addEventListener('pointermove', onMove);
  ctx.add(() => () => removeEventListener('pointermove', onMove));

  // scroll: the collage comes apart as you leave the hero
  layers.forEach((el) => {
    const d = Number(el.dataset.depth);
    gsap.to(el, {
      yPercent: -60 * d - 10,
      rotate: (d - 0.3) * 18,
      ease: 'none',
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
    });
  });
}

function cards() {
  ScrollTrigger.batch('.card', {
    start: 'top 92%',
    once: true,
    onEnter: (els) =>
      gsap.from(els, {
        y: 90,
        rotate: () => gsap.utils.random(-9, 9),
        opacity: 0,
        duration: 1.1,
        ease: 'expo.out',
        stagger: 0.09,
        clearProps: 'transform,opacity',
      }),
  });
  gsap.utils.toArray<HTMLElement>('.zoo__ring').forEach((ring, i, all) => {
    gsap.from(ring, {
      scale: 0.6,
      opacity: 0,
      transformOrigin: '50% 100%',
      duration: 1.2,
      ease: 'expo.out',
      delay: (all.length - i) * 0.08,
      scrollTrigger: { trigger: ring.closest('.zoo'), start: 'top 80%', once: true },
    });
  });
}

function progress() {
  const bar = document.querySelector<HTMLElement>('[data-progress]');
  const prose = document.querySelector<HTMLElement>('.sheet');
  if (!bar || !prose) return;
  gsap.to(bar, { scaleX: 1, ease: 'none', scrollTrigger: { trigger: prose, start: 'top top', end: 'bottom bottom', scrub: 0.3 } });
}

/** Archive: filter the ledger by complexity class via the zoo rings or #hash. */
function zooFilter() {
  const rows = [...document.querySelectorAll<HTMLElement>('.ledger__row')];
  if (!rows.length) return;
  const label = document.querySelector<HTMLElement>('[data-filter-label]')!;
  const clear = document.querySelector<HTMLButtonElement>('[data-filter-clear]')!;
  const apply = (id: string | null) => {
    let n = 0;
    rows.forEach((r) => {
      const show = !id || r.dataset.class === id;
      r.hidden = !show;
      n += +show;
    });
    document.querySelectorAll<HTMLElement>('[data-zoo]').forEach((z) => z.classList.toggle('is-active', z.dataset.zoo === id));
    document.querySelectorAll<HTMLElement>('[data-zoo-legend]').forEach((z) => z.classList.toggle('is-dim', !!id && z.dataset.zooLegend !== id));
    label.textContent = id ? `${id}: ${n} transmission${n === 1 ? '' : 's'}` : `Showing all ${rows.length}`;
    clear.hidden = !id;
    if (!reduced()) gsap.from(rows.filter((r) => !r.hidden), { x: -20, opacity: 0, stagger: 0.03, duration: 0.5, ease: 'power3.out', clearProps: 'all' });
  };
  const fromHash = () => apply(location.hash.slice(1) || null);
  document.querySelectorAll<HTMLAnchorElement>('.zoo--interactive [data-zoo]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.dataset.zoo!;
      const next = location.hash.slice(1) === id ? '' : id;
      history.replaceState(null, '', next ? `#${next}` : location.pathname);
      apply(next || null);
    }),
  );
  clear.addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    apply(null);
  });
  fromHash();
}

/** Reading aids: heading anchors, copy buttons on code and citations, TOC tracking. */
function reading() {
  document.querySelectorAll<HTMLElement>('.prose :is(h2, h3)[id]').forEach((h) => {
    if (h.querySelector('.anchor')) return;
    const a = document.createElement('a');
    a.className = 'anchor mono';
    a.href = `#${h.id}`;
    a.textContent = '#';
    a.setAttribute('aria-label', `Link to “${h.textContent}”`);
    h.append(a);
  });
  document.querySelectorAll<HTMLPreElement>('.prose pre').forEach((pre) => {
    if (pre.querySelector('.copy')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy mono';
    b.textContent = 'copy';
    b.addEventListener('click', async () => {
      await navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? pre.innerText);
      b.textContent = 'copied';
      setTimeout(() => (b.textContent = 'copy'), 1500);
    });
    pre.append(b);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) =>
    b.addEventListener('click', async () => {
      const src = document.querySelector<HTMLElement>(`[data-copy-src="${b.dataset.copy}"]`);
      if (!src) return;
      await navigator.clipboard.writeText(src.innerText);
      toast('Citation copied.');
    }),
  );
  const toc = document.querySelector<HTMLElement>('[data-toc]');
  if (toc) {
    const links = new Map([...toc.querySelectorAll<HTMLAnchorElement>('a')].map((a) => [a.hash.slice(1), a]));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            links.forEach((a) => a.removeAttribute('aria-current'));
            links.get(e.target.id)?.setAttribute('aria-current', 'true');
          }
      },
      { rootMargin: '0px 0px -70% 0px' },
    );
    links.forEach((_, id) => {
      const h = document.getElementById(id);
      if (h) io.observe(h);
    });
  }
}

let ctx: gsap.Context | null = null;

function mount() {
  document.querySelectorAll<HTMLElement>('.torn').forEach(tear);
  mountSigils();
  document.querySelectorAll<HTMLElement>('[data-decode]').forEach(decode);
  zooFilter();
  mountEmbeds();
  reading();
  mountGiscus();
  document.querySelectorAll('[data-open-palette]').forEach((b) => b.addEventListener('click', openPalette));
  document.querySelectorAll('[data-open-term]').forEach((b) => b.addEventListener('click', openTerminal));
  ctx = gsap.context((self) => {
    if (reduced()) return;
    hero(self);
    cards();
    progress();
  });
}

document.addEventListener('astro:page-load', mount);
document.addEventListener('astro:before-swap', () => {
  stopAllSigils();
  ctx?.revert();
  ScrollTrigger.getAll().forEach((t) => t.kill());
});
