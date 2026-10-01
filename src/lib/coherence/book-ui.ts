/**
 * The clerk's book as a page element: a prompt and an answer in, the Ledger's obligations as rows and the answer's
 * pieces as steps out, like a sequencer's grid. Red is where a monitor caught a break.
 *
 *   <div data-book data-caption="…"></div>
 *
 * The rules come from the clerk (read off the prompt's two examples) or, for the study's result files, from the file.
 */
import { book, coherent, audit, MARKERS, NUMBERED, pieceAt, pieces, readRules, SHAPE_NAME, splitPrompt, stateAt, type Row, type Rules } from './book';
import { PRESETS } from './book-presets';
import { chip, shell } from './figures';

const ROW = 22;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

interface Loaded {
  label: string;
  response: string;
  prompt?: string;
  rules?: Rules;
  n?: number;
  coherent?: boolean;
  tokens?: number;
}

/** Rows of a results file (pattern_eval.py) or a data file (pattern_data.py); anything else is skipped. */
function parseFile(text: string): Loaded[] {
  const out: Loaded[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof r.response !== 'string') continue;
    const prompt = typeof r.input === 'string' ? r.input : typeof r.prompt === 'string' ? r.prompt : undefined;
    const rules = r.rules && typeof r.rules === 'object' ? (r.rules as Rules) : undefined;
    if (!prompt && !(rules && typeof r.n === 'number')) continue;
    const who = r.variant ? `${r.variant}${r.seed != null ? ` s${r.seed}` : ''}` : (r.split as string) ?? 'row';
    const ctx = r.length != null ? ` · ${r.length} tokens of notes` : '';
    const ok = typeof r.coherent === 'boolean' ? r.coherent : undefined;
    out.push({
      label: `${who}${ctx} · ${(r.key as string) ?? `#${i + 1}`} · n=${r.n ?? '?'}${ok === undefined ? '' : ok ? ' · kept' : ' · broken'}`,
      response: r.response,
      prompt,
      rules,
      n: typeof r.n === 'number' ? r.n : undefined,
      coherent: ok,
      tokens: typeof r.tokens === 'number' ? r.tokens : undefined,
    });
  }
  return out;
}

function describe(r: Rules, n: number | null) {
  const m = MARKERS[r.marker];
  const parts = [
    `marker <b>${esc(r.marker < NUMBERED ? m.replace('1', 'n') : m)}</b>`,
    r.bold ? '<b>bold</b> leads' : '<b>plain</b> leads',
    r.lowercase ? '<b>all lowercase</b>' : '',
    r.tldr ? `<b>${esc(r.tldr)}</b> first` : '',
    r.sources ? `<b>${esc(r.sources)}</b> last` : '',
    r.signoff ? `sign-off <b>${esc(r.signoff)}</b>` : '',
    n != null ? `<b>${n}</b> items` : '<b>?</b> items (no number in the question)',
  ];
  return parts.filter(Boolean).join(' · ');
}

export function mountBook(host: HTMLElement) {
  const { fig, stage, bar } = shell(host, 'book');
  stage.innerHTML = `
    <div class="cb">
      <p class="cb__clerk mono"><span class="cb__who">clerk</span> <span data-rules></span></p>
      <div class="cb__grid">
        <ol class="cb__labels mono" data-labels></ol>
        <div class="cb__scroll" data-scroll><canvas tabindex="0" role="img"></canvas></div>
        <ol class="cb__state mono" data-state></ol>
      </div>
      <p class="cb__axis mono"><span data-where></span><span class="cb__key"><i class="k-owed"></i>owed <i class="k-kept"></i>kept or paid <i class="k-broken"></i>broken</span></p>
      <div class="cb__text mono" data-text aria-label="The answer, piece by piece"></div>
      <p class="cb__verdict mono" data-verdict></p>
      <details class="cb__edit">
        <summary class="mono">edit the prompt and the answer</summary>
        <div class="cb__fields">
          <label class="mono">prompt: two answers from the column, then a new question<textarea data-prompt spellcheck="false"></textarea></label>
          <label class="mono">answer<textarea data-answer spellcheck="false"></textarea></label>
        </div>
        <p class="cb__note mono">Pieces are cut the way byte-level tokenisers cut text before merging, so a long word may be two or three real tokens. Monitors judge complete lines; an item counts at its first letter and a summary is paid with its label, as in the Ledger's training labels.</p>
      </details>
    </div>`;
  const $ = <T extends HTMLElement>(sel: string) => stage.querySelector<T>(sel)!;
  const rulesEl = $('[data-rules]');
  const labels = $('[data-labels]');
  const states = $('[data-state]');
  const scroll = $('[data-scroll]');
  const cv = stage.querySelector('canvas')!;
  const where = $('[data-where]');
  const textEl = $('[data-text]');
  const verdict = $('[data-verdict]');
  const promptTa = $<HTMLTextAreaElement>('[data-prompt]');
  const answerTa = $<HTMLTextAreaElement>('[data-answer]');

  // the current answer
  let text = '';
  let rules: Rules = readRules([]);
  let n = 0;
  let rows: Row[] = [];
  let ends: number[] = [];
  let at = 0; // the playhead: index of the last piece written
  let pinned = 0;
  let base: HTMLCanvasElement | null = null;
  let cw = 4;
  let fromFile: Loaded | null = null;
  let spans: HTMLElement[] = [];

  const color = {
    paper: css('--paper') || '#ece5d3',
    acid: css('--acid') || '#c6ff3d',
    verm: css('--verm') || '#ff4b1f',
    ghost: css('--ghost') || '#7d8cff',
    voidc: css('--void') || '#0b0a08',
  };

  /** The tone of every row at every piece, and the pieces where something happened. */
  function paintBase() {
    const T = Math.max(1, ends.length);
    const width = scroll.clientWidth || 600;
    cw = Math.max(Math.min(14, width / T), Math.min(3, 12000 / T));
    const W = Math.max(width, Math.ceil(T * cw));
    const H = rows.length * ROW;
    const dpr = Math.min(2, devicePixelRatio || 1);
    base = document.createElement('canvas');
    base.width = Math.round(W * dpr);
    base.height = Math.round(H * dpr);
    const g = base.getContext('2d')!;
    g.scale(dpr, dpr);
    cv.width = base.width;
    cv.height = base.height;
    cv.style.width = `${W}px`;
    cv.style.height = `${H}px`;
    const fill = (c: string, a: number, x: number, y: number, w: number, h: number) => {
      g.globalAlpha = a;
      g.fillStyle = c;
      g.fillRect(x, y, w, h);
    };
    rows.forEach((row, ri) => {
      const y = ri * ROW;
      fill(color.paper, 0.04, 0, y + 1, T * cw, ROW - 2);
      const marks = new Map<number, (typeof row.events)[number]>();
      for (const e of row.events) marks.set(pieceAt(ends, e.at), e);
      let tone: 'quiet' | 'owed' | 'kept' | 'broken' = row.shape === 'G' ? 'quiet' : 'owed';
      let k = 0;
      for (let t = 0; t < T; t++) {
        const e = marks.get(t);
        if (e) {
          if (e.mark === 'break' || e.mark === 'over' || e.mark === 'unpaid' || e.mark === 'short') tone = 'broken';
          else if (tone !== 'broken') tone = 'kept';
          if (e.k !== undefined && e.mark !== 'short') k = e.k;
        }
        const x = t * cw;
        if (row.shape === 'N') {
          const h = (ROW - 4) * Math.min(1, k / Math.max(1, row.n ?? 1));
          if (tone === 'broken') fill(color.verm, 0.75, x, y + 2, cw, ROW - 4);
          else if (h) fill(color.acid, 0.45, x, y + ROW - 2 - h, cw, h);
        } else if (tone === 'owed') fill(color.ghost, 0.32, x, y + 4, cw, ROW - 8);
        else if (tone === 'kept') fill(color.acid, row.shape === 'G' ? 0.16 : 0.3, x, y + 4, cw, ROW - 8);
        else if (tone === 'broken') fill(color.verm, 0.55, x, y + 2, cw, ROW - 4);
        if (e) {
          // the moment itself: a full-height mark
          const bad = e.mark === 'break' || e.mark === 'over' || e.mark === 'unpaid' || e.mark === 'short';
          fill(bad ? color.verm : color.acid, 1, x + Math.max(0, cw / 2 - 1.5), y + 1, Math.min(3, Math.max(1.5, cw)), ROW - 2);
        }
      }
    });
    g.globalAlpha = 1;
  }

  function draw() {
    if (!base) return;
    const g = cv.getContext('2d')!;
    const dpr = cv.width / parseFloat(cv.style.width);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(base, 0, 0);
    g.scale(dpr, dpr);
    const W = parseFloat(cv.style.width);
    const H = parseFloat(cv.style.height);
    const x = (at + 1) * cw;
    g.globalAlpha = 0.62;
    g.fillStyle = color.voidc;
    if (ends.length) g.fillRect(x, 0, W - x, H); // not written yet
    g.globalAlpha = 1;
    g.fillStyle = color.paper;
    g.fillRect(Math.round(x) - 1, 0, 1.5, H);
  }

  function showState() {
    const upto = ends.length ? ends[at] : 0;
    const done = !ends.length || at === ends.length - 1;
    states.innerHTML = rows
      .map((r) => {
        const s = stateAt(r, upto, done);
        return `<li class="is-${s.tone}">${esc(s.text)}</li>`;
      })
      .join('');
    const line = text.slice(0, upto).split('\n').length;
    where.textContent = ends.length ? `piece ${at + 1} of ${ends.length} · line ${line}${fromFile?.tokens ? ` · ${fromFile.tokens} real tokens in this answer` : ''}` : 'nothing written';
    for (let t = 0; t < spans.length; t++) spans[t].classList.toggle('is-later', t > at);
    if (spans[at]) {
      spans.forEach((s) => s.classList.remove('is-here'));
      spans[at].classList.add('is-here');
    }
    // keep the playhead in view
    const x = (at + 1) * cw;
    if (x < scroll.scrollLeft + 20 || x > scroll.scrollLeft + scroll.clientWidth - 20) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 2);
    draw();
  }

  const setAt = (t: number) => {
    at = Math.max(0, Math.min(ends.length - 1, t));
    showState();
  };

  function render() {
    text = answerTa.value.replace(/\r\n?/g, '\n');
    let nn: number | null;
    if (fromFile?.rules && promptTa.disabled) {
      // a results file keeps the author's rules, not the prompt
      rules = fromFile.rules;
      nn = fromFile.n ?? null;
      rulesEl.innerHTML = `${describe(rules, nn)} <span class="cb__src">(the author's rules, from the file)</span>`;
    } else {
      const p = splitPrompt(promptTa.value);
      rules = readRules(p.examples.map(([, a]) => a));
      nn = p.n ?? fromFile?.n ?? null;
      const truth = fromFile?.rules;
      const agree = truth && (['marker', 'bold', 'lowercase', 'tldr', 'sources'] as const).every((k) => truth[k] === rules[k]) && (truth.signoff ?? '').toLowerCase() === (rules.signoff ?? '').toLowerCase();
      const note = truth ? (agree ? ', as the file says' : ': <b class="cb__differ">not what the file says</b>') : '';
      rulesEl.innerHTML = p.examples.length
        ? `${describe(rules, nn)} <span class="cb__src">(read off ${p.examples.length} example${p.examples.length === 1 ? '' : 's'}${note})</span>`
        : 'no examples in the prompt: write them as “Question: …” then “Answer:” and the answer';
    }
    n = nn ?? 0;
    rows = book(text, rules, n);
    ends = pieces(text);
    labels.innerHTML = rows
      .map((r) => `<li title="${esc(`${SHAPE_NAME[r.shape]}: ${r.owes}`)}"><span class="cb__shape is-${r.shape}">${r.shape}</span><span class="cb__name">${esc(r.label)}</span><small>${esc(r.owes)}</small></li>`)
      .join('');
    // the text: the piece where a monitor fired, the rest of the line it judged, the pieces that paid or counted
    const breaks = new Map<number, string[]>();
    const wrong = new Map<number, string[]>();
    const paid = new Set<number>();
    for (const r of rows)
      for (const e of r.events) {
        const t = pieceAt(ends, e.at);
        if (e.mark === 'break' || e.mark === 'over') {
          breaks.set(t, [...(breaks.get(t) ?? []), r.label]);
          // the line a monitor judged, up to the end of the line (an extra item: the whole item line)
          const stop = e.mark === 'over' ? text.indexOf('\n', e.at) : e.at;
          for (let u = pieceAt(ends, (e.from ?? e.at) + 1); u <= pieceAt(ends, stop < 0 ? text.length : stop); u++) if (u !== t) wrong.set(u, [...(wrong.get(u) ?? []), r.label]);
        }
        if (e.mark === 'paid' || e.mark === 'count') paid.add(t);
      }
    textEl.innerHTML = ends
      .map((e, t) => {
        const s = text.slice(t ? ends[t - 1] : 0, e);
        const b = breaks.get(t);
        const w = wrong.get(t);
        const cls = b ? 'is-break' : w ? 'is-wrong' : paid.has(t) ? 'is-paid' : '';
        const title = b ? `caught here: ${b.join(', ')}` : w ? `in the line ${w.join(', ')} judged` : '';
        return `<span data-t="${t}"${cls ? ` class="${cls}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${esc(s)}</span>`;
      })
      .join('');
    spans = [...textEl.querySelectorAll<HTMLElement>('span')];
    const v = audit(text, rules, n);
    const bad = rows.filter((r) => !r.ok);
    verdict.classList.toggle('is-bad', !coherent(v));
    verdict.textContent = coherent(v)
      ? `coherent: all ${rows.length} obligations kept`
      : `${bad.length} of ${rows.length} obligations broken: ${bad.map((r) => `${r.label} (${stateAt(r, text.length, true).text})`).join('; ')}`;
    cv.setAttribute('aria-label', `The clerk's book: ${rows.length} obligations over ${ends.length} pieces. ${verdict.textContent}`);
    paintBase();
    pinned = Math.max(0, ends.length - 1);
    setAt(pinned);
  }

  // ── writing it out, piece by piece ──
  let raf = 0;
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    play.textContent = '▶ write it out';
  };
  const play = chip(bar, '▶ write it out', () => {
    if (raf) return stop();
    const speed = Math.max(30, ends.length / 7); // pieces per second: at most about seven seconds
    const t0 = performance.now();
    play.textContent = '■ stop';
    const step = (now: number) => {
      const t = Math.floor(((now - t0) / 1000) * speed);
      setAt(t);
      if (t >= ends.length - 1) {
        pinned = ends.length - 1;
        return stop();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }, 'Move the playhead through the answer as it was written');

  // ── presets, files ──
  const load = (prompt: string, answer: string, file: Loaded | null = null) => {
    stop();
    fromFile = file;
    promptTa.value = prompt;
    answerTa.value = answer;
    promptTa.disabled = !!file?.rules && !file.prompt;
    if (promptTa.disabled) promptTa.value = '(not in a results file: the rules come from the file)';
    render();
  };
  const presetChips = PRESETS.map((p) => chip(bar, p.name, () => {
    presetChips.forEach((c) => c.setAttribute('aria-pressed', String(c === presetChips[PRESETS.indexOf(p)])));
    load(p.prompt, p.response);
  }, `${p.shows} (constructed by hand, not a model's output)`));

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.jsonl,.json,.txt';
  input.hidden = true;
  const select = document.createElement('select');
  select.className = 'cb__pick mono';
  select.hidden = true;
  select.setAttribute('aria-label', 'Answer from the loaded file');
  const status = document.createElement('span');
  let file: Loaded[] = [];
  const pick = (i: number) => {
    const r = file[i];
    if (!r) return;
    presetChips.forEach((c) => c.setAttribute('aria-pressed', 'false'));
    select.value = String(i);
    load(r.prompt ?? '', r.response, r);
  };
  const openFile = async (f: File) => {
    file = parseFile(await f.text());
    if (!file.length) {
      status.textContent = `${f.name}: no answers this view can read (it reads results-patterns/*.jsonl and data-patterns/*.jsonl)`;
      return;
    }
    const kept = file.filter((r) => r.coherent).length;
    const scored = file.filter((r) => r.coherent !== undefined).length;
    status.textContent = `${f.name}: ${file.length} answers${scored ? `, ${((100 * kept) / scored).toFixed(1)}% coherent` : ''}`;
    select.innerHTML = file.map((r, i) => `<option value="${i}">${esc(r.label)}</option>`).join('');
    select.hidden = false;
    prev.hidden = next.hidden = false;
    pick(Math.max(0, file.findIndex((r) => r.coherent === false)));
  };
  input.addEventListener('change', () => input.files?.[0] && openFile(input.files[0]));
  select.addEventListener('change', () => pick(Number(select.value)));
  chip(bar, 'load results…', () => input.click(), 'A results file of the study (results-patterns/*.jsonl) or its data (data-patterns/*.jsonl); it stays in your browser');
  const prev = chip(bar, '‹', () => pick(Number(select.value) - 1), 'Previous answer');
  bar.append(select);
  const next = chip(bar, '›', () => pick(Number(select.value) + 1), 'Next answer');
  prev.hidden = next.hidden = true;
  bar.append(input, status);
  fig.addEventListener('dragover', (e) => {
    e.preventDefault();
    fig.classList.add('is-drop');
  });
  fig.addEventListener('dragleave', () => fig.classList.remove('is-drop'));
  fig.addEventListener('drop', (e) => {
    e.preventDefault();
    fig.classList.remove('is-drop');
    const f = e.dataTransfer?.files?.[0];
    if (f) void openFile(f);
  });

  // ── the playhead follows the pointer; a click pins it ──
  const pieceOf = (e: PointerEvent) => Math.floor((e.clientX - cv.getBoundingClientRect().left) / cw);
  cv.addEventListener('pointermove', (e) => !raf && setAt(pieceOf(e)));
  cv.addEventListener('pointerleave', () => !raf && setAt(pinned));
  cv.addEventListener('click', (e) => {
    stop();
    pinned = pieceOf(e);
    setAt(pinned);
  });
  cv.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -20, PageDown: 20 }[e.key];
    if (step === undefined && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    stop();
    pinned = e.key === 'Home' ? 0 : e.key === 'End' ? ends.length - 1 : at + (e.shiftKey ? step! * 10 : step!);
    setAt(pinned);
  });
  textEl.addEventListener('click', (e) => {
    const t = Number((e.target as HTMLElement).closest<HTMLElement>('[data-t]')?.dataset.t);
    if (Number.isFinite(t)) {
      stop();
      pinned = t;
      setAt(t);
    }
  });

  let deb = 0;
  const edited = () => {
    clearTimeout(deb);
    deb = window.setTimeout(() => {
      presetChips.forEach((c) => c.setAttribute('aria-pressed', 'false'));
      render();
    }, 150);
  };
  promptTa.addEventListener('input', edited);
  answerTa.addEventListener('input', edited);
  let lastW = 0;
  new ResizeObserver(() => {
    if (Math.abs(scroll.clientWidth - lastW) < 2) return;
    lastW = scroll.clientWidth;
    paintBase();
    showState();
  }).observe(scroll);

  presetChips[1].setAttribute('aria-pressed', 'true');
  load(PRESETS[1].prompt, PRESETS[1].response);
}
