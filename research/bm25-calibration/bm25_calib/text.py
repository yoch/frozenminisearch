"""Whitespace/word tokenizer matching the documented protocol."""

from __future__ import annotations

import re

from .config import TOKEN_PATTERN

_TOKEN_RE = re.compile(TOKEN_PATTERN)


def tokenize(text: str) -> list[str]:
    if not text:
        return []
    return _TOKEN_RE.findall(text.lower())


def unique_terms(tokens: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for tok in tokens:
        if tok not in seen:
            seen.add(tok)
            out.append(tok)
    return out
