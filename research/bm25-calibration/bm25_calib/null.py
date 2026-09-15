"""Index-derived background tail probabilities for BM25.

Two different nulls must not be confused:

* Joint corpus null: D uniform in the collection, S = BM25(q, D) with the
  true dependence among query terms. For a document at global rank r with
  unique scores, P(S >= s_r) = r / N. That quantity is a function of rank
  and collection size only, so it cannot calibrate top-K lists across queries.
  It is kept as a negative control.

* Factorized null: each term contribution X_t is drawn independently from its
  empirical corpus marginal (point mass at 0 plus the posting values). Then
  S_ind = sum_t X_t is NOT the empirical BM25 histogram. Gaussian, Chernoff,
  saddlepoint, and Monte-Carlo approximations target this object.

Kanoulas, Dai, Pavlu & Aslam (SIGIR 2010) already derive analytical BM25
score distributions from TF/DL assumptions under term independence. The
code below is the nonparametric posting-empirical analogue, not a new
generative theory.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.special import logsumexp
from scipy.stats import norm

from .bm25 import u_component
from .config import K1


def posting_x(tf: np.ndarray, doc_idx: np.ndarray, dl_norm: np.ndarray, idf: float, k1: float = K1) -> np.ndarray:
    if len(tf) == 0:
        return np.zeros(0, dtype=np.float64)
    u = u_component(tf, dl_norm[doc_idx], k1=k1)
    return (k1 + 1.0) * float(idf) * u


def mgf_from_posting(x_pos: np.ndarray, n_docs: int, lam: float) -> tuple[float, float, float]:
    """Return (log M, K'=E_tilt[X], K''=Var_tilt[X]) for one term, including zeros."""
    n = max(int(n_docs), 1)
    n_zero = n - len(x_pos)
    if lam == 0.0:
        mu = float(x_pos.sum()) / n
        second = float(np.square(x_pos).sum()) / n
        var = max(second - mu * mu, 0.0)
        return 0.0, mu, var
    # log M = log( (n_zero + sum exp(lam x)) / n )
    if len(x_pos):
        tilted = lam * x_pos
        log_sum_pos = logsumexp(tilted)
        logs = []
        if n_zero > 0:
            logs.append(math.log(n_zero))
        logs.append(log_sum_pos)
        log_num = logsumexp(logs)
    else:
        log_num = math.log(max(n_zero, 1))
    log_m = log_num - math.log(n)
    # E_tilt[X] = sum x e^{lam x} / (n_zero + sum e^{lam x})
    if len(x_pos):
        w = np.exp(lam * x_pos - log_sum_pos)
        # mix with zeros: total mass of positives = exp(log_sum_pos - log_num)
        p_pos = math.exp(log_sum_pos - log_num)
        e1 = p_pos * float(np.dot(w, x_pos))
        e2 = p_pos * float(np.dot(w, np.square(x_pos)))
    else:
        e1 = 0.0
        e2 = 0.0
    var = max(e2 - e1 * e1, 0.0)
    return log_m, e1, var


def query_cgf(term_xs: list[np.ndarray], n_docs: int, lam: float) -> tuple[float, float, float]:
    k = 0.0
    kp = 0.0
    kpp = 0.0
    for x in term_xs:
        log_m, e1, var = mgf_from_posting(x, n_docs, lam)
        k += log_m
        kp += e1
        kpp += var
    return k, kp, kpp


def chernoff_tail(term_xs: list[np.ndarray], n_docs: int, s: float) -> float:
    """Independent-sum Chernoff upper bound inf_λ>0 exp(-λs + K(λ))."""
    mu, _, _ = query_cgf(term_xs, n_docs, 0.0)
    if s <= mu:
        return 1.0
    best = 1.0
    for lam in (0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4):
        k, kp, _ = query_cgf(term_xs, n_docs, lam)
        bound = math.exp(min(0.0, -lam * s + k))
        if bound < best:
            best = bound
        if kp > s:
            break
    return float(min(max(best, 0.0), 1.0))


def saddlepoint_tail(term_xs: list[np.ndarray], n_docs: int, s: float) -> float:
    """Lugannani–Rice right-tail under the factorized null. Falls back to Chernoff."""
    k0, mu, var0 = query_cgf(term_xs, n_docs, 0.0)
    del k0
    if var0 <= 1e-18:
        return 1.0 if s <= mu else 0.0
    if s <= mu:
        # left of mean: use Gaussian, saddlepoint for lower tail is unstable here
        z = (s - mu) / math.sqrt(var0)
        return float(norm.sf(z))
    lam = 0.1 / math.sqrt(var0)
    for _ in range(25):
        k, kp, kpp = query_cgf(term_xs, n_docs, lam)
        g = kp - s
        if abs(g) < 1e-6:
            break
        if kpp < 1e-18:
            break
        step = g / kpp
        lam = max(lam - step, 1e-8)
        if lam > 50:
            lam = 50
            break
    k, kp, kpp = query_cgf(term_xs, n_docs, lam)
    w2 = 2.0 * (lam * s - k)
    if w2 <= 0 or kpp <= 0:
        return chernoff_tail(term_xs, n_docs, s)
    w = math.copysign(math.sqrt(w2), lam)
    u = lam * math.sqrt(kpp)
    if abs(w) < 1e-10 or abs(u) < 1e-10:
        return float(norm.sf((s - mu) / math.sqrt(var0)))
    # Lugannani–Rice survival
    p = float(norm.sf(w) + norm.pdf(w) * (1.0 / w - 1.0 / u))
    return float(min(max(p, 0.0), 1.0))


def gaussian_tail(mu: float, var: float, s: float) -> float:
    if var <= 1e-18:
        return 1.0 if s <= mu else 0.0
    return float(norm.sf((s - mu) / math.sqrt(var)))


def information(p0: float) -> float:
    return -math.log(max(float(p0), 1e-300))


def independence_mc_tail(
    term_xs: list[np.ndarray],
    n_docs: int,
    s: float,
    n_draw: int = 4000,
    seed: int = 0,
) -> float:
    rng = np.random.default_rng(seed)
    n = max(int(n_docs), 1)
    acc = np.zeros(n_draw, dtype=np.float64)
    for x in term_xs:
        df = len(x)
        if df == 0:
            continue
        take = rng.random(n_draw) < (df / n)
        idx = rng.integers(0, df, size=n_draw)
        acc += np.where(take, x[idx], 0.0)
    return float(np.mean(acc >= s))


def query_term_xs(
    terms: list[str],
    idf: dict[str, float],
    postings: dict[str, tuple[np.ndarray, np.ndarray]],
    dl_norm: np.ndarray,
    k1: float = K1,
) -> list[np.ndarray]:
    xs = []
    for t in terms:
        if t not in postings:
            continue
        idx, tf = postings[t]
        xs.append(posting_x(tf, idx, dl_norm, idf[t], k1=k1))
    return xs


def tails_for_scores(
    scores: np.ndarray,
    term_xs: list[np.ndarray],
    n_docs: int,
    mu: float,
    var_diag: float,
    var_full: float,
    n_mc: int = 2000,
    seed: int = 0,
) -> dict[str, np.ndarray]:
    scores = np.asarray(scores, dtype=np.float64)
    p_g = np.array([gaussian_tail(mu, var_diag, s) for s in scores])
    p_gf = np.array([gaussian_tail(mu, var_full, s) for s in scores])
    posting_mass = int(sum(len(x) for x in term_xs))
    if len(scores) == 0:
        p_sp = np.zeros(0)
        p_ch = np.zeros(0)
    elif posting_mass > 20000 or len(scores) > 40:
        knots = np.unique(np.quantile(scores, np.linspace(0, 1, 8)))
        sp_k = np.array([saddlepoint_tail(term_xs, n_docs, float(s)) for s in knots])
        ch_k = np.array([chernoff_tail(term_xs, n_docs, float(s)) for s in knots])
        # monotone decreasing in s: interpolate in log-s space of survival
        p_sp = np.interp(scores, knots, sp_k)
        p_ch = np.interp(scores, knots, ch_k)
    else:
        p_sp = np.array([saddlepoint_tail(term_xs, n_docs, s) for s in scores])
        p_ch = np.array([chernoff_tail(term_xs, n_docs, s) for s in scores])
    # MC on top-1 and median candidate only (cost); interpolate monotone via gaussian ranks
    p_mc = np.full(len(scores), np.nan)
    if len(scores):
        p_mc[0] = independence_mc_tail(term_xs, n_docs, float(scores[0]), n_draw=n_mc, seed=seed)
        mid = len(scores) // 2
        p_mc[mid] = independence_mc_tail(term_xs, n_docs, float(scores[mid]), n_draw=max(n_mc // 2, 500), seed=seed + 1)
    ranks = np.arange(1, len(scores) + 1, dtype=np.float64)
    p_joint = ranks / max(n_docs, 1)
    return {
        'p0_gauss_diag': p_g,
        'p0_gauss_full': p_gf,
        'p0_saddle': p_sp,
        'p0_chernoff': p_ch,
        'p0_mc_top': p_mc,
        'p0_joint_rank': p_joint,
        'I_gauss_diag': np.array([information(p) for p in p_g]),
        'I_gauss_full': np.array([information(p) for p in p_gf]),
        'I_saddle': np.array([information(p) for p in p_sp]),
        'I_joint_rank': np.array([information(p) for p in p_joint]),
    }
