"""Download and parse public BEIR / TREC collections with checksums."""

from __future__ import annotations

import csv
import gzip
import hashlib
import json
import random
import time
import urllib.request
import zipfile
from pathlib import Path

from .config import BEIR_BASE, MAX_QUERIES, SEED, TREC_DL19_QRELS, TREC_DL19_QUERIES, TREC_DL20_QRELS, TREC_DL20_QUERIES
from .text import tokenize, unique_terms


def sha256_file(path: Path, buf: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        while True:
            chunk = f.read(buf)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path, retries: int = 4) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    tmp = dest.with_suffix(dest.suffix + '.part')
    delay = 4
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'frozenminisearch-bm25-study/1.0'})
            with urllib.request.urlopen(req, timeout=120) as src, tmp.open('wb') as out:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
            tmp.replace(dest)
            return dest
        except Exception as exc:  # noqa: BLE001 — download retries are intentional
            last_err = exc
            time.sleep(delay)
            delay *= 2
    raise RuntimeError(f'failed to download {url} after {retries} attempts: {last_err}')


def extract_zip(zp: Path, dest: Path) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    marker = dest / '.extracted'
    if marker.exists():
        return dest
    with zipfile.ZipFile(zp) as zf:
        zf.extractall(dest)
    marker.write_text(zp.name + '\n', encoding='utf8')
    return dest


def _read_jsonl_map(path: Path, key: str, fields: tuple[str, ...]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    with path.open(encoding='utf8') as f:
        for line in f:
            row = json.loads(line)
            item = {k: row.get(k, '') for k in fields}
            out[str(row[key])] = item
    return out


def _read_qrels(path: Path) -> tuple[dict[str, dict[str, int]], dict[str, dict[str, int]]]:
    judged: dict[str, dict[str, int]] = {}
    with path.open(encoding='utf8') as f:
        reader = csv.DictReader(f, delimiter='\t')
        for row in reader:
            qid = str(row['query-id'])
            did = str(row['corpus-id'])
            score = int(float(row['score']))
            judged.setdefault(qid, {})[did] = score
    qrels = {
        qid: {did: g for did, g in grades.items() if g > 0}
        for qid, grades in judged.items()
    }
    qrels = {qid: grades for qid, grades in qrels.items() if grades}
    return qrels, judged


def beir_paths(root: Path, name: str) -> tuple[Path, Path, Path]:
    """Return corpus, queries, qrels paths, including CQADupStack pooling."""
    extracted = root / name
    if name == 'cqadupstack':
        return extracted, extracted, extracted
    base = extracted / name
    if not base.exists():
        # zip may extract with nested folder or flat
        candidates = [p for p in extracted.iterdir() if p.is_dir()]
        if len(candidates) == 1:
            base = candidates[0]
        else:
            base = extracted
    qrels = base / 'qrels' / 'test.tsv'
    if not qrels.exists():
        # msmarco uses dev split in BEIR
        alt = base / 'qrels' / 'dev.tsv'
        if alt.exists():
            qrels = alt
    return base / 'corpus.jsonl', base / 'queries.jsonl', qrels


def load_queries_qrels(queries_path: Path, qrels_path: Path) -> tuple[dict[str, str], dict[str, dict[str, int]], dict[str, dict[str, int]]]:
    queries: dict[str, str] = {}
    with queries_path.open(encoding='utf8') as f:
        for line in f:
            row = json.loads(line)
            queries[str(row['_id'])] = str(row.get('text') or '')
    qrels, judged = _read_qrels(qrels_path)
    queries = {qid: text for qid, text in queries.items() if qid in qrels}
    judged = {qid: judged.get(qid, qrels[qid]) for qid in queries}
    return queries, qrels, judged


def pool_cqadupstack(extracted: Path) -> tuple[list[Path], list[Path], list[Path], list[str]]:
    forums = sorted(p.name for p in extracted.iterdir() if p.is_dir() and (p / 'corpus.jsonl').exists())
    if not forums:
        # nested cqadupstack/cqadupstack/...
        nested = extracted / 'cqadupstack'
        if nested.exists():
            forums = sorted(p.name for p in nested.iterdir() if p.is_dir() and (p / 'corpus.jsonl').exists())
            extracted = nested
    corpora = [extracted / f / 'corpus.jsonl' for f in forums]
    queries = [extracted / f / 'queries.jsonl' for f in forums]
    qrels = []
    for f in forums:
        qp = extracted / f / 'qrels' / 'test.tsv'
        if not qp.exists():
            qp = extracted / f / 'qrels' / 'dev.tsv'
        qrels.append(qp)
    return corpora, queries, qrels, forums


def iter_corpus_jsonl(path: Path):
    with path.open(encoding='utf8') as f:
        for line in f:
            row = json.loads(line)
            title = row.get('title') or ''
            text = row.get('text') or ''
            body = f'{title} {text}'.strip()
            yield str(row['_id']), body


def subsample_queries(
    queries: dict[str, str],
    qrels: dict[str, dict[str, int]],
    n_max: int = MAX_QUERIES,
    seed: int = SEED,
) -> tuple[dict[str, str], dict[str, dict[str, int]], dict]:
    """Keep every document; draw at most n_max queries with a seeded RNG.

    Query ids are sorted first so the draw does not depend on dict order.
    """
    qids = sorted(qid for qid in queries if qid in qrels and qrels[qid])
    n_full = len(qids)
    if n_full <= n_max:
        kept_q = {qid: queries[qid] for qid in qids}
        kept_r = {qid: qrels[qid] for qid in qids}
        return kept_q, kept_r, {
            'subsampled': False,
            'n_queries_full': n_full,
            'n_queries_used': n_full,
            'max_queries': n_max,
            'seed': seed,
            'policy': 'all-judged-queries',
        }
    rng = random.Random(seed)
    chosen = sorted(rng.sample(qids, n_max))
    kept_q = {qid: queries[qid] for qid in chosen}
    kept_r = {qid: qrels[qid] for qid in chosen}
    return kept_q, kept_r, {
        'subsampled': True,
        'n_queries_full': n_full,
        'n_queries_used': n_max,
        'max_queries': n_max,
        'seed': seed,
        'policy': 'sorted-qid sample without replacement; full corpus retained',
        'chosen_qids': chosen,
    }


def _apply_query_cap(
    meta: dict,
    queries: dict[str, str],
    qrels: dict[str, dict[str, int]],
    judged: dict[str, dict[str, int]] | None = None,
) -> tuple[dict, dict[str, str], dict[str, dict[str, int]], dict[str, dict[str, int]]]:
    queries, qrels, slice_meta = subsample_queries(queries, qrels)
    meta = {**meta, 'query_slice': {k: v for k, v in slice_meta.items() if k != 'chosen_qids'}}
    if slice_meta.get('subsampled'):
        meta['query_slice']['n_chosen'] = len(slice_meta['chosen_qids'])
    if judged is None:
        judged = qrels
    judged = {qid: judged.get(qid, qrels[qid]) for qid in queries}
    return meta, queries, qrels, judged


def query_vocab(queries: dict[str, str]) -> tuple[dict[str, list[str]], dict[str, list[str]], set[str]]:
    q_tokens: dict[str, list[str]] = {}
    q_terms: dict[str, list[str]] = {}
    vocab: set[str] = set()
    for qid, text in queries.items():
        toks = tokenize(text)
        terms = unique_terms(toks)
        q_tokens[qid] = toks
        q_terms[qid] = terms
        vocab.update(terms)
    return q_tokens, q_terms, vocab


def prepare_beir(name: str, data_root: Path) -> dict:
    data_root.mkdir(parents=True, exist_ok=True)
    url = f'{BEIR_BASE}/{name}.zip'
    zp = data_root / f'{name}.zip'
    download(url, zp)
    checksum = sha256_file(zp)
    extracted = data_root / name
    extract_zip(zp, extracted)
    meta = {
        'name': name,
        'url': url,
        'zip_path': str(zp),
        'sha256': checksum,
        'bytes': zp.stat().st_size,
    }
    if name == 'cqadupstack':
        corpora, queries_paths, qrels_paths, forums = pool_cqadupstack(extracted)
        queries: dict[str, str] = {}
        qrels: dict[str, dict[str, int]] = {}
        judged: dict[str, dict[str, int]] = {}
        for forum, qp, rp in zip(forums, queries_paths, qrels_paths):
            q, r, j = load_queries_qrels(qp, rp)
            for qid, text in q.items():
                queries[f'{forum}:{qid}'] = text
            for qid, rels in r.items():
                qrels[f'{forum}:{qid}'] = {f'{forum}:{did}': g for did, g in rels.items()}
            for qid, rels in j.items():
                judged[f'{forum}:{qid}'] = {f'{forum}:{did}': g for did, g in rels.items()}
        meta['forums'] = forums
        meta, queries, qrels, judged = _apply_query_cap(meta, queries, qrels, judged)
        return {
            'meta': meta,
            'queries': queries,
            'qrels': qrels,
            'judged': judged,
            'corpus_iter': _iter_many(corpora, forums),
        }
    corpus_path, queries_path, qrels_path = beir_paths(data_root, name)
    queries, qrels, judged = load_queries_qrels(queries_path, qrels_path)
    meta, queries, qrels, judged = _apply_query_cap(meta, queries, qrels, judged)
    return {
        'meta': meta,
        'queries': queries,
        'qrels': qrels,
        'judged': judged,
        'corpus_iter': iter_corpus_jsonl(corpus_path),
        'corpus_path': str(corpus_path),
    }


def _iter_many(paths: list[Path], prefixes: list[str]):
    for prefix, path in zip(prefixes, paths):
        for doc_id, text in iter_corpus_jsonl(path):
            yield f'{prefix}:{doc_id}', text


def _read_tsv_queries(path: Path) -> dict[str, str]:
    queries: dict[str, str] = {}
    opener = gzip.open if path.suffix == '.gz' else path.open
    with opener(path, 'rt', encoding='utf8') as f:
        for line in f:
            parts = line.rstrip('\n').split('\t')
            if len(parts) >= 2:
                queries[parts[0]] = parts[1]
    return queries


def _read_trec_qrels(path: Path) -> tuple[dict[str, dict[str, int]], dict[str, dict[str, int]]]:
    judged: dict[str, dict[str, int]] = {}
    with path.open(encoding='utf8') as f:
        for line in f:
            parts = line.split()
            if len(parts) < 4:
                continue
            qid, _, did, rel = parts[0], parts[1], parts[2], int(parts[3])
            judged.setdefault(qid, {})[did] = rel
    qrels = {
        qid: {did: g for did, g in grades.items() if g > 0}
        for qid, grades in judged.items()
    }
    qrels = {qid: grades for qid, grades in qrels.items() if grades}
    return qrels, judged


def prepare_trec_dl(year: str, data_root: Path, msmarco_corpus_path: str | None) -> dict:
    data_root.mkdir(parents=True, exist_ok=True)
    if year == '2019':
        qrels_url, query_url = TREC_DL19_QRELS, TREC_DL19_QUERIES
    elif year == '2020':
        qrels_url, query_url = TREC_DL20_QRELS, TREC_DL20_QUERIES
    else:
        raise ValueError(year)
    qrels_path = data_root / f'trec-dl-{year}-qrels.txt'
    queries_path = data_root / f'trec-dl-{year}-queries.tsv.gz'
    download(qrels_url, qrels_path)
    download(query_url, queries_path)
    qrels, judged = _read_trec_qrels(qrels_path)
    queries = _read_tsv_queries(queries_path)
    queries = {qid: text for qid, text in queries.items() if qid in qrels}
    meta = {
        'name': f'trec-dl-{year}',
        'qrels_url': qrels_url,
        'queries_url': query_url,
        'qrels_sha256': sha256_file(qrels_path),
        'queries_sha256': sha256_file(queries_path),
    }
    meta, queries, qrels, judged = _apply_query_cap(meta, queries, qrels, judged)
    if not msmarco_corpus_path:
        raise FileNotFoundError('MS MARCO corpus is required for TREC DL')
    return {
        'meta': meta,
        'queries': queries,
        'qrels': qrels,
        'judged': judged,
        'corpus_iter': iter_corpus_jsonl(Path(msmarco_corpus_path)),
        'corpus_path': msmarco_corpus_path,
    }
