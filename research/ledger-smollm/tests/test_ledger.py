"""The Ledger's defining properties, checked on a tiny model with SmolLM2's architecture."""
import copy
import pathlib
import sys

import pytest
import torch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import obligations as ob  # noqa: E402
import tiny  # noqa: E402
from batching import collate, make_example, to  # noqa: E402
from chat import eos_ids, generate  # noqa: E402
from ledger import LedgerConfig, LedgerLM  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

LCFG = dict(clerk_layer=1, width=32, heads=4)
RECS = [
    {'prompt': 'Write a note about 3 cats. Your response should contain at least 12 words. End it with P.S.',
     'response': 'Cats are small, soft and curious. They sleep a lot and purr.\nP.S. feed them.',
     'instruction_id_list': ['length_constraints:number_words', 'detectable_content:postscript'],
     'kwargs': [{'relation': 'at least', 'num_words': 12}, {'postscript_marker': 'P.S.'}]},
    {'prompt': 'List exactly 2 bullet points about rain, all in lowercase.',
     'response': '* rain is wet\n* rain is loud',
     'instruction_id_list': ['detectable_format:number_bullet_lists', 'change_case:english_lowercase'],
     'kwargs': [{'num_bullets': 2}, {}]},
]


@pytest.fixture(scope='module')
def model_dir(tmp_path_factory):
    return tiny.build(tmp_path_factory.mktemp('tiny'))


def fresh(model_dir, variant, perturb=False, dtype=torch.float32):
    torch.manual_seed(0)  # the Ledger's initial weights
    tok = AutoTokenizer.from_pretrained(model_dir)
    backbone = AutoModelForCausalLM.from_pretrained(model_dir, dtype=dtype, attn_implementation='sdpa')
    lm = LedgerLM(backbone, variant, LedgerConfig(**LCFG), lora_rank=4, eos_ids=eos_ids(tok)).eval()
    if perturb:
        g = torch.Generator().manual_seed(1)
        with torch.no_grad():
            for n, p in lm.named_parameters():
                if p.requires_grad:
                    p.add_(torch.randn(p.shape, generator=g) * 0.3)
            if lm.ledger is not None:
                lm.ledger.ev_b.fill_(-1.0)
                for r in lm.ledger.reads.values():
                    r.g.fill_(0.8)
                lm.ledger.gamma.fill_(0.5) if lm.ledger.cfg.gate else None
    return lm, tok


def batch(tok):
    return collate([make_example(tok, r, tok.eos_token_id) for r in RECS], tok.pad_token_id)


@pytest.mark.parametrize('variant', ['lora', 'ledger', 'ledger_joint', 'ledger_nogate'])
def test_identity_at_insertion(model_dir, variant):
    base, tok = fresh(model_dir, 'base')
    lm, _ = fresh(model_dir, variant)
    b = batch(tok)
    pos = (b['attention_mask'].cumsum(-1) - 1).clamp(min=0)
    with torch.no_grad():
        ref = base.run(b['input_ids'], b['attention_mask'], pos, None, None, b['attention_mask'].bool())
        ctx = lm.context('full', prompt_mask=b['prompt_mask'], resp_mask=b['resp_mask'], rmask=b['rmask'], numfeat=b['numfeat'])
        got = lm.run(b['input_ids'], b['attention_mask'], pos, None, ctx, b['attention_mask'].bool())
        if variant == 'ledger_joint':
            assert torch.allclose(ref, got, atol=1e-2)  # lambda = 1e-4 at insertion: nearly closed
            for r in lm.ledger.reads.values():
                r.g.fill_(0.0)
            ctx = lm.context('full', prompt_mask=b['prompt_mask'], resp_mask=b['resp_mask'], rmask=b['rmask'], numfeat=b['numfeat'])
            got = lm.run(b['input_ids'], b['attention_mask'], pos, None, ctx, b['attention_mask'].bool())
    assert torch.allclose(ref, got, atol=1e-5), (ref - got).abs().max()


@pytest.mark.parametrize('variant', ['lora', 'ledger', 'ledger_joint', 'ledger_nogate'])
def test_open_gates_change_the_function(model_dir, variant):
    """Guards the identity test against passing vacuously: with gates open, each variant's path is really used."""
    base, tok = fresh(model_dir, 'base')
    lm, _ = fresh(model_dir, variant, perturb=True)
    b = batch(tok)
    pos = (b['attention_mask'].cumsum(-1) - 1).clamp(min=0)
    with torch.no_grad():
        ref = base.run(b['input_ids'], b['attention_mask'], pos, None, None, b['rmask'])
        ctx = lm.context('full', prompt_mask=b['prompt_mask'], resp_mask=b['resp_mask'], rmask=b['rmask'], numfeat=b['numfeat'])
        got = lm.run(b['input_ids'], b['attention_mask'], pos, None, ctx, b['rmask'])
        if variant == 'ledger_joint':
            for r in lm.ledger.reads.values():
                r.g.fill_(0.0)
            lm.ledger.gamma.fill_(0.0)
            ctx = lm.context('full', prompt_mask=b['prompt_mask'], resp_mask=b['resp_mask'], rmask=b['rmask'], numfeat=b['numfeat'])
            closed = lm.run(b['input_ids'], b['attention_mask'], pos, None, ctx, b['rmask'])
            assert torch.allclose(ref, closed, atol=1e-5)  # the difference came from the slots in the softmax
    assert (ref - got).abs().max() > 1e-3


@pytest.mark.parametrize('variant', ['ledger', 'ledger_joint'])
def test_decoding_matches_full_pass(model_dir, variant):
    """Prefill + step-by-step decoding (with a KV cache and the carried state) equals one teacher-forced pass."""
    lm, tok = fresh(model_dir, variant, perturb=True)
    ex = make_example(tok, RECS[0], tok.eos_token_id)
    b = collate([ex], tok.pad_token_id)
    P, R = len(ex['p_ids']), len(ex['r_ids'])
    pos = (b['attention_mask'].cumsum(-1) - 1).clamp(min=0)
    with torch.no_grad():
        ctx = lm.context('full', prompt_mask=b['prompt_mask'], resp_mask=b['resp_mask'], rmask=b['rmask'], numfeat=b['numfeat'])
        full = lm.run(b['input_ids'], b['attention_mask'], pos, None, ctx, b['rmask'])  # positions P-1 .. P+R-1
        ids = b['input_ids'][:, :P]
        logits, sess = lm.prefill(ids, torch.ones_like(ids), b['numfeat'][:, :P])
        steps = [logits]
        for t in range(R):
            steps.append(lm.decode(sess, b['input_ids'][:, P + t]))
    steps = torch.cat(steps)
    assert torch.allclose(full, steps, atol=1e-4), (full - steps).abs().max()
    assert torch.allclose(ctx.u[0, -1], sess['ctx'].u[0, -1], atol=1e-5)


def test_left_padded_generation_matches_single(model_dir):
    lm, tok = fresh(model_dir, 'ledger', perturb=True)
    prompts = [r['prompt'] for r in RECS]
    both = generate(lm, tok, prompts, max_new_tokens=12, batch_size=2)
    one = [generate(lm, tok, [p], max_new_tokens=12, batch_size=1)[0] for p in prompts]
    assert both == one


def test_gradients_reach_only_the_ledger(model_dir):
    lm, tok = fresh(model_dir, 'ledger', perturb=True)
    lm.train()
    out = lm.loss(batch(tok))
    out['total'].backward()
    assert all(p.grad is None for p in lm.backbone.parameters() if not p.requires_grad)
    named = dict(lm.ledger.named_parameters())
    for key in ('clerk_q', 'num_q', 'rel_w', 'relation_w', 'ev_b', 'gamma', 'reads.2.q.weight', 'reads.3.out.weight'):
        assert named[key].grad is not None and named[key].grad.abs().sum() > 0, key
    assert set(out) >= {'lm', 'rel', 'relation', 'number', 'state', 'total'}


def test_state_is_monotone(model_dir):
    lm, tok = fresh(model_dir, 'ledger', perturb=True)
    b = batch(tok)
    pos = (b['attention_mask'].cumsum(-1) - 1).clamp(min=0)
    with torch.no_grad():
        ctx = lm.context('full', prompt_mask=b['prompt_mask'], resp_mask=b['resp_mask'], rmask=b['rmask'], numfeat=b['numfeat'])
        lm.run(b['input_ids'], b['attention_mask'], pos, None, ctx, b['rmask'])
    owed = torch.tensor(ob.SHAPE != ob.G)
    du = ctx.u[..., owed].diff(dim=1)
    assert (du >= -1e-6).all()
    assert (ctx.u[..., ~owed] == 0).all()


def test_blocked_joint_attention_matches(model_dir, monkeypatch):
    """Long prompts go through the joint attention in blocks of query rows; the result must not change."""
    import ledger as L
    lm, tok = fresh(model_dir, 'ledger_joint', perturb=True)
    b = batch(tok)
    ids, mask, feat = b['input_ids'][:, :40], b['attention_mask'][:, :40], b['numfeat'][:, :40]
    whole, _ = lm.prefill(ids, mask, feat)
    monkeypatch.setattr(L, 'BLOCK_ELEMENTS', 1)  # 16-row blocks
    blocked, _ = lm.prefill(ids, mask, feat)
    assert torch.allclose(whole, blocked, atol=1e-5)


def test_recomputed_blocks_give_the_same_gradients(model_dir, monkeypatch):
    """In training the joint attention recomputes each block in the backward pass; gradients must not change."""
    import ledger as L
    grads = []
    for elements in (2**40, 1):
        monkeypatch.setattr(L, 'BLOCK_ELEMENTS', elements)
        lm, tok = fresh(model_dir, 'ledger_joint', perturb=True)
        lm.loss(batch(tok))['total'].backward()
        grads.append({n: p.grad.clone() for n, p in lm.named_parameters() if p.requires_grad and p.grad is not None})
    assert grads[0].keys() == grads[1].keys() and len(grads[0]) > 10
    for n in grads[0]:
        assert torch.allclose(grads[0][n], grads[1][n], atol=1e-5, rtol=1e-4), n


@pytest.mark.parametrize('variant', ['lora', 'ledger', 'ledger_nogate', 'ledger_joint'])
def test_bfloat16_backbone(model_dir, variant):
    """With a bfloat16 frozen model (the default on GPUs): identity at insertion, and decoding matches a full pass."""
    base, tok = fresh(model_dir, 'base', dtype=torch.bfloat16)
    lm, _ = fresh(model_dir, variant, dtype=torch.bfloat16)
    b = batch(tok)
    pos = (b['attention_mask'].cumsum(-1) - 1).clamp(min=0)
    with torch.no_grad():
        ref = base.run(b['input_ids'], b['attention_mask'], pos, None, None, b['rmask'])
        ctx = lm.context('full', prompt_mask=b['prompt_mask'], resp_mask=b['resp_mask'], rmask=b['rmask'], numfeat=b['numfeat'])
        got = lm.run(b['input_ids'], b['attention_mask'], pos, None, ctx, b['rmask'])
    if variant == 'ledger_joint':  # float32 attention against the bfloat16 kernel, lambda = 1e-4
        assert (ref.float() - got.float()).abs().max() < 0.1
    else:
        assert torch.equal(ref, got)
    lm, _ = fresh(model_dir, variant, perturb=True, dtype=torch.bfloat16)
    ex = make_example(tok, RECS[0], tok.eos_token_id)
    b = collate([ex], tok.pad_token_id)
    P, R = len(ex['p_ids']), len(ex['r_ids'])
    pos = (b['attention_mask'].cumsum(-1) - 1).clamp(min=0)
    with torch.no_grad():
        ctx = lm.context('full', prompt_mask=b['prompt_mask'], resp_mask=b['resp_mask'], rmask=b['rmask'], numfeat=b['numfeat'])
        full = lm.run(b['input_ids'], b['attention_mask'], pos, None, ctx, b['rmask']).float()
        logits, sess = lm.prefill(b['input_ids'][:, :P], torch.ones(1, P, dtype=torch.long), b['numfeat'][:, :P])
        steps = [logits] + [lm.decode(sess, b['input_ids'][:, P + t]) for t in range(R)]
    steps = torch.cat(steps).float()
    assert (full - steps).abs().max() < 0.15 * full.abs().max()
    assert (full.argmax(-1) == steps.argmax(-1)).float().mean() > 0.9
    lm.train()
    out = lm.loss(b)
    out['total'].backward()
    assert all(p.grad is not None and p.grad.dtype == torch.float32 for p in lm.trainable() if p.requires_grad and p.numel() > 1)
