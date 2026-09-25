import { Board } from './life/cpu';
import { parseRule } from './life/engine';
import { LIBRARY, parseRle, toRle } from './life/rle';
import { toast } from './ui/nav';

const NAMES: Record<string, string> = {
  'B3/S23': "Conway's Life",
  'B36/S23': 'HighLife: has a self-replicator',
  'B2/S': 'Seeds: every cell dies at once; explosive',
  'B3678/S34678': 'Day & Night: symmetric under inversion',
  'B4678/S35678': 'Anneal: majority vote with a twist; blobs anneal',
  'B3/S12345': 'Maze: grows corridors',
  'B1357/S1357': 'Replicator: every pattern copies itself',
  'B35678/S5678': 'Diamoeba: diamond-shaped amoebas',
  'B368/S245': 'Morley: rich in spaceships',
  'B3/S012345678': 'Life without death: nothing ever dies',
  'B36/S125': '2×2: patterns built from 2×2 blocks',
};

export function mountLab() {
  const root = document.querySelector<HTMLElement>('[data-lab]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;

  const canvas = $<HTMLCanvasElement>('[data-lab-board]');
  const ctx = canvas.getContext('2d')!;
  const W = 160, H = 100;
  const board = new Board(W, H);
  let cell = 6;
  let running = false;
  let speed = 15;
  let raf = 0, last = 0, acc = 0;
  let ruleCode = 'B3/S23';

  const fit = () => {
    const box = canvas.parentElement!.clientWidth;
    cell = box >= W * 4 ? Math.floor(box / W) : box / W; // whole pixels when there's room, fractional on phones
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * cell * dpr);
    canvas.height = Math.round(H * cell * dpr);
    canvas.style.width = `${W * cell}px`;
    canvas.style.height = `${H * cell}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };
  const draw = () => {
    board.draw(ctx, cell);
    $('[data-lab-gen]').textContent = String(board.gen);
    $('[data-lab-pop]').textContent = String(board.population());
  };

  const setRule = (code: string, fromInput = false) => {
    const r = parseRule(code);
    if (!r) return void $<HTMLInputElement>('[data-lab-code]').classList.add('is-bad');
    ruleCode = r.code;
    board.setRule(r.birth, r.survive);
    $<HTMLInputElement>('[data-lab-code]').classList.remove('is-bad');
    if (!fromInput) $<HTMLInputElement>('[data-lab-code]').value = r.code;
    root.querySelectorAll<HTMLButtonElement>('[data-bit]').forEach((b) => {
      const set = b.dataset.bit === 'b' ? r.birth : r.survive;
      b.setAttribute('aria-pressed', String(set.includes(Number(b.dataset.n))));
    });
    $('[data-lab-rulename]').textContent = NAMES[r.code] ?? 'Uncharted. You may be the first to look.';
  };

  const play = (on = !running) => {
    running = on;
    $('[data-lab-play]').textContent = running ? '❚❚ pause' : '▶ run';
    cancelAnimationFrame(raf);
    if (!running) return;
    last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      acc += ((now - last) / 1000) * speed;
      last = now;
      let n = 0;
      while (acc >= 1 && n++ < 4) board.step(), (acc -= 1);
      if (n) draw();
    };
    raf = requestAnimationFrame(tick);
  };

  const dropPattern = (cells: Array<[number, number]>, w: number, h: number) => {
    board.place(cells, Math.floor((W - w) / 2), Math.floor((H - h) / 2));
    draw();
  };

  // ── drawing ──
  let paint: 0 | 1 | null = null;
  const cellAt = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return [Math.floor(((e.clientX - r.left) / r.width) * W), Math.floor(((e.clientY - r.top) / r.height) * H)] as const;
  };
  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = cellAt(e);
    paint = board.get(x, y) ? 0 : 1;
    board.set(x, y, paint);
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (paint === null) return;
    const [x, y] = cellAt(e);
    board.set(x, y, paint);
    draw();
  });
  canvas.addEventListener('pointerup', () => (paint = null));

  // ── controls ──
  $('[data-lab-play]').addEventListener('click', () => play());
  $('[data-lab-step]').addEventListener('click', () => (play(false), board.step(), draw()));
  $('[data-lab-random]').addEventListener('click', () => (board.randomize(0.28), draw()));
  $('[data-lab-clear]').addEventListener('click', () => (board.clear(), draw()));
  $<HTMLInputElement>('[data-lab-speed]').addEventListener('input', (e) => (speed = Number((e.target as HTMLInputElement).value)));
  root.querySelectorAll<HTMLButtonElement>('[data-bit]').forEach((b) =>
    b.addEventListener('click', () => {
      const r = parseRule(ruleCode)!;
      const key = b.dataset.bit === 'b' ? 'birth' : 'survive';
      const n = Number(b.dataset.n);
      const set = new Set(r[key]);
      set.has(n) ? set.delete(n) : set.add(n);
      r[key] = [...set].sort();
      setRule(`B${r.birth.join('')}/S${r.survive.join('')}`);
    }),
  );
  $<HTMLInputElement>('[data-lab-code]').addEventListener('input', (e) => setRule((e.target as HTMLInputElement).value, true));
  $<HTMLSelectElement>('[data-lab-preset]').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v) setRule(v);
  });
  root.querySelectorAll<HTMLButtonElement>('[data-lab-lib]').forEach((b) =>
    b.addEventListener('click', () => {
      const item = LIBRARY[Number(b.dataset.labLib)];
      const p = parseRle(item.rle)!;
      if (item.name === 'Replicator') setRule('B36/S23');
      dropPattern(p.cells, p.w, p.h);
      $('[data-lab-note]').textContent = `${item.name}: ${item.note}`;
    }),
  );
  const rleBox = $<HTMLTextAreaElement>('[data-lab-rle]');
  $('[data-lab-import]').addEventListener('click', () => {
    const p = parseRle(rleBox.value);
    if (!p) return toast('Could not read that RLE.');
    if (p.w > W || p.h > H) return toast(`Pattern is ${p.w}×${p.h}; the board is ${W}×${H}.`);
    if (p.rule) setRule(p.rule);
    board.clear();
    dropPattern(p.cells, p.w, p.h);
  });
  const current = () => {
    const c = board.crop();
    return c ? toRle({ ...c, rule: ruleCode }) : null;
  };
  $('[data-lab-export]').addEventListener('click', () => {
    rleBox.value = current() ?? '';
    if (!rleBox.value) toast('The board is empty.');
  });
  $('[data-lab-share]').addEventListener('click', async () => {
    const rle = current();
    const url = `${location.origin}/lab/#rule=${encodeURIComponent(ruleCode)}${rle ? `&rle=${encodeURIComponent(rle.split('\n').slice(1).join(''))}` : ''}`;
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      toast('Share link copied. It encodes the rule and the pattern.');
    } catch {
      toast('Link is in the address bar. Copy it from there.');
    }
  });
  $('[data-lab-png]').addEventListener('click', () => {
    canvas.toBlob((b) => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `gpojani-lab-${ruleCode.replace('/', '')}-gen${board.gen}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  });

  // keyboard: space = play/pause, . = step (only while the lab is on screen)
  let family = 'discrete';
  addEventListener('lab:family', (e) => (family = (e as CustomEvent).detail));
  const onKey = (e: KeyboardEvent) => {
    if (family !== 'discrete' || !document.body.contains(root) || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return;
    if (e.key === ' ') e.preventDefault(), play();
    if (e.key === '.') play(false), board.step(), draw();
  };
  addEventListener('keydown', onKey);
  document.addEventListener('astro:before-swap', () => (play(false), removeEventListener('keydown', onKey)), { once: true });

  // ── initial state: from the share link, else a gun ──
  const params = new URLSearchParams(location.hash.slice(1));
  setRule(params.get('rule') ?? 'B3/S23');
  const shared = params.get('rle') && parseRle(params.get('rle')!);
  const initial = shared || parseRle(LIBRARY.find((l) => l.name === 'Gosper glider gun')!.rle)!;
  board.place(initial.cells, Math.floor((W - initial.w) / 2), Math.floor((H - initial.h) / 3));
  new ResizeObserver(fit).observe(canvas.parentElement!);
  fit();
}
