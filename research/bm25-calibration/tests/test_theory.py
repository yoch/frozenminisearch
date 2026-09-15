"""Deterministic unit checks for the KL identity, BM25 kernel, and moments."""

from __future__ import annotations

import math
import unittest

import numpy as np

from bm25_calib.bm25 import idf_lucene, length_norm, term_contributions, u_component
from bm25_calib.normalize import candidate_variants
from bm25_calib.theory import kl_binary_from_score, paper_score, term_moments_from_posting


class KlIdentityTests(unittest.TestCase):
    def test_any_nonnegative_score_is_a_kl(self):
        for s in (0.0, 1e-12, 0.3, 1.0, math.log(2), 12.5):
            q, p, kl = kl_binary_from_score(s)
            self.assertEqual(q, (1.0, 0.0))
            self.assertAlmostEqual(p[0] + p[1], 1.0, places=12)
            self.assertAlmostEqual(kl, s, places=10)

    def test_rejects_negative(self):
        with self.assertRaises(ValueError):
            kl_binary_from_score(-0.1)


class Bm25KernelTests(unittest.TestCase):
    def test_idf_positive_and_decreases_with_df(self):
        self.assertGreater(idf_lucene(1, 1000), idf_lucene(100, 1000))
        self.assertGreater(idf_lucene(1000, 1000), 0.0)

    def test_zero_tf_gives_zero_u(self):
        u = u_component(np.array([0.0]), np.array([1.0]))
        self.assertEqual(float(u[0]), 0.0)

    def test_paper_constant_irrelevant_to_order(self):
        scores = [3.0, 9.0, 1.5]
        a = [paper_score(s, 4) for s in scores]
        b = [s / 4.0 for s in scores]
        self.assertEqual(np.argsort(a).tolist(), np.argsort(b).tolist())


class MomentTests(unittest.TestCase):
    def test_moments_include_zeros_and_match_population(self):
        n = 8
        dl_norm = np.ones(n)
        idx = np.array([0, 2, 5], dtype=np.int32)
        tf = np.array([1.0, 2.0, 4.0])
        idf = 1.7
        k1 = 1.2
        mu, var, u = term_moments_from_posting(tf, idx, dl_norm, idf, n, k1=k1)
        x = np.zeros(n)
        x[idx] = (k1 + 1.0) * idf * u
        self.assertAlmostEqual(mu, float(x.mean()), places=10)
        self.assertAlmostEqual(var, float(x.var()), places=10)


class NormalizeTests(unittest.TestCase):
    def test_within_query_monotone(self):
        raw = np.array([1.0, 4.0, 2.5, 0.2])
        qrow = {
            'qlen_tok': 3,
            'qlen_uniq': 3,
            'sum_idf': 5.0,
            'mu_q': 0.4,
            'sd_diag': 1.1,
            'sd_full': 1.4,
            'mean_term_corr': 0.2,
            'rel': np.array([0, 1, 0, 0]),
        }
        variants = candidate_variants(raw, qrow)
        order = np.argsort(-raw)
        for name, arr in variants.items():
            self.assertEqual(np.argsort(-arr).tolist(), order.tolist(), name)


if __name__ == '__main__':
    unittest.main()
