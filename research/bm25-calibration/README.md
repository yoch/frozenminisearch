# BM25 cross-query calibration study

Isolated research code. It does **not** change FrozenMiniSearch runtime behavior.

Inspired by Silajev, *TF-IDF and BM25 Are Exact KL Divergences*, arXiv:2609.14016.
The study is designed to **falsify** the claim that a posting-derived
factorized BM25 tail probability is a useful training-free Ranked List
Truncation signal in front of a frozen reranker. `BM25/|q|^α` is a
diagnostic baseline only. Surprise (Bahri et al., SIGIR 2023) and fixed-k
are mandatory RLT baselines. Choppy/AttnCut are not reimplemented;
Meng et al. (SIGIR 2024) already showed they rarely beat fixed-k.

## Protocol

See `PROTOCOL.json`. Primary BM25:

- tokenizer: `(?u)\b\w\w+\b`, lowercase, no stemming, no stopwords
- k1=1.2, b=0.75, delta=0
- IDF = log(1 + (N-df+0.5)/(df+0.5))
- unique query terms scored once (`paper_exact` is **not** computed)
- diagnostics: `power_token_len` = BM25 / |q|_tokens, `power_unique_len` = BM25 / |q|_unique
- ceiling sums IDF only for terms with `df_t > 0`
- top-K never padded with zero-score documents
- **full corpus**; at most 400 judged queries (seeded sample if the split is larger)
- no high-df term dropping on the reference path

`I_gauss_diag` is an **index-derived z-normalization** (strictly monotone in `z_diag`).
It is not a validated tail probability `P0` until Gaussian / MC / saddlepoint
error is measured on a stratified sample.

### IR metrics vs calibration

- nDCG / MAP / Recall follow the usual benchmark convention: unjudged = not relevant.
  IDCG always uses the **full query qrels**, not the truncated list.
- Precision@k = hits in the first k documents / k, even if fewer than k documents exist.
- Calibration AUROC / AP / Brier / ECE on retrieved lists is the task
  **`qrel-positive vs all-other-retrieved`**, not P(relevance).
  A judged-only mask exists when explicitly requested.
- Queries with no BM25 match are **kept**. Top-1 confidence is `-inf`. Report `no_match_rate`.

Historical JSON under `results/historical/sha-11d27ef/` is obsolete.

## Run

From the repository root, with Python 3.12+:

```bash
python3 -m pip install -r research/bm25-calibration/requirements.txt
PYTHONPATH=research/bm25-calibration python3 -m unittest discover -s research/bm25-calibration/tests -v
PYTHONPATH=research/bm25-calibration python3 -m bm25_calib.run_phase_a
PYTHONPATH=research/bm25-calibration python3 -m bm25_calib.run_phase_b
```

Unittest output must be recorded in run provenance (`results/unittest-harness.json`)
before any campaign. Phase B needs `torch`, `transformers`, and optionally `sentence-transformers`.

Do not treat the preliminary branch `research/bm25-kl-calibration-20260915` as a result source; it is four BEIR sets, no nested alpha selection, no Z-null, no reranker.

## Outputs

- `results/` machine-readable JSON (committed summaries)
- `results/historical/` obsolete outputs bound to the SHA that produced them
- `artifacts/` local caches (gitignored)
- `REPORT.md` the research report
