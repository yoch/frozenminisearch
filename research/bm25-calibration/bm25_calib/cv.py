"""Leakage-free nested query CV and leave-one-dataset-out helpers."""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence

import numpy as np

from .config import INNER_FOLDS, OUTER_FOLDS, SEED


def query_folds(qids: Sequence[str], n_folds: int = OUTER_FOLDS, seed: int = SEED) -> list[list[str]]:
    q = np.array(list(qids), dtype=object)
    rng = np.random.default_rng(seed)
    rng.shuffle(q)
    n_folds = max(2, min(int(n_folds), len(q) if len(q) else 2))
    return [part.tolist() for part in np.array_split(q, n_folds)]


def fold_splits(qids: Sequence[str], n_folds: int = OUTER_FOLDS, seed: int = SEED):
    folds = query_folds(qids, n_folds=n_folds, seed=seed)
    for i, test in enumerate(folds):
        train = [qid for j, fold in enumerate(folds) if j != i for qid in fold]
        yield i, train, test


def nested_alpha_choice(
    qids_train: Sequence[str],
    per_query: dict[str, dict[str, np.ndarray]],
    alphas: Sequence[float],
    n_inner: int = INNER_FOLDS,
    seed: int = SEED,
) -> float:
    """Pick alpha on inner folds by candidate AUROC; never sees outer test queries."""
    from .metrics import safe_auroc

    if len(qids_train) < max(4, n_inner):
        n_inner = 2
    scores = {a: [] for a in alphas}
    for _, inner_tr, inner_te in fold_splits(qids_train, n_folds=n_inner, seed=seed + 17):
        del inner_tr
        for a in alphas:
            y = []
            s = []
            for qid in inner_te:
                row = per_query.get(qid)
                if not row:
                    continue
                y.extend((np.asarray(row['rel']) > 0).astype(int).tolist())
                denom = max(float(row['qlen_tok']), 1.0) ** float(a)
                s.extend((np.asarray(row['scores'], dtype=float) / denom).tolist())
            auc = safe_auroc(np.array(y), np.array(s))
            if auc is not None:
                scores[a].append(auc)
    means = {a: (float(np.mean(v)) if v else float('-inf')) for a, v in scores.items()}
    best = max(means.values())
    # Prefer the theoretically highlighted 0.5/1.0 only as a tie-break, not as a prior winner.
    candidates = [a for a, m in means.items() if math.isclose(m, best, rel_tol=0, abs_tol=1e-12) or m == best]
    if len(candidates) > 1:
        # Among ties, pick the alpha that on the inner train queries retains fewer
        # candidates at a 0.95 relevant-score quantile. Evaluated only on qids_train.
        def retained(a: float) -> float:
            rel_scores = []
            all_scores = []
            for qid in qids_train:
                row = per_query[qid]
                vals = np.asarray(row['scores'], dtype=float) / (max(float(row['qlen_tok']), 1.0) ** a)
                flags = np.asarray(row['rel']) > 0
                rel_scores.extend(vals[flags].tolist())
                all_scores.extend(vals.tolist())
            if not rel_scores:
                return 1.0
            th = float(np.quantile(rel_scores, 0.05))
            kept = sum(1 for v in all_scores if v >= th)
            return kept / max(len(all_scores), 1)
        candidates.sort(key=lambda a: (retained(a), abs(a - 0.75)))
        return float(candidates[0])
    return float(max(means, key=lambda a: means[a]))


def relevant_quantile_threshold(scores: Iterable[float], keep_frac: float) -> float:
    arr = np.sort(np.asarray(list(scores), dtype=float))[::-1]
    if len(arr) == 0:
        return math.inf
    keep_frac = min(max(keep_frac, 0.0), 1.0)
    idx = min(len(arr) - 1, max(0, int(math.ceil(keep_frac * len(arr)) - 1)))
    return float(arr[idx])
