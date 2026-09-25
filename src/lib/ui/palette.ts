import { search, loadIndex } from './search';
import { go, openDialog } from './nav';

interface Item {
  label: string;
  hint: string;
  run: () => void;
  kind: 'post' | 'page' | 'action';
}

const PAGES: Item[] = [
  { label: 'Home', hint: '/', kind: 'page', run: () => go('/') },
  { label: 'The complexity zoo', hint: 'archive', kind: 'page', run: () => go('/archive/') },
  { label: 'Lab: rule explorer', hint: '/lab/', kind: 'page', run: () => go('/lab/') },
  { label: 'Atlas of 256 elementary rules', hint: '/atlas/', kind: 'page', run: () => go('/atlas/') },
  { label: 'Network of ideas', hint: '/network/', kind: 'page', run: () => go('/network/') },
  { label: 'Complexity unveiled: seed, thread, fold, K(s)', hint: '/unveiled/', kind: 'page', run: () => go('/unveiled/') },
  { label: 'Glider logic: a NOT gate from collisions', hint: '/logic/', kind: 'page', run: () => go('/logic/') },
  { label: 'Tamburo 8: automaton drum machine', hint: '/drums/', kind: 'page', run: () => go('/drums/') },
  { label: 'Stochos 64: stochastic MIDI sequencer', hint: '/sequencer/', kind: 'page', run: () => go('/sequencer/') },
  { label: 'Orfeo 32: underworld synthesizer', hint: '/synth/', kind: 'page', run: () => go('/synth/') },
  { label: 'Melencolia I: vocoder for sad songs', hint: '/vocoder/', kind: 'page', run: () => go('/vocoder/') },
  { label: 'Toggle the homeostat (Ashby loop)', hint: 'terminal: homeostat', kind: 'action', run: () => window.dispatchEvent(new Event('homeostat:toggle')) },
  { label: 'About', hint: '/about/', kind: 'page', run: () => go('/about/') },
  { label: 'Open terminal', hint: '~', kind: 'action', run: () => openDialog('[data-term]') },
  { label: 'Open live channel', hint: 'C', kind: 'action', run: () => window.dispatchEvent(new Event('chat:open')) },
  { label: 'Listen to the colony', hint: 'M', kind: 'action', run: () => window.dispatchEvent(new Event('sound:toggle')) },
  { label: 'Keyboard shortcuts', hint: '?', kind: 'action', run: () => openDialog('[data-help]') },
  { label: 'RSS feed', hint: '/rss.xml', kind: 'page', run: () => (location.href = '/rss.xml') },
];

let items: Item[] = [];
let active = 0;
let seq = 0;

export function mountPalette() {
  const dlg = document.querySelector<HTMLDialogElement>('[data-palette]');
  if (!dlg || dlg.dataset.ready) return;
  dlg.dataset.ready = '1';
  const input = dlg.querySelector<HTMLInputElement>('[data-palette-input]')!;
  const list = dlg.querySelector<HTMLUListElement>('[data-palette-results]')!;

  const render = () => {
    list.replaceChildren(
      ...items.map((it, i) => {
        const li = document.createElement('li');
        li.id = `pal-${i}`;
        li.role = 'option';
        li.className = `palette__item palette__item--${it.kind}`;
        li.setAttribute('aria-selected', String(i === active));
        const a = document.createElement('span');
        a.className = 'palette__label';
        a.textContent = it.label;
        const b = document.createElement('span');
        b.className = 'palette__hint mono';
        b.textContent = it.hint;
        li.append(a, b);
        li.addEventListener('mousemove', () => {
          if (active !== i) (active = i), render();
        });
        li.addEventListener('click', () => choose(i));
        return li;
      }),
    );
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'palette__empty mono';
      li.textContent = 'No signal. Try fewer words.';
      list.append(li);
    }
    input.setAttribute('aria-activedescendant', items.length ? `pal-${active}` : '');
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };

  const update = async () => {
    const q = input.value.trim();
    const my = ++seq;
    const lower = q.toLowerCase();
    const pages = PAGES.filter((p) => !q || p.label.toLowerCase().includes(lower) || p.hint.includes(lower));
    const hits = q ? await search(q, 8) : [];
    if (my !== seq) return;
    items = [
      ...hits.map<Item>((h) => ({
        label: h.doc.title,
        hint: `${h.doc.class} · ${h.doc.n}`,
        kind: 'post',
        run: () => go(h.doc.url),
      })),
      ...pages,
    ];
    active = 0;
    render();
  };

  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    dlg.close();
    it.run();
  };

  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') active = Math.min(items.length - 1, active + 1);
    else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
    else if (e.key === 'Enter') return e.preventDefault(), choose(active);
    else return;
    e.preventDefault();
    render();
  });
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
  dlg.addEventListener('close', () => (input.value = ''));
}

export function openPalette() {
  const dlg = openDialog('[data-palette]');
  if (!dlg) return;
  loadIndex();
  const input = dlg.querySelector<HTMLInputElement>('[data-palette-input]')!;
  input.value = '';
  input.dispatchEvent(new Event('input'));
  input.focus();
}
