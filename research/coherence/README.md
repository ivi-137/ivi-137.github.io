# You need coherence: the experiment

Code, logs and results behind the post `src/content/posts/you-need-coherence.mdx`.

| file | what it does |
|---|---|
| `toy.py` | The task: an author's house style, example posts, a request in the default style, and the monitors that audit a written post |
| `model.py` | A small decoder-only transformer (pre-LN, RoPE, tied embeddings) and the Ledger, with the ablations |
| `train.py` | Trains one variant: `python train.py --variant ledger --seed 0 --steps 1500` |
| `evaluate.py` | Samples 300 posts (the same prompts for every run, temperature 1) and audits them; measures attention on the example posts |
| `aggregate.py` | Collects `results/*-s*.json` into `results/summary.json`, which the post reads at build time |
| `export.py` | Writes the float16 weights the page runs (`public/coherence/`) |
| `parity.py` | Reference logits for `scripts/check-coherence-net.mts`, which checks the browser implementation |
| `queue.sh` | Runs a list of `variant:seed` jobs (train, then evaluate) on chosen cores |

Setup: `python -m venv venv && venv/bin/pip install "jax[cpu]" optax numpy` (JAX 0.10, optax 0.2 were used). Every run is CPU-only and takes about 20 minutes to train and 12 to evaluate on two cores.

Variants: `base`, `base_aux` (same labels as the Ledger, on linear probes), `ledger`, `ledger_joint` (slots inside the ordinary softmax), `ledger_nogate`, `ledger_nosup`.

Trained parameters (`runs/*.pkl`) are not committed; `logs/` has every training curve and `results/` every audited sample.
