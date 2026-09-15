# Skipped this round (not evaluated)

Absence is not a negative result. Revisit later.

## Methods

| id | reason |
|---|---|
| saddlepoint / Lugannani–Rice | posting MGF + Newton per query; hung on ArguAna |
| Chernoff MGF | same cost as saddlepoint |
| independence Monte Carlo tails | sampling every term posting per query |
| exact convolution of P0 | only tractable on tiny synthetic indexes |
| pairwise covariance / Z_full | O(T²) posting intersections |
| Choppy / AttnCut | supervised RLT; Meng 2024 already vs fixed-k |
| Cosine Adapter / TMP Adapter | trained calibration, out of scope |

Online tails are **Gaussian factorized-null** (`Z_diag`, `I_gauss_diag`) plus the joint-rank negative control and Surprise-lite (GPD on the returned list, greedy CvM capped at 8 steps/side).

## Datasets

TREC DL 2019/2020 are skipped until the MS MARCO passage corpus is local.

Every other listed BEIR collection is attempted with:

- **all documents**
- **at most 400 queries**, seeded sample (`SEED=20260915`) if the split is larger

That query slice is recorded in `meta.query_slice` and is **not** the official full-query BEIR split.

## Phase B

`arguana` reranking is skipped: queries are document-length, MiniLM@512 on top-100 is too costly on CPU. The BM25/null Phase A slice is still run.
