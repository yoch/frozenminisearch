"""End-to-end reranking with cached cross-encoder scores and Pareto gating."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

try:
    from sentence_transformers import CrossEncoder
except ImportError:  # optional Phase B dependency
    CrossEncoder = None

try:
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer
except ImportError:  # optional Phase B dependency
    torch = None
    AutoModelForSequenceClassification = None
    AutoTokenizer = None

from .bootstrap import paired_ci
from .config import OUTER_FOLDS, PRIMARY_K, RERANKER_MODEL, SEED
from .cv import fold_splits
from .metrics import ranking_metrics
from .phase_a import GLOBAL_VARIANTS, LOCAL_VARIANTS, _json_default


def load_cross_encoder(model_id: str = RERANKER_MODEL):
    if CrossEncoder is not None:
        return ('st', CrossEncoder(model_id, max_length=512))
    if AutoTokenizer is None or torch is None:
        raise ImportError('Phase B requires sentence-transformers or transformers+torch')
    tok = AutoTokenizer.from_pretrained(model_id)
    model = AutoModelForSequenceClassification.from_pretrained(model_id)
    model.eval()
    device = torch.device('cpu')
    model.to(device)
    return ('hf', (tok, model, device))


def predict_pairs(backend, pairs: list[tuple[str, str]], batch_size: int = 32) -> np.ndarray:
    kind, handle = backend
    if kind == 'st':
        return np.asarray(handle.predict(pairs, batch_size=batch_size, show_progress_bar=False), dtype=float)
    tok, model, device = handle
    out = []
    for i in range(0, len(pairs), batch_size):
        chunk = pairs[i:i + batch_size]
        enc = tok(
            [a for a, _ in chunk],
            [b for _, b in chunk],
            padding=True,
            truncation=True,
            max_length=512,
            return_tensors='pt',
        )
        enc = {k: v.to(device) for k, v in enc.items()}
        with torch.no_grad():
            logits = model(**enc).logits
            if logits.shape[-1] == 1:
                scores = logits.squeeze(-1)
            else:
                scores = logits[:, 1]
            out.append(scores.cpu().numpy())
    return np.concatenate(out, axis=0).astype(float) if out else np.zeros(0, dtype=float)


def cache_path(root: Path, dataset: str, model_id: str) -> Path:
    safe = model_id.replace('/', '_')
    return root / f'{dataset}__{safe}__top{PRIMARY_K}.jsonl'


def score_and_cache(
    dataset: str,
    index: dict,
    retrieved: dict[str, dict],
    texts: dict[str, str],
    cache_root: Path,
    model_id: str = RERANKER_MODEL,
    backend=None,
) -> dict[str, dict[str, float]]:
    path = cache_path(cache_root, dataset, model_id)
    cached: dict[str, dict[str, float]] = {}
    if path.exists():
        with path.open(encoding='utf8') as f:
            for line in f:
                row = json.loads(line)
                cached.setdefault(row['qid'], {})[row['docid']] = float(row['ce'])
        return cached
    if backend is None:
        backend = load_cross_encoder(model_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    queries = index['queries']
    docids = index['docids']
    with path.open('w', encoding='utf8') as f:
        for qid, row in retrieved.items():
            qtext = queries[qid]
            pairs = []
            dids = []
            for i in row['inds']:
                did = docids[int(i)]
                dtext = texts.get(did, '')
                pairs.append((qtext, dtext))
                dids.append(did)
            if not pairs:
                cached[qid] = {}
                continue
            scores = predict_pairs(backend, pairs)
            cached[qid] = {}
            for did, ce in zip(dids, scores):
                cached[qid][did] = float(ce)
                f.write(json.dumps({'qid': qid, 'docid': did, 'ce': float(ce)}) + '\n')
    return cached


def query_rerank(
    qid: str,
    row: dict,
    index: dict,
    ce_by_doc: dict[str, float],
    keep_mask: np.ndarray | None,
) -> dict[str, float]:
    docids = index['docids']
    relmap = index['qrels'].get(qid, {})
    n_relevant = len(relmap)
    inds = np.asarray(row['inds'])
    if keep_mask is None:
        keep_mask = np.ones(len(inds), dtype=bool)
    kept = inds[keep_mask]
    ce = np.array([ce_by_doc.get(docids[int(i)], -1e9) for i in kept], dtype=float)
    if len(kept) == 0:
        empty = np.zeros(0)
        metrics = ranking_metrics(empty, n_relevant, k=10)
        metrics['n_candidates'] = 0
        return metrics
    order = np.argsort(ce)[::-1]
    ranked_rel = np.array([int(relmap.get(docids[int(kept[j])], 0)) for j in order], dtype=np.int32)
    metrics = ranking_metrics(ranked_rel, n_relevant, k=10)
    metrics['n_candidates'] = int(len(kept))
    return metrics


FIXED_KS = (5, 10, 20, 30, 50, 75, 100)


def baseline_top_docs(qid: str, row: dict, index: dict, ce_by_doc: dict[str, float], n: int = 10) -> list[str]:
    docids = index['docids']
    inds = np.asarray(row['inds'])
    ce = np.array([ce_by_doc.get(docids[int(i)], -1e9) for i in inds], dtype=float)
    if len(inds) == 0:
        return []
    order = np.argsort(ce)[::-1][:n]
    return [docids[int(inds[j])] for j in order]


def _summarize_queries(ndcgs, bases, ns, recs, dropped, mrrs, maps, succs, r10s):
    ndcgs = np.asarray(ndcgs, dtype=float)
    bases = np.asarray(bases, dtype=float)
    ns = np.asarray(ns, dtype=float)
    return {
        'ndcg@10': float(ndcgs.mean()) if len(ndcgs) else 0.0,
        'mrr@10': float(np.mean(mrrs)) if mrrs else 0.0,
        'map': float(np.mean(maps)) if maps else 0.0,
        'success@10': float(np.mean(succs)) if succs else 0.0,
        'recall@10': float(np.mean(r10s)) if r10s else 0.0,
        'n_candidates_mean': float(ns.mean()) if len(ns) else 0.0,
        'n_candidates_median': float(np.median(ns)) if len(ns) else 0.0,
        'n_candidates_p95': float(np.quantile(ns, 0.95)) if len(ns) else 0.0,
        'candidate_recall': float(np.mean(recs)) if recs else 0.0,
        'frac_drop_baseline_top10': float(np.mean(dropped)) if dropped else 0.0,
        'delta_ndcg_ci': paired_ci(ndcgs, bases),
        'n_queries_loss_gt_005': int(np.sum((ndcgs - bases) < -0.005)),
        'n_queries_loss_gt_01': int(np.sum((ndcgs - bases) < -0.01)),
        'worst_delta': float((ndcgs - bases).min()) if len(ndcgs) else 0.0,
    }


def pareto_and_end_to_end(
    packed: dict[str, dict],
    index: dict,
    ce_cache: dict[str, dict[str, float]],
    seed: int = SEED,
) -> dict:
    qids = [qid for qid in packed if qid in index['q_terms']]
    methods = GLOBAL_VARIANTS + LOCAL_VARIANTS
    retain_grid = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]
    outer = []
    for fold_i, train, test in fold_splits(qids, n_folds=min(OUTER_FOLDS, max(2, len(qids))), seed=seed):
        if not train or not test:
            continue
        fold = {'fold': fold_i, 'n_train': len(train), 'n_test': len(test), 'methods': {}, 'fixed_k': {}}
        top10 = {}
        for qid in test:
            m = query_rerank(qid, packed[qid], index, ce_cache.get(qid, {}), None)
            packed[qid]['_base'] = m
            top10[qid] = baseline_top_docs(qid, packed[qid], index, ce_cache.get(qid, {}), n=10)
        for kfix in FIXED_KS:
            ndcgs, bases, ns, recs, dropped, mrrs, maps, succs, r10s = [], [], [], [], [], [], [], [], []
            for qid in test:
                row = packed[qid]
                mask = np.zeros(len(row['inds']), dtype=bool)
                mask[: min(kfix, len(mask))] = True
                if not np.any(mask) and len(mask):
                    mask[0] = True
                m = query_rerank(qid, row, index, ce_cache.get(qid, {}), mask)
                ndcgs.append(m['ndcg@10'])
                bases.append(packed[qid]['_base']['ndcg@10'])
                ns.append(m['n_candidates'])
                mrrs.append(m['mrr@10'])
                maps.append(m['map'])
                succs.append(m['success@10'])
                r10s.append(m['recall@10'])
                flags = np.asarray(row['rel']) > 0
                recs.append(float(flags[mask].sum() / flags.sum()) if flags.any() else 1.0)
                kept = {index['docids'][int(i)] for i, keep in zip(row['inds'], mask) if keep}
                dropped.append(0.0 if set(top10[qid]).issubset(kept) else 1.0)
            fold['fixed_k'][str(kfix)] = _summarize_queries(ndcgs, bases, ns, recs, dropped, mrrs, maps, succs, r10s)
        for name in methods:
            if name not in packed[train[0]]['variants']:
                continue
            train_scores = []
            for qid in train:
                train_scores.extend(np.asarray(packed[qid]['variants'][name], dtype=float).tolist())
            train_scores = np.asarray(train_scores, dtype=float)
            method_res = {'grid': []}
            for retain in retain_grid:
                th = -np.inf if retain >= 1.0 else float(np.quantile(train_scores, 1.0 - retain))
                ndcgs, bases, ns, recs, dropped, mrrs, maps, succs, r10s = [], [], [], [], [], [], [], [], []
                for qid in test:
                    row = packed[qid]
                    vals = np.asarray(row['variants'][name], dtype=float)
                    mask = vals >= th
                    if not np.any(mask) and len(vals):
                        mask[0] = True
                    m = query_rerank(qid, row, index, ce_cache.get(qid, {}), mask)
                    ndcgs.append(m['ndcg@10'])
                    bases.append(packed[qid]['_base']['ndcg@10'])
                    ns.append(m['n_candidates'])
                    mrrs.append(m['mrr@10'])
                    maps.append(m['map'])
                    succs.append(m['success@10'])
                    r10s.append(m['recall@10'])
                    flags = np.asarray(row['rel']) > 0
                    recs.append(float(flags[mask].sum() / flags.sum()) if flags.any() else 1.0)
                    kept = {index['docids'][int(i)] for i, keep in zip(row['inds'], mask) if keep}
                    dropped.append(0.0 if set(top10[qid]).issubset(kept) else 1.0)
                method_res['grid'].append({
                    'retain_target': retain,
                    'threshold': None if not np.isfinite(th) else th,
                    **_summarize_queries(ndcgs, bases, ns, recs, dropped, mrrs, maps, succs, r10s),
                })
            fold['methods'][name] = method_res
        outer.append(fold)
    return {'folds': outer, 'model': RERANKER_MODEL, 'fixed_ks': list(FIXED_KS)}


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True, default=_json_default), encoding='utf8')
