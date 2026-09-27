"""k1/b and top-K sensitivity on cheap collections."""

from __future__ import annotations

import argparse
import sys

import numpy as np

from .config import PRIMARY_K, SEED
from .phase_a import aggregate_folds, evaluate_calibration, flatten_candidates, write_json
from .retrieve import load_index
from .run_phase_a import ART, RES, dataset_stats, run_one
from .theory import query_null
from .bm25 import length_norm, term_contributions


def retrieve_with_params(index: dict, k: int, k1: float, b: float) -> dict:
    dl_norm = length_norm(index['dls'], index['avgdl'], b=b)
    # Recompute IDF is independent of k1/b; saturation is not.
    from .theory import query_null
    out = {}
    docids = index['docids']
    qrels = index['qrels']
    n = index['n_docs']
    for qid, terms in index['q_terms'].items():
        scores = np.zeros(n, dtype=np.float32)
        for term in terms:
            if term not in index['postings']:
                continue
            idx, tf = index['postings'][term]
            scores[idx] += term_contributions(tf, dl_norm[idx], index['idf'][term], k1=k1).astype(np.float32)
        pos = np.flatnonzero(scores > 0)
        if len(pos) == 0:
            inds = np.zeros(0, dtype=np.int32)
            sc = np.zeros(0, dtype=np.float32)
        else:
            if len(pos) > k:
                pick = np.argpartition(scores[pos], -k)[-k:]
                inds = pos[pick]
            else:
                inds = pos
            inds = inds[np.argsort(scores[inds])[::-1]]
            sc = scores[inds]
        relmap = qrels.get(qid, {})
        rel = np.array([int(relmap.get(docids[i], 0)) for i in inds], dtype=np.int32)
        tokens = index['q_tokens'][qid]
        null = query_null(terms, index['idf'], index['postings'], dl_norm, n, k1=k1)
        out[qid] = {
            'inds': inds,
            'scores': sc,
            'rel': rel,
            'qlen_tok': max(len(tokens), 1),
            'qlen_uniq': max(len(terms), 1),
            'sum_idf': float(sum(index['idf'].get(t, 0.0) for t in terms)),
            **null,
        }
    return out


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--datasets', nargs='*', default=['scifact', 'nfcorpus'])
    args = p.parse_args(argv)
    jobs = []
    for name in args.datasets:
        idx_path = ART / 'indexes' / f'{name}.pkl'
        if not idx_path.exists():
            run_one(name, PRIMARY_K, force=False)
        index = load_index(idx_path)
        for k1, b in ((1.2, 0.75), (1.2, 0.7), (0.9, 0.4)):
            for k in (50, 100, 200):
                retrieved = retrieve_with_params(index, k=k, k1=k1, b=b)
                packed = flatten_candidates(retrieved)
                cal = evaluate_calibration(packed)
                agg = aggregate_folds(cal)
                blob = {
                    'dataset': name,
                    'k': k,
                    'k1': k1,
                    'b': b,
                    'seed': SEED,
                    'stats': dataset_stats(index, retrieved),
                    'calibration': agg,
                    'chosen_alphas': cal['chosen_alphas'],
                }
                write_json(RES / f'sensitivity_{name}_k{k}_k1{k1}_b{b}.json', blob)
                jobs.append({'dataset': name, 'k': k, 'k1': k1, 'b': b, 'alpha': agg['mean_chosen_alpha']})
                print(jobs[-1], flush=True)
    write_json(RES / 'sensitivity_summary.json', jobs)
    return 0


if __name__ == '__main__':
    sys.exit(main())
