"""Paired query-level bootstrap confidence intervals."""

from __future__ import annotations

import numpy as np

from .config import BOOTSTRAP_RESAMPLES, SEED


def paired_ci(
    a: np.ndarray,
    b: np.ndarray,
    n_resamples: int = BOOTSTRAP_RESAMPLES,
    seed: int = SEED,
    alpha: float = 0.05,
) -> dict[str, float]:
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    if len(a) != len(b) or len(a) == 0:
        return {'mean_delta': float('nan'), 'lo': float('nan'), 'hi': float('nan'), 'n': int(len(a))}
    delta = a - b
    mean = float(delta.mean())
    rng = np.random.default_rng(seed)
    n = len(delta)
    idx = rng.integers(0, n, size=(n_resamples, n))
    boot = delta[idx].mean(axis=1)
    lo = float(np.quantile(boot, alpha / 2))
    hi = float(np.quantile(boot, 1.0 - alpha / 2))
    return {
        'mean_delta': mean,
        'lo': lo,
        'hi': hi,
        'n': n,
        'p_positive': float(np.mean(boot > 0)),
        'p_noninferior_005': float(np.mean(boot >= -0.005)),
        'p_noninferior_01': float(np.mean(boot >= -0.01)),
    }
