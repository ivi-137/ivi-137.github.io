"""The Ledger with the house-pattern obligations (patterns.py): labels, identity at insertion, the style heads, decoding."""
import math
import pathlib
import random
import sys

import numpy as np
import pytest
import torch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import patterns as pt  # noqa: E402
import specs  # noqa: E402
import tiny  # noqa: E402
from batching import collate, make_example  # noqa: E402
from chat import encode_response, eos_ids, generate  # noqa: E402
from ledger import LedgerConfig, LedgerLM  # noqa: E402
from load import ledger_params  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

LCFG = dict(clerk_layer=1, width=32, heads=4, spec='patterns')
SPEC = specs.get('patterns')
TOPICS = ['gardening', 'the ocean', 'coffee', 'bicycles', 'the moon', 'chess']


def fake_content(rng, n):
    words = 'water light soil prune rest share read walk plan map tide orbit'.split()
    return {'intro': 'Here is what I have learned.', 'items': [(rng.choice(words).title(), f'{rng.choice(words)} a little every day.') for _ in range(n)]}


def records(k=3, seed=0, n=4):
    rng = random.Random(seed)
    pool = {'train': [{'topic': t, 'n': rng.randint(2, 4), 'question': pt.question(t, 3, rng), 'content': fake_content(rng, 8)} for t in TOPICS for _ in range(2)]}
    out = []
    for i in range(k):
        rec = pt.make_record(rng, pool, 'train', n=n)
        rec['rules'].update(tldr=rec['rules']['tldr'] or 'TL;DR:', signoff=rec['rules']['signoff'] or 'Cheers, Ben')  # owe something
        rec['response'] = pt.render({'intro': '', 'items': [('Plan', 'walk every day.')] * n}, rec['rules'], 'chess', rng)
        rec['instruction_id_list'], rec['kwargs'] = pt.obligations(rec['rules'], n)
        out.append(rec)
    return out


@pytest.fixture(scope='module')
def model_dir(tmp_path_factory):
    return tiny.build(tmp_path_factory.mktemp('tiny'))


def fresh(model_dir, variant, perturb=False, lcfg=LCFG):
    torch.manual_seed(0)
    tok = AutoTokenizer.from_pretrained(model_dir)
    backbone = AutoModelForCausalLM.from_pretrained(model_dir, dtype=torch.float32, attn_implementation='sdpa')
    lm = LedgerLM(backbone, variant, LedgerConfig(**lcfg), lora_rank=4, eos_ids=eos_ids(tok)).eval()
    if perturb:
        g = torch.Generator().manual_seed(1)
        with torch.no_grad():
            for p in lm.parameters():
                if p.requires_grad:
                    p.add_(torch.randn(p.shape, generator=g) * 0.3)
            if lm.ledger is not None:
                lm.ledger.ev_b.fill_(-1.0)
                for r in lm.ledger.reads.values():
                    r.g.fill_(0.8)
                lm.ledger.gamma.fill_(0.5) if lm.ledger.cfg.gate else None
    return lm, tok


def batch(tok, recs=None):
    return collate([make_example(tok, r, tok.eos_token_id, 4096, SPEC) for r in recs or records()], tok.pad_token_id)


def ctx_of(lm, b):
    return lm.context('full', prompt_mask=b['prompt_mask'], resp_mask=b['resp_mask'], rmask=b['rmask'], numfeat=b['numfeat'])


def test_labels(model_dir):
    tok = AutoTokenizer.from_pretrained(model_dir)
    for rec in records(6, seed=3, n=5):
        ex = make_example(tok, rec, tok.eos_token_id, 4096, SPEC)
        on = {SPEC.SLOT[i] for i in rec['instruction_id_list']}
        assert set(np.flatnonzero(ex['applies'])) == on
        items = SPEC.SLOT['pattern:items']
        assert ex['relation'][items] == pt.EXACTLY and ex['nlog'][items] == pytest.approx(math.log1p(5))
        assert ex['event'][:, items].sum() == 5  # one event per item
        for key in ('tldr', 'signoff'):
            k = SPEC.SLOT[f'pattern:{key}']
            assert ex['paid'][-1, k] == 1 and ex['paid'][0, k] == 0 and np.all(np.diff(ex['paid'][:, k]) >= 0)
        assert ex['style'][SPEC.SLOT['pattern:marker']] == rec['rules']['marker']
        assert ex['style'][SPEC.SLOT['pattern:bold']] == rec['rules']['bold']
        assert (ex['style'][[SPEC.SLOT[f'pattern:{k}'] for k in ('lowercase', 'tldr', 'sources', 'signoff', 'items')]] == -100).all()
        # the response's tokens as encode_response cut them: the count is paid at the first letter of each item
        _, ends = encode_response(tok, rec['response'])
        assert len(ends) + 1 == len(ex['r_ids'])


def test_the_ifeval_ledger_is_unchanged(model_dir):
    """Style heads exist only for obligation sets with styles; IFEval's Ledger has the same parameters as before."""
    cfg = AutoModelForCausalLM.from_pretrained(model_dir).config
    lm, _ = fresh(model_dir, 'ledger', lcfg={k: v for k, v in LCFG.items() if k != 'spec'})
    assert lm.ledger.K == 23 and lm.ledger.S == 0 and not any('style' in n for n, _ in lm.ledger.named_parameters())
    lm, _ = fresh(model_dir, 'ledger')
    assert lm.ledger.K == SPEC.K and lm.ledger.S == len(pt.MARKERS)
    assert lm.ledger.style_w.shape == (SPEC.K, 32, len(pt.MARKERS))
    assert ledger_params(cfg, LedgerConfig(**LCFG)) == sum(p.numel() for p in lm.ledger.parameters())


@pytest.mark.parametrize('variant', ['lora', 'ledger', 'ledger_joint', 'ledger_nogate'])
def test_identity_at_insertion(model_dir, variant):
    base, tok = fresh(model_dir, 'base')
    lm, _ = fresh(model_dir, variant)
    b = batch(tok)
    pos = (b['attention_mask'].cumsum(-1) - 1).clamp(min=0)
    with torch.no_grad():
        ref = base.run(b['input_ids'], b['attention_mask'], pos, None, None, b['rmask'])
        if variant == 'ledger_joint':
            for r in lm.ledger.reads.values():
                r.g.fill_(0.0)
        got = lm.run(b['input_ids'], b['attention_mask'], pos, None, ctx_of(lm, b), b['rmask'])
    assert torch.allclose(ref, got, atol=1e-5), (ref - got).abs().max()


def test_style_heads_read_only_their_classes(model_dir):
    lm, tok = fresh(model_dir, 'ledger', perturb=True)
    b = batch(tok)
    pos = (b['attention_mask'].cumsum(-1) - 1).clamp(min=0)
    with torch.no_grad():
        ctx = ctx_of(lm, b)
        lm.run(b['input_ids'], b['attention_mask'], pos, None, ctx, b['rmask'])
    p = ctx.clerk['style_logit'].softmax(-1)  # [B, K, S]
    bold = SPEC.SLOT['pattern:bold']
    assert torch.allclose(p[:, bold, 2:], torch.zeros_like(p[:, bold, 2:]))  # bold is a two-way choice
    assert (p[:, SPEC.SLOT['pattern:marker']] > 0).all()  # the marker, eight
    # invariants are never owed: their state stays 0 and they never hold the gate
    inv = torch.tensor(SPEC.SHAPE == pt.G)
    assert (ctx.u[..., inv] == 0).all()


def test_gradients_reach_the_style_heads_and_the_clerk(model_dir):
    lm, tok = fresh(model_dir, 'ledger', perturb=True)
    lm.train()
    out = lm.loss(batch(tok))
    assert set(out) >= {'lm', 'rel', 'relation', 'number', 'state', 'style', 'total'} and out['style'] > 0
    out['total'].backward()
    named = dict(lm.ledger.named_parameters())
    for key in ('style_w', 'style_b', 'clerk_q', 'num_q', 'ev_b', 'rel_w'):
        assert named[key].grad is not None and named[key].grad.abs().sum() > 0, key
    # classes a slot does not have receive no gradient
    assert named['style_b'].grad[SPEC.SLOT['pattern:bold'], 2:].abs().sum() == 0
    assert named['style_b'].grad[SPEC.SLOT['pattern:tldr']].abs().sum() == 0


def test_the_clerk_can_learn_the_house_style(model_dir):
    """A few steps on four records: the style loss falls (the path from prompt to class is wired end to end)."""
    lm, tok = fresh(model_dir, 'ledger')
    b = batch(tok, records(4, seed=7))
    opt = torch.optim.Adam(lm.trainable(), lr=3e-2)
    lm.train()
    first = None
    for _ in range(40):
        out = lm.loss(b)
        first = first if first is not None else float(out['style'].detach())
        opt.zero_grad()
        (out['style'] + out['number']).backward()
        opt.step()
    last = float(out['style'].detach())
    assert last < 0.2 * first, (first, last)


@pytest.mark.parametrize('variant', ['ledger', 'ledger_joint'])
def test_decoding_matches_full_pass(model_dir, variant):
    lm, tok = fresh(model_dir, variant, perturb=True)
    rec = records(1, seed=5, n=2)[0]
    ex = make_example(tok, rec, tok.eos_token_id, 4096, SPEC)
    b = collate([ex], tok.pad_token_id)
    P, R = len(ex['p_ids']), min(24, len(ex['r_ids']))
    pos = (b['attention_mask'].cumsum(-1) - 1).clamp(min=0)
    with torch.no_grad():
        ctx = ctx_of(lm, b)
        full = lm.run(b['input_ids'], b['attention_mask'], pos, None, ctx, b['rmask'])[: R + 1]
        logits, sess = lm.prefill(b['input_ids'][:, :P], torch.ones(1, P, dtype=torch.long), b['numfeat'][:, :P])
        steps = torch.cat([logits] + [lm.decode(sess, b['input_ids'][:, P + t]) for t in range(R)])
    assert torch.allclose(full, steps, atol=1e-4), (full - steps).abs().max()


def test_generation(model_dir):
    lm, tok = fresh(model_dir, 'ledger', perturb=True)
    prompts = [r['prompt'] for r in records(2, seed=9)]
    both = generate(lm, tok, prompts, max_new_tokens=8, batch_size=2)
    assert both == [generate(lm, tok, [p], max_new_tokens=8, batch_size=1)[0] for p in prompts]
