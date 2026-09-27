"""Factorized moments, joint variance, and vectorized Gaussian tails."""

from __future__ import annotations

import math
import unittest

import numpy as np
from scipy.special import log_ndtr
from scipy.stats import norm

from bm25_calib.null import gaussian_rank_tails, gaussian_tail
from bm25_calib.retrieve import build_index, retrieve_query
from bm25_calib.theory import term_moments_from_posting

from _synth import make_bundle


class MomentEnumerationTests(unittest.TestCase):
    def test_mu_var_match_full_enumeration(self):
        n = 8
        dl_norm = np.ones(n)
        idx = np.array([0, 2, 5], dtype=np.int32)
        tf = np.array([1.0, 2.0, 4.0])
        idf = 1.7
        k1 = 1.2
        mu, var, u = term_moments_from_posting(tf, idx, dl_norm, idf, n, k1=k1)
        x = np.zeros(n)
        x[idx] = (k1 + 1.0) * idf * u
        self.assertAlmostEqual(mu, float(x.mean()), places=12)
        self.assertAlmostEqual(var, float(x.var()), places=12)


class JointVarianceTests(unittest.TestCase):
    def _inject(self, n, postings, queries):
        qrels = {qid: {'d0': 1} for qid in queries}
        docs = [(f'd{i}', 'padtoken') for i in range(n)]
        index = build_index(make_bundle(docs, queries, qrels, name='var'))
        index['n_docs'] = n
        index['postings'].update(postings)
        for term, (idx, x) in postings.items():
            n_safe = max(n, 1)
            mu = float(np.asarray(x, dtype=np.float64).sum()) / n_safe
            second = float(np.square(np.asarray(x, dtype=np.float64)).sum()) / n_safe
            index['term_mu'][term] = mu
            index['term_var'][term] = max(second - mu * mu, 0.0)
            index['df'][term] = int(len(idx))
            index['idf'][term] = 1.0
        index['q_terms'] = {qid: terms for qid, terms in queries.items()}
        # queries dict maps qid -> text; overwrite q_terms properly
        index['q_terms'] = {qid: [t for t in text.split() if t != 'unused'] for qid, text in queries.items()}
        return index

    def test_independent_ratio_near_one(self):
        rng = np.random.default_rng(0)
        n = 400
        idx_a = np.flatnonzero(rng.random(n) < 0.2).astype(np.int32)
        idx_b = np.flatnonzero(rng.random(n) < 0.2).astype(np.int32)
        xa = np.ones(len(idx_a), dtype=np.float32)
        xb = np.ones(len(idx_b), dtype=np.float32)
        queries = {'q': 'a b'}
        index = self._inject(n, {'a': (idx_a, xa), 'b': (idx_b, xb)}, queries)
        index['q_terms'] = {'q': ['a', 'b']}
        _, _, _, touched = retrieve_query(['a', 'b'], index, k=n)
        mu_j = float(touched.astype(np.float64).sum()) / n
        e2 = float(np.square(touched.astype(np.float64)).sum()) / n
        v_joint = e2 - mu_j * mu_j
        v_diag = index['term_var']['a'] + index['term_var']['b']
        ratio = v_joint / v_diag
        self.assertAlmostEqual(ratio, 1.0, delta=0.08)

    def test_cooccurring_ratio_greater_than_one(self):
        n = 200
        idx = np.arange(80, dtype=np.int32)
        x = np.ones(len(idx), dtype=np.float32)
        index = self._inject(n, {'a': (idx, x.copy()), 'b': (idx, x.copy())}, {'q': 'a b'})
        index['q_terms'] = {'q': ['a', 'b']}
        _, _, _, touched = retrieve_query(['a', 'b'], index, k=n)
        mu_j = float(touched.astype(np.float64).sum()) / n
        e2 = float(np.square(touched.astype(np.float64)).sum()) / n
        v_joint = e2 - mu_j * mu_j
        v_diag = index['term_var']['a'] + index['term_var']['b']
        self.assertGreater(v_joint / v_diag, 1.5)

    def test_exclusive_ratio_less_than_one(self):
        n = 200
        idx_a = np.arange(0, 80, dtype=np.int32)
        idx_b = np.arange(80, 160, dtype=np.int32)
        xa = np.ones(len(idx_a), dtype=np.float32)
        xb = np.ones(len(idx_b), dtype=np.float32)
        index = self._inject(n, {'a': (idx_a, xa), 'b': (idx_b, xb)}, {'q': 'a b'})
        index['q_terms'] = {'q': ['a', 'b']}
        _, _, _, touched = retrieve_query(['a', 'b'], index, k=n)
        mu_j = float(touched.astype(np.float64).sum()) / n
        e2 = float(np.square(touched.astype(np.float64)).sum()) / n
        v_joint = e2 - mu_j * mu_j
        v_diag = index['term_var']['a'] + index['term_var']['b']
        self.assertLess(v_joint / v_diag, 1.0)

    def test_precomputed_mu_q_is_sum_of_term_moments(self):
        from bm25_calib.retrieve import retrieve_all
        docs = [
            ('d0', 'alpha beta'),
            ('d1', 'alpha'),
            ('d2', 'gamma'),
            ('d3', 'beta gamma'),
        ]
        queries = {'q': 'alpha beta'}
        qrels = {'q': {'d0': 1}}
        index = build_index(make_bundle(docs, queries, qrels))
        row = retrieve_all(index, k=10)['q']
        expected_mu = index['term_mu']['alpha'] + index['term_mu']['beta']
        expected_var = index['term_var']['alpha'] + index['term_var']['beta']
        self.assertAlmostEqual(row['mu_q'], expected_mu, places=10)
        self.assertAlmostEqual(row['v_diag'], expected_var, places=10)


class GaussianTailTests(unittest.TestCase):
    def test_vectorized_matches_scipy_logsf(self):
        mu = 0.4
        var = 1.21
        scores = np.linspace(-4, 8, 40)
        tails = gaussian_rank_tails(scores, n_docs=1000, mu=mu, var_diag=var)
        z = (scores - mu) / math.sqrt(var)
        np.testing.assert_allclose(tails['z_scores'], z, rtol=0, atol=1e-12)
        np.testing.assert_allclose(tails['I_gauss_diag'], -norm.logsf(z), rtol=1e-10, atol=1e-10)
        np.testing.assert_allclose(tails['I_gauss_diag'], -log_ndtr(-z), rtol=0, atol=1e-12)

    def test_extreme_z_matches_high_precision_reference(self):
        mu = 0.0
        var = 1.0
        z = np.array([-8.0, -3.0, 0.0, 3.0, 8.0, 20.0, 40.0])
        scores = z  # mu=0 var=1
        tails = gaussian_rank_tails(scores, n_docs=10, mu=mu, var_diag=var)
        ref = -norm.logsf(z)
        np.testing.assert_allclose(tails['I_gauss_diag'], ref, rtol=1e-9, atol=1e-9)
        # No artificial -log(1e-300) cap on the far right tail.
        self.assertGreater(float(tails['I_gauss_diag'][-1]), 700.0)

    def test_scalar_gaussian_tail_agrees_with_vectorized(self):
        scores = np.array([0.2, 1.5, 4.0])
        tails = gaussian_rank_tails(scores, 50, 0.1, 0.81)
        for s, p in zip(scores, tails['p0_gauss_diag']):
            self.assertAlmostEqual(float(p), gaussian_tail(0.1, 0.81, float(s)), places=12)

    def test_i_gauss_is_monotone_in_z(self):
        scores = np.array([1.0, 2.0, 4.0, 7.0])
        tails = gaussian_rank_tails(scores, 100, 0.0, 1.0)
        order_z = np.argsort(-tails['z_scores']).tolist()
        order_i = np.argsort(-tails['I_gauss_diag']).tolist()
        self.assertEqual(order_z, order_i)


if __name__ == '__main__':
    unittest.main()
