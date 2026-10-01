"""
Data for the house-pattern study (patterns.py): training records, a dev split, test prompts, background passages.

1. The frozen model answers plain questions ("Give me 12 tips for gardening."), several wordings and samples per
   topic. Each answer is parsed into an intro and a list of items; answers with too few items are dropped. Train and
   test topics are disjoint, and so are the sign-offs.
2. A record takes an author (a house pattern), two example answers on other topics (2 to 6 items each), and a new
   question asking for n items. The target is the model's own answer to that question, cut to n items and rendered in
   the house pattern: the words are the model's, only the form is imposed. Every variant trains on the same records.
3. 30% of training inputs have background notes between the examples and the new question.
4. Test prompts: held-out topics and sign-offs, n in {3, 6, 9, 12} (12 is longer than any training answer), fixed seed.

  python pattern_data.py --out data-patterns --prompts 3000
"""
import argparse
import collections
import json
import os
import pathlib
import random
import re
import time

import torch

import patterns as pt
from chat import device_auto, generate
from load import DEFAULT_MODEL, build

TOPICS = [
    'gardening', 'the ocean', 'coffee', 'bicycles', 'the moon', 'recycling', 'chess', 'volcanoes', 'jazz music', 'city parks',
    'honey bees', 'trains', 'public libraries', 'space travel', 'healthy breakfasts', 'the Roman Empire', 'electric cars',
    'friendship', 'mountains', 'video games', 'photography', 'the desert', 'birds', 'learning a language', 'robots',
    'bread baking', 'the solar system', 'tea', 'running', 'dinosaurs', 'clean water', 'rivers', 'the night sky', 'penguins',
    'bridges', 'painting', 'camping', 'forests', 'the weather', 'board games', 'farming', 'old maps', 'lighthouses', 'sleep',
    'a new job', 'moving house', 'volunteering', 'mathematics', 'a road trip', 'snow', 'the seaside', 'cooking pasta', 'owls',
    'houseplants', 'saving money', 'writing letters', 'public speaking', 'swimming', 'knitting', 'bird watching', 'cycling to work',
    'museums', 'the violin', 'first aid', 'composting', 'rainy days', 'sourdough', 'stargazing', 'hiking', 'journaling', 'yoga',
    'tidying a room', 'learning to draw', 'the piano', 'caring for a dog', 'caring for a cat', 'studying for exams', 'podcasts',
    'origami', 'sushi', 'tennis', 'a vegetable garden', 'fixing a bike', 'packing for a trip', 'autumn', 'spring cleaning',
]
TEST_TOPICS = [
    'beekeeping', 'the Arctic', 'chocolate', 'skateboarding', 'Mars', 'pottery', 'kites', 'waterfalls', 'the harp', 'coral reefs',
    'bonsai trees', 'the Silk Road', 'windmills', 'tide pools', 'calligraphy', 'lanterns', 'glaciers', 'mushrooms', 'fireflies', 'canals',
]
ASK_N = (6, 9, 12)  # the plain questions ask for this many items (records use fewer, cut from the start)
TEST_NS = (3, 6, 9, 12)


def write_whole(path, text):
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(text, encoding='utf-8')
    os.replace(tmp, path)


def plain_questions(topics, rng, per_topic):
    out = []
    for t in topics:
        for w in rng.sample(range(len(pt.QUESTIONS)), min(per_topic, len(pt.QUESTIONS))):
            out.append({'topic': t, 'template': w, 'ask': rng.choice(ASK_N)})
    return out


def stand_in(q):
    """A list for plumbing checks only (a random-weight model writes no lists): never used in a study."""
    return {'intro': f'Some notes on {q["topic"]}.', 'items': [(f'Point {w}', f'one thing to know about {q["topic"]}.') for w in pt.NUM_WORDS[1 : q['ask'] + 1]]}


def answer_pool(lm, tok, qs, samples, max_new, batch, seed, log, stand_ins=False):
    """The frozen model's answers to plain questions, parsed; each kept answer knows how many items it has."""
    prompts = [pt.QUESTIONS[q['template']].format(n=q['ask'], t=q['topic']) for q in qs for _ in range(samples)]
    texts = generate(lm, tok, prompts, max_new_tokens=max_new, temperature=0.8, top_p=0.95, batch_size=batch, seed=seed, log=log)
    pool, dropped = [], 0
    for i, q in enumerate(qs):
        for s in texts[i * samples : (i + 1) * samples]:
            c = pt.parse_answer(s, 2)
            filler = c is None and stand_ins
            c = stand_in(q) if filler else c
            if c is None:
                dropped += 1
                continue
            if re.search(r'\d|\b(' + '|'.join(pt.NUM_WORDS) + r')\b', c['intro'], flags=re.IGNORECASE):
                c['intro'] = ''  # an intro that names a number would contradict the n the record asks for
            pool.append({'topic': q['topic'], 'template': q['template'], 'content': c, 'max_n': len(c['items']), **({'stand_in': True} if filler else {})})
    return pool, dropped


def record(rng, pool, split, n, ex_range=(2, 6)):
    """make_record over pool entries whose wording is kept and whose count is chosen per use."""
    rules = pt.sample_rules(rng, split)
    target = rng.choice([e for e in pool if e['max_n'] >= n])
    exs = []
    for _ in range(2):
        cands = [e for e in pool if e['topic'] != target['topic'] and all(e['topic'] != x[0]['topic'] for x in exs) and e['max_n'] >= ex_range[0]]
        e = rng.choice(cands)
        exs.append((e, rng.randint(ex_range[0], min(ex_range[1], e['max_n']))))
    ask = lambda e, k: pt.QUESTIONS[e['template']].format(n=pt.NUM_WORDS[k] if rng.random() < 0.3 else k, t=e['topic'])
    examples = [(ask(e, k), pt.render({'intro': e['content']['intro'], 'items': e['content']['items'][:k]}, rules, e['topic'], rng)) for e, k in exs]
    q = ask(target, n)
    parts = pt.prompt_parts(examples, q)
    response = pt.render({'intro': target['content']['intro'], 'items': target['content']['items'][:n]}, rules, target['topic'], rng)
    ids, kws = pt.obligations(rules, n)
    return {'prompt': pt.assemble(parts), 'input': pt.assemble(parts), 'parts': parts, 'response': response, 'rules': rules, 'n': n,
            'topic': target['topic'], 'instruction_id_list': ids, 'kwargs': kws, 'examples': examples, 'split': split}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--out', default='data-patterns')
    ap.add_argument('--prompts', type=int, default=3000, help='training records')
    ap.add_argument('--per-topic', type=int, default=4, help='plain questions per topic (different wordings)')
    ap.add_argument('--samples', type=int, default=2, help='answers sampled per plain question')
    ap.add_argument('--test-per-n', type=int, default=75, help='test prompts for each n in 3, 6, 9, 12')
    ap.add_argument('--max-new-tokens', type=int, default=640)
    ap.add_argument('--batch-size', type=int, default=16)
    ap.add_argument('--passages', type=int, default=200, help='background passages, unless --distractors is given')
    ap.add_argument('--distractors', default='', help='reuse background passages from this file (e.g. the IFEval study\'s)')
    ap.add_argument('--long-frac', type=float, default=0.3)
    ap.add_argument('--long-max', type=int, default=1000, help='longest background, in tokens, during training')
    ap.add_argument('--topics', type=int, default=0, help='use only this many training topics (smoke runs)')
    ap.add_argument('--stand-ins', action='store_true', help='plumbing checks only: replace answers without a list by stand-in lists')
    ap.add_argument('--device', default='auto')
    ap.add_argument('--dtype', default='auto')
    ap.add_argument('--seed', type=int, default=4321)
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    log = lambda m: print(f'[{time.time() - t0:7.0f}s] {m}', flush=True)
    dev = device_auto(a.device)
    lm, tok, _ = build(a.model, 'base', dev, dtype=a.dtype)
    lm.eval()
    rng = random.Random(a.seed)

    # background passages
    if a.distractors and pathlib.Path(a.distractors).exists():
        passages = [json.loads(l)['text'] for l in pathlib.Path(a.distractors).read_text(encoding='utf-8').splitlines() if l.strip()]
        log(f'{len(passages)} background passages from {a.distractors}')
    else:
        topics = [rng.choice(TOPICS) for _ in range(a.passages)]
        passages = generate(lm, tok, [f'Write a long, detailed article about {t}.' for t in topics], max_new_tokens=512, temperature=0.8,
                            top_p=0.95, batch_size=a.batch_size, seed=a.seed, log=log)
        log(f'{len(passages)} background passages')
    write_whole(out / 'distractors.jsonl', ''.join(json.dumps({'text': p}) + '\n' for p in passages))

    # the model's own answers, train and test topics apart
    train_topics = TOPICS[: a.topics] if a.topics else TOPICS
    test_topics = TEST_TOPICS[: max(4, a.topics // 4)] if a.topics else TEST_TOPICS
    pools, stats = {}, collections.Counter()
    for split, topics in (('train', train_topics), ('test', test_topics)):
        qs = plain_questions(topics, rng, a.per_topic)
        pools[split], dropped = answer_pool(lm, tok, qs, a.samples, a.max_new_tokens, a.batch_size, a.seed + (split == 'test'), log, a.stand_ins)
        if len({e['topic'] for e in pools[split] if e['max_n'] >= 2}) < 3:
            raise SystemExit(f'{split}: the model gave lists on fewer than 3 topics; raise --samples or --max-new-tokens')
        stats[f'{split}_answers'] = len(pools[split])
        stats[f'{split}_unparsed'] = dropped
        stats[f'{split}_stand_ins'] = sum(e.get('stand_in', False) for e in pools[split])
        stats[f'{split}_max_items_mean'] = round(sum(e['max_n'] for e in pools[split]) / max(1, len(pools[split])), 2)
        log(f'{split}: {len(pools[split])} usable answers, {dropped} without a list')
    (out / 'pool.jsonl').write_text(''.join(json.dumps({**e, 'split': s}) + '\n' for s, p in pools.items() for e in p), encoding='utf-8')

    # training records
    corpus_ids = tok('\n\n'.join(passages), add_special_tokens=False)['input_ids']
    train_max = max(e['max_n'] for e in pools['train'])
    recs = []
    for _ in range(a.prompts):
        n = rng.randint(2, min(10, train_max))
        r = record(rng, pools['train'], 'train', n)
        if corpus_ids and rng.random() < a.long_frac:
            L = rng.randint(64, a.long_max)
            s = rng.randrange(max(1, len(corpus_ids) - L))
            r['input'] = pt.assemble(r['parts'], tok.decode(corpus_ids[s : s + L]))
        recs.append(r)
    n_dev = max(1, len(recs) // 20)
    (out / 'dev.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in recs[:n_dev]), encoding='utf-8')

    # test prompts: fixed seed, every n
    trng = random.Random(a.seed + 7)
    test_max = max(e['max_n'] for e in pools['test'])
    tests = []
    for n in TEST_NS:
        if n > test_max:
            log(f'test: no answer with {n} items; n={n} left out')
            continue
        for i in range(a.test_per_n):
            r = record(trng, pools['test'], 'test', n)
            r['key'] = f'n{n}-{i}'
            tests.append(r)
    write_whole(out / 'test.jsonl', ''.join(json.dumps(r) + '\n' for r in tests))
    summary = {'train_records': len(recs) - n_dev, 'dev_records': n_dev, 'test_prompts': len(tests), **stats,
               'rules': {k: dict(collections.Counter(str(r['rules'][k]) for r in recs)) for k in ('marker', 'bold', 'lowercase', 'tldr', 'sources', 'signoff')},
               'n': dict(collections.Counter(r['n'] for r in recs)), 'seconds': round(time.time() - t0), 'args': vars(a)}
    (out / 'stats.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    write_whole(out / 'train.jsonl', ''.join(json.dumps(r) + '\n' for r in recs[n_dev:]))  # last: marks finished data
    log(f'wrote {out}: {len(recs) - n_dev} training records, {len(tests)} test prompts')


if __name__ == '__main__':
    torch.set_grad_enabled(False)
    main()
