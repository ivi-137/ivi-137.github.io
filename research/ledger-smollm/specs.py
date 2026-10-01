"""Obligation sets the Ledger can keep, by name: IFEval's stated instructions, or house patterns read from examples.
Each is a module with SLOTS, K, SLOT, SHAPE, POINTER, target(), token_targets(); patterns.py also has STYLES and
style_label() (classes the clerk must read off the examples). Modules load on first use, so the pattern study does
not need IFEval's code."""
import importlib

import numpy as np

NAMES = {'ifeval': 'obligations', 'patterns': 'patterns'}


def get(name):
    if name not in NAMES:
        raise KeyError(f'unknown obligation set {name!r}: one of {sorted(NAMES)}')
    return importlib.import_module(NAMES[name])


def styles(spec):
    """Number of style classes per slot (0: the slot carries no style)."""
    return np.asarray(getattr(spec, 'STYLES', np.zeros(spec.K, dtype=np.int64)))


def style_label(spec, iid, kw):
    return spec.style_label(iid, kw) if hasattr(spec, 'style_label') else -100
