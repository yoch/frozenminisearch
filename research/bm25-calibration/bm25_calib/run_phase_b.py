"""CLI: Phase B cached cross-encoder reranking and gating Pareto."""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path

from .config import MAX_QUERIES, PHASE_B_DATASETS, PHASE_B_SKIP, PRIMARY_K, RERANKER_MODEL, SEED
from .phase_a import flatten_candidates, write_json
from .phase_b import load_cross_encoder, pareto_and_end_to_end, score_and_cache
from .retrieve import load_candidate_texts, load_index, retrieve_all
from .run_phase_a import ART, RES, run_one


def run_one_b(name: str, force: bool, backend=None) -> dict:
    out_path = RES / f'phase_b_{name}.json'
    if out_path.exists() and not force:
        return json.loads(out_path.read_text(encoding='utf8'))
    t0 = time.time()
    run_one(name, PRIMARY_K, force=False)
    idx_path = ART / 'indexes' / f'{name}_qcap{MAX_QUERIES}.pkl'
    index = load_index(idx_path)
    retrieved = retrieve_all(index, k=PRIMARY_K)
    packed = flatten_candidates(retrieved)
    texts = load_candidate_texts(index, retrieved)
    ce = score_and_cache(name, index, retrieved, texts, ART / 'rerank', backend=backend)
    result = pareto_and_end_to_end(packed, index, ce, seed=SEED)
    result['dataset'] = name
    result['seconds'] = time.time() - t0
    result['n_cached_queries'] = len(ce)
    result['model'] = RERANKER_MODEL
    write_json(out_path, result)
    return result


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--datasets', nargs='*', default=None)
    p.add_argument('--force', action='store_true')
    args = p.parse_args(argv)
    names = args.datasets or list(PHASE_B_DATASETS)
    backend = None
    summary = []
    failures = []
    for name in names:
        print(f'=== phase B {name} ===', flush=True)
        try:
            if backend is None:
                backend = load_cross_encoder()
            out = run_one_b(name, args.force, backend=backend)
            summary.append({'dataset': name, 'seconds': out.get('seconds'), 'folds': len(out.get('folds', []))})
            print(json.dumps(summary[-1]), flush=True)
        except Exception as exc:  # noqa: BLE001
            failures.append({'dataset': name, 'error': repr(exc), 'trace': traceback.format_exc()})
            print('FAILED', name, repr(exc), flush=True)
            traceback.print_exc()
    write_json(RES / 'phase_b_summary.json', {
        'ok': summary,
        'failures': failures,
        'skipped': [{'id': name, 'reason': 'document-length queries; MiniLM CPU cost'} for name in PHASE_B_SKIP],
    })
    return 0 if summary else 1


if __name__ == '__main__':
    sys.exit(main())
