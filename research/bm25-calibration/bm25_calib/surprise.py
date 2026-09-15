"""Bahri et al. (SIGIR 2023) Surprise scoring via a GPD fit on one ranked list.

The null is the tail of the *returned* list, not the collection. Hyper-parameters
(i, j) follow the greedy Cramér–von Mises procedure in the paper (arXiv:2010.09797).
GPD shape is constrained to ξ >= 0 (infinite positive support), matching their c <= 0
reparameterization.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.stats import genpareto


def _cvm(excess: np.ndarray) -> float:
    if len(excess) < 8:
        return 1e9
    try:
        c, loc, scale = genpareto.fit(excess, floc=0.0)
    except Exception:  # noqa: BLE001
        return 1e9
    if c < 0:
        try:
            c, loc, scale = genpareto.fit(excess, floc=0.0, fc=0.0)
        except Exception:  # noqa: BLE001
            return 1e9
    cdf = genpareto.cdf(excess, c, loc=loc, scale=max(scale, 1e-12))
    m = len(excess)
    linear = (np.arange(1, m + 1) - 0.5) / m
    return float(np.sum((np.sort(cdf) - linear) ** 2) + 1.0 / (12.0 * m))


def _fit_gpd(excess: np.ndarray):
    c, loc, scale = genpareto.fit(excess, floc=0.0)
    if c < 0:
        c, loc, scale = genpareto.fit(excess, floc=0.0, fc=0.0)
    return c, loc, max(float(scale), 1e-12)


def surprise_scores(raw: np.ndarray) -> np.ndarray:
    """raw is descending BM25; internally we work on ascending scores as in the paper."""
    raw = np.asarray(raw, dtype=np.float64)
    n = len(raw)
    out = np.zeros(n, dtype=np.float64)
    if n < 12:
        return out
    scores = raw[::-1]  # ascending
    i = 0
    j = n
    prev = _cvm(scores[i:j] - scores[i])
    for _ in range(8):
        if j - i <= 12:
            break
        trial = _cvm(scores[i:j - 1] - scores[i])
        if trial < prev:
            j -= 1
            prev = trial
        else:
            break
    for _ in range(8):
        if j - i <= 12:
            break
        trial = _cvm(scores[i + 1:j] - scores[i + 1])
        if trial < prev:
            i += 1
            prev = trial
        else:
            break
    u = float(scores[i])
    excess = scores[i:] - u
    if len(excess) < 8 or float(np.std(excess)) <= 1e-12:
        return out
    try:
        c, loc, scale = _fit_gpd(excess)
    except Exception:  # noqa: BLE001
        return out
    surv = 1.0 - genpareto.cdf(excess, c, loc=loc, scale=scale)
    surv = np.clip(surv, 1e-12, 1.0)
    surprise_asc = np.zeros(n)
    surprise_asc[i:] = -np.log(surv)
    return surprise_asc[::-1]


def nqc(raw: np.ndarray) -> float:
    raw = np.asarray(raw, dtype=float)
    if len(raw) < 2:
        return 0.0
    mu = abs(float(raw.mean())) + 1e-12
    return float(np.std(raw, ddof=0) / mu)


def wig_like(raw: np.ndarray, mu_q: float, qlen: float) -> float:
    raw = np.asarray(raw, dtype=float)
    if len(raw) == 0:
        return 0.0
    return float((raw.mean() - mu_q) / math.sqrt(max(qlen, 1.0)))
