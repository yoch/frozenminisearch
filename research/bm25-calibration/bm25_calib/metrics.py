"""IR and calibration metrics. Raw BM25 is never treated as a probability."""

from __future__ import annotations

import math

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score


def dcg_at(rels: np.ndarray, k: int) -> float:
    rels = np.asarray(rels, dtype=np.float64)[:k]
    if len(rels) == 0:
        return 0.0
    gains = np.where(rels > 0, (2.0 ** rels) - 1.0, 0.0)
    discounts = np.log2(np.arange(2, len(gains) + 2))
    return float(np.sum(gains / discounts))


def ndcg_at(rels: np.ndarray, k: int) -> float:
    rels = np.asarray(rels, dtype=np.float64)
    actual = dcg_at(rels, k)
    ideal = dcg_at(np.sort(rels)[::-1], k)
    return 0.0 if ideal <= 0 else actual / ideal


def mrr_at(rels: np.ndarray, k: int) -> float:
    rels = np.asarray(rels)[:k]
    hits = np.flatnonzero(rels > 0)
    return 0.0 if len(hits) == 0 else 1.0 / float(hits[0] + 1)


def precision_at(rels: np.ndarray, k: int) -> float:
    rels = np.asarray(rels)[:k]
    if k <= 0:
        return 0.0
    return float(np.mean(rels > 0)) if len(rels) else 0.0


def recall_at(rels: np.ndarray, n_relevant: int, k: int) -> float:
    if n_relevant <= 0:
        return 0.0
    return float(np.sum(np.asarray(rels)[:k] > 0)) / float(n_relevant)


def success_at(rels: np.ndarray, k: int) -> float:
    return 1.0 if np.any(np.asarray(rels)[:k] > 0) else 0.0


def average_precision(rels: np.ndarray, n_relevant: int) -> float:
    rels = np.asarray(rels) > 0
    if n_relevant <= 0:
        return 0.0
    hits = 0
    acc = 0.0
    for i, flag in enumerate(rels, start=1):
        if flag:
            hits += 1
            acc += hits / i
    return acc / n_relevant


def ranking_metrics(rels: np.ndarray, n_relevant: int, k: int = 10) -> dict[str, float]:
    rels = np.asarray(rels)
    return {
        'ndcg@10': ndcg_at(rels, k),
        'mrr@10': mrr_at(rels, k),
        'p@10': precision_at(rels, k),
        'map': average_precision(rels, n_relevant),
        'recall@10': recall_at(rels, n_relevant, k),
        'success@10': success_at(rels, k),
    }


def safe_auroc(y: np.ndarray, s: np.ndarray) -> float | None:
    y = np.asarray(y).astype(int)
    if len(set(y.tolist())) < 2:
        return None
    return float(roc_auc_score(y, s))


def safe_ap(y: np.ndarray, s: np.ndarray) -> float | None:
    y = np.asarray(y).astype(int)
    if int(y.sum()) == 0:
        return None
    return float(average_precision_score(y, s))


def spearman(x, y) -> float | None:
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    if len(x) < 3 or len(set(x.tolist())) < 2 or len(set(y.tolist())) < 2:
        return None
    rx = np.argsort(np.argsort(x))
    ry = np.argsort(np.argsort(y))
    rx = rx.astype(float)
    ry = ry.astype(float)
    rx -= rx.mean()
    ry -= ry.mean()
    den = math.sqrt(float(np.sum(rx * rx)) * float(np.sum(ry * ry)))
    if den <= 0:
        return None
    return float(np.sum(rx * ry) / den)


def fit_platt(scores: np.ndarray, y: np.ndarray) -> LogisticRegression | None:
    y = np.asarray(y).astype(int)
    if len(set(y.tolist())) < 2:
        return None
    x = np.asarray(scores, dtype=float).reshape(-1, 1)
    clf = LogisticRegression(max_iter=1000)
    clf.fit(x, y)
    return clf


def predict_proba(model: LogisticRegression | None, scores: np.ndarray) -> np.ndarray:
    scores = np.asarray(scores, dtype=float)
    if model is None:
        # rank-based fallback, not a probability claim
        if len(scores) == 0:
            return scores
        lo, hi = float(scores.min()), float(scores.max())
        if hi <= lo:
            return np.full_like(scores, 0.5, dtype=float)
        return (scores - lo) / (hi - lo)
    return model.predict_proba(scores.reshape(-1, 1))[:, 1]


def brier(y: np.ndarray, p: np.ndarray) -> float:
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    return float(np.mean((p - y) ** 2)) if len(y) else float('nan')


def ece(y: np.ndarray, p: np.ndarray, n_bins: int = 15) -> tuple[float, list[dict]]:
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    if len(y) == 0:
        return float('nan'), []
    bins = np.linspace(0.0, 1.0, n_bins + 1)
    ece_val = 0.0
    curve = []
    n = len(y)
    for i in range(n_bins):
        lo, hi = bins[i], bins[i + 1]
        mask = (p >= lo) & (p < hi) if i < n_bins - 1 else (p >= lo) & (p <= hi)
        if not np.any(mask):
            curve.append({'lo': lo, 'hi': hi, 'n': 0, 'conf': None, 'acc': None})
            continue
        conf = float(p[mask].mean())
        acc = float(y[mask].mean())
        w = float(mask.mean())
        ece_val += w * abs(acc - conf)
        curve.append({'lo': lo, 'hi': hi, 'n': int(mask.sum()), 'conf': conf, 'acc': acc})
    return float(ece_val), curve
