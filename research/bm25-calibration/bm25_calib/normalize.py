"""Cross-query score transforms. All are monotone in the raw score within a query."""

from __future__ import annotations

import math

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
        'paper',
        'ceiling',
        'top_ratio',
        'minmax',
        'sumnorm',
        'z_emp',
        'z_robust',
        'z_diag',
        'z_full',
        'I_saddle',
        'I_gauss_diag',
        'I_gauss_full',
        'I_joint_rank',
        'surprise',
    ]
    names.extend(f'power_{a:g}' for a in ALPHAS)
    return names


def candidate_variants(raw: np.ndarray, qrow: dict, k1: float = K1) -> dict[str, np.ndarray]:
    raw = np.asarray(raw, dtype=np.float64)
    qlen = float(qrow['qlen_tok'])
    qlen_u = float(qrow['qlen_uniq'])
    ceiling = max((k1 + 1.0) * float(qrow['sum_idf']), 1e-12)
    top = float(raw[0]) if len(raw) else 1.0
    top = top if top > 0 else 1.0
    lo = float(raw.min()) if len(raw) else 0.0
    hi = float(raw.max()) if len(raw) else 1.0
    span = hi - lo if hi > lo else 1.0
    ssum = float(raw.sum()) if len(raw) and float(raw.sum()) > 0 else 1.0
    mu_emp = float(raw.mean()) if len(raw) else 0.0
    sd_emp = _safe_std(raw)
    med = float(np.median(raw)) if len(raw) else 0.0
    mad = _mad(raw)
    mu_q = float(qrow['mu_q'])
    sd_diag = max(float(qrow['sd_diag']), 1e-12)
    sd_full = max(float(qrow['sd_full']), 1e-12)
    out = {
        'raw': raw,
        'paper': raw / (qlen * (k1 + 1.0)),
        'paper_unique': raw / (qlen_u * (k1 + 1.0)),
        'ceiling': raw / ceiling,
        'top_ratio': raw / top,
        'minmax': (raw - lo) / span,
        'sumnorm': raw / ssum,
        'z_emp': (raw - mu_emp) / sd_emp,
        'z_robust': (raw - med) / mad,
        'z_diag': (raw - mu_q) / sd_diag,
        'z_full': (raw - mu_q) / sd_full,
        'I_saddle': np.asarray(qrow.get('I_saddle', (raw - mu_q) / sd_diag), dtype=float),
        'I_gauss_diag': np.asarray(qrow.get('I_gauss_diag', (raw - mu_q) / sd_diag), dtype=float),
        'I_gauss_full': np.asarray(qrow.get('I_gauss_full', (raw - mu_q) / sd_full), dtype=float),
        'surprise': np.asarray(qrow.get('surprise', np.zeros(len(raw))), dtype=float),
        'I_joint_rank': np.asarray(qrow.get('I_joint_rank', np.zeros(len(raw))), dtype=float),
    }
    for a in ALPHAS:
        out[f'power_{a:g}'] = raw / (qlen ** a)
    return out


def query_top_features(raw: np.ndarray, qrow: dict, variants: dict[str, np.ndarray]) -> dict[str, float]:
    feats = {
        'qlen_tok': float(qrow['qlen_tok']),
        'qlen_uniq': float(qrow['qlen_uniq']),
        'sum_idf': float(qrow['sum_idf']),
        'mu_q': float(qrow['mu_q']),
        'sd_diag': float(qrow['sd_diag']),
        'sd_full': float(qrow['sd_full']),
        'mean_term_corr': float(qrow['mean_term_corr']),
        'n_cand': int(len(raw)),
        'n_rel': int(np.sum(np.asarray(qrow['rel']) > 0)),
        'top_rel': int(qrow['rel'][0] > 0) if len(qrow['rel']) else 0,
    }
    for name, arr in variants.items():
        feats[f'top_{name}'] = float(arr[0]) if len(arr) else 0.0
    return feats
