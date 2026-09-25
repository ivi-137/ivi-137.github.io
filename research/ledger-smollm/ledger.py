"""
The Ledger (paper, Section 5) retrofitted to a frozen Hugging Face Llama-architecture model such as SmolLM2.

  clerk   after decoder layer l_c, one learned query per slot reads the prompt once; heads predict whether the
          slot's instruction applies, its relation, and its target number (a pointer over numbers in the prompt)
  state   each response token's layer-l_c state emits an event probability per slot; eventualities accumulate by
          noisy-OR, counts by summation (paper, eq. 2); pending weight pi = relevance * (1 - u)
  read    in every layer above l_c, after self-attention, each response position attends to the K slots with a
          softmax over the slots alone, added through tanh(g) with g = 0 at insertion
  gate    logit(eos) += gamma * sum over pending slots of log(1 - pi + eps), gamma = 0 at insertion

Variants built by LedgerLM:
  base           the frozen model
  lora           the frozen model plus LoRA adapters on q_proj and v_proj (the parameter-matched control)
  ledger         the Ledger as above
  ledger_joint   identical slots and state, but read inside the model's own attention softmax, as extra keys whose
                 share of the budget is scaled by lambda = g^2 (isolates Fact 1)
  ledger_nogate  the Ledger with gamma fixed at 0
lora, ledger and ledger_nogate compute exactly the base model's function at insertion; ledger_joint does so up to
lambda = 1e-4 at insertion (a softmax share cannot start at exactly zero and still learn; see JointKV).
"""
import contextvars
import math
from dataclasses import dataclass, field

import torch
import torch.nn as nn
import torch.nn.functional as fn
from transformers import AttentionInterface, DynamicCache
from transformers.masking_utils import ALL_MASK_ATTENTION_FUNCTIONS
from transformers.models.llama.modeling_llama import repeat_kv

import obligations as ob

VARIANTS = ('base', 'lora', 'ledger', 'ledger_joint', 'ledger_nogate')
FEATS = 4  # per slot and position: u, pi, relevance, progress towards a count
_ACTIVE: contextvars.ContextVar = contextvars.ContextVar('ledger_ctx', default=None)


@dataclass
class LedgerConfig:
    clerk_layer: int = 9  # index of the decoder layer whose output the clerk and the events read
    width: int = 128
    heads: int = 4
    eps: float = 1e-3
    joint: bool = False
    gate: bool = True


@dataclass
class Ctx:
    """What one forward pass needs to know about the ledger; persists across decoding steps."""

    ledger: 'Ledger'
    mode: str  # 'full' (training, prefill: run the clerk) or 'step' (decode: reuse the clerk, carry the state)
    prompt_mask: torch.Tensor | None = None  # [B,T] positions the clerk reads
    resp_mask: torch.Tensor | None = None  # [B,T] response tokens (events are counted)
    rmask: torch.Tensor | None = None  # [B,T] positions that read the ledger and whose eos is gated
    numfeat: torch.Tensor | None = None  # [B,T,2] (is a number, log1p(value))
    clerk: dict = field(default_factory=dict)
    slot_kv: dict = field(default_factory=dict)
    carry: tuple | None = None
    e: torch.Tensor | None = None
    u: torch.Tensor | None = None
    pi: torch.Tensor | None = None
    feats: torch.Tensor | None = None
    gate: torch.Tensor | None = None


class Read(nn.Module):
    """Own-softmax read over the K slots. Slot keys are W_k o_i plus a rank-4 update from the slot's state, so
    the per-token cost is O(d*w + K*w): the slot projections are computed once per prompt (paper, Prop. 6 (v))."""

    def __init__(self, d, w, heads):
        super().__init__()
        self.h, self.dh = heads, w // heads
        self.q = nn.Linear(d, w, bias=False)
        self.k = nn.Linear(w, w, bias=False)
        self.v = nn.Linear(w, w, bias=False)
        self.kf = nn.Parameter(torch.randn(FEATS, w) * 0.02)
        self.vf = nn.Parameter(torch.randn(FEATS, w) * 0.02)
        self.out = nn.Linear(w, d, bias=False)
        nn.init.normal_(self.out.weight, std=0.02)
        self.g = nn.Parameter(torch.zeros(()))

    def slots(self, o):
        return self.k(o), self.v(o)  # [B,K,w] each

    def forward(self, x, ko, vo, f):
        B, T, _ = x.shape
        h, dh = self.h, self.dh
        q = self.q(x).view(B, T, h, dh)
        s = torch.einsum('bthd,bkhd->bthk', q, ko.view(B, -1, h, dh))
        s = s + torch.einsum('bthc,btkc->bthk', torch.einsum('bthd,chd->bthc', q, self.kf.view(FEATS, h, dh)), f)
        a = (s * dh**-0.5).softmax(-1)
        out = torch.einsum('bthk,bkhd->bthd', a, vo.view(B, -1, h, dh))
        out = out + torch.einsum('bthc,chd->bthd', torch.einsum('bthk,btkc->bthc', a, f), self.vf.view(FEATS, h, dh))
        return torch.tanh(self.g) * self.out(out.reshape(B, T, -1))


class JointKV(nn.Module):
    """Slots as extra keys and values inside a layer's own attention (the shared-softmax control)."""

    def __init__(self, w, kv_heads, head_dim):
        super().__init__()
        self.hkv, self.dh = kv_heads, head_dim
        self.k = nn.Linear(w, kv_heads * head_dim, bias=False)
        self.v = nn.Linear(w, kv_heads * head_dim, bias=False)
        self.kf = nn.Parameter(torch.randn(FEATS, kv_heads * head_dim) * 0.02)
        self.vf = nn.Parameter(torch.randn(FEATS, kv_heads * head_dim) * 0.02)
        # The slots' share of the softmax is scaled by lambda = g^2: never negative (a softmax), never stuck at 0
        # (unlike max(g, 0), whose gradient vanishes once g < 0), and nearly closed at insertion (lambda = 1e-4).
        self.g = nn.Parameter(torch.tensor(0.01))

    @property
    def lam(self):
        return self.g * self.g

    def slots(self, o):
        B, K, _ = o.shape
        return (self.k(o).view(B, K, self.hkv, self.dh).transpose(1, 2), self.v(o).view(B, K, self.hkv, self.dh).transpose(1, 2))


class Ledger(nn.Module):
    def __init__(self, lcfg: LedgerConfig, mcfg):
        super().__init__()
        d, w, K = mcfg.hidden_size, lcfg.width, ob.K
        self.cfg, self.w = lcfg, w
        self.register_buffer('isF', torch.tensor(ob.SHAPE == ob.F), persistent=False)
        self.register_buffer('isN', torch.tensor(ob.SHAPE == ob.N), persistent=False)
        self.register_buffer('pointer', torch.tensor(ob.POINTER), persistent=False)
        self.norm = nn.RMSNorm(d, eps=mcfg.rms_norm_eps)
        # clerk
        self.clerk_q = nn.Parameter(torch.randn(K, w) * w**-0.5)
        self.clerk_k = nn.Linear(d + 2, w, bias=False)
        self.clerk_v = nn.Linear(d + 2, w, bias=False)
        self.num_q = nn.Parameter(torch.randn(K, w) * w**-0.5)
        self.num_k = nn.Linear(d + 2, w, bias=False)
        self.rel_w = nn.Parameter(torch.zeros(K, w))
        self.rel_b = nn.Parameter(torch.zeros(K))
        self.relation_w = nn.Parameter(torch.zeros(K, w, 3))
        self.relation_b = nn.Parameter(torch.zeros(K, 3))
        self.count_w = nn.Parameter(torch.zeros(K, w))  # target counts not written as numbers (keywords)
        self.count_b = nn.Parameter(torch.zeros(K))
        # events
        self.ev_h = nn.Linear(d, w, bias=False)
        self.ev_o = nn.Linear(w, w, bias=False)
        self.ev_b = nn.Parameter(torch.full((K,), -6.0))
        # gate
        self.gamma = nn.Parameter(torch.zeros(()), requires_grad=lcfg.gate)
        # reads, in every layer above the clerk
        layers = range(lcfg.clerk_layer + 1, mcfg.num_hidden_layers)
        head_dim = getattr(mcfg, 'head_dim', None) or d // mcfg.num_attention_heads
        make = (lambda: JointKV(w, mcfg.num_key_value_heads, head_dim)) if lcfg.joint else (lambda: Read(d, w, lcfg.heads))
        self.reads = nn.ModuleDict({str(i): make() for i in layers})

    # ── clerk: read the prompt once ──
    def clerk(self, h, prompt_mask, numfeat):
        z = torch.cat([self.norm(h), numfeat.to(h.dtype)], -1)
        scale = self.w**-0.5
        s = torch.einsum('kw,btw->bkt', self.clerk_q, self.clerk_k(z)) * scale
        s = s.masked_fill(~prompt_mask[:, None, :], float('-inf'))
        o = torch.einsum('bkt,btw->bkw', s.softmax(-1), self.clerk_v(z))
        is_num = prompt_mask & (numfeat[..., 0] > 0)
        sn = torch.einsum('kw,btw->bkt', self.num_q, self.num_k(z)) * scale
        # a finite fill keeps gradients clean when a prompt has no numbers (the pointer then reads 0)
        sn = sn.masked_fill(~is_num[:, None, :], -1e9)
        an = sn.softmax(-1) * is_num[:, None, :] * is_num.any(-1)[:, None, None]
        pointed = torch.einsum('bkt,bt->bk', an, numfeat[..., 1].to(h.dtype))
        regressed = (o * self.count_w).sum(-1) + self.count_b
        return {
            'o': o,
            'rel_logit': (o * self.rel_w).sum(-1) + self.rel_b,
            'relation_logit': torch.einsum('bkw,kwc->bkc', o, self.relation_w) + self.relation_b,
            'nhat_log': torch.where(self.pointer, pointed, regressed),
        }

    # ── state: events accumulate per slot type ──
    def events(self, h, o):
        s = torch.einsum('btw,bkw->btk', self.ev_h(self.norm(h)), self.ev_o(o)) * self.w**-0.5
        return torch.sigmoid(s + self.ev_b) * (self.isF | self.isN)

    def state(self, e, c, carry):
        logq0, cnt0 = carry
        logq = logq0[:, None] + torch.cumsum(torch.log1p(-e.clamp(max=1 - 1e-6)), 1)
        cnt = cnt0[:, None] + torch.cumsum(e, 1)
        nhat = torch.expm1(c['nhat_log']).clamp(min=0)[:, None]
        u = torch.where(self.isF, 1 - torch.exp(logq), torch.where(self.isN, torch.sigmoid(4 * (cnt - nhat + 0.5)), 0.0))
        rel = torch.sigmoid(c['rel_logit'])
        relp = c['relation_logit'].softmax(-1)
        holds = torch.where(self.isN, relp[..., ob.AT_LEAST] + relp[..., ob.EXACTLY], self.isF.to(rel.dtype))
        pi = (rel * holds)[:, None] * (1 - u)
        prog = torch.where(self.isN, (cnt / nhat.clamp(min=1)).clamp(0, 2), 0.0)
        feats = torch.stack([u, pi, rel[:, None].expand_as(u), prog], -1)
        return u, pi, feats, (logq[:, -1], cnt[:, -1])

    def observe(self, h, ctx: Ctx):
        """Called with the output of layer l_c: fill the context for the layers above and for the gate."""
        B = h.shape[0]
        if ctx.mode == 'full':
            ctx.clerk = self.clerk(h, ctx.prompt_mask, ctx.numfeat)
            ctx.slot_kv = {i: r.slots(ctx.clerk['o']) for i, r in self.reads.items()}
            ctx.carry = (h.new_zeros(B, ob.K), h.new_zeros(B, ob.K))
        e = self.events(h, ctx.clerk['o']) * ctx.resp_mask[..., None]
        u, pi, feats, carry = self.state(e, ctx.clerk, ctx.carry)
        ctx.e, ctx.u, ctx.pi, ctx.feats, ctx.carry = e, u, pi, feats, carry
        owed = (self.isF | self.isN).to(pi.dtype)
        ctx.gate = (torch.log(1 - pi + self.cfg.eps) * owed).sum(-1) * ctx.rmask


QUERY_BLOCK = 1024  # without gradients, long prompts are processed in blocks of queries to bound memory


def _joint_attention(module, query, key, value, attention_mask, scaling, dropout=0.0, **kwargs):
    """Eager attention; in the joint variant's read layers the slots join the same softmax as the context."""
    ks, vs = repeat_kv(key, module.num_key_value_groups), repeat_kv(value, module.num_key_value_groups)
    ctx = _ACTIVE.get()
    lid = str(module.layer_idx)
    joint = ctx is not None and ctx.feats is not None and lid in ctx.ledger.reads
    T = query.shape[2]
    size = QUERY_BLOCK if (T > QUERY_BLOCK and not torch.is_grad_enabled()) else T
    outs = []
    for a in range(0, T, size):
        rows = slice(a, a + size)
        s = torch.matmul(query[:, :, rows], ks.transpose(2, 3)) * scaling
        if attention_mask is not None:
            m = attention_mask[:, :, rows]
            s = s.masked_fill(~m, float('-inf')) if m.dtype == torch.bool else s + m
        if joint:
            outs.append(_joint_block(module, ctx, lid, query[:, :, rows], s, vs, scaling, rows))
        else:
            outs.append(torch.matmul(fn.softmax(s, dim=-1, dtype=torch.float32).to(query.dtype), vs))
    return torch.cat(outs, 2).transpose(1, 2).contiguous(), None


def _joint_block(module, ctx, lid, query, s, vs, scaling, rows):
    """One block of query rows: context scores s and slot scores normalised together."""
    jkv = ctx.ledger.reads[lid]
    groups = module.num_key_value_groups
    ko, vo = (t.repeat_interleave(groups, dim=1) for t in ctx.slot_kv[lid])  # [B,H,K,dh]
    kf = jkv.kf.view(FEATS, jkv.hkv, jkv.dh).repeat_interleave(groups, dim=1)
    vf = jkv.vf.view(FEATS, jkv.hkv, jkv.dh).repeat_interleave(groups, dim=1)
    f = ctx.feats[:, rows]
    se = torch.einsum('bhtd,bhkd->bhtk', query, ko) + torch.einsum('bhtc,btkc->bhtk', torch.einsum('bhtd,chd->bhtc', query, kf), f)
    se = (se * scaling).masked_fill(~ctx.rmask[:, rows][:, None, :, None], float('-inf'))
    m = torch.maximum(s.amax(-1, keepdim=True), se.amax(-1, keepdim=True))
    ps, pe = torch.exp(s - m), torch.exp(se - m)
    lam = jkv.lam
    extra = torch.einsum('bhtk,bhkd->bhtd', pe, vo) + torch.einsum('bhtc,chd->bhtd', torch.einsum('bhtk,btkc->bhtc', pe, f), vf)
    return (torch.matmul(ps, vs) + lam * extra) / (ps.sum(-1, keepdim=True) + lam * pe.sum(-1, keepdim=True))


AttentionInterface.register('ledger_eager', _joint_attention)
ALL_MASK_ATTENTION_FUNCTIONS.register('ledger_eager', ALL_MASK_ATTENTION_FUNCTIONS['eager'])


class LoRALinear(nn.Module):
    def __init__(self, base: nn.Linear, rank: int, alpha: float = None):
        super().__init__()
        self.base = base
        self.a = nn.Parameter(torch.randn(rank, base.in_features) / math.sqrt(base.in_features))
        self.b = nn.Parameter(torch.zeros(base.out_features, rank))
        self.scale = (alpha or rank) / rank

    def forward(self, x):
        return self.base(x) + (x @ self.a.t() @ self.b.t()) * self.scale


class LedgerLM(nn.Module):
    """A frozen causal LM with an optional Ledger or LoRA; training loss, prefill and decoding."""

    def __init__(self, backbone, variant='base', lcfg: LedgerConfig | None = None, lora_rank=64, eos_ids=()):
        super().__init__()
        assert variant in VARIANTS, variant
        self.backbone, self.variant = backbone, variant
        for p in backbone.parameters():
            p.requires_grad_(False)
        self.ledger = None
        if variant.startswith('ledger'):
            lcfg = lcfg or LedgerConfig()
            lcfg.joint = variant == 'ledger_joint'
            lcfg.gate = variant != 'ledger_nogate'
            self.ledger = Ledger(lcfg, backbone.config)
            layers = backbone.model.layers
            layers[lcfg.clerk_layer].register_forward_hook(self._observe)
            if lcfg.joint:
                backbone.config._attn_implementation = 'ledger_eager'
            else:
                for i in self.ledger.reads:
                    layers[int(i)].self_attn.register_forward_hook(self._read(i), with_kwargs=True)
        if variant == 'lora':
            for layer in backbone.model.layers:
                layer.self_attn.q_proj = LoRALinear(layer.self_attn.q_proj, lora_rank)
                layer.self_attn.v_proj = LoRALinear(layer.self_attn.v_proj, lora_rank)
        self.register_buffer('eos_ids', torch.tensor(sorted(set(eos_ids)), dtype=torch.long), persistent=False)

    # ── hooks ──
    def _observe(self, module, args, output):
        ctx = _ACTIVE.get()
        if ctx is not None:
            self.ledger.observe(output[0] if isinstance(output, tuple) else output, ctx)

    def _read(self, i):
        def hook(module, args, kwargs, output):
            ctx = _ACTIVE.get()
            if ctx is None or ctx.feats is None:
                return output
            x = kwargs['hidden_states'] if 'hidden_states' in kwargs else args[0]
            out = self.ledger.reads[i](x, *ctx.slot_kv[i], ctx.feats) * ctx.rmask[..., None]
            return (output[0] + out.to(output[0].dtype),) + tuple(output[1:])

        return hook

    def trainable(self):
        return [p for p in self.parameters() if p.requires_grad]

    def trainable_state(self):
        names = {id(p) for p in self.trainable()}
        return {k: v.detach().cpu() for k, v in self.named_parameters() if id(v) in names}

    # ── one pass through the backbone ──
    def run(self, input_ids, attention_mask, position_ids, cache, ctx, select):
        token = _ACTIVE.set(ctx)
        try:
            out = self.backbone.model(
                input_ids=input_ids,
                attention_mask=attention_mask,
                position_ids=position_ids,
                past_key_values=cache,
                use_cache=cache is not None,
            )
        finally:
            _ACTIVE.reset(token)
        logits = self.backbone.lm_head(out.last_hidden_state[select])
        if ctx is not None and ctx.gate is not None and self.ledger.cfg.gate and len(self.eos_ids):
            bias = torch.zeros(logits.shape[-1], device=logits.device, dtype=logits.dtype).index_fill(0, self.eos_ids, 1.0)
            logits = logits + (self.ledger.gamma * ctx.gate[select])[:, None].to(logits.dtype) * bias
        return logits

    def context(self, mode, **kw):
        return Ctx(ledger=self.ledger, mode=mode, **kw) if self.ledger is not None else None

    # ── training ──
    def loss(self, batch, lam_ext=0.3, lam_ev=0.3):
        ids, attn = batch['input_ids'], batch['attention_mask']
        position_ids = (attn.cumsum(-1) - 1).clamp(min=0)
        ctx = self.context('full', prompt_mask=batch['prompt_mask'], resp_mask=batch['resp_mask'], rmask=batch['rmask'], numfeat=batch['numfeat'])
        lm_pos = batch['lm_mask']  # positions whose next token is a response token
        logits = self.run(ids, attn, position_ids, None, ctx, lm_pos)
        target = ids[:, 1:][lm_pos[:, :-1]]
        out = {'lm': fn.cross_entropy(logits.float(), target)}
        if ctx is not None:
            out.update(self._aux(ctx, batch))
            out['total'] = out['lm'] + lam_ext * (out['rel'] + out['relation'] + out['number']) + lam_ev * out['state']
        else:
            out['total'] = out['lm']
        return out

    def _aux(self, ctx, batch):
        c, applies = ctx.clerk, batch['applies']  # [B,K] float
        out = {'rel': fn.binary_cross_entropy_with_logits(c['rel_logit'].float(), applies)}
        isN = self.ledger.isN[None] & (applies > 0)
        rt = batch['relation'].masked_fill(~isN, -100)
        out['relation'] = fn.cross_entropy(c['relation_logit'].float().reshape(-1, 3), rt.reshape(-1), ignore_index=-100) if isN.any() else c['rel_logit'].sum() * 0
        out['number'] = ((c['nhat_log'].float() - batch['nlog']) ** 2)[isN].mean() if isN.any() else c['rel_logit'].sum() * 0
        resp = batch['resp_mask'][..., None]
        f_mask = resp & (self.ledger.isF[None, None] & (applies[:, None] > 0))
        n_mask = resp & (self.ledger.isN[None, None] & (applies[:, None] > 0))
        terms = []
        if f_mask.any():
            terms.append(fn.binary_cross_entropy(ctx.u.float().clamp(1e-6, 1 - 1e-6)[f_mask], batch['paid'][f_mask]))
        if n_mask.any():
            terms.append(fn.binary_cross_entropy(ctx.e.float().clamp(1e-6, 1 - 1e-6)[n_mask], batch['event'][n_mask]))
        out['state'] = sum(terms) / len(terms) if terms else c['rel_logit'].sum() * 0
        return out

    # ── generation ──
    @torch.no_grad()
    def prefill(self, input_ids, attention_mask, numfeat):
        B, T = input_ids.shape
        position_ids = (attention_mask.cumsum(-1) - 1).clamp(min=0)
        last = torch.zeros(B, T, dtype=torch.bool, device=input_ids.device)
        last[:, -1] = True
        ctx = self.context(
            'full', prompt_mask=attention_mask.bool(), resp_mask=torch.zeros_like(last), rmask=last, numfeat=numfeat
        )
        cache = DynamicCache(config=self.backbone.config)
        logits = self.run(input_ids, attention_mask, position_ids, cache, ctx, last)
        return logits, {'ctx': ctx, 'cache': cache, 'mask': attention_mask, 'pos': position_ids[:, -1] + 1}

    @torch.no_grad()
    def decode(self, session, next_ids):
        B = next_ids.shape[0]
        one = torch.ones(B, 1, dtype=torch.bool, device=next_ids.device)
        session['mask'] = torch.cat([session['mask'], one.to(session['mask'].dtype)], 1)
        ctx = session['ctx']
        if ctx is not None:
            ctx.mode, ctx.resp_mask, ctx.rmask = 'step', one, one
        pos = session['pos'][:, None]
        session['pos'] = session['pos'] + 1
        return self.run(next_ids[:, None], session['mask'], pos, session['cache'], ctx, one)
