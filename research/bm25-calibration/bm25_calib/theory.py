"""Representational KL identity and the corpus-null BM25 standardization.

The Silajev construction (arXiv:2609.14016) shows that TF-IDF and BM25 term
scores can be written as a Kullback-Leibler divergence after the event
probabilities P and Q are defined from the same TF/IDF statistics. That is a
representational fact: it does not by itself supply independently meaningful
generative models for P and Q.

Any finite s >= 0 is itself a KL divergence. Take the binary alphabet and set
    Q = (1, 0)
    P = (exp(-s), 1 - exp(-s)).
Then, with the 0 log 0 = 0 convention,
    KL(Q || P) = 1 * log(1 / exp(-s)) + 0 * log(0 / (1-exp(-s))) = s.
Hence "score s is a KL divergence" does not constrain the scoring function
until P and Q are given meaning that does not route through s.

The paper's query-level score is the query-term mixture
    Score(q, d) = sum_t (q(t)/|q|) * BM25(t, d) / (k1+1)
which is BM25(q, d) / (|q| * (k1+1)) when BM25 sums q(t)*term_score. The
constant (k1+1) does not affect threshold orderings among scores that share k1.

Null-standardized score
-----------------------
Write the contribution of term t in document D as
    X_t(D) = (k1+1) * IDF_t * u_t(D)
with u_t(D) = 0 when t not in D, and the usual BM25 saturation otherwise.
Let D ~ uniform on the corpus (background / non-relevant proxy). Then
    mu_t = E[X_t(D)]
    v_t  = Var(X_t(D))
include the point mass at 0 from non-posting documents. For a query,
    mu_q = sum_t mu_t
    v_q_diag = sum_t v_t
    Z_diag(q, d) = (BM25(q, d) - mu_q) / sqrt(v_q_diag).
Pairwise
    v_q_full = sum_t v_t + 2 sum_{t<u} Cov(X_t, X_u).
If term contributions are i.i.d. with finite variance, sd(BM25) ~ sqrt(|q|).
Positive dependence inflates Var(sum) toward |q|^2, so a variance-stabilizing
exponent can lie between 1/2 and 1. That is a prediction to test, not an axiom.
"""

from __future__ import annotations

import math

import numpy as np

from .bm25 import u_component
from .config import K1, Z_FULL_TERM_CAP


def kl_binary_from_score(s: float) -> tuple[tuple[float, float], tuple[float, float], float]:
    if s < 0 or not math.isfinite(s):
        raise ValueError('s must be a finite non-negative score')
    q = (1.0, 0.0)
    p = (math.exp(-s), 1.0 - math.exp(-s))
    kl = 0.0 if q[0] == 0.0 else q[0] * math.log(q[0] / p[0])
    if q[1] > 0.0:
        kl += q[1] * math.log(q[1] / p[1])
    return q, p, kl


def paper_score(bm25: float, qlen: float, k1: float = K1) -> float:
    return float(bm25) / (max(float(qlen), 1.0) * (k1 + 1.0))


def power_score(bm25: float, qlen: float, alpha: float) -> float:
    return float(bm25) / (max(float(qlen), 1.0) ** float(alpha))


def term_moments_from_posting(
    tf: np.ndarray,
    doc_idx: np.ndarray,
    dl_norm: np.ndarray,
    idf: float,
    n_docs: int,
    k1: float = K1,
) -> tuple[float, float, np.ndarray]:
    """Return (mu_X, var_X, u_on_postings). Zeros off the posting are included."""
    n_docs = max(int(n_docs), 1)
    if len(tf) == 0:
        return 0.0, 0.0, np.zeros(0, dtype=np.float64)
    u = u_component(tf, dl_norm[doc_idx], k1=k1)
    scale = (k1 + 1.0) * float(idf)
    sum_u = float(u.sum())
    sum_u2 = float(np.square(u).sum())
    mu_u = sum_u / n_docs
    var_u = max(sum_u2 / n_docs - mu_u * mu_u, 0.0)
    return scale * mu_u, (scale * scale) * var_u, u


def pairwise_cov(
    idx_a: np.ndarray,
    u_a: np.ndarray,
    mu_xa: float,
    idx_b: np.ndarray,
    u_b: np.ndarray,
    mu_xb: float,
    idf_a: float,
    idf_b: float,
    n_docs: int,
    k1: float = K1,
) -> float:
    """Cov(X_a, X_b) using posting intersection; off-support products are 0."""
    if len(idx_a) == 0 or len(idx_b) == 0:
        return -mu_xa * mu_xb
    i = 0
    j = 0
    acc = 0.0
    na = len(idx_a)
    nb = len(idx_b)
    while i < na and j < nb:
        da = int(idx_a[i])
        db = int(idx_b[j])
        if da == db:
            acc += float(u_a[i]) * float(u_b[j])
            i += 1
            j += 1
        elif da < db:
            i += 1
        else:
            j += 1
    scale = (k1 + 1.0) * (k1 + 1.0) * float(idf_a) * float(idf_b)
    e_prod = (scale * acc) / max(int(n_docs), 1)
    return e_prod - mu_xa * mu_xb


def pairwise_cov_x(
    idx_a: np.ndarray,
    x_a: np.ndarray,
    mu_a: float,
    idx_b: np.ndarray,
    x_b: np.ndarray,
    mu_b: float,
    n_docs: int,
) -> float:
    """Cov(X_a, X_b) from precomputed BM25 contributions (same weights as scoring)."""
    if len(idx_a) == 0 or len(idx_b) == 0:
        return -mu_a * mu_b
    i = 0
    j = 0
    acc = 0.0
    na = len(idx_a)
    nb = len(idx_b)
    while i < na and j < nb:
        da = int(idx_a[i])
        db = int(idx_b[j])
        if da == db:
            acc += float(x_a[i]) * float(x_b[j])
            i += 1
            j += 1
        elif da < db:
            i += 1
        else:
            j += 1
    e_prod = acc / max(int(n_docs), 1)
    return e_prod - mu_a * mu_b


def query_null(
    terms: list[str],
    idf: dict[str, float],
    postings: dict[str, tuple[np.ndarray, np.ndarray]],
    dl_norm: np.ndarray,
    n_docs: int,
    k1: float = K1,
    term_cap: int = Z_FULL_TERM_CAP,
    compute_cov: bool = False,
) -> dict[str, float]:
    mus = []
    vars_ = []
    usable = []
    del dl_norm, k1
    for t in terms:
        if t not in postings:
            mus.append(0.0)
            vars_.append(0.0)
            continue
        idx, x = postings[t]
        x = np.asarray(x, dtype=np.float64)
        n = max(int(n_docs), 1)
        mu = float(x.sum()) / n
        var = max(float(np.square(x).sum()) / n - mu * mu, 0.0)
        mus.append(mu)
        vars_.append(var)
        usable.append((t, idx, x, mu, idf[t], var))
    mu_q = float(sum(mus))
    v_diag = float(sum(vars_))
    v_full = v_diag
    mean_corr = 0.0
    n_pairs = 0
    cov_terms = usable
    if not compute_cov:
        cov_terms = []
    elif len(usable) > term_cap:
        cov_terms = sorted(usable, key=lambda row: -row[4])[:term_cap]
    for i in range(len(cov_terms)):
        t_i, idx_i, u_i, mu_i, idf_i, var_i = cov_terms[i]
        del t_i
        for j in range(i + 1, len(cov_terms)):
            t_j, idx_j, u_j, mu_j, idf_j, var_j = cov_terms[j]
            del t_j
            cov = pairwise_cov_x(idx_i, u_i, mu_i, idx_j, u_j, mu_j, n_docs)
            v_full += 2.0 * cov
            denom = math.sqrt(max(var_i, 0.0) * max(var_j, 0.0))
            if denom > 0:
                mean_corr += cov / denom
                n_pairs += 1
    if n_pairs:
        mean_corr /= n_pairs
    v_full = max(v_full, 1e-18)
    v_diag = max(v_diag, 1e-18)
    return {
        'mu_q': mu_q,
        'v_diag': v_diag,
        'v_full': v_full,
        'sd_diag': math.sqrt(v_diag),
        'sd_full': math.sqrt(v_full),
        'mean_term_corr': mean_corr,
        'n_cov_terms': len(cov_terms),
        'n_cov_pairs': n_pairs,
        'cov_skipped': not compute_cov,
    }
