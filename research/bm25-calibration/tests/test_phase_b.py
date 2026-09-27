"""Prefix-metric cache, fixed-K invariants, threshold-to-K monotonicity."""

from __future__ import annotations

import unittest

import numpy as np

from bm25_calib.metrics import ranking_metrics
from bm25_calib.phase_a import flatten_candidates
from bm25_calib.phase_b import (
    prefix_metrics_table,
    threshold_to_prefix_k,
)
from bm25_calib.retrieve import build_index, retrieve_all

from _synth import make_bundle


def _packed():
    docs = [
        ('d0', 'alpha rare relevant'),
        ('d1', 'alpha beta'),
        ('d2', 'beta gamma'),
        ('d3', 'gamma rare'),
        ('d4', 'other tokens here'),
        ('d5', 'alpha gamma rare'),
    ]
    queries = {
        'q1': 'alpha rare',
        'q2': 'beta gamma',
        'q3': 'rare gamma',
        'q4': 'alpha beta',
        'q5': 'gamma',
        'q6': 'rare',
        'q7': 'alpha gamma',
        'q8': 'beta rare',
    }
    qrels = {
        'q1': {'d0': 3, 'd5': 1},
        'q2': {'d2': 1},
        'q3': {'d3': 2, 'd0': 1},
        'q4': {'d1': 1},
        'q5': {'d2': 1, 'd5': 1},
        'q6': {'d0': 1, 'd3': 1},
        'q7': {'d5': 1},
        'q8': {'d0': 1},
    }
    index = build_index(make_bundle(docs, queries, qrels, name='pb'))
    retrieved = retrieve_all(index, k=100)
    packed = flatten_candidates(retrieved)
    return index, packed


class PrefixMetricTests(unittest.TestCase):
    def test_prefix_table_matches_brute_rerank(self):
        index, packed = _packed()
        rng = np.random.default_rng(1)
        for qid, row in packed.items():
            n = len(row['inds'])
            ce = rng.normal(size=n)
            table = prefix_metrics_table(row, ce)
            self.assertEqual(len(table), n + 1)
            for k in range(0, n + 1):
                if k == 0:
                    brute = ranking_metrics(np.zeros(0), row['ideal_rels'], k=10)
                else:
                    order = np.argsort(-ce[:k], kind='mergesort')
                    ranked = np.asarray(row['rel'][:k], dtype=float)[order]
                    brute = ranking_metrics(ranked, row['ideal_rels'], k=10)
                self.assertAlmostEqual(table[k]['ndcg@10'], brute['ndcg@10'])
                self.assertAlmostEqual(table[k]['p@10'], brute['p@10'])
                self.assertAlmostEqual(table[k]['map'], brute['map'])
                self.assertEqual(table[k]['n_candidates'], k)
            self.assertAlmostEqual(table[n]['ndcg@10'], table[-1]['ndcg@10'])

    def test_fixed_k_100_and_retain_all_equal_baseline(self):
        index, packed = _packed()
        for qid, row in packed.items():
            n = len(row['inds'])
            ce = np.linspace(1.0, 0.0, n) if n else np.zeros(0)
            table = prefix_metrics_table(row, ce)
            baseline = table[-1]
            k100 = table[min(100, n)]
            self.assertAlmostEqual(k100['ndcg@10'], baseline['ndcg@10'])
            self.assertAlmostEqual(k100['mrr@10'], baseline['mrr@10'])
            self.assertAlmostEqual(k100['p@10'], baseline['p@10'])
            vals = np.asarray(row['scores'], dtype=float)
            k_retain = threshold_to_prefix_k(vals, -np.inf)
            self.assertEqual(k_retain, n if n else 0)
            if n:
                self.assertEqual(table[k_retain]['n_candidates'], n)

    def test_threshold_to_k_is_monotone(self):
        vals = np.array([5.0, 4.0, 3.0, 2.0, 1.0])
        ks = [threshold_to_prefix_k(vals, th) for th in (6, 5, 4.5, 3, 0, -np.inf)]
        self.assertEqual(ks[0], 1)  # nothing passes, force 1
        for a, b in zip(ks, ks[1:]):
            self.assertLessEqual(a, b)
        self.assertEqual(ks[-1], 5)

    def test_dropping_grade_3_is_not_ndcg_one(self):
        # Reconstruct the P0 metric bug: keep only B while A=3, B=2 exist in qrels.
        from bm25_calib.metrics import ndcg_at
        row_rel = np.array([2.0])  # kept B
        ideal = np.array([3.0, 2.0])
        self.assertLess(ndcg_at(row_rel, ideal, k=10), 1.0)


if __name__ == '__main__':
    unittest.main()
