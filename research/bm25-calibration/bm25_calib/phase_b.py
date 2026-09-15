"""End-to-end reranking with a fail-closed CE cache and BM25-prefix metrics."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

try:
    from sentence_transformers import CrossEncoder
except ImportError:
    CrossEncoder = None

try:
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer
    import transformers
except ImportError:
    torch = None
    AutoModelForSequenceClassification = None
    AutoTokenizer = None
    transformers = None

from .bootstrap import oof_paired_report
from .cache import (
    MAX_LENGTH,
    build_manifest,
    cache_paths,
    expected_pairs,
    load_cache_strict,
    write_cache_atomic,
)
from .config import INNER_FOLDS, NONINFERIORITY, OUTER_FOLDS, PRIMARY_K, RERANKER_MODEL, SEED
from .cv import fold_splits
from .metrics import ranking_metrics
from .phase_a import GLOBAL_VARIANTS, LOCAL_VARIANTS, _json_default
from .provenance import file_hash, git_sha


FIXED_KS = (5, 10, 20, 30, 50, 75, 100)
RETAIN_GRID = (1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1)


def load_cross_encoder(model_id: str = RERANKER_MODEL):
    if CrossEncoder is not None:
        handle = CrossEncoder(model_id, max_length=MAX_LENGTH)
        rev = getattr(handle, 'model', None)
        commit = None
        if rev is not None and hasattr(rev, 'config'):
            commit = getattr(rev.config, '_commit_hash', None)
        ver = f'sentence-transformers:{getattr(__import__("sentence_transformers"), "__version__", "unknown")}'
        return ('st', handle, commit, ver)
    if AutoTokenizer is None or torch is None:
        raise ImportError('Phase B requires sentence-transformers or transformers+torch')
    tok = AutoTokenizer.from_pretrained(model_id)
    model = AutoModelForSequenceClassification.from_pretrained(model_id)
    model.eval()
    device = torch.device('cpu')
    model.to(device)
    commit = getattr(model.config, '_commit_hash', None)
    ver = f'transformers:{transformers.__version__};torch:{torch.__version__}'
    return ('hf', (tok, model, device), commit, ver)


def predict_pairs(backend, pairs: list[tuple[str, str]], batch_size: int = 32) -> np.ndarray:
    kind, handle = backend[0], backend[1]
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
            max_length=MAX_LENGTH,
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


def score_and_cache(
    dataset: str,
    index: dict,
    retrieved: dict[str, dict],
    texts: dict[str, str],
    cache_root: Path,
    model_id: str = RERANKER_MODEL,
    backend=None,
) -> dict[str, dict[str, float]]:
    jsonl_path, man_path = cache_paths(cache_root, dataset, model_id)
    if backend is None:
        backend = load_cross_encoder(model_id)
    kind, handle, commit, ver = backend
    protocol = Path(__file__).resolve().parents[1] / 'PROTOCOL.json'
    expected = build_manifest(
        dataset, index, retrieved, model_id, commit, kind, ver, git_sha(), file_hash(protocol),
        k=PRIMARY_K,
    )
    docids = index['docids']
    pair_set = set(expected_pairs(retrieved, docids))
    try:
        return load_cache_strict(jsonl_path, man_path, expected, pair_set)
    except (FileNotFoundError, ValueError):
        pass
    queries = index['queries']
    rows = []
    cached: dict[str, dict[str, float]] = {}
    for qid, row in retrieved.items():
        qtext = queries[qid]
        if not qtext:
            raise ValueError(f'empty query text for {qid}')
        pairs = []
        dids = []
        for i in row['inds']:
            did = docids[int(i)]
            if did not in texts:
                raise KeyError(f'missing text for candidate {qid} {did}')
            dtext = texts[did]
            if not dtext:
                raise ValueError(f'empty text for candidate {qid} {did}')
            pairs.append((qtext, dtext))
            dids.append(did)
        cached[qid] = {}
        if not pairs:
            continue
        scores = predict_pairs(backend, pairs)
        if len(scores) != len(dids):
            raise RuntimeError(f'CE score count mismatch for {qid}')
        for did, ce in zip(dids, scores):
            cached[qid][did] = float(ce)
            rows.append({'qid': qid, 'docid': did, 'ce': float(ce)})
    write_cache_atomic(jsonl_path, man_path, rows, expected, expected_pair_set=pair_set)
    return load_cache_strict(jsonl_path, man_path, expected, pair_set)


def ce_aligned(qid: str, row: dict, index: dict, ce_by_doc: dict[str, float]) -> np.ndarray:
    docids = index['docids']
    out = []
    for i in row['inds']:
        did = docids[int(i)]
        if did not in ce_by_doc:
            raise KeyError(f'missing CE score for {qid} {did}')
        out.append(ce_by_doc[did])
    return np.asarray(out, dtype=float)


def prefix_metrics_table(row: dict, ce: np.ndarray, k_eval: int = 10) -> list[dict]:
    n = len(row['inds'])
    ideal = np.asarray(row['ideal_rels'], dtype=float)
    table = []
    if n == 0:
        m = ranking_metrics(np.zeros(0), ideal, k=k_eval)
        m['n_candidates'] = 0
        m['baseline_top10_preserved'] = 1.0
        return [m]
    order_all = np.argsort(-ce, kind='mergesort')
    top10_idx = set(int(j) for j in order_all[:k_eval])
    for k in range(0, n + 1):
        if k == 0:
            m = ranking_metrics(np.zeros(0), ideal, k=k_eval)
            m['n_candidates'] = 0
            m['baseline_top10_preserved'] = 0.0 if top10_idx else 1.0
        else:
            order = np.argsort(-ce[:k], kind='mergesort')
            ranked_rel = np.asarray(row['rel'][:k], dtype=float)[order]
            m = ranking_metrics(ranked_rel, ideal, k=k_eval)
            m['n_candidates'] = k
            m['baseline_top10_preserved'] = 1.0 if top10_idx.issubset(set(range(k))) else 0.0
        table.append(m)
    return table


def threshold_to_prefix_k(vals: np.ndarray, th: float) -> int:
    """Map a monotone-within-query score to a BM25 prefix length.

    Walks the BM25-ordered list and stops at the first value below the
    threshold. At least one document is kept when the list is non-empty.
    """
    vals = np.asarray(vals, dtype=float)
    if len(vals) == 0:
        return 0
    k = 0
    for v in vals:
        if v >= th:
            k += 1
        else:
            break
    return max(k, 1)


def _lookup(table: list[dict], k: int) -> dict:
    k = max(0, min(int(k), len(table) - 1))
    return table[k]


def select_threshold_nested(
    train_qids: list[str],
    packed: dict,
    prefixes: dict[str, list[dict]],
    method: str,
    delta: float,
    seed: int,
) -> dict:
    """Pick one threshold on inner CV: min mean candidates s.t. mean ΔnDCG >= -delta."""
    scores = []
    for qid in train_qids:
        scores.extend(np.asarray(packed[qid]['variants'][method], dtype=float).tolist())
    scores = np.asarray(scores, dtype=float)
    candidates = [-np.inf]
    if len(scores):
        for q in (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
            candidates.append(float(np.quantile(scores, q)))
    n_inner = min(INNER_FOLDS, max(2, len(train_qids)))
    best = None
    for th in candidates:
        deltas = []
        ns = []
        for _, _tr, inner_te in fold_splits(train_qids, n_folds=n_inner, seed=seed + 31):
            for qid in inner_te:
                table = prefixes[qid]
                base = table[-1]['ndcg@10']
                vals = packed[qid]['variants'][method]
                k = threshold_to_prefix_k(vals, th)
                m = _lookup(table, k)
                deltas.append(m['ndcg@10'] - base)
                ns.append(m['n_candidates'])
        mean_d = float(np.mean(deltas)) if deltas else 0.0
        mean_n = float(np.mean(ns)) if ns else 0.0
        ok = mean_d >= -delta
        rec = {'threshold': None if not np.isfinite(th) else th, 'mean_delta': mean_d, 'mean_n': mean_n, 'feasible': ok}
        if ok and (best is None or mean_n < best['mean_n'] or (mean_n == best['mean_n'] and mean_d > best['mean_delta'])):
            best = rec
    if best is None:
        best = {'threshold': None, 'mean_delta': 0.0, 'mean_n': float('nan'), 'feasible': False, 'fallback': 'rerank_all'}
    return best


def _pack_oof(ndcgs, bases, ns, recs, dropped, extra) -> dict:
    ndcgs = np.asarray(ndcgs, dtype=float)
    bases = np.asarray(bases, dtype=float)
    ns = np.asarray(ns, dtype=float)
    report = oof_paired_report(ndcgs, bases)
    report.update({
        'ndcg@10': float(ndcgs.mean()) if len(ndcgs) else 0.0,
        'n_candidates_mean': float(ns.mean()) if len(ns) else 0.0,
        'n_candidates_median': float(np.median(ns)) if len(ns) else 0.0,
        'n_candidates_p95': float(np.quantile(ns, 0.95)) if len(ns) else 0.0,
        'candidate_recall': float(np.mean(recs)) if recs else 0.0,
        'frac_drop_baseline_top10': float(np.mean(dropped)) if dropped else 0.0,
    })
    report.update(extra)
    return report


def pareto_and_end_to_end(
    packed: dict[str, dict],
    index: dict,
    ce_cache: dict[str, dict[str, float]],
    seed: int = SEED,
) -> dict:
    qids = [qid for qid in packed if qid in index['q_terms']]
    methods = [m for m in GLOBAL_VARIANTS + LOCAL_VARIANTS if m in packed[qids[0]]['variants']]
    prefixes: dict[str, list[dict]] = {}
    for qid in qids:
        ce_map = ce_cache[qid] if len(packed[qid]['inds']) else {}
        ce = ce_aligned(qid, packed[qid], index, ce_map)
        if len(packed[qid]['inds']) and len(ce) != len(packed[qid]['inds']):
            raise RuntimeError(f'CE alignment length mismatch for {qid}')
        prefixes[qid] = prefix_metrics_table(packed[qid], ce)
        n = len(packed[qid]['inds'])
        if n and prefixes[qid][n]['ndcg@10'] != prefixes[qid][-1]['ndcg@10']:
            raise RuntimeError('prefix table tail is not the full-list baseline')
    oof_base = []
    oof_policy = {name: {str(d): {'ndcg': [], 'base': [], 'n': [], 'rec': [], 'drop': []} for d in NONINFERIORITY} for name in methods}
    oof_fixed = {str(k): {'ndcg': [], 'base': [], 'n': [], 'rec': [], 'drop': []} for k in FIXED_KS}
    outer = []
    for fold_i, train, test in fold_splits(qids, n_folds=min(OUTER_FOLDS, max(2, len(qids))), seed=seed):
        if not train or not test:
            continue
        fold = {'fold': fold_i, 'n_train': len(train), 'n_test': len(test), 'fixed_k': {}, 'methods': {}, 'policies': {}}
        for qid in test:
            oof_base.append(prefixes[qid][-1]['ndcg@10'])
        for kfix in FIXED_KS:
            bucket = oof_fixed[str(kfix)]
            ndcgs, bases, ns, recs, dropped = [], [], [], [], []
            for qid in test:
                table = prefixes[qid]
                k = min(kfix, len(table) - 1)
                m = _lookup(table, k)
                ndcgs.append(m['ndcg@10'])
                bases.append(table[-1]['ndcg@10'])
                ns.append(m['n_candidates'])
                recs.append(_cand_recall(packed[qid], k))
                dropped.append(1.0 - m['baseline_top10_preserved'])
                bucket['ndcg'].append(m['ndcg@10'])
                bucket['base'].append(table[-1]['ndcg@10'])
                bucket['n'].append(m['n_candidates'])
                bucket['rec'].append(recs[-1])
                bucket['drop'].append(dropped[-1])
            fold['fixed_k'][str(kfix)] = _pack_oof(ndcgs, bases, ns, recs, dropped, {})
        for name in methods:
            # diagnostic Pareto on outer test (not used as the reported operating point)
            train_scores = np.concatenate([
                np.asarray(packed[qid]['variants'][name], dtype=float)
                for qid in train if len(packed[qid]['variants'][name])
            ]) if any(len(packed[qid]['variants'][name]) for qid in train) else np.zeros(0)
            grid = []
            for retain in RETAIN_GRID:
                th = -np.inf if retain >= 1.0 else float(np.quantile(train_scores, 1.0 - retain)) if len(train_scores) else -np.inf
                ndcgs, bases, ns, recs, dropped = [], [], [], [], []
                for qid in test:
                    k = threshold_to_prefix_k(packed[qid]['variants'][name], th)
                    m = _lookup(prefixes[qid], k)
                    ndcgs.append(m['ndcg@10'])
                    bases.append(prefixes[qid][-1]['ndcg@10'])
                    ns.append(m['n_candidates'])
                    recs.append(_cand_recall(packed[qid], k))
                    dropped.append(1.0 - m['baseline_top10_preserved'])
                grid.append({
                    'retain_target': retain,
                    'threshold': None if not np.isfinite(th) else th,
                    **_pack_oof(ndcgs, bases, ns, recs, dropped, {}),
                })
            fold['methods'][name] = {'grid_diagnostic': grid}
            fold['policies'][name] = {}
            for delta in NONINFERIORITY:
                chosen = select_threshold_nested(train, packed, prefixes, name, delta, seed)
                th = -np.inf if chosen['threshold'] is None else chosen['threshold']
                ndcgs, bases, ns, recs, dropped = [], [], [], [], []
                bucket = oof_policy[name][str(delta)]
                for qid in test:
                    k = threshold_to_prefix_k(packed[qid]['variants'][name], th)
                    m = _lookup(prefixes[qid], k)
                    ndcgs.append(m['ndcg@10'])
                    bases.append(prefixes[qid][-1]['ndcg@10'])
                    ns.append(m['n_candidates'])
                    recs.append(_cand_recall(packed[qid], k))
                    dropped.append(1.0 - m['baseline_top10_preserved'])
                    bucket['ndcg'].append(m['ndcg@10'])
                    bucket['base'].append(table_base(prefixes[qid]))
                    bucket['n'].append(m['n_candidates'])
                    bucket['rec'].append(recs[-1])
                    bucket['drop'].append(dropped[-1])
                fold['policies'][name][str(delta)] = {
                    'chosen': chosen,
                    **_pack_oof(ndcgs, bases, ns, recs, dropped, {}),
                }
        outer.append(fold)
    oof_summary = {
        'fixed_k': {
            k: _pack_oof(v['ndcg'], v['base'], v['n'], v['rec'], v['drop'], {})
            for k, v in oof_fixed.items()
        },
        'policies': {
            name: {
                d: _pack_oof(v['ndcg'], v['base'], v['n'], v['rec'], v['drop'], {})
                for d, v in by_d.items()
            }
            for name, by_d in oof_policy.items()
        },
    }
    return {
        'folds': outer,
        'oof': oof_summary,
        'model': RERANKER_MODEL,
        'fixed_ks': list(FIXED_KS),
        'idcg': 'full_qrels',
        'selection': 'inner_cv_min_candidates_s.t._mean_delta_ndcg >= -delta',
    }


def table_base(table: list[dict]) -> float:
    return table[-1]['ndcg@10']


def _cand_recall(row: dict, k: int) -> float:
    flags = np.asarray(row['rel']) > 0
    if not flags.any():
        return 1.0
    return float(flags[:k].sum() / flags.sum())


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True, default=_json_default), encoding='utf8')
