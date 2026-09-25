/**
 * gsh — a small shell over the archive. The filesystem is derived from the
 * search index: /posts/*.md, /classes/<ID>/, and a few pages you can `open`.
 * Output is built with DOM nodes (never innerHTML), so post text is inert.
 */
import { loadIndex, search, type Doc } from './search';
import { go, life, openDialog } from './nav';
import { RULES } from '../life/engine';
import { CLASSES } from '../classes';
import { hilbert } from '../curves';

type Out = { text: (s: string, cls?: string) => void; link: (label: string, url: string) => void; line: (...parts: Array<string | Node>) => void };
type Cmd = { run: (args: string[], out: Out) => void | Promise<void>; man: string };

const HOST = 'gianni@gpojani';
const PAGES: Record<string, string> = { lab: '/lab/', atlas: '/atlas/', network: '/network/', unveiled: '/unveiled/', logic: '/logic/', drums: '/drums/', zoo: '/archive/', about: '/about/', home: '/' };
const README = `gpojani.me: a specimen archive.
Everything here is either a transmission (posts/), a taxonomy (classes/)
or an instrument (lab, atlas, network). Try: ls posts, cat posts/<name>.md,
grep glider, rule 110, life rule B36/S23, neofetch.`;
const FORTUNES = [
  'Complexity is what you get when simple rules are left alone for long enough.',
  'Every program is a very patient glider gun.',
  'If P = NP, the proof would be easy to check. Nobody has found it.',
  'Randomness is just order you have not computed yet.',
  'A still life is a pattern that has made peace with its neighbours.',
  'The halting problem is not a bug. It is the price of being able to compute anything.',
  'Emergence: when the whole starts doing things none of the parts were told to.',
  'Rule 30 has no memory of being simple.',
  'Every sufficiently advanced automaton is indistinguishable from weather.',
  'To simulate the universe, you need a computer at least as large as the universe. Start small.',
  'Two neighbours: survive. Three: be born. Four: overcrowding. Choose your friends.',
  'An alien civilisation would recognise Rule 110 before it recognised us.',
];

let cwd = '/';
const history: string[] = [];
let hIdx = 0;

async function fs() {
  const docs = await loadIndex();
  return { docs, byFile: new Map(docs.map((d) => [`${d.id}.md`, d])) };
}

function resolve(path = '.'): string {
  const parts = (path.startsWith('/') ? path : `${cwd}/${path}`).split('/');
  const stack: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') stack.pop();
    else if (p === '~') stack.length = 0;
    else stack.push(p);
  }
  return '/' + stack.join('/');
}

async function list(dir: string): Promise<string[] | null> {
  const { docs } = await fs();
  if (dir === '/') return ['README', 'posts/', 'classes/', ...Object.keys(PAGES).filter((p) => p !== 'home')];
  if (dir === '/posts') return docs.map((d) => `${d.id}.md`);
  if (dir === '/classes') return CLASSES.map((c) => `${c.id}/`);
  const m = dir.match(/^\/classes\/([A-Z]+)$/);
  if (m && CLASSES.some((c) => c.id === m[1])) return docs.filter((d) => d.class === m[1]).map((d) => `${d.id}.md`);
  return null;
}

async function docAt(path: string): Promise<Doc | undefined> {
  const { byFile } = await fs();
  const name = path.split('/').pop() ?? '';
  return /^\/(posts|classes\/[A-Z]+)\/[^/]+\.md$/.test(path) ? byFile.get(name) : undefined;
}

function eca(rule: number, width = 63, rows = 24) {
  let row = new Uint8Array(width);
  row[width >> 1] = 1;
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    lines.push([...row].map((v) => (v ? '█' : ' ')).join(''));
    const next = new Uint8Array(width);
    for (let i = 0; i < width; i++) next[i] = (rule >> ((row[(i - 1 + width) % width] << 2) | (row[i] << 1) | row[(i + 1) % width])) & 1;
    row = next;
  }
  return lines.join('\n');
}

const COMMANDS: Record<string, Cmd> = {
  help: {
    man: 'list commands',
    run: (_, o) => {
      o.text('Commands:');
      for (const [k, c] of Object.entries(COMMANDS).filter(([k]) => !HIDDEN.has(k))) o.text(`  ${k.padEnd(10)} ${c.man}`, 'dim');
      o.text('Tab completes, ↑↓ walks history, Ctrl+L clears, Esc closes.', 'dim');
    },
  },
  man: {
    man: 'manual for a command: man <cmd>',
    run: ([c], o) => {
      if (!c) return o.text('What manual page do you want?');
      const cmd = COMMANDS[c];
      o.text(cmd ? `${c.toUpperCase()}(1)\n\n    ${c} — ${cmd.man}` : `No manual entry for ${c}`);
    },
  },
  ls: {
    man: 'list directory: ls [-l] [path]',
    run: async (args, o) => {
      const long = args.includes('-l');
      const target = resolve(args.find((a) => !a.startsWith('-')) ?? '.');
      const entries = await list(target);
      if (!entries) return o.text(`ls: cannot access '${target}': No such file or directory`, 'err');
      if (!long) return o.text(entries.join('   '));
      const { byFile } = await fs();
      for (const e of entries) {
        const d = byFile.get(e);
        o.text(d ? `-r--r--r--  ${d.class.padEnd(6)} ${d.date}  ${e}` : `dr-xr-xr-x  ${''.padEnd(6)} ${''.padEnd(10)}  ${e}`, d ? '' : 'dir');
      }
    },
  },
  cd: {
    man: 'change directory: cd <path>',
    run: async ([p = '/'], o) => {
      const target = resolve(p);
      if ((await list(target)) === null) return o.text(`cd: ${p}: No such file or directory`, 'err');
      cwd = target;
    },
  },
  pwd: { man: 'print working directory', run: (_, o) => o.text(cwd) },
  cat: {
    man: 'print a file: cat posts/<name>.md',
    run: async ([p], o) => {
      if (!p) return o.text('cat: missing operand', 'err');
      const path = resolve(p);
      if (path === '/README') return o.text(README);
      const d = await docAt(path);
      if (!d) return o.text(`cat: ${p}: No such file`, 'err');
      o.text(`# ${d.title}\n${d.n} · ${d.date} · class ${d.class}\n`, 'hi');
      o.text(d.description + '\n');
      o.text(d.text.slice(0, 900) + (d.text.length > 900 ? ' […]' : ''));
      o.line('→ ', link(`open ${d.url}`, d.url));
    },
  },
  less: { man: 'alias for cat', run: (a, o) => COMMANDS.cat.run(a, o) },
  open: {
    man: 'open a post, page or URL: open lab | open posts/<name>.md',
    run: async ([p], o) => {
      if (!p) return o.text('open: what?', 'err');
      if (PAGES[p]) return close(), go(PAGES[p]);
      if (p.startsWith('/') && !p.endsWith('.md') && !(await list(resolve(p)))) return close(), go(p);
      const d = await docAt(resolve(p));
      if (d) return close(), go(d.url);
      o.text(`open: ${p}: nothing to open`, 'err');
    },
  },
  grep: {
    man: 'full-text search: grep <words>',
    run: async (args, o) => {
      const q = args.filter((a) => !a.startsWith('-')).join(' ');
      if (!q) return o.text('usage: grep <words>', 'err');
      const hits = await search(q, 12);
      if (!hits.length) return o.text('(no matches)', 'dim');
      for (const h of hits) o.line(link(`posts/${h.doc.id}.md`, h.doc.url), `: ${h.snippet}`);
    },
  },
  find: { man: 'alias for grep', run: (a, o) => COMMANDS.grep.run(a, o) },
  tree: {
    man: 'show the archive as a tree',
    run: async (_, o) => {
      o.text('.');
      o.text('├── README');
      o.text('├── classes/');
      for (const [i, c] of CLASSES.entries()) {
        const posts = (await list(`/classes/${c.id}`)) ?? [];
        o.text(`│   ${i === CLASSES.length - 1 ? '└──' : '├──'} ${c.id}/ (${posts.length})`);
      }
      const posts = (await list('/posts')) ?? [];
      o.text('└── posts/');
      posts.forEach((p, i) => o.text(`    ${i === posts.length - 1 ? '└──' : '├──'} ${p}`));
    },
  },
  rule: {
    man: 'draw an elementary automaton from one cell: rule <0-255>',
    run: ([n], o) => {
      const r = Number(n);
      if (!Number.isInteger(r) || r < 0 || r > 255) return o.text('usage: rule <0-255>   (try 30, 90, 110, 137)', 'err');
      const screen = document.querySelector<HTMLElement>('[data-term-screen]');
      const charW = 13 * 0.62; // JetBrains Mono advance at 13px
      const width = Math.max(15, Math.min(95, Math.floor(((screen?.clientWidth ?? 600) - 40) / charW))) | 1;
      o.text(`rule ${r} = ${r.toString(2).padStart(8, '0')}`, 'hi');
      o.text(eca(r, width, 22), 'ca');
    },
  },
  life: {
    man: 'drive the background colony: life [status|pause|play|reseed|glider|gun|rule <B../S..|1-4>]',
    run: ([sub = 'status', arg], o) => {
      const l = life();
      if (!l) return o.text('life: no colony (WebGL2 unavailable)', 'err');
      const cx = innerWidth / 2, cy = innerHeight / 2;
      switch (sub) {
        case 'status':
          return o.text(`gen ${l.generation} · rule ${l.rule.code} (${l.rule.name}) · ${l.running ? 'running' : 'paused'}`);
        case 'pause':
          return l.toggle(false), o.text('colony paused');
        case 'play':
          return l.toggle(true), o.text('colony running');
        case 'reseed':
          return l.seed(), o.text('reseeded');
        case 'glider':
          return l.dropAt(cx, cy, 'glider'), o.text('glider launched from the centre of the screen');
        case 'gun':
          return l.dropAt(cx, cy, 'gun'), o.text('Gosper gun planted; period 30');
        case 'rule': {
          if (!arg) return o.text(RULES.map((r, i) => `  ${i + 1}  ${r.code.padEnd(14)} ${r.name}`).join('\n'));
          if (/^[1-4]$/.test(arg)) return l.setRule(Number(arg) - 1), o.text(`rule → ${l.rule.code}`);
          return l.setRuleCode(arg) ? o.text(`rule → ${l.rule.code} (${l.rule.name})`) : o.text(`life: bad rule '${arg}', expected e.g. B3/S23`, 'err');
        }
        default:
          o.text(COMMANDS.life.man, 'err');
      }
    },
  },
  seed: {
    man: 'write text into the colony: seed <text>',
    run: (args, o) => {
      const t = args.join(' ').slice(0, 12);
      if (!t) return o.text('usage: seed <text>', 'err');
      life()?.seed(t);
      o.text(`seeded "${t}"; watch it come apart`);
    },
  },
  neofetch: {
    man: 'system information',
    run: async (_, o) => {
      const l = life();
      const { docs } = await fs();
      const art = ['  ░█░  ', '  ░░█  ', '  ███  ', '       ', ' ░▒▓█▓▒ ', '       ', '       ', '       '];
      const info = [
        HOST,
        '─'.repeat(HOST.length),
        'OS: gpojani.me (Astro, static)',
        `Kernel: WebGL2 · ${l?.rule.code ?? 'n/a'}`,
        `Uptime: ${l?.generation ?? 0} generations`,
        'Shell: gsh 0.137',
        `Display: ${innerWidth}×${innerHeight} · ${devicePixelRatio}x`,
        `Archive: ${docs.length} transmissions`,
      ];
      o.text(info.map((l, i) => `${art[i] ?? '       '}  ${l}`).join('\n'), 'hi');
    },
  },
  homeostat: {
    man: 'the Ashby loop between you and the colony: homeostat [on|off]',
    run: ([arg], o) => {
      const h = (window as any).__homeostat;
      if (!h) return o.text('homeostat: no colony', 'err');
      if (arg === 'on' || arg === 'off') h.toggle(arg === 'on');
      const r = h.history[h.history.length - 1];
      o.text(`homeostat ${h.on ? 'ON' : 'OFF'}`, 'hi');
      if (r) o.text(`  H_you    ${r.you.toFixed(3)}   (your input variety)\n  target   ${r.target.toFixed(3)}\n  H_colony ${r.colony.toFixed(3)}   (block entropy)\n  tempo    ×${r.tempo.toFixed(2)}`);
      o.text('Requisite variety: only variety can absorb variety. (Ashby, 1956)', 'dim');
    },
  },
  K: {
    man: 'upper bounds on Kolmogorov complexity: K <text>',
    run: async (args, o) => {
      const s = args.join(' ');
      if (!s) return o.text('usage: K <text>', 'err');
      const bytes = new TextEncoder().encode(s);
      const z = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
      o.text(`|s|         ${bytes.length * 8} bits`);
      o.text(`deflate(s)  ${z.byteLength * 8} bits`);
      o.text(`K(s) ≤ min(|s|, deflate(s)) + O(1). The exact value is uncomputable.`, 'dim');
    },
  },
  hilbert: {
    man: 'draw a Hilbert curve: hilbert <1-5>',
    run: ([n = '3'], o) => {
      const k = Math.max(1, Math.min(5, Number(n) || 3));
      const size = 2 ** k;
      const grid = Array.from({ length: size * 2 - 1 }, () => Array(size * 2 - 1).fill(' '));
      let prev = hilbert(k, 0);
      grid[prev[1] * 2][prev[0] * 2] = '●';
      for (let d = 1; d < size * size; d++) {
        const p = hilbert(k, d);
        grid[prev[1] + p[1]][prev[0] + p[0]] = p[0] === prev[0] ? '│' : '─';
        grid[p[1] * 2][p[0] * 2] = d === size * size - 1 ? '●' : '┼';
        prev = p;
      }
      o.text(grid.map((r) => r.join('')).join('\n'), 'ca');
      o.text(`order ${k}: ${size * size} cells, one thread. As k → ∞ the image fills the square (D_H = 2).`, 'dim');
    },
  },
  omega: {
    man: "Chaitin's halting probability",
    run: (_, o) => {
      o.text('Ω = Σ 2^(−|p|) over every program p that halts.', 'hi');
      o.text('A real number in (0, 1). Its bits are algorithmically random, and the first n of them would decide the\nhalting problem for all programs up to length n. It can be approximated from below, forever, never known.');
    },
  },
  rice: {
    man: "Rice's theorem",
    run: (_, o) => o.text('Every non-trivial semantic property of programs is undecidable. (H. G. Rice, 1953)'),
  },
  whoami: { man: 'who are you', run: (_, o) => o.text('a reader. or a glider. hard to tell from here.') },
  uname: { man: 'kernel name', run: (_, o) => o.text('gpojani 0.137.0 #110 SMP PREEMPT WebGL2 x86_64 GNU/Automaton') },
  date: { man: 'print the date', run: (_, o) => o.text(new Date().toString()) },
  echo: { man: 'print arguments', run: (a, o) => o.text(a.join(' ')) },
  fortune: { man: 'an aphorism', run: (_, o) => o.text(FORTUNES[(Math.random() * FORTUNES.length) | 0]) },
  history: { man: 'command history', run: (_, o) => o.text(history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join('\n') || '(empty)') },
  clear: { man: 'clear the screen', run: () => void (outEl().textContent = '') },
  chat: { man: 'open the live channel', run: () => void (close(), window.dispatchEvent(new Event('chat:open'))) },
  search: { man: 'open the search palette', run: () => void (close(), window.dispatchEvent(new Event('palette:open'))) },
  exit: { man: 'close the terminal', run: () => close() },
  // easter eggs
  sudo: { man: '', run: (_, o) => o.text(`${HOST.split('@')[0]} is not in the sudoers file. This incident will be reported to the colony.`, 'err') },
  rm: { man: '', run: (_, o) => o.text('rm: cannot remove: this is an append-only universe', 'err') },
  vim: { man: '', run: (_, o) => o.text('You are now trapped in vim. (Kidding. This shell has no editors, only automata.)') },
  emacs: { man: '', run: (_, o) => o.text('emacs: a fine operating system, lacking only a good cellular automaton. Try `life`.') },
  ping: { man: '', run: (_, o) => o.text(`pong from generation ${life()?.generation ?? 0}`) },
  hello: { man: '', run: (_, o) => o.text('hello, colony.') },
};
const HIDDEN = new Set(['sudo', 'rm', 'vim', 'emacs', 'ping', 'hello', 'less', 'find']);

// ── UI ─────────────────────────────────────────────────────────────────────

const outEl = () => document.querySelector<HTMLElement>('[data-term-out]')!;
const close = () => document.querySelector<HTMLDialogElement>('[data-term]')?.close();

function link(label: string, url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.textContent = label;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    close();
    go(url);
  });
  return a;
}

function makeOut(): Out {
  const host = outEl();
  const add = (el: HTMLElement) => {
    host.append(el);
    host.parentElement!.scrollTop = host.parentElement!.scrollHeight;
  };
  return {
    text(s, cls = '') {
      const p = document.createElement('pre');
      p.className = `term__out ${cls}`;
      p.textContent = s;
      add(p);
    },
    link(label, url) {
      const p = document.createElement('pre');
      p.className = 'term__out';
      p.append(link(label, url));
      add(p);
    },
    line(...parts) {
      const p = document.createElement('pre');
      p.className = 'term__out';
      p.append(...parts);
      add(p);
    },
  };
}

const promptText = () => `${HOST}:${cwd === '/' ? '~' : '~' + cwd}$`;

async function complete(input: HTMLInputElement) {
  const v = input.value;
  const parts = v.split(' ');
  const last = parts[parts.length - 1];
  let candidates: string[];
  if (parts.length === 1) candidates = Object.keys(COMMANDS).filter((c) => !HIDDEN.has(c));
  else if (parts[0] === 'open') candidates = [...Object.keys(PAGES), ...(((await list('/posts')) ?? []).map((p) => `posts/${p}`))];
  else {
    const slash = last.lastIndexOf('/');
    const dirPart = slash >= 0 ? last.slice(0, slash + 1) : '';
    const entries = (await list(resolve(dirPart || '.'))) ?? [];
    candidates = entries.map((e) => dirPart + e);
  }
  const matches = candidates.filter((c) => c.startsWith(last));
  if (matches.length === 1) parts[parts.length - 1] = matches[0] + (matches[0].endsWith('/') ? '' : ' ');
  else if (matches.length > 1) {
    makeOut().text(matches.join('   '), 'dim');
    let pre = matches[0];
    for (const m of matches) while (!m.startsWith(pre)) pre = pre.slice(0, -1);
    parts[parts.length - 1] = pre;
  }
  input.value = parts.join(' ');
}

export function mountTerminal() {
  const dlg = document.querySelector<HTMLDialogElement>('[data-term]');
  if (!dlg || dlg.dataset.ready) return;
  dlg.dataset.ready = '1';
  const input = dlg.querySelector<HTMLInputElement>('[data-term-input]')!;
  const prompt = dlg.querySelector<HTMLElement>('[data-term-prompt]')!;
  prompt.textContent = promptText();
  const o = makeOut();
  o.text(`gsh 0.137 on gpojani.me. Type 'help', or try 'neofetch', 'rule 110', 'grep glider'.`, 'dim');

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const line = input.value.trim();
      input.value = '';
      o.line(Object.assign(document.createElement('span'), { className: 'term__prompt', textContent: promptText() + ' ' }), line);
      if (line) {
        history.push(line);
        hIdx = history.length;
        const [name, ...args] = line.split(/\s+/);
        const cmd = COMMANDS[name];
        if (cmd) await cmd.run(args, o);
        else o.text(`gsh: command not found: ${name}. Try 'help'.`, 'err');
      }
      prompt.textContent = promptText();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      hIdx = Math.max(0, hIdx - 1);
      input.value = history[hIdx] ?? '';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      hIdx = Math.min(history.length, hIdx + 1);
      input.value = history[hIdx] ?? '';
    } else if (e.key === 'Tab') {
      e.preventDefault();
      await complete(input);
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      outEl().textContent = '';
    } else if (e.key === 'c' && e.ctrlKey && !getSelection()?.toString()) {
      o.text(promptText() + ' ' + input.value + '^C', 'dim');
      input.value = '';
    }
  });
  dlg.querySelector('[data-term-close]')!.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
  dlg.querySelector('[data-term-screen]')!.addEventListener('click', () => {
    if (!getSelection()?.toString()) input.focus();
  });
}

export function openTerminal() {
  const dlg = openDialog('[data-term]');
  loadIndex();
  dlg?.querySelector<HTMLInputElement>('[data-term-input]')?.focus();
}
