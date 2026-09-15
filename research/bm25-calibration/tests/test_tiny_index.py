"""Synthetic end-to-end retrieval check (no network)."""

from __future__ import annotations

import unittest

import numpy as np

from bm25_calib.retrieve import build_index, retrieve_all
from bm25_calib.phase_a import flatten_candidates, evaluate_calibration


class TinyCorpusTests(unittest.TestCase):
    def test_retrieves_relevant_and_never_pads_zeros(self):
        docs = [
            ('d1', 'alpha beta beta rareterm'),
            ('d2', 'alpha gamma'),
            ('d3', 'unrelated text here'),
            ('d4', 'rareterm only'),
            ('d5', 'beta gamma delta'),
            ('d6', 'rareterm alpha'),
        ]
        queries = {
            'q1': 'rareterm beta',
            'q2': 'alpha gamma',
            'q3': 'rareterm',
            'q4': 'beta delta',
            'q5': 'gamma',
            'q6': 'unrelated rareterm',
            'q7': 'alpha beta',
            'q8': 'delta rareterm',
        }
        qrels = {
            'q1': {'d1': 1, 'd4': 1},
            'q2': {'d2': 1},
            'q3': {'d4': 1, 'd1': 1},
            'q4': {'d5': 1},
            'q5': {'d2': 1, 'd5': 1},
            'q6': {'d3': 1, 'd4': 1},
            'q7': {'d1': 1},
            'q8': {'d4': 1, 'd5': 1},
        }
        bundle = {
            'meta': {'name': 'tiny', 'url': 'synthetic', 'sha256': 'none'},
            'queries': queries,
            'qrels': qrels,
            'corpus_iter': iter(docs),
            'corpus_path': None,
        }
        index = build_index(bundle)
        retrieved = retrieve_all(index, k=10)
        row = retrieved['q1']
        self.assertGreater(len(row['scores']), 0)
        self.assertTrue(np.all(row['scores'] > 0))
        self.assertLessEqual(len(row['scores']), 10)
        packed = flatten_candidates(retrieved)
        cal = evaluate_calibration(packed)
        self.assertIn('folds', cal)
        self.assertGreater(len(cal['folds']), 0)
