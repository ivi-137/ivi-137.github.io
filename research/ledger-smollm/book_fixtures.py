"""
Parity fixtures for the browser's clerk's book (src/lib/coherence/book.ts), a port of this study's monitors and clerk.

Random authors and answers, most of them broken on purpose in one or more ways, with the verdicts of patterns.audit
and the positions of patterns.milestones; and random prompts (with background notes or not) with what read_rules reads
from their examples and the n their question asks for. scripts/check-book.mts checks the port against them.

  python book_fixtures.py --out ../../scripts/fixtures/book-parity.json
"""
import argparse
import json
import pathlib
import random

import patterns as pt

WORDS = 'water light soil prune rest share read walk listen plan sketch map rhythm tide orbit Paris Monday salt clay wind'.split()


def content(rng, n):
    lead = lambda: ' '.join(rng.choice(WORDS) for _ in range(rng.randint(1, 3))).capitalize()
    body = lambda: ' '.join(rng.choice(WORDS) for _ in range(rng.randint(3, 9))) + '.'
    return {'intro': 'Here is what I know.' if rng.random() < 0.5 else '', 'items': [(lead(), body() if rng.random() < 0.9 else '') for _ in range(n)]}


def corrupt(rng, text, rules):
    """One of the ways an answer goes wrong."""
    lines = text.split('\n')
    items = [i for i, l in enumerate(lines) if pt.parse_item(l.strip())]
    kind = rng.randrange(12)
    if kind == 0 and items:  # another marker on one item
        i = rng.choice(items)
        st, num, body = pt.parse_item(lines[i].strip())
        lines[i] = f'{pt.marker_text(rng.randrange(len(pt.MARKERS)), num or 1)} {body}'
    elif kind == 1 and items:  # a skipped or repeated number
        i = rng.choice(items)
        lines[i] = lines[i].replace(str(items.index(i) + 1), str(rng.randint(1, 14)), 1)
    elif kind == 2 and items:  # bold dropped or added
        i = rng.choice(items)
        lines[i] = lines[i].replace('**', '') if '**' in lines[i] else lines[i].replace(' ', ' **', 1) + '** x'
    elif kind == 3:  # a capital letter
        i = rng.randrange(len(lines))
        lines[i] += ' Paris.'
    elif kind == 4 and items:  # stop early
        lines = lines[: rng.choice(items) + 1]
    elif kind == 5 and items:  # one item too many, perhaps after everything
        j = items[-1] + (0 if rng.random() < 0.6 else len(lines) - items[-1])
        lines.insert(j + 1, f'{pt.marker_text(rules["marker"], len(items) + 1)} Extra: one more.')
    elif kind == 6:  # a line after the end
        lines.append(rng.choice(['Hope this helps!', '', '[3] Another Book', '- one more thing']))
    elif kind == 7 and len(lines) > 2:  # the first line moved to the end
        lines = lines[1:] + [lines[0]]
    elif kind == 8:  # a line dropped
        del lines[rng.randrange(len(lines))]
    elif kind == 9:  # indentation and trailing spaces
        lines = [('  ' + l + ' ') if l and rng.random() < 0.3 else l for l in lines]
    elif kind == 10:  # an unnumbered paragraph between items
        lines.insert(rng.randint(0, len(lines)), 'Some words in between.')
    else:  # Windows line ends are normalised by the view; here, everything lowercased
        lines = [l.lower() for l in lines]
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default='../../scripts/fixtures/book-parity.json')
    ap.add_argument('--answers', type=int, default=300)
    ap.add_argument('--prompts', type=int, default=80)
    a = ap.parse_args()
    rng = random.Random(137)
    answers = []
    for i in range(a.answers):
        rules = pt.sample_rules(rng, rng.choice(['train', 'test']))
        n = rng.randint(1, 12)
        text = pt.render(content(rng, rng.choice([n, n, n, max(1, n - 2), n + 2])), rules, rng.choice(WORDS), rng)
        for _ in range(rng.choice([0, 1, 1, 2, 3])):
            text = corrupt(rng, text, rules)
        ids, kws = pt.obligations(rules, n)
        miles = {iid.split(':')[1]: pt.milestones(iid, kw, text) for iid, kw in zip(ids, kws) if iid in ('pattern:items', 'pattern:tldr')}
        answers.append({'rules': rules, 'n': n, 'text': text, 'verdicts': pt.audit(text, rules, n), 'milestones': miles})
    prompts = []
    pool = {'train': [{'topic': t, 'n': rng.randint(2, 6), 'question': pt.question(t, rng.randint(2, 12), rng), 'content': content(rng, 6)}
                      for t in WORDS for _ in range(2)]}
    for i in range(a.prompts):
        rec = pt.make_record(rng, pool, 'train', n_range=(2, 6))
        bg = ' '.join(rng.choice(WORDS) for _ in range(rng.randint(20, 80))) if rng.random() < 0.3 else ''
        prompts.append({'prompt': pt.assemble(rec['parts'], bg), 'examples': [x for _, x in rec['examples']], 'read': pt.read_rules(rec['examples']),
                        'rules': rec['rules'], 'n': rec['n']})
    out = pathlib.Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({'answers': answers, 'prompts': prompts}, ensure_ascii=False) + '\n', encoding='utf-8')
    broken = sum(not pt.coherent(x['verdicts']) for x in answers)
    print(f'{len(answers)} answers ({broken} broken), {len(prompts)} prompts -> {out}')


if __name__ == '__main__':
    main()
