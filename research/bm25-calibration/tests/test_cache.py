"""Fail-closed atomic cross-encoder cache."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from bm25_calib.cache import (
    build_manifest,
    load_cache_strict,
    write_cache_atomic,
)
from bm25_calib.phase_b import ce_aligned, score_and_cache
from bm25_calib.retrieve import build_index, load_candidate_texts, retrieve_all

from _synth import make_bundle


def _tiny():
    docs = [('d0', 'alpha token'), ('d1', 'beta token'), ('d2', 'gamma')]
    queries = {'q1': 'alpha', 'q2': 'beta'}
    qrels = {'q1': {'d0': 1}, 'q2': {'d1': 1}}
    index = build_index(make_bundle(docs, queries, qrels, name='cache-ds'))
    retrieved = retrieve_all(index, k=10)
    return index, retrieved


class CacheContractTests(unittest.TestCase):
    def _manifest(self, index, retrieved, **over):
        man = build_manifest(
            'cache-ds', index, retrieved, 'dummy-model', 'rev-abc', 'st', '1.0',
            'deadbeef', 'protohash', k=10,
        )
        man.update(over)
        return man

    def test_atomic_write_and_roundtrip(self):
        index, retrieved = _tiny()
        pairs = [('q1', 'd0'), ('q2', 'd1')]
        # actual pairs from retrieval may include more docs
        from bm25_calib.cache import expected_pairs
        pair_list = expected_pairs(retrieved, index['docids'])
        pair_set = set(pair_list)
        rows = [{'qid': q, 'docid': d, 'ce': 0.5} for q, d in pair_list]
        man = self._manifest(index, retrieved)
        man['n_pairs'] = len(rows)
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            jsonl = root / 'c.jsonl'
            mp = root / 'c.manifest.json'
            write_cache_atomic(jsonl, mp, rows, man, expected_pair_set=pair_set)
            self.assertTrue(jsonl.exists())
            self.assertFalse(jsonl.with_suffix('.jsonl.tmp').exists())
            cached = load_cache_strict(jsonl, mp, man, pair_set)
            self.assertEqual(len(pair_set), sum(len(v) for v in cached.values()))

    def test_incomplete_file_rejected(self):
        index, retrieved = _tiny()
        from bm25_calib.cache import expected_pairs
        pair_list = expected_pairs(retrieved, index['docids'])
        man = self._manifest(index, retrieved)
        man['n_pairs'] = len(pair_list)
        rows = [{'qid': pair_list[0][0], 'docid': pair_list[0][1], 'ce': 1.0}]
        with tempfile.TemporaryDirectory() as td:
            jsonl = Path(td) / 'c.jsonl'
            mp = Path(td) / 'c.manifest.json'
            with self.assertRaises(ValueError):
                write_cache_atomic(jsonl, mp, rows, man, expected_pair_set=set(pair_list))
            self.assertFalse(jsonl.exists())

    def test_wrong_query_hash_rejected(self):
        index, retrieved = _tiny()
        from bm25_calib.cache import expected_pairs
        pair_list = expected_pairs(retrieved, index['docids'])
        rows = [{'qid': q, 'docid': d, 'ce': 0.1} for q, d in pair_list]
        man = self._manifest(index, retrieved)
        man['n_pairs'] = len(rows)
        with tempfile.TemporaryDirectory() as td:
            jsonl = Path(td) / 'c.jsonl'
            mp = Path(td) / 'c.manifest.json'
            write_cache_atomic(jsonl, mp, rows, man, expected_pair_set=set(pair_list))
            expected = dict(man)
            expected['query_set_hash'] = '0' * 64
            with self.assertRaises(ValueError) as ctx:
                load_cache_strict(jsonl, mp, expected, set(pair_list))
            self.assertIn('query_set_hash', str(ctx.exception))

    def test_wrong_candidate_hash_rejected(self):
        index, retrieved = _tiny()
        from bm25_calib.cache import expected_pairs
        pair_list = expected_pairs(retrieved, index['docids'])
        rows = [{'qid': q, 'docid': d, 'ce': 0.1} for q, d in pair_list]
        man = self._manifest(index, retrieved)
        man['n_pairs'] = len(rows)
        with tempfile.TemporaryDirectory() as td:
            jsonl = Path(td) / 'c.jsonl'
            mp = Path(td) / 'c.manifest.json'
            write_cache_atomic(jsonl, mp, rows, man, expected_pair_set=set(pair_list))
            expected = dict(man)
            expected['candidate_set_hash'] = 'ffff'
            with self.assertRaises(ValueError) as ctx:
                load_cache_strict(jsonl, mp, expected, set(pair_list))
            self.assertIn('candidate_set_hash', str(ctx.exception))

    def test_wrong_model_revision_rejected(self):
        index, retrieved = _tiny()
        from bm25_calib.cache import expected_pairs
        pair_list = expected_pairs(retrieved, index['docids'])
        rows = [{'qid': q, 'docid': d, 'ce': 0.1} for q, d in pair_list]
        man = self._manifest(index, retrieved)
        man['n_pairs'] = len(rows)
        with tempfile.TemporaryDirectory() as td:
            jsonl = Path(td) / 'c.jsonl'
            mp = Path(td) / 'c.manifest.json'
            write_cache_atomic(jsonl, mp, rows, man, expected_pair_set=set(pair_list))
            expected = dict(man)
            expected['reranker_revision'] = 'other-rev'
            with self.assertRaises(ValueError) as ctx:
                load_cache_strict(jsonl, mp, expected, set(pair_list))
            self.assertIn('reranker_revision', str(ctx.exception))

    def test_missing_score_rejected_at_align(self):
        index, retrieved = _tiny()
        row = retrieved['q1']
        with self.assertRaises(KeyError):
            ce_aligned('q1', row, index, {'not-a-doc': 1.0})

    def test_missing_text_rejected_before_rerank(self):
        index, retrieved = _tiny()
        texts = load_candidate_texts(index, retrieved)
        texts.pop(next(iter(texts)))
        fake_backend = ('st', None, 'rev', '1.0')

        class Boom:
            def predict(self, *a, **k):
                raise AssertionError('should not score')

        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(KeyError):
                score_and_cache(
                    'cache-ds', index, retrieved, texts, Path(td),
                    model_id='dummy-model', backend=('st', Boom(), 'rev', '1.0'),
                )
        del fake_backend

    def test_empty_text_rejected(self):
        index, retrieved = _tiny()
        texts = load_candidate_texts(index, retrieved)
        did = next(iter(texts))
        texts[did] = ''
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ValueError):
                score_and_cache(
                    'cache-ds', index, retrieved, texts, Path(td),
                    model_id='dummy-model',
                    backend=('st', object(), 'rev', '1.0'),
                )


if __name__ == '__main__':
    unittest.main()
