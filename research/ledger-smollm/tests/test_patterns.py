"""House patterns: the monitors, the rendering, the labels, and that two examples determine the rules."""
import pathlib
import random
import sys

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import patterns as pt  # noqa: E402

TOPICS = ['gardening', 'the ocean', 'coffee', 'bicycles', 'the moon', 'chess', 'volcanoes', 'jazz music', 'trains', 'birds']


def fake_content(rng, n, intro=True):
    words = 'water light soil prune rest share read walk listen plan sketch map rhythm tide orbit'.split()
    items = [(f'{rng.choice(words).title()} {rng.choice(words)}', f'try to {rng.choice(words)} every day, it helps the {rng.choice(words)}.') for _ in range(n)]
    return {'intro': 'Here is what I have learned.' if intro else '', 'items': items}


def pool(rng, split='train', per=8):
    out = []
    for t in TOPICS:
        for _ in range(per):
            n = rng.randint(2, 14)
            out.append({'topic': t, 'n': n, 'question': pt.question(t, n, rng), 'content': fake_content(rng, 14)})
    return {split: out}


def all_rules():
    rng = random.Random(0)
    return [pt.sample_rules(rng) for _ in range(300)]


@pytest.mark.parametrize('seed', range(40))
def test_rendered_answers_pass_every_monitor(seed):
    rng = random.Random(seed)
    rules = pt.sample_rules(rng)
    n = rng.randint(1, 14)
    text = pt.render(fake_content(rng, n, intro=seed % 3 != 0), rules, 'gardening', rng)
    v = pt.audit(text, rules, n)
    assert pt.coherent(v), (rules, text, v)
    assert v['items']['found'] == n


def test_every_style_and_shape_is_reachable():
    rs = all_rules()
    assert {r['marker'] for r in rs} == set(range(len(pt.MARKERS)))
    assert {r['bold'] for r in rs} == {0, 1} and {r['lowercase'] for r in rs} == {0, 1}
    for key in ('tldr', 'sources', 'signoff'):
        assert any(r[key] for r in rs) and any(not r[key] for r in rs)


def rules_with(**kw):
    base = {'marker': 1, 'bold': 1, 'lowercase': 0, 'tldr': 'TL;DR:', 'sources': 'Sources:', 'signoff': 'Cheers, Ben'}
    base.update(kw)
    return base


def render(rules, n=4, seed=1):
    rng = random.Random(seed)
    return pt.render(fake_content(rng, n), rules, 'coffee', rng)


def broken(text, rules, n):
    v = pt.audit(text, rules, n)
    return {k for k, x in v.items() if not x['ok']}, v


def test_each_break_is_caught_by_its_monitor():
    r = rules_with()
    good = render(r)
    lines = good.split('\n')
    items = [i for i, l in enumerate(lines) if pt.parse_item(l)]
    # the marker: another style on the third item; a skipped number
    t = lines.copy()
    t[items[2]] = t[items[2]].replace('3)', '3.', 1)
    b, v = broken('\n'.join(t), r, 4)
    assert b == {'marker'} and v['marker']['break_at'] == 2
    t = lines.copy()
    t[items[1]] = t[items[1]].replace('2)', '5)', 1)
    assert broken('\n'.join(t), r, 4)[0] == {'marker'}
    # bold: one plain lead
    t = lines.copy()
    t[items[3]] = t[items[3]].replace('**', '')
    b, v = broken('\n'.join(t), r, 4)
    assert b == {'bold'} and v['bold']['break_at'] == 3
    # the count: one item too many
    t = lines[: items[-1] + 1] + [lines[items[-1]].replace('4)', '5)', 1)] + lines[items[-1] + 1 :]
    assert broken('\n'.join(t), r, 4)[0] == {'items'}
    # TL;DR missing; TL;DR not first
    assert broken('\n'.join(lines[2:]), r, 4)[0] == {'tldr', 'tldr_first'}
    moved = '\n'.join(lines[2:items[-1] + 1] + [lines[0]] + lines[items[-1] + 1 :])
    assert broken(moved, r, 4)[0] == {'tldr_first'}
    # sources: an item after the header; no source lines after it
    at = lines.index('Sources:')
    t = lines[: at + 1] + ['5) **Extra**: one more.'] + lines[at + 1 :]
    b, _ = broken('\n'.join(t), r, 5)
    assert 'sources_after' in b and 'sources_only' in b
    t = [l for l in lines if not l.startswith('[')]
    assert broken('\n'.join(t), r, 4)[0] == {'sources'}
    # sign-off: missing; not last
    assert broken('\n'.join(lines[:-1]), r, 4)[0] == {'signoff', 'signoff_last'}
    assert broken(good + '\nOne more thing.', r, 4)[0] == {'signoff_last', 'sources_only'}


def test_lowercase_is_an_invariant_over_lines():
    r = rules_with(lowercase=1)
    good = render(r)
    assert good == good.lower() and pt.coherent(pt.audit(good, r, 4))
    lines = good.split('\n')
    third = [i for i, l in enumerate(lines) if pt.parse_item(l)][2]
    lines[third] += ' See Paris.'
    b, v = broken('\n'.join(lines), r, 4)
    assert b == {'lowercase'}
    nonempty = [l for l in lines if l.strip()]
    assert nonempty[v['lowercase']['break_at']] == lines[third]


def test_unnumbered_markers_and_plain_leads():
    for marker in range(pt.NUMBERED, len(pt.MARKERS)):
        r = rules_with(marker=marker, bold=0, tldr=None, sources=None, signoff=None)
        text = render(r, n=6)
        assert pt.coherent(pt.audit(text, r, 6)), text
        assert '**' not in text


def test_parse_answer_reads_typical_model_output():
    text = ("Here are 5 tips for gardening:\n\n1. **Choose the right plants**: Pick plants that suit your climate.\n"
            "2. **Water regularly**: Most plants need water twice a week.\n3. Mulch: It keeps the soil moist.\n"
            "4. Prune dead leaves so new ones can grow.\n5. **Watch for pests** - Check the leaves every week.\n\nHappy gardening!")
    c = pt.parse_answer(text, 5)
    assert c['intro'].startswith('Here are 5 tips')
    assert [lead for lead, _ in c['items']][:3] == ['Choose the right plants', 'Water regularly', 'Mulch']
    assert c['items'][4][0] == 'Watch for pests' and c['items'][4][1].startswith('Check')
    assert pt.parse_answer(text, 6) is None
    assert '*' not in ''.join(a + b for a, b in c['items'])


@pytest.mark.parametrize('seed', range(60))
def test_two_examples_determine_the_rules(seed):
    rng = random.Random(seed)
    rec = pt.make_record(rng, pool(random.Random(seed)), 'train')
    read = pt.read_rules(rec['examples'])
    assert pt.same_rules(read, rec['rules']), (read, rec['rules'])
    assert pt.coherent(pt.audit(rec['response'], rec['rules'], rec['n']))
    # the new question asks for n items, and the examples show other numbers
    assert str(rec['n']) in rec['parts']['question'] or pt.NUM_WORDS[rec['n']] in rec['parts']['question']


def fake_tokens(text, rng):
    """Token end positions for a random segmentation into pieces of 1 to 5 characters."""
    ends, at = [], 0
    while at < len(text):
        at = min(len(text), at + rng.randint(1, 5))
        ends.append(at)
    return ends


@pytest.mark.parametrize('seed', range(30))
def test_state_labels_agree_with_the_monitors_on_every_prefix(seed):
    rng = random.Random(seed)
    rules = pt.sample_rules(rng)
    rules.update(tldr=rules['tldr'] or 'TL;DR:', signoff=rules['signoff'] or '— R.', sources=rules['sources'] or 'Sources:')
    n = rng.randint(2, 12)
    text = pt.render(fake_content(rng, n), rules, 'chess', rng)
    ends = fake_tokens(text, rng)
    ids, kws = pt.obligations(rules, n)
    for iid, kw in zip(ids, kws):
        lab = pt.token_targets(iid, kw, text, ends)
        if iid == 'pattern:items':
            # the running count of events equals the number of complete item markers in each prefix
            for t, e in enumerate(ends):
                assert int(lab[: t + 1].sum()) == sum(1 for l in text[:e].split('\n') if pt.ITEM.match(l)), text[:e][-30:]
            assert lab.sum() == n
        elif pt.SHAPE[pt.SLOT[iid]] == pt.F:
            key = iid.split(':')[1]
            for t, e in enumerate(ends):
                prefix = text[:e]
                paid = any((l.strip().startswith(kw['text']) if key == 'tldr' else l.strip() == kw['text']) for l in prefix.split('\n'))
                assert bool(lab[t]) == paid, (iid, prefix[-40:])
            assert lab[-1] == 1 and np.all(np.diff(lab) >= 0)


def test_spec_interface():
    assert pt.K == len(pt.SLOTS) == len(pt.SHAPE) == len(pt.POINTER) == len(pt.STYLES)
    assert pt.SHAPE[pt.SLOT['pattern:items']] == pt.N and pt.POINTER[pt.SLOT['pattern:items']]
    assert pt.target('pattern:items', {'n': 7}) == (pt.EXACTLY, 7)
    assert pt.style_label('pattern:marker', {'style': 5}) == 5 and pt.style_label('pattern:tldr', {'text': 'x'}) == -100
    rng = random.Random(3)
    for _ in range(50):
        r = pt.sample_rules(rng)
        ids, kws = pt.obligations(r, 5)
        assert all(i in pt.SLOT for i in ids) and len(ids) == len(set(ids))


def test_hazards_and_the_length_exponent():
    rows = [{'verdicts': {'marker': {'ok': False, 'break_at': 2, 'opportunities': 5}}},
            {'verdicts': {'marker': {'ok': True, 'break_at': None, 'opportunities': 3}}}]
    h = pt.hazard_rows(rows, 'marker')
    assert h == {0: (2, 0), 1: (2, 0), 2: (2, 1)}
    # S(n) = 0.9^n has log-slope log 0.9 per item
    ns = [2, 4, 8, 12]
    tot = [10**6] * 4
    ok = [round(t * 0.9**n) for n, t in zip(ns, tot)]
    assert abs(pt.log_survival_slope(ns, ok, tot) - np.log(0.9)) < 1e-3


def test_analysis_recovers_known_exponents(tmp_path, monkeypatch):
    """Synthetic results with S(n) = 0.95^n for the Ledger and 0.85^n for LoRA: the analysis finds both exponents and
    a difference whose interval excludes 0."""
    import json
    import pattern_analyze
    rng = np.random.default_rng(0)
    for variant, keep in (('ledger', 0.95), ('lora', 0.85)):
        rows = []
        for n in (3, 6, 9, 12):
            for i in range(400):
                ok = bool(rng.random() < keep**n)
                rows.append({'key': f'n{n}-{i}', 'n': n, 'length': 0, 'variant': variant, 'seed': 0, 'coherent': ok, 'tokens': 10 * n,
                             'verdicts': {'items': {'ok': ok, 'found': n if ok else n - 1}, 'marker': {'ok': True, 'break_at': None, 'opportunities': n}}})
        (tmp_path / f'{variant}-s0-L0.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows))
    monkeypatch.setattr(sys, 'argv', ['pattern_analyze.py', '--results', str(tmp_path), '--boot', '400'])
    pattern_analyze.main()
    s = json.loads((tmp_path / 'summary.json').read_text())
    k = {e['variant']: e['kappa_per_item'] for e in s['length_exponent']}
    # tolerances of about 3.5 standard deviations of the estimate at 400 prompts per n (0.005 and 0.013)
    assert abs(k['ledger'] + np.log(0.95)) < 0.02 and abs(k['lora'] + np.log(0.85)) < 0.05, k
    d = s['kappa_contrast'][0]
    assert d['control'] == 'lora' and d['ci'][1] < 0 < -d['ci'][0], d
    assert abs(d['difference'] - (np.log(0.85) - np.log(0.95))) < 0.05
