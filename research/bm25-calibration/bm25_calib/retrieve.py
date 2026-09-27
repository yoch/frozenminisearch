"""Query-vocabulary inverted index and BM25 top-K retrieval.

Scoring complexity is O(sum df_t) via a generation/touched accumulator.
Term contributions X_t, mu_t, var_t, and dl_norm are precomputed at index
build with the same BM25 weights used at query time.
"""

from __future__ import annotations

import pickle
from array import array
from collections import defaultdict
from pathlib import Path

import numpy as np

from .bm25 import idf_lucene, length_norm, term_contributions
from .config import B, K1, PRIMARY_K
from .data import iter_corpus_jsonl, query_vocab
from .null import gaussian_rank_tails
from .surprise import nqc, surprise_scores, wig_like
from .text import tokenize

# Bump when posting layout or scoring weights change. Old pickles must not be reused.
INDEX_FORMAT = 2


def get_dl_norm(index: dict, b: float | None = None) -> np.ndarray:
    """Length-norm vector. Recompute only when a sensitivity run uses a different b."""
    if b is None or float(b) == float(index['b']):
        return index['dl_norm']
    return length_norm(index['dls'], index['avgdl'], b=float(b))


def _topk(ids: np.ndarray, scores: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    """Top-k by score descending, then doc-id ascending. Tie-complete at the cutoff."""
    if len(ids) == 0 or k <= 0:
        return np.zeros(0, dtype=np.int32), np.zeros(0, dtype=np.float32)
    if len(ids) <= k:
        order = np.lexsort((ids, -scores))
        return ids[order].astype(np.int32), scores[order].astype(np.float32)
    pick = np.argpartition(-scores, kth=k - 1)
    cutoff = scores[pick[k - 1]]
    greater = scores > cutoff
    n_greater = int(np.count_nonzero(greater))
    if n_greater >= k:
        ids_g = ids[greater]
        sc_g = scores[greater]
        order = np.lexsort((ids_g, -sc_g))[:k]
        return ids_g[order].astype(np.int32), sc_g[order].astype(np.float32)
    need = k - n_greater
    equal = scores == cutoff
    ids_e = ids[equal]
    sc_e = scores[equal]
    take_e = np.argsort(ids_e, kind='mergesort')[:need]
    if n_greater:
        ids_out = np.concatenate([ids[greater], ids_e[take_e]])
        sc_out = np.concatenate([scores[greater], sc_e[take_e]])
    else:
        ids_out = ids_e[take_e]
        sc_out = sc_e[take_e]
    order = np.lexsort((ids_out, -sc_out))
    return ids_out[order].astype(np.int32), sc_out[order].astype(np.float32)


class SearchAccumulator:
    """Dense reusable scores with generation stamps; no O(N) reset per query."""

    def __init__(self, n_docs: int):
        n = max(int(n_docs), 1)
        self.n = n
        self.scores = np.empty(n, dtype=np.float32)
        self.generation = np.zeros(n, dtype=np.uint32)
        self.touched = np.empty(n, dtype=np.int32)
        self.gen = np.uint32(0)
        self.n_touched = 0

    def begin(self) -> None:
        g = int(self.gen) + 1
        if g >= 2 ** 32 - 2:
            self.generation.fill(0)
            g = 1
        self.gen = np.uint32(g)
        self.n_touched = 0

    def add_posting(self, idx: np.ndarray, x: np.ndarray) -> None:
        if len(idx) == 0:
            return
        g = self.gen
        is_new = self.generation[idx] != g
        if np.any(is_new):
            new_idx = idx[is_new]
            self.generation[new_idx] = g
            self.scores[new_idx] = 0.0
            n0 = self.n_touched
            n1 = n0 + int(len(new_idx))
            self.touched[n0:n1] = new_idx
            self.n_touched = n1
        self.scores[idx] += x.astype(np.float32, copy=False)

    def candidates(self) -> tuple[np.ndarray, np.ndarray]:
        ids = self.touched[: self.n_touched]
        return ids, self.scores[ids]


def build_index(bundle: dict, k1: float = K1, b: float = B) -> dict:
    queries = bundle['queries']
    q_tokens, q_terms, vocab = query_vocab(queries)
    post_docs: dict[str, array] = defaultdict(lambda: array('I'))
    post_tfs: dict[str, array] = defaultdict(lambda: array('I'))
    docids: list[str] = []
    dls: list[int] = []
    for i, (doc_id, text) in enumerate(bundle['corpus_iter']):
        if i and i % 50_000 == 0:
            print(f'  index {i} docs', flush=True)
        toks = tokenize(text)
        dls.append(len(toks))
        docids.append(doc_id)
        tf_map: dict[str, int] = {}
        for tok in toks:
            if tok in vocab:
                tf_map[tok] = tf_map.get(tok, 0) + 1
        for tok, tf in tf_map.items():
            post_docs[tok].append(i)
            post_tfs[tok].append(int(tf))
    n_docs = len(docids)
    dls_arr = np.asarray(dls, dtype=np.float32)
    avgdl = float(dls_arr.mean()) if n_docs else 1.0
    dl_norm = length_norm(dls_arr, avgdl, b=b).astype(np.float64)
    postings: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    df: dict[str, int] = {}
    idf: dict[str, float] = {}
    term_mu: dict[str, float] = {}
    term_var: dict[str, float] = {}
    n = max(n_docs, 1)
    for term in vocab:
        buf_i = post_docs.get(term)
        buf_t = post_tfs.get(term)
        if not buf_i:
            idx = np.zeros(0, dtype=np.int32)
            tf = np.zeros(0, dtype=np.float32)
        else:
            idx = np.frombuffer(buf_i, dtype=np.uint32).astype(np.int32, copy=True)
            tf = np.frombuffer(buf_t, dtype=np.uint32).astype(np.float32, copy=True)
        df_t = int(len(idx))
        idf_t = idf_lucene(df_t, n_docs) if n_docs else 0.0
        if df_t:
            x = term_contributions(tf, dl_norm[idx], idf_t, k1=k1).astype(np.float32)
        else:
            x = np.zeros(0, dtype=np.float32)
        mu = float(x.sum()) / n
        second = float(np.square(x, dtype=np.float64).sum()) / n
        var = max(second - mu * mu, 0.0)
        postings[term] = (idx, x)
        df[term] = df_t
        idf[term] = idf_t
        term_mu[term] = mu
        term_var[term] = var
    return {
        'docids': docids,
        'dls': dls_arr,
        'avgdl': avgdl,
        'dl_norm': dl_norm,
        'n_docs': n_docs,
        'postings': postings,
        'df': df,
        'idf': idf,
        'term_mu': term_mu,
        'term_var': term_var,
        'k1': k1,
        'b': b,
        'format': INDEX_FORMAT,
        'q_tokens': q_tokens,
        'q_terms': q_terms,
        'queries': queries,
        'qrels': bundle['qrels'],
        'judged': bundle.get('judged') or bundle['qrels'],
        'doc_texts': bundle.get('doc_texts'),
        'meta': {
            **bundle['meta'],
            'n_docs': n_docs,
            'n_queries': len(queries),
            'n_qrels': sum(len(v) for v in bundle['qrels'].values()),
            'avgdl': avgdl,
            'k1': k1,
            'b': b,
            'dropped_high_df_terms': [],
            'index_format': INDEX_FORMAT,
            'vocab': len(vocab),
            'kept_terms': len(postings),
        },
        'corpus_path': bundle.get('corpus_path'),
    }


def save_index(index: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as f:
        pickle.dump(index, f, protocol=4)


def load_index(path: Path) -> dict:
    with path.open('rb') as f:
        return pickle.load(f)


def retrieve_naive(
    terms: list[str],
    index: dict,
    k: int = PRIMARY_K,
) -> tuple[np.ndarray, np.ndarray]:
    """Independent dense implementation for tests. Same top-K rule as the accumulator."""
    n = index['n_docs']
    scores = np.zeros(n, dtype=np.float32)
    postings = index['postings']
    for term in terms:
        if term not in postings:
            continue
        idx, x = postings[term]
        if len(idx):
            scores[idx] += x
    pos = np.flatnonzero(scores > 0)
    return _topk(pos.astype(np.int32), scores[pos], k)


def retrieve_query(
    terms: list[str],
    index: dict,
    k: int = PRIMARY_K,
    acc: SearchAccumulator | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return (top_ids, top_scores, touched_ids, touched_scores)."""
    n = index['n_docs']
    if acc is None:
        acc = SearchAccumulator(n)
    acc.begin()
    postings = index['postings']
    for term in terms:
        if term not in postings:
            continue
        idx, x = postings[term]
        acc.add_posting(idx, x)
    touched_ids, touched_scores = acc.candidates()
    top_ids, top_scores = _topk(touched_ids.copy(), touched_scores.copy(), k)
    return top_ids, top_scores, touched_ids, touched_scores


def _query_factorized_moments(terms: list[str], index: dict) -> tuple[float, float]:
    mu = 0.0
    var = 0.0
    term_mu = index['term_mu']
    term_var = index['term_var']
    for t in terms:
        mu += term_mu.get(t, 0.0)
        var += term_var.get(t, 0.0)
    return mu, max(var, 1e-18)


def _joint_moments(touched_scores: np.ndarray, n_docs: int) -> tuple[float, float]:
    n = max(int(n_docs), 1)
    if len(touched_scores) == 0:
        return 0.0, 0.0
    s = touched_scores.astype(np.float64, copy=False)
    mu = float(s.sum()) / n
    e2 = float(np.square(s).sum()) / n
    return mu, max(e2 - mu * mu, 0.0)


def retrieve_all(index: dict, k: int = PRIMARY_K) -> dict[str, dict]:
    n_docs = index['n_docs']
    acc = SearchAccumulator(n_docs)
    out: dict[str, dict] = {}
    qrels = index['qrels']
    judged = index.get('judged') or qrels
    docids = index['docids']
    n_q = len(index['q_terms'])
    n_no_match = 0
    for qi, (qid, terms) in enumerate(index['q_terms'].items(), start=1):
        inds, scores, touched_ids, touched_scores = retrieve_query(terms, index, k=k, acc=acc)
        relmap = qrels.get(qid, {})
        judged_map = judged.get(qid, {})
        ideal_rels = np.array(list(relmap.values()), dtype=np.float64)
        rel = np.array([int(relmap.get(docids[int(i)], 0)) for i in inds], dtype=np.int32)
        judged_mask = np.array([docids[int(i)] in judged_map for i in inds], dtype=bool)
        tokens = index['q_tokens'][qid]
        qlen_tok = max(len(tokens), 1)
        qlen_uniq = max(len(terms), 1)
        in_vocab = [t for t in terms if index['df'].get(t, 0) > 0]
        sum_idf = float(sum(index['idf'][t] for t in in_vocab))
        mu_q, v_diag = _query_factorized_moments(in_vocab, index)
        mu_joint, v_joint = _joint_moments(touched_scores, n_docs)
        tails = gaussian_rank_tails(scores, n_docs, mu_q, v_diag)
        no_match = len(scores) == 0
        n_no_match += int(no_match)
        var_ratio = (v_joint / v_diag) if v_diag > 0 else float('nan')
        out[qid] = {
            'inds': inds,
            'scores': scores,
            'rel': rel,
            'judged_mask': judged_mask,
            'ideal_rels': ideal_rels,
            'qlen_tok': qlen_tok,
            'qlen_uniq': qlen_uniq,
            'sum_idf': sum_idf,
            'n_terms_in_vocab': len(in_vocab),
            'no_match': no_match,
            'mu_q': mu_q,
            'v_diag': v_diag,
            'sd_diag': float(np.sqrt(v_diag)),
            'mu_joint': mu_joint,
            'v_joint': max(v_joint, 1e-18),
            'sd_joint': float(np.sqrt(max(v_joint, 1e-18))),
            'variance_ratio': var_ratio,
            'covariance_sum': (v_joint - v_diag) / 2.0,
            'surprise': surprise_scores(scores),
            'nqc': nqc(scores),
            'wig': wig_like(scores, mu_q, qlen_tok),
            **tails,
        }
        if qi % 100 == 0 or qi == n_q:
            print(f'  retrieve {qi}/{n_q}', flush=True)
    return out


def load_candidate_texts(index: dict, retrieved: dict[str, dict]) -> dict[str, str]:
    needed: set[str] = set()
    docids = index['docids']
    for qid, row in retrieved.items():
        if qid.startswith('_'):
            continue
        for i in row['inds']:
            needed.add(docids[int(i)])
    if not needed:
        return {}
    stored = index.get('doc_texts')
    if stored is not None:
        missing = [did for did in needed if did not in stored]
        if missing:
            raise KeyError(f'missing stored texts for {len(missing)} docs, e.g. {missing[:3]}')
        empty = [did for did in needed if not stored[did]]
        if empty:
            raise ValueError(f'empty stored document text for {empty[:3]}')
        return {did: stored[did] for did in needed}
    corpus_path = index.get('corpus_path')
    if not corpus_path:
        raise FileNotFoundError('no corpus_path or doc_texts to load candidate text')
    texts: dict[str, str] = {}
    for doc_id, text in iter_corpus_jsonl(Path(corpus_path)):
        if doc_id in needed:
            if not text:
                raise ValueError(f'empty document text for {doc_id}')
            texts[doc_id] = text
            if len(texts) == len(needed):
                break
    missing = needed - set(texts)
    if missing:
        raise KeyError(f'missing corpus texts for {len(missing)} docs, e.g. {list(missing)[:3]}')
    empty = [did for did, t in texts.items() if not t]
    if empty:
        raise ValueError(f'empty document text for {empty[:3]}')
    return texts
