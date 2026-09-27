"""Spearman ties and paired bootstrap determinism."""

from __future__ import annotations

import unittest

import numpy as np
from scipy.stats import spearmanr as scipy_spearmanr

from bm25_calib.bootstrap import oof_paired_report, paired_ci
from bm25_calib.metrics import spearman


class SpearmanTieTests(unittest.TestCase):
    def test_many_ties_match_scipy_exactly(self):
        x = np.array([1.0, 1.0, 1.0, 2.0, 2.0, 3.0, 3.0, 3.0, 4.0])
        y = np.array([9.0, 8.0, 8.0, 7.0, 7.0, 1.0, 1.0, 0.0, 0.0])
        got = spearman(x, y)
        ref, _ = scipy_spearmanr(x, y)
        self.assertAlmostEqual(got, float(ref), places=15)

    def test_permutation_ties(self):
        rng = np.random.default_rng(0)
        for _ in range(20):
            x = rng.integers(0, 4, size=30).astype(float)
            y = rng.integers(0, 5, size=30).astype(float)
            if np.unique(x).size < 2 or np.unique(y).size < 2:
                continue
            got = spearman(x, y)
            ref, _ = scipy_spearmanr(x, y)
            self.assertAlmostEqual(got, float(ref), places=12)


class BootstrapTests(unittest.TestCase):
    def test_deterministic_for_fixed_seed(self):
        rng = np.random.default_rng(4)
        a = rng.random(40)
        b = a + rng.normal(0, 0.02, size=40)
        r1 = paired_ci(a, b, n_resamples=2000, seed=20260915)
        r2 = paired_ci(a, b, n_resamples=2000, seed=20260915)
        self.assertEqual(r1, r2)
        r3 = paired_ci(a, b, n_resamples=2000, seed=1)
        self.assertNotEqual(r1['lo'], r3['lo'])

    def test_oof_report_noninferiority_is_ci_lower_bound(self):
        base = np.ones(30)
        treat = np.ones(30)
        rep = oof_paired_report(treat, base, n_resamples=1000, seed=0)
        self.assertTrue(rep['noninferior_005'])
        self.assertGreater(rep['lo'], -0.005)
        lost = base - 0.02
        bad = oof_paired_report(lost, base, n_resamples=1000, seed=0)
        self.assertFalse(bad['noninferior_005'])
        self.assertLessEqual(bad['lo'], -0.005)


if __name__ == '__main__':
    unittest.main()
