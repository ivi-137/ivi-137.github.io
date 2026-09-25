import { go, life, openDialog, toast } from './nav';
import { mountPalette, openPalette } from './palette';
import { mountTerminal, openTerminal } from './terminal';
import { Sonifier } from '../life/sound';
import { GOSPER_GUN } from '../life/patterns';

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

const GOTO: Record<string, string> = { h: '/', z: '/archive/', l: '/lab/', a: '/atlas/', n: '/network/', b: '/about/', u: '/unveiled/', x: '/logic/', d: '/drums/', s: '/synth/' };
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

let sound: Sonifier | null = null;
const toggleSound = async () => {
  const l = life();
  if (!l) return toast('No colony to listen to: WebGL2 is unavailable.');
  sound ??= new Sonifier(l);
  const on = await sound.toggle();
  toast(on ? '♪ listening to the scanline. Every birth is a note.' : 'sound off');
};

/** The colony answers. */
function firstContact() {
  const l = life();
  document.documentElement.classList.add('contact');
  setTimeout(() => document.documentElement.classList.remove('contact'), 2400);
  if (l) {
    l.toggle(true);
    for (let i = 0; i < 6; i++) l.stampAt(GOSPER_GUN, innerWidth * (0.15 + 0.7 * Math.random()), innerHeight * (0.12 + 0.76 * Math.random()), Math.random() < 0.5, Math.random() < 0.5);
  }
  toast('TRANSMISSION RECEIVED ▸ "we have been computing you too."', 7000);
}

let gPending = 0;
let konami = 0;

function onKey(e: KeyboardEvent) {
  konami = e.key === KONAMI[konami] || e.key.toLowerCase() === KONAMI[konami] ? konami + 1 : e.key === KONAMI[0] ? 1 : 0;
  if (konami === KONAMI.length) {
    konami = 0;
    firstContact();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    return openPalette();
  }
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
  if (document.querySelector('.overlays dialog[open]')) return;

  const k = e.key;
  if (gPending && performance.now() - gPending < 1200 && GOTO[k.toLowerCase()]) {
    gPending = 0;
    e.preventDefault();
    return go(GOTO[k.toLowerCase()]);
  }
  gPending = 0;
  switch (k) {
    case '/':
      e.preventDefault();
      return openPalette();
    case '~':
    case '`':
      e.preventDefault();
      return openTerminal();
    case '?':
      e.preventDefault();
      return openDialog('[data-help]');
    case 'g':
    case 'G':
      gPending = performance.now();
      return;
    case 'c':
    case 'C':
      e.preventDefault(); // otherwise the keystroke lands in the freshly focused input
      return window.dispatchEvent(new Event('chat:open'));
    case 'm':
    case 'M':
      return toggleSound();
    case 'j':
    case 'k': {
      const a = document.querySelector<HTMLAnchorElement>(k === 'j' ? '.pager__next' : '.pager__prev');
      if (a) go(a.href);
      return;
    }
  }
}

/** Idle on the home page's hero for a while → the interface fades, the colony stays. */
function zen() {
  let t = 0;
  const wake = () => {
    document.documentElement.classList.remove('zen');
    clearTimeout(t);
    t = window.setTimeout(() => {
      if (document.body.classList.contains('home') && scrollY < innerHeight * 0.3 && !document.querySelector('dialog[open], .chat.is-open')) {
        document.documentElement.classList.add('zen');
      }
    }, 75_000);
  };
  for (const ev of ['pointermove', 'keydown', 'scroll', 'touchstart']) addEventListener(ev, wake, { passive: true });
  document.addEventListener('astro:page-load', wake);
  wake();
}

export function mountShortcuts() {
  mountPalette();
  mountTerminal();
  addEventListener('keydown', onKey);
  addEventListener('palette:open', openPalette);
  addEventListener('term:open', openTerminal);
  addEventListener('sound:toggle', toggleSound);
  addEventListener('homeostat:toggle', () => {
    const h = (window as any).__homeostat;
    if (h) toast(h.toggle() ? '⟲ homeostat on: the colony will match your variety' : 'homeostat off: the colony runs open-loop');
  });
  zen();
}
