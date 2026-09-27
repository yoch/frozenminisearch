"""Paired query-level bootstrap confidence intervals on OOF predictions."""

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
    rng = np.random.default_rng(seed)
    n = len(delta)
    idx = rng.integers(0, n, size=(n_resamples, n))
    boot = delta[idx].mean(axis=1)
    lo = float(np.quantile(boot, alpha / 2))
    hi = float(np.quantile(boot, 1.0 - alpha / 2))
    return {
        'mean_delta': float(delta.mean()),
        'lo': lo,
        'hi': hi,
        'n': n,
    }


def oof_paired_report(
    treatment: np.ndarray,
    baseline: np.ndarray,
    n_resamples: int = BOOTSTRAP_RESAMPLES,
    seed: int = SEED,
) -> dict:
    treatment = np.asarray(treatment, dtype=float)
    baseline = np.asarray(baseline, dtype=float)
    ci = paired_ci(treatment, baseline, n_resamples=n_resamples, seed=seed)
    delta = treatment - baseline
    if len(delta) == 0:
        return {**ci, 'median_delta': float('nan'), 'worst_delta': float('nan')}
    return {
        **ci,
        'median_delta': float(np.median(delta)),
        'worst_delta': float(delta.min()),
        'q01_delta': float(np.quantile(delta, 0.01)),
        'q05_delta': float(np.quantile(delta, 0.05)),
        'q10_delta': float(np.quantile(delta, 0.10)),
        'frac_loss_gt_005': float(np.mean(delta < -0.005)),
        'frac_loss_gt_01': float(np.mean(delta < -0.01)),
        'noninferior_005': bool(ci['lo'] > -0.005),
        'noninferior_01': bool(ci['lo'] > -0.01),
    }
