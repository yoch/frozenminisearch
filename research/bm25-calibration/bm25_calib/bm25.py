"""Lucene-like BM25 with always-non-negative IDF.

The FrozenMiniSearch runtime uses MiniSearch BM25+ (k=1.2, b=0.7, d=0.5).
This study uses the classical saturation kernel with k1=1.2, b=0.75, d=0
and IDF = log(1 + (N-df+0.5)/(df+0.5)), matching Lucene/BEIR practice and
the +1 IDF form treated by Silajev (arXiv:2609.14016).
"""

from __future__ import annotations

import math

import numpy as np

from .config import B, DELTA, K1


def idf_lucene(df: int, n_docs: int) -> float:
    df = max(int(df), 0)
    n_docs = max(int(n_docs), 1)
    return math.log(1.0 + (n_docs - df + 0.5) / (df + 0.5))


def length_norm(dl: np.ndarray, avgdl: float, b: float = B) -> np.ndarray:
    avgdl = max(float(avgdl), 1e-12)
    return (1.0 - b) + b * (dl.astype(np.float64) / avgdl)


def tf_component(
    tf: np.ndarray,
    dl_norm: np.ndarray,
    k1: float = K1,
    delta: float = DELTA,
) -> np.ndarray:
    tf = tf.astype(np.float64, copy=False)
    denom = tf + k1 * dl_norm
    sat = (tf * (k1 + 1.0)) / np.maximum(denom, 1e-12)
    if delta:
        sat = sat + delta
    return sat


def u_component(tf: np.ndarray, dl_norm: np.ndarray, k1: float = K1) -> np.ndarray:
    """Saturated TF without the (k1+1) multiplier: X = (k1+1)*IDF*u."""
    tf = tf.astype(np.float64, copy=False)
    return tf / np.maximum(tf + k1 * dl_norm, 1e-12)


def term_contributions(
    tf: np.ndarray,
    dl_norm: np.ndarray,
    idf: float,
    k1: float = K1,
    delta: float = DELTA,
) -> np.ndarray:
    return idf * tf_component(tf, dl_norm, k1=k1, delta=delta)
