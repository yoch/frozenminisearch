"""BM25 retrieval: accumulator vs brute, OOV, ties, no-match, unique terms."""

from __future__ import annotations

import unittest

import numpy as np

from bm25_calib.bm25 import idf_lucene, length_norm, term_contributions
from bm25_calib.retrieve import (
    SearchAccumulator,
    _topk,
    build_index,
    get_dl_norm,
    retrieve_naive,
    retrieve_query,
)
from bm25_calib.text import tokenize, unique_terms

from _synth import make_bundle


def brute_bm25_scores(query: str, docs: list[tuple[str, str]], k1: float = 1.2, b: float = 0.75) -> np.ndarray:
    tokenized = [tokenize(text) for _, text in docs]
    n = len(docs)
    dls = np.array([len(toks) for toks in tokenized], dtype=np.float32)
    avgdl = float(dls.mean()) if n else 1.0
    dl_n = length_norm(dls, avgdl, b=b)
    tfs: list[dict[str, int]] = []
    df: dict[str, int] = {}
    for toks in tokenized:
        tf: dict[str, int] = {}
        for tok in toks:
            tf[tok] = tf.get(tok, 0) + 1
        tfs.append(tf)
        for tok in tf:
            df[tok] = df.get(tok, 0) + 1
    scores = np.zeros(n, dtype=np.float32)
    for term in unique_terms(tokenize(query)):
        df_t = df.get(term, 0)
        if df_t == 0:
            continue
        idf = idf_lucene(df_t, n)
        for i, tfmap in enumerate(tfs):
            tf = tfmap.get(term, 0.0)
            if tf:
                contrib = term_contributions(np.array([float(tf)]), dl_n[i:i + 1], idf, k1=k1)
                scores[i] += np.float32(contrib[0])
    return scores


class TinyIndexFactory(unittest.TestCase):
    def _index(self, docs, queries, qrels):
        return build_index(make_bundle(docs, queries, qrels, name='tiny-ret'))


class AccumulatorVsNaiveTests(TinyIndexFactory):
    def test_topk_matches_naive_on_random_corpora(self):
        rng = np.random.default_rng(20260915)
        vocab = [f'w{i}' for i in range(24)]
        for trial in range(12):
            n = int(rng.integers(30, 90))
            docs = []
            for i in range(n):
                words = rng.choice(vocab, size=int(rng.integers(4, 18)), replace=True)
                docs.append((f'd{i}', ' '.join(str(w) for w in words)))
            queries = {}
            qrels = {}
            for q in range(8):
                qwords = rng.choice(vocab, size=int(rng.integers(1, 5)), replace=False)
                queries[f'q{q}'] = ' '.join(str(w) for w in qwords)
                qrels[f'q{q}'] = {docs[0][0]: 1}
            index = self._index(docs, queries, qrels)
            acc = SearchAccumulator(index['n_docs'])
            for qid, terms in index['q_terms'].items():
                ids_a, sc_a, _, _ = retrieve_query(terms, index, k=10, acc=acc)
                ids_n, sc_n = retrieve_naive(terms, index, k=10)
                np.testing.assert_array_equal(ids_a, ids_n, err_msg=f'trial {trial} {qid} ids')
                np.testing.assert_array_equal(sc_a, sc_n, err_msg=f'trial {trial} {qid} scores')

    def test_matches_independent_brute_implementation(self):
        rng = np.random.default_rng(7)
        vocab = [f't{i}' for i in range(16)]
        for trial in range(8):
            n = int(rng.integers(20, 50))
            docs = []
            for i in range(n):
                words = rng.choice(vocab, size=int(rng.integers(3, 12)), replace=True)
                docs.append((f'd{i}', ' '.join(str(w) for w in words)))
            qwords = rng.choice(vocab, size=3, replace=False)
            query = ' '.join(str(w) for w in qwords)
            queries = {'q': query}
            qrels = {'q': {docs[0][0]: 1}}
            index = self._index(docs, queries, qrels)
            ids, scores, _, _ = retrieve_query(index['q_terms']['q'], index, k=10)
            brute = brute_bm25_scores(query, docs)
            pos = np.flatnonzero(brute > 0)
            brute_ids, brute_sc = _topk(pos.astype(np.int32), brute[pos], 10)
            np.testing.assert_array_equal(ids, brute_ids, err_msg=f'trial {trial}')
            np.testing.assert_allclose(scores, brute_sc, rtol=0, atol=1e-5)


class QuerySemanticsTests(TinyIndexFactory):
    def test_repeated_query_terms_are_scored_once(self):
        docs = [('d0', 'alpha alpha alpha'), ('d1', 'beta')]
        queries = {'q': 'alpha alpha'}
        qrels = {'q': {'d0': 1}}
        index = self._index(docs, queries, qrels)
        self.assertEqual(index['q_tokens']['q'], ['alpha', 'alpha'])
        self.assertEqual(index['q_terms']['q'], ['alpha'])
        ids, scores, _, _ = retrieve_query(index['q_terms']['q'], index, k=10)
        self.assertEqual(list(ids), [0])
        once = retrieve_query(['alpha'], index, k=10)[1]
        twice_wrong = retrieve_query(['alpha', 'alpha'], index, k=10)[1]
        np.testing.assert_allclose(scores, once)
        self.assertGreater(float(twice_wrong[0]), float(scores[0]))

    def test_oov_does_not_increase_ceiling_sum_idf(self):
        docs = [('d0', 'alpha beta'), ('d1', 'alpha')]
        queries = {'q': 'alpha zzzoovtoken'}
        qrels = {'q': {'d0': 1}}
        from bm25_calib.retrieve import retrieve_all
        index = self._index(docs, queries, qrels)
        row = retrieve_all(index, k=10)['q']
        only_alpha = idf_lucene(index['df']['alpha'], index['n_docs'])
        self.assertAlmostEqual(row['sum_idf'], only_alpha)
        self.assertEqual(index['df'].get('zzzoovtoken', 0), 0)

    def test_term_with_df_equal_n_still_scores(self):
        docs = [('d0', 'common rare'), ('d1', 'common')]
        queries = {'q': 'common'}
        qrels = {'q': {'d0': 1}}
        index = self._index(docs, queries, qrels)
        self.assertEqual(index['df']['common'], 2)
        self.assertEqual(index['n_docs'], 2)
        self.assertGreater(index['idf']['common'], 0.0)
        ids, scores, _, _ = retrieve_query(['common'], index, k=10)
        self.assertEqual(len(ids), 2)
        self.assertTrue(np.all(scores > 0))

    def test_no_match_query_is_kept_empty(self):
        from bm25_calib.retrieve import retrieve_all
        docs = [('d0', 'alpha'), ('d1', 'beta')]
        queries = {'q': 'zzzmissingtoken'}
        qrels = {'q': {'d0': 1}}
        index = self._index(docs, queries, qrels)
        retrieved = retrieve_all(index, k=10)
        self.assertIn('q', retrieved)
        self.assertTrue(retrieved['q']['no_match'])
        self.assertEqual(len(retrieved['q']['scores']), 0)

    def test_ties_break_by_ascending_doc_id(self):
        docs = [('d0', 'alpha'), ('d1', 'alpha'), ('d2', 'alpha')]
        queries = {'q': 'alpha'}
        qrels = {'q': {'d0': 1}}
        index = self._index(docs, queries, qrels)
        ids, scores, _, _ = retrieve_query(['alpha'], index, k=10)
        self.assertTrue(np.allclose(scores, scores[0]))
        np.testing.assert_array_equal(ids, np.array([0, 1, 2], dtype=np.int32))

    def test_dl_norm_is_precomputed_and_b_override_differs(self):
        docs = [('d0', 'alpha beta gamma'), ('d1', 'alpha')]
        queries = {'q': 'alpha'}
        qrels = {'q': {'d0': 1}}
        index = self._index(docs, queries, qrels)
        cached = get_dl_norm(index)
        np.testing.assert_array_equal(cached, index['dl_norm'])
        other = get_dl_norm(index, b=0.0)
        self.assertFalse(np.allclose(other, cached))


class MissingTextTests(TinyIndexFactory):
    def test_missing_and_empty_text_raise(self):
        from bm25_calib.retrieve import load_candidate_texts, retrieve_all
        docs = [('d0', 'alpha'), ('d1', 'beta')]
        queries = {'q': 'alpha'}
        qrels = {'q': {'d0': 1}}
        index = self._index(docs, queries, qrels)
        retrieved = retrieve_all(index, k=10)
        index['doc_texts'] = {'d0': ''}
        with self.assertRaises(ValueError):
            load_candidate_texts(index, retrieved)
        index['doc_texts'] = {}
        with self.assertRaises(KeyError):
            load_candidate_texts(index, retrieved)


if __name__ == '__main__':
    unittest.main()
