"""Cross-query score transforms. All listed global methods are monotone in the
raw BM25 score *within* a query, so Ranked List Truncation reduces to a prefix
length K_q on the BM25 list.

Retrieval uses unique query terms (TF_q = 1). `paper_exact` would require
query-term multiplicities inside BM25 and is not computed. Diagnostics:

* power_token_len  = BM25 / |q|_tokens
* power_unique_len = BM25 / |q|_unique
* power_token_{α}  = BM25 / |q|_tokens^α

`I_gauss_diag` is a monotone map of `z_diag` and is not a validated P0.
"""

from __future__ import annotations

import numpy as np

from .config import ALPHAS, K1


def _safe_std(x: np.ndarray) -> float:
    if len(x) < 2:
        return 1.0
    s = float(np.std(x, ddof=0))
    return s if s > 1e-12 else 1.0


def _mad(x: np.ndarray) -> float:
    if len(x) == 0:
        return 1.0
    med = float(np.median(x))
    mad = float(np.median(np.abs(x - med)))
    scaled = 1.4826 * mad
    return scaled if scaled > 1e-12 else 1.0


def variant_names() -> list[str]:
    names = [
        'raw',
        'power_token_len',
        'power_unique_len',
        'ceiling',
        'top_ratio',
        'minmax',
        'sumnorm',
        'z_emp',
        'z_robust',
        'z_diag',
        'I_gauss_diag',
        'I_joint_rank',
        'surprise',
    ]
    names.extend(f'power_token_{a:g}' for a in ALPHAS)
    names.extend(f'power_unique_{a:g}' for a in ALPHAS)
    return names


def candidate_variants(raw: np.ndarray, qrow: dict, k1: float = K1) -> dict[str, np.ndarray]:
    raw = np.asarray(raw, dtype=np.float64)
    qlen = float(qrow['qlen_tok'])
    qlen_u = float(qrow['qlen_uniq'])
    ceiling = max((k1 + 1.0) * float(qrow['sum_idf']), 1e-12)
    if len(raw) == 0:
        empty = raw
        out = {name: empty.copy() for name in variant_names()}
        return out
    top = float(raw[0]) if float(raw[0]) > 0 else 1.0
    lo = float(raw.min())
    hi = float(raw.max())
    span = hi - lo if hi > lo else 1.0
    ssum = float(raw.sum()) if float(raw.sum()) > 0 else 1.0
    mu_emp = float(raw.mean())
    sd_emp = _safe_std(raw)
    med = float(np.median(raw))
    mad = _mad(raw)
    mu_q = float(qrow['mu_q'])
    sd_diag = max(float(qrow['sd_diag']), 1e-12)
    out = {
        'raw': raw,
        'power_token_len': raw / qlen,
        'power_unique_len': raw / qlen_u,
        'ceiling': raw / ceiling,
        'top_ratio': raw / top,
        'minmax': (raw - lo) / span,
        'sumnorm': raw / ssum,
        'z_emp': (raw - mu_emp) / sd_emp,
        'z_robust': (raw - med) / mad,
        'z_diag': (raw - mu_q) / sd_diag,
        'I_gauss_diag': np.asarray(qrow.get('I_gauss_diag', (raw - mu_q) / sd_diag), dtype=float),
        'surprise': np.asarray(qrow.get('surprise', np.zeros(len(raw))), dtype=float),
        'I_joint_rank': np.asarray(qrow.get('I_joint_rank', np.zeros(len(raw))), dtype=float),
    }
    for a in ALPHAS:
        out[f'power_token_{a:g}'] = raw / (qlen ** a)
        out[f'power_unique_{a:g}'] = raw / (qlen_u ** a)
    return out
