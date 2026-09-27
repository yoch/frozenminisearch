"""CLI: Phase A cheap calibration sweep."""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path

import numpy as np

from .config import MAX_QUERIES, PHASE_A_ORDER, PRIMARY_K, SEED, SKIPPED_DATASET_REASONS, SKIPPED_DATASETS, SKIPPED_METHODS
from .data import prepare_beir
from .phase_a import aggregate_folds, evaluate_calibration, flatten_candidates, write_json
from .provenance import write_provenance
from .retrieve import INDEX_FORMAT, build_index, load_index, retrieve_all, save_index


ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'artifacts'
RES = ROOT / 'results'


def index_cache_path(name: str) -> Path:
    return ART / 'indexes' / f'{name}_qcap{MAX_QUERIES}_fmt{INDEX_FORMAT}.pkl'


def dataset_stats(index: dict, retrieved: dict) -> dict:
    qlens = [row['qlen_tok'] for row in retrieved.values()]
    quniq = [row['qlen_uniq'] for row in retrieved.values()]
    nrel = [len(index['qrels'].get(qid, {})) for qid in retrieved]
    ncand = [len(row['scores']) for row in retrieved.values()]
    n_rel_pool = 0
    n_rel_all = 0
    success = 0
    for qid, row in retrieved.items():
        n_rel_all += len(index['qrels'].get(qid, {}))
        n_rel_pool += int(np.sum(np.asarray(row['rel']) > 0))
        success += int(np.any(np.asarray(row['rel']) > 0))
    corrs = [row.get('mean_term_corr', 0.0) for row in retrieved.values()]
    return {
        'n_docs': index['n_docs'],
        'n_queries': len(retrieved),
        'n_qrels': n_rel_all,
        'mean_qlen': float(np.mean(qlens)) if qlens else 0,
        'std_qlen': float(np.std(qlens)) if qlens else 0,
        'mean_qlen_unique': float(np.mean(quniq)) if quniq else 0,
        'mean_n_relevant': float(np.mean(nrel)) if nrel else 0,
        'mean_candidates': float(np.mean(ncand)) if ncand else 0,
        'pool_recall': n_rel_pool / max(n_rel_all, 1),
        'query_success_at_k': success / max(len(retrieved), 1),
        'no_match_rate': sum(1 for row in retrieved.values() if row.get('no_match')) / max(len(retrieved), 1),
        'mean_term_corr': float(np.mean(corrs)) if corrs else 0,
        'median_term_corr': float(np.median(corrs)) if corrs else 0,
        'mean_variance_ratio': float(np.nanmean([row.get('variance_ratio', np.nan) for row in retrieved.values()])),
        'meta': index['meta'],
    }


def run_one(name: str, k: int, force: bool) -> dict:
    res_path = RES / f'phase_a_{name}_k{k}.json'
    if res_path.exists() and not force:
        return json.loads(res_path.read_text(encoding='utf8'))
    t0 = time.time()
    idx_path = index_cache_path(name)
    index = None
    if idx_path.exists() and not force:
        index = load_index(idx_path)
        if index.get('format') != INDEX_FORMAT:
            index = None
    if index is None:
        bundle = prepare_beir(name, ART / 'datasets')
        index = build_index(bundle)
        save_index(index, idx_path)
    retrieved = retrieve_all(index, k=k)
    packed = flatten_candidates(retrieved)
    cal = evaluate_calibration(packed)
    agg = aggregate_folds(cal)
    stats = dataset_stats(index, retrieved)
    out = {
        'dataset': name,
        'k': k,
        'seconds': time.time() - t0,
        'stats': stats,
        'calibration': agg,
        'chosen_alphas': cal['chosen_alphas'],
        'seed': SEED,
    }
    write_json(res_path, out)
    # compact per-query table for LDO / dependence tests
    qrows = []
    for qid, row in packed.items():
        qrows.append({
            'qid': qid,
            'qlen_tok': row['qlen_tok'],
            'qlen_uniq': row['qlen_uniq'],
            'sum_idf': row['sum_idf'],
            'mean_term_corr': row.get('mean_term_corr', 0.0),
            'mu_q': row['mu_q'],
            'sd_diag': row['sd_diag'],
            'variance_ratio': row.get('variance_ratio'),
            'n_cand': int(len(row['scores'])),
            'n_rel': int(np.sum(np.asarray(row['rel']) > 0)),
            'top_rel': int(row['rel'][0] > 0) if len(row['rel']) else 0,
            'top_raw': float(row['scores'][0]) if len(row['scores']) else float('-inf'),
            'top_power_token_len': float(row['variants']['power_token_len'][0]) if len(row['scores']) else float('-inf'),
            'top_ceiling': float(row['variants']['ceiling'][0]) if len(row['scores']) else float('-inf'),
            'top_z_diag': float(row['variants']['z_diag'][0]) if len(row['scores']) else float('-inf'),
            'top_I_gauss': float(row['variants']['I_gauss_diag'][0]) if len(row['scores']) else float('-inf'),
            'top_surprise': float(row['variants']['surprise'][0]) if len(row['scores']) else float('-inf'),
            'variance_ratio': row.get('variance_ratio'),
            'no_match': bool(row.get('no_match')),
        })
    write_json(RES / f'phase_a_{name}_k{k}_queries.json', qrows)
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--datasets', nargs='*', default=None)
    p.add_argument('--k', type=int, default=PRIMARY_K)
    p.add_argument('--force', action='store_true')
    p.add_argument('--limit', type=int, default=0, help='optional cap on datasets from the default order')
    args = p.parse_args(argv)
    names = args.datasets or list(PHASE_A_ORDER)
    if args.limit:
        names = names[: args.limit]
    skipped = {
        'methods': list(SKIPPED_METHODS),
        'datasets': [
            {'id': name, 'reason': SKIPPED_DATASET_REASONS.get(name, 'cost')}
            for name in SKIPPED_DATASETS
        ],
        'query_slice': {
            'max_queries': MAX_QUERIES,
            'corpus': 'full',
            'policy': 'seeded query sample without replacement when n_queries > MAX_QUERIES',
        },
        'note': 'Skipped items are methods or TREC DL (missing MS MARCO dump). Large BEIR sets keep all documents and subsample queries.',
    }
    ART.mkdir(parents=True, exist_ok=True)
    RES.mkdir(parents=True, exist_ok=True)
    write_json(RES / 'skipped.json', skipped)
    write_provenance({'phase': 'A', 'datasets': names, 'k': args.k, 'skipped': skipped})
    summary = []
    failures = []
    for name in names:
        print(f'=== phase A {name} k={args.k} ===', flush=True)
        try:
            out = run_one(name, args.k, args.force)
            summary.append({
                'dataset': name,
                'stats': out['stats'],
                'mean_chosen_alpha': out['calibration']['mean_chosen_alpha'],
                'seconds': out['seconds'],
            })
            print(json.dumps(summary[-1], default=str), flush=True)
        except Exception as exc:  # noqa: BLE001
            failures.append({'dataset': name, 'error': repr(exc), 'trace': traceback.format_exc()})
            print('FAILED', name, repr(exc), flush=True)
            traceback.print_exc()
    write_json(RES / f'phase_a_summary_k{args.k}.json', {'ok': summary, 'failures': failures, 'k': args.k})
    return 0 if summary else 1


if __name__ == '__main__':
    sys.exit(main())
