"""Atomic, fail-closed cross-encoder score cache."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from .config import PRIMARY_K, RERANKER_MODEL, SEED
from .phase_a import _json_default


MAX_LENGTH = 512


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_text(s: str) -> str:
    return _sha256_bytes(s.encode('utf8'))


def query_set_hash(queries: dict[str, str]) -> str:
    h = hashlib.sha256()
    for qid in sorted(queries):
        h.update(qid.encode('utf8'))
        h.update(b'\0')
        h.update(queries[qid].encode('utf8'))
        h.update(b'\n')
    return h.hexdigest()


def qid_list_hash(qids: list[str]) -> str:
    return _sha256_text('\n'.join(sorted(qids)))


def candidate_set_hash(retrieved: dict[str, dict], docids: list[str]) -> str:
    h = hashlib.sha256()
    for qid in sorted(retrieved):
        if qid.startswith('_'):
            continue
        h.update(qid.encode('utf8'))
        for i in retrieved[qid]['inds']:
            h.update(b'\0')
            h.update(docids[int(i)].encode('utf8'))
        h.update(b'\n')
    return h.hexdigest()


def bm25_config_hash(index: dict) -> str:
    blob = json.dumps({
        'k1': index.get('k1'),
        'b': index.get('b'),
        'avgdl': index.get('avgdl'),
        'n_docs': index.get('n_docs'),
        'analyzer': '(?u)\\b\\w\\w+\\b',
        'unique_terms': True,
    }, sort_keys=True)
    return _sha256_text(blob)


def expected_pairs(retrieved: dict[str, dict], docids: list[str]) -> list[tuple[str, str]]:
    pairs = []
    for qid in sorted(retrieved):
        if qid.startswith('_'):
            continue
        for i in retrieved[qid]['inds']:
            pairs.append((qid, docids[int(i)]))
    return pairs


def build_manifest(
    dataset: str,
    index: dict,
    retrieved: dict[str, dict],
    model_id: str,
    model_revision: str | None,
    backend_name: str,
    backend_version: str,
    git_sha: str,
    protocol_sha: str,
    k: int = PRIMARY_K,
) -> dict:
    docids = index['docids']
    pairs = expected_pairs(retrieved, docids)
    corpus_sha = None
    meta = index.get('meta') or {}
    corpus_sha = meta.get('sha256')
    return {
        'dataset': dataset,
        'corpus_sha256': corpus_sha,
        'query_set_hash': query_set_hash(index['queries']),
        'qid_list_hash': qid_list_hash(list(index['q_terms'])),
        'candidate_set_hash': candidate_set_hash(retrieved, docids),
        'bm25_config_hash': bm25_config_hash(index),
        'analyzer': '(?u)\\b\\w\\w+\\b',
        'candidate_k': k,
        'reranker_model_id': model_id,
        'reranker_revision': model_revision,
        'max_length': MAX_LENGTH,
        'backend': backend_name,
        'backend_version': backend_version,
        'harness_git_sha': git_sha,
        'protocol_sha256': protocol_sha,
        'n_pairs': len(pairs),
        'seed': SEED,
    }


def cache_paths(root: Path, dataset: str, model_id: str) -> tuple[Path, Path]:
    safe = model_id.replace('/', '_')
    base = root / f'{dataset}__{safe}__top{PRIMARY_K}'
    return base.with_suffix('.jsonl'), base.with_suffix('.manifest.json')


def _fsync_file(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_cache_atomic(
    jsonl_path: Path,
    manifest_path: Path,
    rows: list[dict],
    manifest: dict,
    expected_pair_set: set[tuple[str, str]] | None = None,
) -> None:
    jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_jsonl = jsonl_path.with_suffix(jsonl_path.suffix + '.tmp')
    tmp_man = manifest_path.with_suffix(manifest_path.suffix + '.tmp')
    try:
        with tmp_jsonl.open('w', encoding='utf8') as f:
            for row in rows:
                f.write(json.dumps(row, default=_json_default) + '\n')
            f.flush()
            os.fsync(f.fileno())
        tmp_man.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding='utf8')
        _fsync_file(tmp_man)
        got = {(row['qid'], row['docid']) for row in rows}
        if len(rows) != int(manifest['n_pairs']):
            raise ValueError(f'cache row count {len(rows)} != manifest n_pairs {manifest["n_pairs"]}')
        if expected_pair_set is not None and got != expected_pair_set:
            raise ValueError(
                f'cache pair set mismatch: extra={len(got - expected_pair_set)} '
                f'missing={len(expected_pair_set - got)}'
            )
        tmp_jsonl.replace(jsonl_path)
        tmp_man.replace(manifest_path)
    except Exception:
        tmp_jsonl.unlink(missing_ok=True)
        tmp_man.unlink(missing_ok=True)
        raise


def load_cache_strict(
    jsonl_path: Path,
    manifest_path: Path,
    expected_manifest: dict,
    expected_pair_set: set[tuple[str, str]],
) -> dict[str, dict[str, float]]:
    if not jsonl_path.exists() or not manifest_path.exists():
        raise FileNotFoundError('complete reranker cache+manifest required')
    stored = json.loads(manifest_path.read_text(encoding='utf8'))
    for key, val in expected_manifest.items():
        if stored.get(key) != val:
            raise ValueError(f'cache manifest mismatch on {key}: {stored.get(key)!r} != {val!r}')
    cached: dict[str, dict[str, float]] = {}
    n = 0
    with jsonl_path.open(encoding='utf8') as f:
        for line in f:
            row = json.loads(line)
            cached.setdefault(row['qid'], {})[row['docid']] = float(row['ce'])
            n += 1
    pairs = {(qid, did) for qid, docs in cached.items() for did in docs}
    if pairs != expected_pair_set:
        raise ValueError(
            f'cached pair set mismatch: extra={len(pairs - expected_pair_set)} '
            f'missing={len(expected_pair_set - pairs)}'
        )
    if n != int(expected_manifest['n_pairs']):
        raise ValueError(f'cached count {n} != expected {expected_manifest["n_pairs"]}')
    return cached
