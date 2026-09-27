"""Shared synthetic corpora for harness tests."""

from __future__ import annotations

from collections.abc import Iterable


def make_bundle(
    docs: Iterable[tuple[str, str]],
    queries: dict[str, str],
    qrels: dict[str, dict[str, int]],
    judged: dict[str, dict[str, int]] | None = None,
    name: str = 'synth',
) -> dict:
    docs = list(docs)
    return {
        'meta': {'name': name, 'url': 'synthetic', 'sha256': 'synth'},
        'queries': queries,
        'qrels': qrels,
        'judged': judged if judged is not None else qrels,
        'corpus_iter': iter(docs),
        'corpus_path': None,
        'doc_texts': {did: text for did, text in docs},
    }
