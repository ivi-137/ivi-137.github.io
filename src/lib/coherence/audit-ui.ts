/**
 * The audit as a page element: paste a draft, read the ledger of this notebook.
 */
import { audit, coherent, type Finding, type Style } from './audit';
import { chip, shell } from './figures';

const CARELESS = `---
title: The Hidden Power Of Attention
date: 2026-09-26
description: A deep dive into transformers — and why they sometimes lose the thread
concepts: [transformers]
class: NP
---
# Introduction

Transformers are remarkable! 🚀 Their behavior surprises — each weight $\\alpha_{ij}$ is normalized over the whole context.

<div data-attention data-caption="Attention explorer"></div>

This builds on [gliders](/posts/gliders-are-messages), which also showed emergent behavior.

### Conclusion

In summary, attention is all you need.
`;

const KIND: Record<string, string> = { G: 'always', F: 'eventually', L: 'last', S: 'shape' };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function mountAudit(host: HTMLElement) {
  const style = JSON.parse(host.dataset.style ?? '{"of":0,"support":{}}') as Style;
  const self = host.dataset.self ?? '';
  let sources: Record<string, string> = {};
  try {
    sources = JSON.parse(host.querySelector('[data-sources]')?.textContent ?? '{}');
  } catch {}
  const { stage, bar } = shell(host, 'audit');
  stage.innerHTML = `
    <div class="ca">
      <textarea class="ca__text mono" spellcheck="false" aria-label="Draft to audit"></textarea>
      <div class="ca__side">
        <div class="ca__trace" aria-hidden="true"></div>
        <p class="ca__verdict mono"></p>
        <ol class="ca__list mono"></ol>
      </div>
    </div>`;
  const ta = stage.querySelector<HTMLTextAreaElement>('textarea')!;
  const list = stage.querySelector<HTMLElement>('.ca__list')!;
  const verdict = stage.querySelector<HTMLElement>('.ca__verdict')!;
  const trace = stage.querySelector<HTMLElement>('.ca__trace')!;

  const row = (f: Finding) => {
    const mark = f.verdict === 'kept' ? '✓' : f.verdict === 'owed' ? '?' : '✗';
    const need = f.required ? 'owed' : 'habit';
    const where = f.verdict === 'kept' ? '' : f.line ? ` · line ${f.line}` : ' · at the end';
    return `<li class="is-${f.verdict} ${f.required ? 'is-required' : ''}" data-line="${f.line ?? ''}">
      <span class="ca__mark">${mark}</span>
      <span class="ca__kind" title="${KIND[f.kind]}">${f.kind}</span>
      <span class="ca__label">${esc(f.label)}<small>${need}: kept by ${f.support} of ${f.of} posts${where}${f.detail && f.verdict !== 'kept' ? ` · ${esc(f.detail)}` : ''}</small></span>
    </li>`;
  };

  const run = () => {
    const src = ta.value;
    const res = audit(src, style);
    list.innerHTML = res.map(row).join('');
    const broken = res.filter((f) => f.required && f.verdict !== 'kept').length;
    verdict.textContent = coherent(res) ? `coherent: every owed rule kept (${res.length} monitors, one pass)` : `${broken} owed rule${broken === 1 ? '' : 's'} broken or unpaid`;
    verdict.classList.toggle('is-bad', !coherent(res));
    // the draft as a trace: one tick per line, marks where a monitor fired
    const n = Math.max(1, src.split('\n').length);
    const marks = res.filter((f) => f.verdict !== 'kept').map((f) => ({ at: f.line ? (f.line - 1) / n : 1, f }));
    trace.innerHTML = `<span class="ca__line"></span>${marks.map((m) => `<span class="ca__tick is-${m.f.kind}" style="left:${(m.at * 100).toFixed(1)}%" title="${esc(m.f.label)}"></span>`).join('')}<span class="ca__end">end</span>`;
  };

  let t = 0;
  ta.addEventListener('input', () => {
    clearTimeout(t);
    t = window.setTimeout(run, 120);
  });
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-line]');
    const line = Number(li?.dataset.line);
    if (!line) return;
    const lines = ta.value.split('\n');
    const start = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
    ta.focus();
    ta.setSelectionRange(start, start + lines[line - 1].length);
  });
  const load = (s: string) => {
    ta.value = s;
    ta.scrollTop = 0;
    run();
  };
  chip(bar, 'a careless draft', () => load(CARELESS));
  if (sources[self]) chip(bar, 'this post', () => load(sources[self]));
  if (sources['rule-137']) chip(bar, 'Rule 137', () => load(sources['rule-137']));
  chip(bar, 'clear', () => load(''));
  load(CARELESS);
}
