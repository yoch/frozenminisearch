"""Phase A calibration: nested CV AUROC/AP/Brier/ECE and gating transfer."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .config import ALPHAS, OUTER_FOLDS, SEED
from .cv import fold_splits, nested_alpha_choice, relevant_quantile_threshold
from .metrics import brier, ece, fit_platt, predict_proba, safe_ap, safe_auroc, spearman
from .normalize import candidate_variants, variant_names


GLOBAL_VARIANTS = [
    'raw',
    'power_token_len',
    'power_unique_len',
    'ceiling',
    'z_diag',
    'I_gauss_diag',
    'I_joint_rank',
    'surprise',
    'power_token_0',
    'power_token_0.5',
    'power_token_1',
]

LOCAL_VARIANTS = ['top_ratio', 'minmax', 'sumnorm', 'z_emp', 'z_robust']


def flatten_candidates(retrieved: dict[str, dict]) -> dict[str, dict]:
    packed = {}
    for qid, row in retrieved.items():
        variants = candidate_variants(row['scores'], row)
        packed[qid] = {
            **row,
            'variants': variants,
        }
    return packed


def _gather(packed, qids, name, rel_only=False, judged_only=False):
    y = []
    s = []
    for qid in qids:
        row = packed[qid]
        flags = np.asarray(row['rel']) > 0
        vals = np.asarray(row['variants'][name], dtype=float)
        if len(vals) == 0:
            continue
        mask = np.ones(len(vals), dtype=bool)
        if judged_only and 'judged_mask' in row:
            mask = np.asarray(row['judged_mask'], dtype=bool)
        if rel_only:
            mask = mask & flags
            vals = vals[mask]
            flags = np.ones(len(vals), dtype=bool)
        else:
            vals = vals[mask]
            flags = flags[mask]
        y.extend(flags.astype(int).tolist())
        s.extend(vals.tolist())
    return np.array(y, dtype=int), np.array(s, dtype=float)


def _top_gather(packed, qids, name):
    y = []
    s = []
    qlen = []
    sidf = []
    n_no_match = 0
    for qid in qids:
        row = packed[qid]
        qlen.append(float(row['qlen_tok']))
        sidf.append(float(row['sum_idf']))
        if len(row['scores']) == 0:
            n_no_match += 1
            y.append(0)
            s.append(float('-inf'))
            continue
        y.append(int(row['rel'][0] > 0))
        s.append(float(row['variants'][name][0]))
    return np.array(y), np.array(s), np.array(qlen), np.array(sidf), n_no_match


def evaluate_calibration(packed: dict[str, dict], seed: int = SEED) -> dict:
    qids = list(packed.keys())
    methods = [n for n in variant_names() if n in next(iter(packed.values()))['variants']]
    # include paper_unique if present
    extra = next(iter(packed.values()))['variants'].keys()
    methods = sorted(set(methods) | set(extra))
    outer = []
    chosen_alphas = []
    n_folds = min(OUTER_FOLDS, max(2, len(qids)))
    for fold_i, train, test in fold_splits(qids, n_folds=n_folds, seed=seed):
        if not train or not test:
            continue
        alpha = nested_alpha_choice(train, packed, ALPHAS, seed=seed)
        chosen_alphas.append(alpha)
        fold_res = {'fold': fold_i, 'n_train': len(train), 'n_test': len(test), 'chosen_alpha': alpha}
        available = packed[train[0]]['variants']
        power_key = f'power_token_{alpha:g}'
        for name in list(methods) + [power_key]:
            key = name if name in available else power_key
            if key not in available:
                continue
            y_tr, s_tr = _gather(packed, train, key)
            y_te, s_te = _gather(packed, test, key)
            model = fit_platt(s_tr, y_tr)
            p_te = predict_proba(model, s_te)
            ece_val, curve = ece(y_te, p_te)
            yt, st, ql, si, n_miss = _top_gather(packed, test, key)
            fold_res[name] = {
                'candidate_auroc': safe_auroc(y_te, s_te),
                'candidate_ap': safe_ap(y_te, s_te),
                'brier': brier(y_te, p_te),
                'ece': ece_val,
                'reliability': curve,
                'calibration_task': 'qrel-positive vs all-other-retrieved',
                'top1_auroc': safe_auroc(yt, st),
                'top1_ap': safe_ap(yt, st),
                'rho_qlen': spearman(st, ql),
                'rho_sumidf': spearman(st, si),
                'n_no_match': n_miss,
            }
        # gating transfer at relevant-score quantiles 0.95 and 0.99
        fold_res['gate'] = {}
        for target in (0.95, 0.99):
            fold_res['gate'][str(target)] = {}
            for name in GLOBAL_VARIANTS + LOCAL_VARIANTS + [f'cv_power_token_{alpha:g}']:
                key = name
                if name.startswith('cv_power_token_'):
                    key = f'power_token_{alpha:g}'
                y_tr, s_tr = _gather(packed, train, key, rel_only=True)
                th = relevant_quantile_threshold(s_tr, target)
                keep_rel = 0
                tot_rel = 0
                keep_n = 0
                tot_n = 0
                succ_num = 0
                succ_den = 0
                for qid in test:
                    row = packed[qid]
                    vals = np.asarray(row['variants'][key], dtype=float)
                    flags = np.asarray(row['rel']) > 0
                    tot_rel += int(flags.sum())
                    tot_n += len(vals)
                    mask = vals >= th
                    keep_n += int(mask.sum())
                    keep_rel += int((flags & mask).sum())
                    if flags.any():
                        succ_den += 1
                        if (flags & mask).any():
                            succ_num += 1
                fold_res['gate'][str(target)][name] = {
                    'threshold': th,
                    'recall': keep_rel / max(tot_rel, 1),
                    'retained': keep_n / max(tot_n, 1),
                    'success': succ_num / max(succ_den, 1),
                }
        outer.append(fold_res)
    n_no_match = sum(1 for row in packed.values() if row.get('no_match') or len(row['scores']) == 0)
    return {
        'n_queries': len(qids),
        'no_match_rate': n_no_match / max(len(qids), 1),
        'chosen_alphas': chosen_alphas,
        'mean_chosen_alpha': float(np.mean(chosen_alphas)) if chosen_alphas else None,
        'folds': outer,
        'calibration_task': 'qrel-positive vs all-other-retrieved',
        'judged_note': (
            'IR metrics use the usual qrel convention (unjudged = 0). '
            'Calibration AUROC/AP/Brier/ECE on retrieved lists is not P(relevance); '
            'set judged_only=True to restrict to explicitly judged documents.'
        ),
    }


def aggregate_folds(cal: dict) -> dict:
    skip = {'fold', 'n_train', 'n_test', 'chosen_alpha', 'gate'}
    methods = set()
    for fold in cal['folds']:
        methods.update(k for k in fold if k not in skip)
    summary = {}
    for name in sorted(methods):
        summary[name] = {}
        for metric in ('candidate_auroc', 'candidate_ap', 'brier', 'ece', 'top1_auroc', 'top1_ap', 'rho_qlen', 'rho_sumidf'):
            vals = [fold[name][metric] for fold in cal['folds'] if fold.get(name) and fold[name][metric] is not None]
            summary[name][metric] = {
                'mean': float(np.mean(vals)) if vals else None,
                'std': float(np.std(vals)) if vals else None,
                'n_folds': len(vals),
            }
    gate = {}
    for target in ('0.95', '0.99'):
        gate[target] = {}
        names = set()
        for fold in cal['folds']:
            names.update(fold['gate'][target].keys())
        for name in sorted(names):
            rec = [fold['gate'][target][name]['recall'] for fold in cal['folds'] if name in fold['gate'][target]]
            ret = [fold['gate'][target][name]['retained'] for fold in cal['folds'] if name in fold['gate'][target]]
            suc = [fold['gate'][target][name]['success'] for fold in cal['folds'] if name in fold['gate'][target]]
            gate[target][name] = {
                'recall_mean': float(np.mean(rec)),
                'recall_std': float(np.std(rec)),
                'retained_mean': float(np.mean(ret)),
                'retained_std': float(np.std(ret)),
                'success_mean': float(np.mean(suc)),
            }
    return {'methods': summary, 'gate': gate, 'mean_chosen_alpha': cal['mean_chosen_alpha']}


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True, default=_json_default), encoding='utf8')


def _json_default(o):
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(type(o))
