"""Query-vocabulary inverted index and BM25 top-K retrieval."""

from __future__ import annotations

import hashlib
import pickle
from collections import defaultdict
from pathlib import Path

import numpy as np

from .bm25 import idf_lucene, length_norm, term_contributions
from .config import B, HIGH_DF_DROP_FRACTION, K1, PRIMARY_K
from .data import iter_corpus_jsonl
from .data import query_vocab
from .null import query_term_xs, tails_for_scores
from .surprise import nqc, surprise_scores, wig_like
from .text import tokenize
from .theory import query_null


def build_index(bundle: dict, k1: float = K1, b: float = B) -> dict:
    queries = bundle['queries']
    q_tokens, q_terms, vocab = query_vocab(queries)
    post_docs: dict[str, list[int]] = defaultdict(list)
    post_tfs: dict[str, list[int]] = defaultdict(list)
    docids: list[str] = []
    dls: list[int] = []
    for i, (doc_id, text) in enumerate(bundle['corpus_iter']):
        toks = tokenize(text)
        dls.append(len(toks))
        docids.append(doc_id)
        tf_map: dict[str, int] = {}
        for tok in toks:
            if tok in vocab:
                tf_map[tok] = tf_map.get(tok, 0) + 1
        for tok, tf in tf_map.items():
            post_docs[tok].append(i)
            post_tfs[tok].append(tf)
    n_docs = len(docids)
    dls_arr = np.asarray(dls, dtype=np.float32)
    avgdl = float(dls_arr.mean()) if n_docs else 1.0
    postings: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    df: dict[str, int] = {}
    idf: dict[str, float] = {}
    dropped_high_df: list[str] = []
    for term in vocab:
        idx = np.asarray(post_docs.get(term, []), dtype=np.int32)
        tf = np.asarray(post_tfs.get(term, []), dtype=np.float32)
        df_t = int(len(idx))
        if n_docs >= 1_000_000 and df_t > HIGH_DF_DROP_FRACTION * n_docs:
            dropped_high_df.append(term)
            continue
        postings[term] = (idx, tf)
        df[term] = df_t
        idf[term] = idf_lucene(df_t, n_docs)
    return {
        'docids': docids,
        'dls': dls_arr,
        'avgdl': avgdl,
        'n_docs': n_docs,
        'postings': postings,
        'df': df,
        'idf': idf,
        'q_tokens': q_tokens,
        'q_terms': q_terms,
        'queries': queries,
        'qrels': bundle['qrels'],
        'meta': {
            **bundle['meta'],
            'n_docs': n_docs,
            'n_queries': len(queries),
            'n_qrels': sum(len(v) for v in bundle['qrels'].values()),
            'avgdl': avgdl,
            'k1': k1,
            'b': b,
            'dropped_high_df_terms': dropped_high_df,
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


def retrieve_query(
    terms: list[str],
    index: dict,
    k: int = PRIMARY_K,
    k1: float = K1,
    b: float = B,
) -> tuple[np.ndarray, np.ndarray]:
    n = index['n_docs']
    scores = np.zeros(n, dtype=np.float32)
    dl_norm = length_norm(index['dls'], index['avgdl'], b=b)
    postings = index['postings']
    idf = index['idf']
    for term in terms:
        if term not in postings:
            continue
        idx, tf = postings[term]
        if len(idx) == 0:
            continue
        scores[idx] += term_contributions(tf, dl_norm[idx], idf[term], k1=k1).astype(np.float32)
    pos = np.flatnonzero(scores > 0)
    if len(pos) == 0:
        return np.zeros(0, dtype=np.int32), np.zeros(0, dtype=np.float32)
    if len(pos) > k:
        pick = np.argpartition(scores[pos], -k)[-k:]
        inds = pos[pick]
    else:
        inds = pos
    order = np.argsort(scores[inds])[::-1]
    inds = inds[order]
    return inds.astype(np.int32), scores[inds].astype(np.float32)


def retrieve_all(index: dict, k: int = PRIMARY_K, k1: float = K1, b: float = B) -> dict[str, dict]:
    dl_norm = length_norm(index['dls'], index['avgdl'], b=b)
    out: dict[str, dict] = {}
    qrels = index['qrels']
    docids = index['docids']
    for qid, terms in index['q_terms'].items():
        inds, scores = retrieve_query(terms, index, k=k, k1=k1, b=b)
        relmap = qrels.get(qid, {})
        rel = np.array([int(relmap.get(docids[i], 0)) for i in inds], dtype=np.int32)
        tokens = index['q_tokens'][qid]
        qlen_tok = max(len(tokens), 1)
        qlen_uniq = max(len(terms), 1)
        sum_idf = float(sum(index['idf'].get(t, 0.0) for t in terms))
        null = query_null(terms, index['idf'], index['postings'], dl_norm, index['n_docs'], k1=k1)
        xs = query_term_xs(terms, index['idf'], index['postings'], dl_norm, k1=k1)
        tails = tails_for_scores(
            scores, xs, index['n_docs'], null['mu_q'], null['v_diag'], null['v_full'],
            n_mc=1500, seed=int(hashlib.md5(qid.encode('utf8')).hexdigest()[:8], 16),
        )
        out[qid] = {
            'inds': inds,
            'scores': scores,
            'rel': rel,
            'qlen_tok': qlen_tok,
            'qlen_uniq': qlen_uniq,
            'sum_idf': sum_idf,
            'n_terms_in_vocab': sum(1 for t in terms if t in index['idf']),
            'surprise': surprise_scores(scores),
            'nqc': nqc(scores),
            'wig': wig_like(scores, null['mu_q'], qlen_tok),
            **null,
            **tails,
        }
    return out


def load_candidate_texts(index: dict, retrieved: dict[str, dict], data_root: Path | None = None) -> dict[str, str]:
    needed: set[str] = set()
    docids = index['docids']
    for row in retrieved.values():
        for i in row['inds']:
            needed.add(docids[int(i)])
    texts: dict[str, str] = {}
    corpus_path = index.get('corpus_path')
    if not corpus_path:
        return texts
    for doc_id, text in iter_corpus_jsonl(Path(corpus_path)):
        if doc_id in needed:
            texts[doc_id] = text
            if len(texts) == len(needed):
                break
    return texts
