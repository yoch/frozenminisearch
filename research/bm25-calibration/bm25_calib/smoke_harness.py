"""One-off smoke + RSS/timing on local BEIR dumps. Not a campaign."""

from __future__ import annotations

import resource
import time
from pathlib import Path

import numpy as np

from bm25_calib.data import prepare_beir
from bm25_calib.phase_a import flatten_candidates
from bm25_calib.retrieve import SearchAccumulator, build_index, retrieve_all, retrieve_naive, retrieve_query


def rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def smoke_dataset(name: str, data_root: Path, k: int = 100) -> dict:
    rss0 = rss_mb()
    t0 = time.perf_counter()
    bundle = prepare_beir(name, data_root)
    t_dl = time.perf_counter() - t0
    t1 = time.perf_counter()
    index = build_index(bundle)
    t_build = time.perf_counter() - t1
    rss_build = rss_mb()
    t2 = time.perf_counter()
    retrieved = retrieve_all(index, k=k)
    t_acc = time.perf_counter() - t2
    acc = SearchAccumulator(index['n_docs'])
    t3 = time.perf_counter()
    for terms in index['q_terms'].values():
        retrieve_naive(terms, index, k=k)
    t_naive = time.perf_counter() - t3
    t4 = time.perf_counter()
    for terms in index['q_terms'].values():
        retrieve_query(terms, index, k=k, acc=acc)
    t_acc2 = time.perf_counter() - t4
    n_mismatch = 0
    acc2 = SearchAccumulator(index['n_docs'])
    for qid, terms in index['q_terms'].items():
        a, sa, _, _ = retrieve_query(terms, index, k=min(k, 20), acc=acc2)
        b, sb = retrieve_naive(terms, index, k=min(k, 20))
        if list(a) != list(b) or not np.allclose(sa, sb, atol=1e-5, rtol=0):
            n_mismatch += 1
    packed = flatten_candidates(retrieved)
    sample = []
    for qid in list(index['q_terms'])[:3]:
        row = retrieved[qid]
        sample.append({
            'qid': qid,
            'query': index['queries'][qid][:120],
            'n_cand': int(len(row['scores'])),
            'no_match': bool(row['no_match']),
            'top_doc': index['docids'][int(row['inds'][0])] if len(row['inds']) else None,
            'top_score': float(row['scores'][0]) if len(row['scores']) else None,
            'n_rel_in_pool': int(np.sum(np.asarray(row['rel']) > 0)),
            'n_qrels': len(index['qrels'].get(qid, {})),
            'variance_ratio': row.get('variance_ratio'),
            'sum_idf': row['sum_idf'],
            'qlen_tok': row['qlen_tok'],
            'qlen_uniq': row['qlen_uniq'],
        })
    return {
        'dataset': name,
        'n_docs': index['n_docs'],
        'n_queries': len(retrieved),
        'no_match_rate': sum(1 for r in retrieved.values() if r['no_match']) / max(len(retrieved), 1),
        'mean_variance_ratio': float(np.nanmean([r.get('variance_ratio', np.nan) for r in retrieved.values()])),
        'seconds': {
            'prepare_or_reuse': t_dl,
            'build_index': t_build,
            'retrieve_all_accumulator': t_acc,
            'retrieve_naive_loop': t_naive,
            'retrieve_query_loop': t_acc2,
        },
        'rss_mb_after_build': rss_build,
        'rss_mb_delta_from_start': rss_build - rss0,
        'topk20_mismatches_vs_naive': n_mismatch,
        'index_format': index.get('format'),
        'dropped_high_df_terms': index['meta'].get('dropped_high_df_terms'),
        'sample_queries': sample,
        'n_packed': len(packed),
    }


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1] / 'artifacts' / 'datasets'
    out = {
        'rss_note': 'ru_maxrss is the process high-water mark in MiB (Linux, kB/1024)',
        'runs': [smoke_dataset('scifact', root), smoke_dataset('nfcorpus', root)],
    }
    from bm25_calib.phase_a import write_json
    dest = Path(__file__).resolve().parents[1] / 'results' / 'harness_smoke.json'
    write_json(dest, out)
    print(dest)
    for run in out['runs']:
        print(run['dataset'], {k: run[k] for k in ('n_docs', 'n_queries', 'no_match_rate', 'rss_mb_after_build', 'topk20_mismatches_vs_naive')})
        print('  seconds', run['seconds'])
        print('  sample', run['sample_queries'][0] if run['sample_queries'] else None)
