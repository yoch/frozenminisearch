"""Leave-one-dataset-out transfer of a single global alpha."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .config import ALPHAS, PRIMARY_K, SEED
from .cv import fold_splits, relevant_quantile_threshold
from .metrics import safe_auroc
from .phase_a import flatten_candidates, write_json
from .retrieve import load_index, retrieve_all
from .run_phase_a import ART, RES, index_cache_path, run_one


def load_packed(name: str, k: int = PRIMARY_K) -> dict:
    run_one(name, k, force=False)
    index = load_index(index_cache_path(name))
    retrieved = retrieve_all(index, k=k)
    return flatten_candidates(retrieved)


def candidate_auc_for_alpha(packed: dict, alpha: float) -> float | None:
    y = []
    s = []
    for row in packed.values():
        y.extend((np.asarray(row['rel']) > 0).astype(int).tolist())
        denom = max(float(row['qlen_tok']), 1.0) ** float(alpha)
        s.extend((np.asarray(row['scores'], dtype=float) / denom).tolist())
    return safe_auroc(np.array(y), np.array(s))


def gate_at_alpha(packed: dict, alpha: float, target: float = 0.95) -> dict:
    qids = list(packed)
    recs = []
    rets = []
    for _, train, test in fold_splits(qids, seed=SEED):
        rel_scores = []
        for qid in train:
            flags = np.asarray(packed[qid]['rel']) > 0
            vals = np.asarray(packed[qid]['scores'], dtype=float) / (max(float(packed[qid]['qlen_tok']), 1.0) ** alpha)
            rel_scores.extend(vals[flags].tolist())
        th = relevant_quantile_threshold(rel_scores, target)
        keep_rel = tot_rel = keep_n = tot_n = 0
        for qid in test:
            vals = np.asarray(packed[qid]['scores'], dtype=float) / (max(float(packed[qid]['qlen_tok']), 1.0) ** alpha)
            flags = np.asarray(packed[qid]['rel']) > 0
            tot_rel += int(flags.sum())
            tot_n += len(vals)
            mask = vals >= th
            keep_n += int(mask.sum())
            keep_rel += int((flags & mask).sum())
        recs.append(keep_rel / max(tot_rel, 1))
        rets.append(keep_n / max(tot_n, 1))
    return {'recall': float(np.mean(recs)), 'retained': float(np.mean(rets))}


def run_lodo(datasets: list[str]) -> dict:
    packed_all = {}
    local_alpha = {}
    for name in datasets:
        path = RES / f'phase_a_{name}_k{PRIMARY_K}.json'
        if not path.exists():
            continue
        blob = json.loads(path.read_text(encoding='utf8'))
        local_alpha[name] = blob.get('calibration', {}).get('mean_chosen_alpha')
        packed_all[name] = load_packed(name)
    rows = []
    names = list(packed_all)
    for held in names:
        others = [n for n in names if n != held]
        # choose alpha by mean candidate AUROC on the other collections
        aucs = {a: [] for a in ALPHAS}
        for n in others:
            for a in ALPHAS:
                auc = candidate_auc_for_alpha(packed_all[n], a)
                if auc is not None:
                    aucs[a].append(auc)
        means = {a: float(np.mean(v)) if v else float('-inf') for a, v in aucs.items()}
        chosen = max(means, key=lambda a: means[a])
        held_aucs = {str(a): candidate_auc_for_alpha(packed_all[held], a) for a in ALPHAS}
        gate = {str(a): gate_at_alpha(packed_all[held], a) for a in ALPHAS}
        rows.append({
            'held_out': held,
            'transferred_alpha': chosen,
            'local_alpha': local_alpha.get(held),
            'held_aucs': held_aucs,
            'held_gate_0.95': gate,
            'transferred_auc': held_aucs[str(chosen)],
            'transferred_gate': gate[str(chosen)],
        })
    write_json(RES / 'lodo_alpha.json', {'rows': rows, 'datasets': names})
    return {'rows': rows, 'datasets': names}
