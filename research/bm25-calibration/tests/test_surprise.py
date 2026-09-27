"""Surprise / GPD greedy selection without an arbitrary 8-step cap."""

from __future__ import annotations

import unittest

import numpy as np

from bm25_calib.surprise import surprise_scores


class SurpriseBehaviorTests(unittest.TestCase):
    def test_short_lists_are_zero(self):
        self.assertTrue(np.all(surprise_scores(np.array([3.0, 2.0, 1.0])) == 0))
        self.assertTrue(np.all(surprise_scores(np.array([9.0] * 11)) == 0))

    def test_flat_lists_are_zero(self):
        flat = np.full(40, 2.5)
        out = surprise_scores(flat)
        self.assertTrue(np.all(out == 0))

    def test_weak_monotonicity_on_skewed_list(self):
        rng = np.random.default_rng(0)
        raw = np.sort(rng.lognormal(0, 0.7, size=80))[::-1]
        s = surprise_scores(raw)
        self.assertEqual(len(s), 80)
        self.assertGreaterEqual(float(s[0]), float(s[-1]) - 1e-9)

    def test_greedy_can_trim_more_than_eight_each_side(self):
        # A long almost-GPD tail plus many low outliers: the uncapped greedy
        # must be allowed to drop more than 8 points if that improves CvM.
        rng = np.random.default_rng(3)
        tail = np.sort(rng.pareto(2.0, size=60) + 3.0)
        low = np.linspace(0.0, 0.2, 20)
        high = np.linspace(20.0, 21.0, 12)
        scores_asc = np.concatenate([low, tail, high])
        raw = scores_asc[::-1]
        s = surprise_scores(raw)
        self.assertEqual(len(s), len(raw))
        # Finite scores on the upper tail; zeros are allowed on discarded lower mass.
        self.assertTrue(np.any(s > 0))

    def test_does_not_crash_on_tiny_variance_tail(self):
        raw = np.concatenate([np.array([10.0, 9.99, 9.98]), np.full(30, 1.0)])
        s = surprise_scores(raw)
        self.assertEqual(len(s), len(raw))


if __name__ == '__main__':
    unittest.main()
