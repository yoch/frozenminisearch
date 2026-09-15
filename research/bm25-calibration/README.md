# BM25 cross-query calibration study

Isolated research code. It does **not** change FrozenMiniSearch runtime behavior.

Inspired by Silajev, *TF-IDF and BM25 Are Exact KL Divergences*, arXiv:2609.14016.
The study is designed to **falsify** the claim that BM25 / (|q|(k1+1)) is a
theoretically justified, well-calibrated, collection-robust candidate gate.

## Protocol

See `PROTOCOL.json`. Primary BM25:

- tokenizer: `(?u)\b\w\w+\b`, lowercase, no stemming, no stopwords
- k1=1.2, b=0.75, delta=0
- IDF = log(1 + (N-df+0.5)/(df+0.5))
- unique query terms scored once
- top-K never padded with zero-score documents

## Run

From the repository root, with Python 3.12+:

```bash
python3 -m pip install -r research/bm25-calibration/requirements.txt
PYTHONPATH=research/bm25-calibration python3 -m unittest discover -s research/bm25-calibration/tests -v
PYTHONPATH=research/bm25-calibration python3 -m bm25_calib.run_phase_a
PYTHONPATH=research/bm25-calibration python3 -m bm25_calib.run_phase_b
```

Phase B needs `torch`, `transformers`, and optionally `sentence-transformers`.

Do not treat the preliminary branch `research/bm25-kl-calibration-20260915` as a result source; it is four BEIR sets, no nested alpha selection, no Z-null, no reranker.

## Outputs

- `results/` machine-readable JSON (committed summaries)
- `artifacts/` local caches (gitignored)
- `REPORT.md` the research report
