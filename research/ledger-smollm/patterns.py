"""
House patterns: implicit rules learned from examples, on a real model.

IFEval states its instructions. Here nothing is stated. A prompt shows two answers from the same column, then a new
question that asks for N items; the column's house pattern has to be read off the two examples and kept, unasked,
while the new answer is written. This is the toy's task (an author's house style, read from example posts) moved to
a pretrained model, with all five shapes of obligation in the paper's table:

  invariant    the list marker (8 styles, numbered ones counting 1, 2, 3, ...), bold leads or plain ones, all lowercase
  eventuality  a TL;DR line, a sources section, a sign-off
  order        the TL;DR line comes first; the sources come after the last item
  last         the sign-off is the last line; after the sources header only sources (and the sign-off) follow
  count        exactly N items, N read from the new question (the examples show other counts)

The Ledger's slots (spec interface shared with obligations.py): three invariants (the marker and bold slots also
carry a style class the clerk must read, like the toy's font), three eventualities, one count. Order and last have
no state of their own; the monitors check them, as in the toy.

A response is audited by exact monitors; each gives a verdict for the whole response and, for invariants, the index
of the first opportunity at which it broke (per-opportunity hazards, Proposition 2).
"""
import math
import random
import re

import numpy as np

from shapes import AT_LEAST, EXACTLY, F, G, LESS, N, numbers  # noqa: F401  (shared constants and number reader)

MARKERS = ['1.', '1)', '(1)', '#1', '-', '*', '•', '→']
NUMBERED = 4  # styles below this index carry the item's number
MARKER_PRIOR = [0.3] + [0.1] * 7  # '1.' is what the base model writes by itself: a model that stops reading drifts there
TLDR_LABELS = ['TL;DR:', 'In short:', 'Summary:', 'The gist:']
SOURCE_HEADERS = ['Sources:', 'Further reading:', 'References:']
SOURCE_TITLES = ["A Beginner's Guide to {T}", '{T}: Questions and Answers', 'The Little Book of {T}', 'Notes on {T}',
                 '{T} for Everyone', 'Getting Started with {T}', 'What I Learned About {T}', 'The {T} Handbook']
SIGNOFFS = {
    'train': ['— Ada', 'Cheers, Ben', '~ The Garden Desk', 'Yours, Clara', '— the Weekend Team', 'Stay curious, Mo.',
              'Until next time, Iris', '— R.', 'Best, Tom', '~ Luca'],
    'test': ['— Ines', 'Take care, Otto', '~ The Science Desk', 'Warmly, Priya', '— the Night Shift', 'Onwards, Leo'],
}
QUESTIONS = ['Give me {n} tips for {t}.', 'List {n} ideas about {t}.', 'What are {n} things to know about {t}?',
             'Name {n} ways to enjoy {t}.', 'Share {n} facts about {t}.', 'Suggest {n} ways to get better at {t}.']
NUM_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
             'thirteen', 'fourteen', 'fifteen', 'sixteen']
HEAD = 'Below are two answers from the same column, then a new question. Answer the new question the way the column always answers.'
BACKGROUND_HEAD = 'Background notes (not part of the column):\n'

# ── the Ledger's slots ────────────────────────────────────────────────────────────
SLOTS = [
    ('pattern:marker', G),
    ('pattern:bold', G),
    ('pattern:lowercase', G),
    ('pattern:tldr', F),
    ('pattern:sources', F),
    ('pattern:signoff', F),
    ('pattern:items', N),
]
K = len(SLOTS)
SLOT = {iid: i for i, (iid, _) in enumerate(SLOTS)}
SHAPE = np.array([s for _, s in SLOTS])
POINTER = np.array([iid == 'pattern:items' for iid, _ in SLOTS])  # N is written in the new question
STYLES = np.array([len(MARKERS), 2, 0, 0, 0, 0, 0])  # style classes per slot, read by the clerk (0: none)
SHAPE_OF_MONITOR = {'marker': 'invariant', 'bold': 'invariant', 'lowercase': 'invariant', 'tldr': 'eventuality',
                    'sources': 'eventuality', 'signoff': 'eventuality', 'tldr_first': 'order', 'sources_after': 'order',
                    'signoff_last': 'last', 'sources_only': 'last', 'items': 'count'}
MONITORS = list(SHAPE_OF_MONITOR)

ITEM = re.compile(r'^\s*(?:(\d+)\.|(\d+)\)|\((\d+)\)|#(\d+)|([-*•→]))[ \t]+(\S.*)$')
SOURCE = re.compile(r'^\s*\[\d+\]\s+\S')


def marker_text(style, k):
    return [f'{k}.', f'{k})', f'({k})', f'#{k}', '-', '*', '•', '→'][style]


def parse_item(line):
    """(style, number or None, text) if the line is a list item, else None."""
    m = ITEM.match(line)
    if not m:
        return None
    for g in range(4):
        if m.group(g + 1) is not None:
            return g, int(m.group(g + 1)), m.group(6)
    return 4 + '-*•→'.index(m.group(5)), None, m.group(6)


# ── an author: the column's house pattern ───────────────────────────────────────────────
def sample_rules(rng, split='train'):
    return {
        'marker': rng.choices(range(len(MARKERS)), MARKER_PRIOR)[0],
        'bold': int(rng.random() < 0.5),
        'lowercase': int(rng.random() < 0.15),
        'tldr': rng.choice(TLDR_LABELS) if rng.random() < 0.4 else None,
        'sources': rng.choice(SOURCE_HEADERS) if rng.random() < 0.35 else None,
        'signoff': rng.choice(SIGNOFFS[split]) if rng.random() < 0.5 else None,
    }


def obligations(rules, n):
    """(instruction_id_list, kwargs) in the form batching.make_example reads: the slots that apply to this answer."""
    ids, kws = ['pattern:marker', 'pattern:bold'], [{'style': rules['marker']}, {'style': rules['bold']}]
    if rules['lowercase']:
        ids.append('pattern:lowercase'), kws.append({})
    for key in ('tldr', 'sources', 'signoff'):
        if rules[key]:
            ids.append(f'pattern:{key}'), kws.append({'text': _case(rules[key], rules)})
    ids.append('pattern:items'), kws.append({'n': n})
    return ids, kws


def _case(s, rules):
    return s.lower() if rules['lowercase'] else s


# ── content: the base model's own answer to a plain question, cut into parts ──────────────────────
def split_lead(text):
    """(lead, body) of an item: '**X**: Y', 'X: Y' or 'X - Y' when the lead is short; else the first words."""
    text = text.strip()
    m = re.match(r'^\*\*(.+?)\*\*\s*[:\-–—]?\s*(.*)$', text)
    if m:
        return m.group(1).strip(' :'), m.group(2).strip()
    m = re.match(r'^([^:.!?]{2,60}?)\s*[:–—]\s+(.+)$', text)
    if m and len(m.group(1).split()) <= 7:
        return m.group(1).strip(), m.group(2).strip()
    words = text.split()
    k = min(len(words), 3 if len(words) > 6 else max(1, len(words) // 2))
    return ' '.join(words[:k]).strip(' ,;:'), ' '.join(words[k:]).strip()


def _clean(s, max_words=40):
    s = re.sub(r'\*+|`|#+\s', '', s).replace('\n', ' ')
    s = re.sub(r'\s+', ' ', s).strip()
    words = s.split()
    if len(words) > max_words:
        s = ' '.join(words[:max_words]).rstrip(',;:') + '.'
    return s


def parse_answer(text, n):
    """The base model's answer as {'intro', 'items': [(lead, body)]} with at least n items, or None."""
    lines = [l for l in text.split('\n') if l.strip()]
    items, intro = [], []
    for l in lines:
        it = parse_item(l)
        if it:
            lead, body = split_lead(it[2])
            lead, body = _clean(lead, 8), _clean(body)
            if lead:
                items.append((lead, body))
        elif not items:
            intro.append(l.strip())
    if len(items) < n:
        return None
    first = re.split(r'(?<=[.!?:])\s', ' '.join(intro).strip())[0] if intro else ''
    first = _clean(first, 30) if first and len(first.split()) <= 30 and not parse_item(first) else ''
    return {'intro': first, 'items': items[:n]}


def render(content, rules, topic, rng):
    """An answer written in the house pattern."""
    items = content['items']
    out = []
    if rules['tldr']:
        leads = [items[i][0] for i in range(min(3, len(items)))]
        leads = [leads[0]] + [x[:1].lower() + x[1:] for x in leads[1:]]
        gist = leads[0] if len(leads) == 1 else ', '.join(leads[:-1]) + ' and ' + leads[-1]
        out += [f'{rules["tldr"]} {gist.rstrip(".")}.', '']
    if content['intro']:
        out += [content['intro'], '']
    for k, (lead, body) in enumerate(items, 1):
        head = f'**{lead}**' if rules['bold'] else lead
        out.append(f'{marker_text(rules["marker"], k)} {head}: {body}' if body else f'{marker_text(rules["marker"], k)} {head}')
    if rules['sources']:
        T = topic[:1].upper() + topic[1:]
        titles = rng.sample(SOURCE_TITLES, 2)
        out += ['', rules['sources']] + [f'[{i}] ' + t.format(T=T) for i, t in enumerate(titles, 1)]
    if rules['signoff']:
        out += ['', rules['signoff']]
    text = '\n'.join(out)
    return text.lower() if rules['lowercase'] else text


def question(topic, n, rng):
    num = NUM_WORDS[n] if n < len(NUM_WORDS) and rng.random() < 0.3 else str(n)
    return rng.choice(QUESTIONS).format(n=num, t=topic)


def prompt_parts(examples, q):
    """The prompt as parts, so background notes can be put between the examples and the new question."""
    ex = '\n\n'.join(f'Question: {eq}\nAnswer:\n{ea}' for eq, ea in examples)
    return {'head': HEAD + '\n\n' + ex + '\n\n', 'question': f'Question: {q}\nAnswer:'}


def assemble(parts, background=''):
    bg = f'{BACKGROUND_HEAD}{background.strip()}\n\n' if background else ''
    return parts['head'] + bg + parts['question']


# ── monitors ─────────────────────────────────────────────────────────────────────────
def audit(text, rules, n):
    """Verdicts of every monitor that applies: {name: {'ok': bool, 'break_at': opportunity index or None,
    'opportunities': int}}. Invariants report where they first broke (0-based, over item lines or over lines)."""
    lines = text.split('\n')
    nonempty = [(i, l) for i, l in enumerate(lines) if l.strip()]
    kinds = []  # per non-empty line: 'item', 'tldr', 'sources', 'source', 'signoff', 'prose'
    tl = _case(rules['tldr'], rules) if rules['tldr'] else None
    sh = _case(rules['sources'], rules) if rules['sources'] else None
    so = _case(rules['signoff'], rules) if rules['signoff'] else None
    for _, l in nonempty:
        s = l.strip()
        if tl and s.startswith(tl):
            kinds.append('tldr')
        elif sh and s == sh:
            kinds.append('sources')
        elif so and s == so:
            kinds.append('signoff')
        elif SOURCE.match(s):
            kinds.append('source')
        elif parse_item(s):
            kinds.append('item')
        else:
            kinds.append('prose')
    items = [parse_item(l.strip()) for (_, l), k in zip(nonempty, kinds) if k == 'item']
    out = {}
    # invariants: per item line
    brk = next((j for j, (st, num, _) in enumerate(items) if st != rules['marker'] or (st < NUMBERED and num != j + 1)), None)
    out['marker'] = {'ok': brk is None, 'break_at': brk, 'opportunities': len(items)}
    bold = lambda body: body.startswith('**') and '**' in body[2:]
    brk = next((j for j, (_, _, body) in enumerate(items) if bold(body) != bool(rules['bold'])), None)
    out['bold'] = {'ok': brk is None, 'break_at': brk, 'opportunities': len(items)}
    if rules['lowercase']:
        brk = next((j for j, (_, l) in enumerate(nonempty) if re.search(r'[A-Z]', l)), None)
        out['lowercase'] = {'ok': brk is None, 'break_at': brk, 'opportunities': len(nonempty)}
    last_item = len(kinds) - 1 - kinds[::-1].index('item') if 'item' in kinds else -1
    if tl:
        at = kinds.index('tldr') if 'tldr' in kinds else None
        out['tldr'] = {'ok': at is not None}
        out['tldr_first'] = {'ok': at == 0}
    if sh:
        at = kinds.index('sources') if 'sources' in kinds else None
        out['sources'] = {'ok': at is not None and 'source' in kinds[at + 1 :]}
        out['sources_after'] = {'ok': at is not None and at > last_item}
        out['sources_only'] = {'ok': at is not None and all(k in ('source', 'signoff') for k in kinds[at + 1 :])}
    if so:
        at = kinds.index('signoff') if 'signoff' in kinds else None
        out['signoff'] = {'ok': at is not None}
        out['signoff_last'] = {'ok': at is not None and at == len(kinds) - 1}
    out['items'] = {'ok': len(items) == n, 'found': len(items)}
    return out


def coherent(verdicts):
    return all(v['ok'] for v in verdicts.values())


# ── labels for the Ledger's state ─────────────────────────────────────────────────────────
def milestones(iid, kw, text, prompt=None):
    """Sorted character positions (prefix lengths) at which the count gains an item or an eventuality is paid."""
    if iid == 'pattern:items':
        out, at = [], 0
        for line in text.split('\n'):
            m = ITEM.match(line)
            if m:
                out.append(at + m.start(6) + 1)  # an item counts once its marker and its first letter are written
            at += len(line) + 1
        return out
    if iid in ('pattern:tldr', 'pattern:sources', 'pattern:signoff'):
        s = kw['text']
        at, pos = 0, None
        for line in text.split('\n'):
            stripped = line.strip()
            ok = stripped.startswith(s) if iid == 'pattern:tldr' else stripped == s
            if ok:
                pos = at + line.index(s) + len(s)
                break
            at += len(line) + 1
        return [pos] if pos is not None else []
    return []


def token_targets(iid, kw, text, ends, prompt=None):
    ends = np.asarray(ends)
    marks = np.asarray(milestones(iid, kw, text, prompt), dtype=np.int64)
    shape = SHAPE[SLOT[iid]]
    if shape == F:
        return (ends >= marks[0]).astype(np.float32) if len(marks) else np.zeros(len(ends), np.float32)
    if shape == N:
        counts = np.searchsorted(marks, ends, side='right')
        return (np.diff(np.concatenate([[0], counts])) > 0).astype(np.float32)
    return np.zeros(len(ends), np.float32)


def target(iid, kw):
    if iid == 'pattern:items':
        return EXACTLY, kw['n']
    raise KeyError(iid)


def style_label(iid, kw):
    """The class the clerk should read for a slot, or -100."""
    return kw.get('style', -100) if iid in ('pattern:marker', 'pattern:bold') else -100


# ── reading the pattern back from the examples (by counting) ───────────────────────────────────
def read_rules(examples):
    """The house pattern as the examples show it, by majority count over their lines: what a perfect clerk would
    read. Used to check that every prompt's examples determine its rules, and ported to the browser view."""
    items = [parse_item(l.strip()) for _, a in examples for l in a.split('\n') if parse_item(l.strip())]
    styles = [st for st, _, _ in items]
    marker = max(set(styles), key=styles.count) if styles else 0
    bolds = [b.startswith('**') for _, _, b in items]
    firsts = [a.split('\n')[0].strip() for _, a in examples]
    lasts = [[l.strip() for l in a.split('\n') if l.strip()][-1] for _, a in examples]
    tldr = next((lab for lab in TLDR_LABELS if all(f.lower().startswith(lab.lower()) for f in firsts)), None)
    heads = [h for h in SOURCE_HEADERS if all(any(l.strip().lower() == h.lower() for l in a.split('\n')) for _, a in examples)]
    lower = all(not re.search(r'[A-Z]', a) for _, a in examples)
    signoff = lasts[0] if len(set(lasts)) == 1 and not parse_item(lasts[0]) and not SOURCE.match(lasts[0]) else None
    return {
        'marker': marker, 'bold': int(sum(bolds) * 2 > len(bolds)), 'lowercase': int(lower),
        'tldr': next((lab for lab in TLDR_LABELS if lab.lower() == (tldr or '').lower()), None),
        'sources': heads[0] if heads else None,
        'signoff': signoff,
    }


def same_rules(a, b):
    keys = ('marker', 'bold', 'lowercase', 'tldr', 'sources')
    return all(a[k] == b[k] for k in keys) and (a['signoff'] or '').lower() == (b['signoff'] or '').lower()


def make_record(rng, pool, split, n=None, n_range=(2, 10), ex_range=(2, 6)):
    """One prompt: an author, two example answers from the pool, and a new question asking for n items.
    `pool` maps split -> list of {'topic', 'n', 'question', 'content'} (the base model's own answers, parsed)."""
    rules = sample_rules(rng, split)
    entries = pool[split]
    n = n or rng.randint(*n_range)
    target_entry = rng.choice([e for e in entries if len(e['content']['items']) >= n])
    exs = []
    for _ in range(2):
        cands = [e for e in entries if e['topic'] != target_entry['topic'] and e is not target_entry and ex_range[0] <= e['n'] <= ex_range[1]
                 and all(e['topic'] != x['topic'] for x in exs)]
        exs.append(rng.choice(cands))
    examples = [(e['question'], render({'intro': e['content']['intro'], 'items': e['content']['items'][: e['n']]}, rules, e['topic'], rng)) for e in exs]
    q = question(target_entry['topic'], n, rng)
    parts = prompt_parts(examples, q)
    response = render({'intro': target_entry['content']['intro'], 'items': target_entry['content']['items'][:n]}, rules, target_entry['topic'], rng)
    ids, kws = obligations(rules, n)
    return {'prompt': assemble(parts), 'parts': parts, 'response': response, 'rules': rules, 'n': n, 'topic': target_entry['topic'],
            'instruction_id_list': ids, 'kwargs': kws, 'examples': examples}


def hazard_rows(rows, monitor):
    """Per item position j (0-based): (at risk, first breaks) pooled over responses, for an invariant over items."""
    at_risk, breaks = {}, {}
    for r in rows:
        v = r['verdicts'].get(monitor)
        if not v:
            continue
        stop = v['break_at'] if v['break_at'] is not None else v['opportunities']
        for j in range(min(stop + 1, v['opportunities'])):
            at_risk[j] = at_risk.get(j, 0) + 1
        if v['break_at'] is not None:
            breaks[v['break_at']] = breaks.get(v['break_at'], 0) + 1
    return {j: (at_risk[j], breaks.get(j, 0)) for j in sorted(at_risk)}


def log_survival_slope(ns, ok_counts, totals):
    """Least-squares slope of log S(n) against n (S = share of coherent answers at n items): minus the length exponent
    per item. Shares of 0 are floored at half an answer."""
    xs, ys = [], []
    for n, k, t in zip(ns, ok_counts, totals):
        if t:
            xs.append(n)
            ys.append(math.log(max(k, 0.5) / t))
    if len(xs) < 2:
        return float('nan')
    xm, ym = np.mean(xs), np.mean(ys)
    return float(np.sum((np.array(xs) - xm) * (np.array(ys) - ym)) / np.sum((np.array(xs) - xm) ** 2))


__all__ = ['SLOTS', 'K', 'SLOT', 'SHAPE', 'POINTER', 'STYLES', 'target', 'token_targets', 'milestones', 'numbers', 'style_label',
           'audit', 'coherent', 'render', 'parse_answer', 'make_record', 'read_rules', 'random']
