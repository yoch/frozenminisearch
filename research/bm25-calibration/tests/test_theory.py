"""Deterministic unit checks for the KL identity, BM25 kernel, and moments."""

from __future__ import annotations

import math
import unittest

import numpy as np

from bm25_calib.bm25 import idf_lucene, u_component
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
    def test_within_query_monotone_and_no_ambiguous_paper_name(self):
        raw = np.array([1.0, 4.0, 2.5, 0.2])
        qrow = {
            'qlen_tok': 3,
            'qlen_uniq': 3,
            'sum_idf': 5.0,
            'mu_q': 0.4,
            'sd_diag': 1.1,
            'rel': np.array([0, 1, 0, 0]),
            'I_gauss_diag': (raw - 0.4) / 1.1,
            'I_joint_rank': np.array([4.0, 3.0, 2.0, 1.0]),
            'surprise': raw.copy(),
        }
        variants = candidate_variants(raw, qrow)
        self.assertNotIn('paper', variants)
        order = np.argsort(-raw)
        monotone = [
            'raw', 'power_token_len', 'power_unique_len', 'ceiling', 'top_ratio',
            'minmax', 'sumnorm', 'z_emp', 'z_robust', 'z_diag', 'power_token_0',
            'power_token_1', 'I_gauss_diag',
        ]
        for name in monotone:
            arr = variants[name]
            self.assertEqual(np.argsort(-arr).tolist(), order.tolist(), name)


class NullTailTests(unittest.TestCase):
    def test_joint_rank_is_rank_over_n(self):
        from bm25_calib.null import gaussian_rank_tails, information
        scores = np.array([9.0, 4.0, 1.0])
        tails = gaussian_rank_tails(scores, n_docs=1000, mu=0.0, var_diag=1.0)
        np.testing.assert_allclose(tails['p0_joint_rank'], np.array([1, 2, 3]) / 1000.0)
        self.assertAlmostEqual(tails['I_joint_rank'][0], information(0.001), places=10)
        self.assertEqual(tails['tails_mode'], 'gaussian_z_normalization')

    def test_independence_mc_near_gaussian_for_many_terms(self):
        from bm25_calib.null import gaussian_tail, independence_mc_tail
        rng = np.random.default_rng(0)
        xs = [rng.normal(0.3, 0.2, size=80).clip(0) for _ in range(12)]
        s = 8.0
        p_mc = independence_mc_tail(xs, n_docs=500, s=s, n_draw=3000, seed=1)
        mu = sum(float(x.sum()) / 500 for x in xs)
        var = sum(float(np.square(x).sum()) / 500 - (float(x.sum()) / 500) ** 2 for x in xs)
        p_g = gaussian_tail(mu, var, s)
        self.assertLess(abs(p_mc - p_g), 0.15)


class SurpriseSmokeTests(unittest.TestCase):
    def test_surprise_preserves_weak_order_and_zeros_tiny_lists(self):
        from bm25_calib.surprise import surprise_scores
        tiny = np.array([3.0, 2.0, 1.0])
        self.assertTrue(np.all(surprise_scores(tiny) == 0))
        rng = np.random.default_rng(0)
        raw = np.sort(rng.lognormal(0, 0.5, size=80))[::-1]
        s = surprise_scores(raw)
        self.assertEqual(len(s), 80)
        self.assertGreaterEqual(float(s[0]), float(s[-1]) - 1e-9)


class QuerySliceTests(unittest.TestCase):
    def test_keeps_all_when_under_cap_and_samples_deterministically(self):
        from bm25_calib.data import subsample_queries
        queries = {f'q{i:03d}': 'text' for i in range(10)}
        qrels = {f'q{i:03d}': {'d1': 1} for i in range(10)}
        q1, r1, m1 = subsample_queries(queries, qrels, n_max=20, seed=1)
        self.assertFalse(m1['subsampled'])
        self.assertEqual(len(q1), 10)
        q2, r2, m2 = subsample_queries(queries, qrels, n_max=4, seed=20260915)
        q3, r3, m3 = subsample_queries(queries, qrels, n_max=4, seed=20260915)
        self.assertTrue(m2['subsampled'])
        self.assertEqual(len(q2), 4)
        self.assertEqual(sorted(q2), sorted(q3))
        self.assertEqual(set(q2), set(r2))
        q4, _, m4 = subsample_queries(queries, qrels, n_max=4, seed=7)
        self.assertTrue(m4['subsampled'])
        self.assertNotEqual(sorted(q2), sorted(q4))


if __name__ == '__main__':
    unittest.main()
