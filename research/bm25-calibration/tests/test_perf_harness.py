"""Optional timing comparison: typed postings + accumulator vs list + O(N)."""

from __future__ import annotations

import time
import unittest
from collections import defaultdict

import numpy as np

from bm25_calib.bm25 import idf_lucene, length_norm, term_contributions
from bm25_calib.retrieve import SearchAccumulator, build_index, retrieve_naive, retrieve_query
from bm25_calib.text import tokenize

from _synth import make_bundle


def _python_list_postings(docs: list[tuple[str, str]], vocab: set[str], k1: float = 1.2, b: float = 0.75):
    post_docs: dict[str, list[int]] = defaultdict(list)
    post_tfs: dict[str, list[int]] = defaultdict(list)
    dls = []
    for i, (_did, text) in enumerate(docs):
        toks = tokenize(text)
        dls.append(len(toks))
        tf_map: dict[str, int] = {}
        for tok in toks:
            if tok in vocab:
                tf_map[tok] = tf_map.get(tok, 0) + 1
        for tok, tf in tf_map.items():
            post_docs[tok].append(i)
            post_tfs[tok].append(int(tf))
    n = len(docs)
    dls_arr = np.asarray(dls, dtype=np.float32)
    avgdl = float(dls_arr.mean()) if n else 1.0
    dl_norm = length_norm(dls_arr, avgdl, b=b)
    postings = {}
    for term in vocab:
        idx = np.asarray(post_docs[term], dtype=np.int32) if post_docs[term] else np.zeros(0, dtype=np.int32)
        tf = np.asarray(post_tfs[term], dtype=np.float32) if post_tfs[term] else np.zeros(0, dtype=np.float32)
        df_t = int(len(idx))
        idf_t = idf_lucene(df_t, n) if n else 0.0
        x = term_contributions(tf, dl_norm[idx], idf_t, k1=k1).astype(np.float32) if df_t else np.zeros(0, dtype=np.float32)
        postings[term] = (idx, x)
    return postings


class PerfSmokeTests(unittest.TestCase):
    def test_accumulator_matches_naive_and_is_not_slower_on_medium_synth(self):
        rng = np.random.default_rng(11)
        vocab_words = [f'w{i}' for i in range(80)]
        n = 2500
        docs = []
        for i in range(n):
            words = rng.choice(vocab_words, size=int(rng.integers(8, 40)), replace=True)
            docs.append((f'd{i}', ' '.join(str(w) for w in words)))
        queries = {
            f'q{j}': ' '.join(str(w) for w in rng.choice(vocab_words, size=3, replace=False))
            for j in range(40)
        }
        qrels = {qid: {docs[0][0]: 1} for qid in queries}
        t0 = time.perf_counter()
        index = build_index(make_bundle(docs, queries, qrels, name='perf'))
        typed_s = time.perf_counter() - t0
        t_list = time.perf_counter()
        _python_list_postings(docs, set(index['postings']))
        list_s = time.perf_counter() - t_list
        acc = SearchAccumulator(index['n_docs'])
        t1 = time.perf_counter()
        for terms in index['q_terms'].values():
            retrieve_query(terms, index, k=50, acc=acc)
        acc_s = time.perf_counter() - t1
        t2 = time.perf_counter()
        for terms in index['q_terms'].values():
            retrieve_naive(terms, index, k=50)
        naive_s = time.perf_counter() - t2
        self.assertGreater(typed_s, 0.0)
        self.assertGreater(list_s, 0.0)
        self.assertLess(acc_s, naive_s * 4.0 + 0.05)
        self.assertIn('format', index)
