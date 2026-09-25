"""
Training data for the retrofit: IFEval-style prompts, responses that keep every instruction, and background text.

Prompts combine a plain writing task with one to three instructions whose wording and random arguments come from
the official IFEval instruction classes (build_description), respecting their conflict table. The IFEval test
prompts themselves are never used for training.

Targets come from the frozen model itself: several samples per prompt; the first that passes every official
checker is kept; otherwise the sample satisfying most instructions is repaired by exact edits (lowercasing,
adding a postscript, regrouping sentences into the requested number of paragraphs, ...) and kept only if it then
passes. Every variant, the LoRA control included, trains on the same records.

  python data.py --model HuggingFaceTB/SmolLM2-135M-Instruct --prompts 3000 --samples 4 --out data
"""
import argparse
import collections
import json
import pathlib
import random
import re
import time

import torch

import obligations as ob
from chat import device_auto, generate, with_distractor
from ifeval_bridge import REGISTRY, follows, instructions_registry, instructions_util
from load import DEFAULT_MODEL, build

TEMPLATES = [
    'Write a short blog post about {t}.', 'Write an email to a friend about {t}.', 'Explain {t} to a child.',
    'Write a poem about {t}.', 'Give advice to someone who wants to learn about {t}.', 'Write a story about {t}.',
    'Summarize what people should know about {t}.', 'Write a letter to the editor about {t}.',
    'Describe a typical day for someone who works with {t}.', 'Write a short speech about {t}.',
    'What are the pros and cons of {t}?', 'Write a review of a book about {t}.', 'Write a diary entry about {t}.',
    'Write a dialogue between two friends discussing {t}.', 'Write an advertisement for a class on {t}.',
    'Write a news report about {t}.', 'Write a cover letter for a job related to {t}.', 'Tell me about the history of {t}.',
    'Write a product description for something related to {t}.', 'Write a travel guide entry about {t}.',
]
TOPICS = [
    'gardening', 'the ocean', 'coffee', 'bicycles', 'the moon', 'recycling', 'chess', 'a rainy day', 'volcanoes',
    'the internet', 'jazz music', 'city parks', 'honey bees', 'trains', 'winter holidays', 'public libraries',
    'space travel', 'healthy breakfasts', 'the Roman Empire', 'electric cars', 'friendship', 'mountains', 'video games',
    'photography', 'kindness', 'the desert', 'birds', 'a summer festival', 'learning a language', 'robots',
    'bread baking', 'the solar system', 'tea', 'running', 'a small town', 'dinosaurs', 'clean water', 'rivers',
    'the night sky', 'a museum visit', 'penguins', 'bridges', 'painting', 'camping', 'a birthday party', 'forests',
    'the weather', 'board games', 'a school trip', 'farming', 'the city at night', 'old maps', 'lighthouses',
    'a football match', 'sleep', 'bees and flowers', 'a new job', 'moving house', 'volunteering', 'the library card',
    'mathematics', 'a road trip', 'snow', 'the seaside', 'a marathon', 'cooking pasta', 'a science fair', 'owls',
]
PLACEHOLDERS = ['name', 'address', 'date', 'phone number', 'email', 'company', 'city', 'time', 'price', 'website',
                'country', 'job title', 'manager', 'school', 'street', 'zip code', 'day', 'amount', 'product', 'team']
PS_LINES = ['Thank you for reading.', 'Let me know if you have questions.', 'Have a wonderful day.', 'More soon.']
SUPPORTED = [iid for iid, _ in ob.SLOTS]
WEIGHT = {'language:response_language': 0.3}  # a 135M model rarely writes other languages, and it cannot be repaired
REPAIR_ORDER = [
    'keywords:forbidden_words', 'length_constraints:number_words', 'length_constraints:number_sentences',
    'keywords:existence', 'keywords:frequency', 'detectable_content:number_placeholders',
    'detectable_format:number_highlighted_sections', 'change_case:capital_word_frequency',
    'length_constraints:number_paragraphs', 'detectable_format:multiple_sections', 'detectable_format:number_bullet_lists',
    'detectable_format:constrained_response', 'detectable_format:title', 'detectable_content:postscript',
    'startend:end_checker', 'combination:two_responses', 'combination:repeat_prompt', 'change_case:english_lowercase',
    'change_case:english_capital', 'punctuation:no_comma', 'detectable_format:json_format', 'startend:quotation',
]


def make_prompts(n, seed):
    rng = random.Random(seed)
    random.seed(seed)  # the IFEval classes draw their arguments from the global generator
    conflicts = instructions_registry.conflict_make({k: set(v) for k, v in instructions_registry.INSTRUCTION_CONFLICTS.items()})
    weights = [WEIGHT.get(i, 1.0) for i in SUPPORTED]
    out = []
    for _ in range(n):
        topic = rng.choice(TOPICS)
        base = rng.choice(TEMPLATES).format(t=topic)
        k = rng.choices([1, 2, 3], [0.56, 0.33, 0.11])[0]
        ids = []
        for _ in range(50):
            if len(ids) == k:
                break
            c = rng.choices(SUPPORTED, weights)[0]
            if c not in ids and all(c not in conflicts.get(j, ()) and j not in conflicts.get(c, ()) for j in ids):
                ids.append(c)
        descs, kwargs = [], []
        for iid in ids:
            inst = REGISTRY[iid](iid)
            descs.append(inst.build_description(prompt_to_repeat=base) if iid == 'combination:repeat_prompt' else inst.build_description())
            kwargs.append({a: v for a, v in (inst.get_instruction_args() or {}).items() if v is not None})
        out.append({'prompt': base + ' ' + ' '.join(descs), 'base': base, 'topic': topic, 'instruction_id_list': ids, 'kwargs': kwargs})
    return out


def _sentences(text):
    return [s.strip() for s in instructions_util._get_sentence_tokenizer().tokenize(text.replace('\n', ' ')) if s.strip()]


def _enough_sentences(text, pool, n):
    sents = _sentences(text)
    for extra in pool:
        if len(sents) >= n:
            break
        sents += _sentences(extra)
    return sents


def repair(iid, kw, text, rec, pool, rng):
    """One exact edit that makes `text` satisfy instruction `iid` (it may still fail; the caller re-checks)."""
    if iid == 'keywords:forbidden_words':
        for w in kw['forbidden_words']:
            text = re.sub(r'\b' + w + r'\b', '', text, flags=re.IGNORECASE)
        return re.sub(r'[ \t]{2,}', ' ', text)
    if iid in ('length_constraints:number_words', 'length_constraints:number_sentences'):
        words = iid.endswith('words')
        n, rel = (kw['num_words'] if words else kw['num_sentences']), kw['relation']
        count = instructions_util.count_words if words else instructions_util.count_sentences
        if rel == 'at least':
            for extra in pool:
                if count(text) >= n:
                    break
                text = text.rstrip() + '\n\n' + extra.strip()
            return text
        sents, kept = _sentences(text), []
        for s in sents:
            if count(' '.join(kept + [s])) >= n:
                break
            kept.append(s)
        if not kept and words:
            kept = [' '.join(text.split()[: max(1, n - 1)])]
        return ' '.join(kept)
    if iid == 'keywords:existence':
        return text.rstrip() + '\n\nThis brings to mind ' + ' and '.join(kw['keywords']) + '.'
    if iid == 'keywords:frequency':
        key, n = kw['keyword'], kw['frequency']
        if kw['relation'] == 'at least':
            have = len(re.findall(key, text, flags=re.IGNORECASE))
            return text.rstrip() + ''.join(f' The {key} matters.' for _ in range(max(0, n - have)))
        seen = [0]

        def cap(m):
            seen[0] += 1
            return m.group() if seen[0] < n else 'this'

        return re.sub(key, cap, text, flags=re.IGNORECASE)
    if iid == 'detectable_content:number_placeholders':
        names = (PLACEHOLDERS * 2)[: kw['num_placeholders']]
        return text.rstrip() + '\n\n' + '\n'.join(f'[{p}]' for p in names)
    if iid == 'detectable_format:number_highlighted_sections':
        sents, n = _sentences(text), kw['num_highlights']
        marked = [f'*{s.replace("*", "")}*' if i < n else s for i, s in enumerate(sents)]
        marked += [f'*point {i + 1}*' for i in range(max(0, n - len(sents)))]
        return ' '.join(marked)
    if iid == 'change_case:capital_word_frequency':
        n = kw['capital_frequency']
        if kw['capital_relation'] == 'at least':
            words = text.split(' ')
            done = 0
            for i, w in enumerate(words):
                if done >= n:
                    break
                if re.fullmatch(r'[A-Za-z]{2,}[.,!?]?', w) and not w.isupper():
                    words[i], done = w.upper(), done + 1
            return ' '.join(words)
        return re.sub(r'\b[A-Z]{1,}\b', lambda m: m.group().capitalize() if len(m.group()) > 1 else m.group().lower(), text)
    if iid == 'length_constraints:number_paragraphs':
        n = kw['num_paragraphs']
        sents = _enough_sentences(text, pool, n)
        if len(sents) < n:
            return text
        groups = [sents[round(i * len(sents) / n) : round((i + 1) * len(sents) / n)] for i in range(n)]
        return '\n\n***\n\n'.join(' '.join(g).replace('***', '') for g in groups)
    if iid == 'detectable_format:multiple_sections':
        n, split = kw['num_sections'], kw['section_spliter']
        sents = _enough_sentences(text, pool, n)
        if len(sents) < n:
            return text
        groups = [sents[round(i * len(sents) / n) : round((i + 1) * len(sents) / n)] for i in range(n)]
        return '\n\n'.join(f'{split} {i + 1}\n' + ' '.join(g) for i, g in enumerate(groups))
    if iid == 'detectable_format:number_bullet_lists':
        n = kw['num_bullets']
        sents = _enough_sentences(text, pool, n)
        return '\n'.join('* ' + s.lstrip('*- ').replace('\n', ' ') for s in sents[:n])
    if iid == 'detectable_format:constrained_response':
        return rng.choice(['My answer is yes.', 'My answer is no.', 'My answer is maybe.'])
    if iid == 'detectable_format:title':
        return f'<<{rec["topic"].title()}>>\n\n' + text.lstrip()
    if iid == 'detectable_content:postscript':
        return text.rstrip() + f'\n\n{kw["postscript_marker"]} {rng.choice(PS_LINES)}'
    if iid == 'startend:end_checker':
        return text.rstrip() + ' ' + kw['end_phrase']
    if iid == 'combination:two_responses':
        other = next((p for p in pool if p.strip() and p.strip() != text.strip()), None)
        return text.strip() + '\n******\n' + other.strip() if other else text
    if iid == 'combination:repeat_prompt':
        return kw['prompt_to_repeat'] + '\n\n' + text.lstrip()
    if iid == 'change_case:english_lowercase':
        return text.lower()
    if iid == 'change_case:english_capital':
        return text.upper()
    if iid == 'punctuation:no_comma':
        return text.replace(',', '')
    if iid == 'detectable_format:json_format':
        return json.dumps({'response': text}, indent=2).replace(',', '') if 'punctuation:no_comma' in rec['instruction_id_list'] else json.dumps({'response': text}, indent=2)
    if iid == 'startend:quotation':
        return '"' + text.strip().strip('"') + '"'
    return text


def passes(rec, text):
    return [follows(i, k, text, prompt=rec['prompt']) for i, k in zip(rec['instruction_id_list'], rec['kwargs'])]


def target(rec, samples, rng):
    """The kept response and how it was obtained, or (None, reason)."""
    verdicts = [passes(rec, s) for s in samples]
    for s, v in zip(samples, verdicts):
        if all(v):
            return s, 'sample'
    best = max(range(len(samples)), key=lambda i: sum(verdicts[i]))
    text, pool = samples[best], [s for i, s in enumerate(samples) if i != best]
    for iid in REPAIR_ORDER:
        if iid in rec['instruction_id_list']:
            kw = rec['kwargs'][rec['instruction_id_list'].index(iid)]
            if not follows(iid, kw, text, prompt=rec['prompt']):
                text = repair(iid, kw, text, rec, pool, rng)
    return (text, 'repair') if all(passes(rec, text)) else (None, 'unrepairable')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--out', default='data')
    ap.add_argument('--prompts', type=int, default=3000)
    ap.add_argument('--samples', type=int, default=4)
    ap.add_argument('--max-new-tokens', type=int, default=512)
    ap.add_argument('--temperature', type=float, default=0.8)
    ap.add_argument('--batch-size', type=int, default=16)
    ap.add_argument('--passages', type=int, default=200, help='background passages for long contexts')
    ap.add_argument('--long-frac', type=float, default=0.3, help='share of training inputs followed by background notes')
    ap.add_argument('--long-max', type=int, default=1500, help='longest background, in tokens, during training')
    ap.add_argument('--device', default='auto')
    ap.add_argument('--dtype', default='auto', help='frozen model precision: auto (bfloat16 on a GPU), float32, bfloat16')
    ap.add_argument('--seed', type=int, default=1234)
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    log = lambda m: print(f'[{time.time() - t0:7.0f}s] {m}', flush=True)
    dev = device_auto(a.device)
    lm, tok, _ = build(a.model, 'base', dev, dtype=a.dtype)
    lm.eval()

    # background passages written by the model itself, used to lengthen contexts
    rng = random.Random(a.seed)
    topics = [rng.choice(TOPICS) for _ in range(a.passages)]
    passages = generate(lm, tok, [f'Write a long, detailed article about {t}.' for t in topics], max_new_tokens=a.max_new_tokens,
                        temperature=a.temperature, top_p=0.95, batch_size=a.batch_size, seed=a.seed, log=log)
    (out / 'distractors.jsonl').write_text(''.join(json.dumps({'topic': t, 'text': p}) + '\n' for t, p in zip(topics, passages)), encoding='utf-8')
    log(f'{len(passages)} background passages')

    recs = make_prompts(a.prompts, a.seed)
    flat = [r['prompt'] for r in recs for _ in range(a.samples)]
    samples = generate(lm, tok, flat, max_new_tokens=a.max_new_tokens, temperature=a.temperature, top_p=0.95,
                       batch_size=a.batch_size, seed=a.seed + 1, log=log)
    stats = collections.Counter()
    by_type = collections.defaultdict(collections.Counter)
    kept = []
    corpus = '\n\n'.join(passages)
    corpus_ids = tok(corpus, add_special_tokens=False)['input_ids']
    for i, rec in enumerate(recs):
        mine = samples[i * a.samples : (i + 1) * a.samples]
        for iid in rec['instruction_id_list']:
            k = rec['kwargs'][rec['instruction_id_list'].index(iid)]
            by_type[iid]['sampled_pass'] += sum(follows(iid, k, s, prompt=rec['prompt']) for s in mine)
            by_type[iid]['sampled'] += len(mine)
        text, how = target(rec, mine, rng)
        stats[how] += 1
        for iid in rec['instruction_id_list']:
            by_type[iid][how] += 1
        if text is None:
            continue
        rec['response'], rec['source'] = text, how
        rec['input'] = rec['prompt']
        if corpus_ids and rng.random() < a.long_frac:
            L = rng.randint(64, a.long_max)
            s = rng.randrange(max(1, len(corpus_ids) - L))
            rec['input'] = with_distractor(rec['prompt'], tok.decode(corpus_ids[s : s + L]))
        kept.append(rec)
    rng.shuffle(kept)
    n_dev = max(1, len(kept) // 20)
    (out / 'dev.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in kept[:n_dev]), encoding='utf-8')
    (out / 'train.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in kept[n_dev:]), encoding='utf-8')
    summary = {'prompts': len(recs), 'kept': len(kept), 'how': dict(stats), 'by_type': {k: dict(v) for k, v in sorted(by_type.items())},
               'seconds': round(time.time() - t0), 'args': vars(a)}
    (out / 'stats.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    log(f'kept {len(kept)}/{len(recs)} ({dict(stats)}); wrote {out}')


if __name__ == '__main__':
    torch.set_grad_enabled(False)
    main()
