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
from .config import BOOTSTRAP_RESAMPLES, OUTER_FOLDS, PRIMARY_K, RERANKER_MODEL, SEED
from .cv import fold_splits, nested_alpha_choice, relevant_quantile_threshold
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
        alpha = nested_alpha_choice(train, packed, (0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5), seed=seed)
        methods_fold = methods + [f'power_{alpha:g}']
        fold = {'fold': fold_i, 'chosen_alpha': alpha, 'methods': {}}
        # baseline: keep all
        base_ndcg = []
        for qid in test:
            m = query_rerank(qid, packed[qid], index, ce_cache.get(qid, {}), None)
            packed[qid].setdefault('_base', m)
            base_ndcg.append(m['ndcg@10'])
        for name in methods_fold:
            key = name
            # train thresholds from global score quantiles of ALL train candidates
            train_scores = []
            for qid in train:
                train_scores.extend(np.asarray(packed[qid]['variants'][key], dtype=float).tolist())
            train_scores = np.asarray(train_scores, dtype=float)
            method_res = {'grid': []}
            test_base = []
            test_treat = []
            test_n = []
            for retain in retain_grid:
                if retain >= 1.0:
                    th = -np.inf
                else:
                    th = float(np.quantile(train_scores, 1.0 - retain))
                ndcgs = []
                ns = []
                recs = []
                for qid in test:
                    row = packed[qid]
                    vals = np.asarray(row['variants'][key], dtype=float)
                    mask = vals >= th
                    if not np.any(mask) and len(vals):
                        mask[0] = True  # never emit an empty ranking; keep BM25 top-1
                    m = query_rerank(qid, row, index, ce_cache.get(qid, {}), mask)
                    ndcgs.append(m['ndcg@10'])
                    ns.append(m['n_candidates'])
                    flags = np.asarray(row['rel']) > 0
                    recs.append(float(flags[mask].sum() / flags.sum()) if flags.any() else 1.0)
                method_res['grid'].append({
                    'retain_target': retain,
                    'threshold': th if np.isfinite(th) else None,
                    'ndcg@10': float(np.mean(ndcgs)),
                    'n_candidates_mean': float(np.mean(ns)),
                    'n_candidates_p95': float(np.quantile(ns, 0.95)) if ns else 0.0,
                    'candidate_recall': float(np.mean(recs)),
                })
                if abs(retain - 0.5) < 1e-9:
                    test_base = [packed[qid]['_base']['ndcg@10'] for qid in test]
                    test_treat = ndcgs
                    test_n = ns
            if test_base:
                method_res['retain50_vs_baseline'] = paired_ci(
                    np.array(test_treat), np.array(test_base), n_resamples=min(BOOTSTRAP_RESAMPLES, 20000),
                )
                method_res['retain50_n_mean'] = float(np.mean(test_n))
            fold['methods'][name] = method_res
        # also relevant-quantile gates 0.95/0.99
        fold['rel_quantile_gate'] = {}
        for target in (0.95, 0.99):
            fold['rel_quantile_gate'][str(target)] = {}
            for name in methods_fold:
                rel_scores = []
                for qid in train:
                    flags = np.asarray(packed[qid]['rel']) > 0
                    vals = np.asarray(packed[qid]['variants'][name], dtype=float)
                    rel_scores.extend(vals[flags].tolist())
                th = relevant_quantile_threshold(rel_scores, target)
                ndcgs = []
                bases = []
                ns = []
                recs = []
                maps = []
                mrrs = []
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
                    flags = np.asarray(row['rel']) > 0
                    recs.append(float(flags[mask].sum() / flags.sum()) if flags.any() else 1.0)
                    maps.append(m['map'])
                    mrrs.append(m['mrr@10'])
                fold['rel_quantile_gate'][str(target)][name] = {
                    'threshold': th if np.isfinite(th) else None,
                    'ndcg@10': float(np.mean(ndcgs)),
                    'mrr@10': float(np.mean(mrrs)),
                    'map': float(np.mean(maps)),
                    'n_candidates_mean': float(np.mean(ns)),
                    'n_candidates_p95': float(np.quantile(ns, 0.95)) if ns else 0.0,
                    'candidate_recall': float(np.mean(recs)),
                    'delta_ndcg_ci': paired_ci(np.array(ndcgs), np.array(bases)),
                }
        outer.append(fold)
    return {'folds': outer, 'model': RERANKER_MODEL}


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True, default=_json_default), encoding='utf8')
