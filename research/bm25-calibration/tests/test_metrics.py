"""IR metric definitions: full-qrel IDCG, P@k / k, MAP, Recall."""

from __future__ import annotations

import unittest

import numpy as np

from bm25_calib.metrics import (
    average_precision,
    ndcg_at,
    precision_at,
    ranking_metrics,
    recall_at,
)


class NdcgFullQrelsTests(unittest.TestCase):
    def test_dropping_best_grade_is_not_perfect(self):
        # A=3, B=2. Treatment keeps only B. IDCG uses both grades.
        ideal = np.array([3.0, 2.0])
        treatment = np.array([2.0])
        score = ndcg_at(treatment, ideal, k=10)
        self.assertLess(score, 1.0)
        self.assertGreater(score, 0.0)
        # Truncated-list IDCG would incorrectly yield 1.0.
        bogus = ndcg_at(treatment, treatment, k=10)
        self.assertAlmostEqual(bogus, 1.0)
        self.assertNotAlmostEqual(score, bogus)

    def test_baseline_and_treatment_share_idcg(self):
        ideal = np.array([3.0, 1.0, 2.0])
        baseline = np.array([3.0, 2.0, 1.0, 0.0])
        treatment = np.array([2.0, 1.0])
        b = ndcg_at(baseline, ideal, k=10)
        t = ndcg_at(treatment, ideal, k=10)
        self.assertAlmostEqual(b, 1.0)
        self.assertLess(t, b)

    def test_no_relevant_is_zero(self):
        self.assertEqual(ndcg_at(np.array([0.0, 0.0]), np.array([0.0]), k=10), 0.0)


class PrecisionAtKTests(unittest.TestCase):
    def test_single_relevant_hit_is_one_tenth(self):
        rels = np.array([1])
        self.assertAlmostEqual(precision_at(rels, k=10), 0.1)

    def test_empty_is_zero(self):
        self.assertEqual(precision_at(np.array([]), k=10), 0.0)

    def test_full_ten_hits(self):
        self.assertAlmostEqual(precision_at(np.ones(10), k=10), 1.0)


class MapRecallTests(unittest.TestCase):
    def test_map_denominator_is_full_qrel_relevant_count(self):
        # One hit at rank 1, but two qrel-relevant documents.
        rels = np.array([1, 0, 0])
        self.assertAlmostEqual(average_precision(rels, n_relevant=2), 0.5)

    def test_recall_uses_full_qrel_count(self):
        rels = np.array([1, 0, 0])
        self.assertAlmostEqual(recall_at(rels, n_relevant=5, k=10), 0.2)

    def test_ranking_metrics_bundle(self):
        ranked = np.array([1, 0])
        ideal = np.array([1, 1, 1])
        m = ranking_metrics(ranked, ideal, k=10)
        self.assertAlmostEqual(m['p@10'], 0.1)
        self.assertAlmostEqual(m['recall@10'], 1.0 / 3.0)
        self.assertLess(m['ndcg@10'], 1.0)
        self.assertAlmostEqual(m['success@10'], 1.0)
        self.assertAlmostEqual(m['map'], (1.0 / 1.0) / 3.0)


if __name__ == '__main__':
    unittest.main()
