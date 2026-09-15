# BM25 Cross-Query Score Normalization: A Falsification Study

**Status:** code and protocol frozen on this branch; empirical tables are filled only from JSON artifacts produced by the same commit SHA.  
**Inspiration:** Ivan Silajev, *TF-IDF and BM25 Are Exact KL Divergences*, arXiv:2609.14016v1 (12 Sep 2026).  
**This document is not a paper submission.** It records a retrieval study designed to *fail* the hypothesis if the evidence is weak.

## Verdict (filled after experiments)

Pending empirical runs on this SHA. Allowed labels:

- **A.** no useful effect
- **B.** useful heuristic but collection-specific
- **C.** theoretically supported and robust calibration method
- **D.** sufficiently novel/strong to justify a dedicated paper or upstream FrozenMiniSearch feature

Do not read a positive verdict into the KL representation alone.

## 1. Literature and novelty

### 1.1 What arXiv:2609.14016 actually claims

Silajev shows that the usual TF-IDF term score and the Lucene-style BM25 term score (IDF with the `+1` inside the logarithm) can be *written as* a Kullback–Leibler divergence after one defines events “key token” / “common token” / “verbose document” and sets their probabilities equal to the TF, DF, `k1`, and `b` statistics. The query-level score is the mixture over the empirical query-term distribution:

```
Score(q, d) = sum_t (q(t)/|q|) * BM25(t, d) / (k1 + 1)
```

which is `BM25(q, d) / (|q| * (k1+1))` when BM25 is the corresponding weighted sum. The paper contains **no retrieval experiments**, **no calibration study**, and **no reranking cutoff**. Events X, Y, W are acknowledged as *arbitrarily labelled* to match the algebra (Section 3.2).

### 1.2 The representation is not a generative identification

For any finite `s ≥ 0`, set `Q = (1, 0)` and `P = (e^{-s}, 1-e^{-s})`. Then `KL(Q || P) = s` under the `0 log 0 = 0` convention. Proof: the second atom of `Q` has mass 0, and

```
KL(Q || P) = 1 * log(1 / e^{-s}) = s.
```

Therefore “score s is a KL divergence” is true of **every** non-negative score, including raw BM25, BM25/`|q|`, cosine, and a random positive number. A KL writing becomes a probabilistic *model* only if P and Q are independently meaningful. In the paper they are reverse-engineered from TF/IDF. That is a useful mnemonic, not a uniqueness theorem, and it does **not** by itself justify using `BM25 / |q|` as a probability or as a cross-query threshold.

This KL is also **not** the Lafferty–Zhai language-model retrieval model (KL between query and document unigrams with a collection background). Primary sources: Lafferty & Zhai, SIGIR 2001; Zhai & Lafferty, TOIS 2004; the KL-as-bits interpretation in MacKay (2003), cited by Silajev.

### 1.3 Prior work that already covers pieces of the hypothesis

**BM25 itself.** Robertson, Walker, Jones, Hancock-Beaulieu, Gatford, *Okapi at TREC-3* (1994). Robertson & Zaragoza, *The Probabilistic Relevance Framework: BM25 and Beyond* (FnTIR 2009). IDF with the 0.5 correction and the `k1` saturation come from the 2-Poisson / RSJ programme. Query-length averaging is **not** part of the classical RSJ derivation: BM25 is a sum of term weights, i.e. a log-odds *sum*, not a per-token mean.

**Document-length (not query-length) normalization.** Singhal, Buckley, Mitra, *Pivoted document length normalization* (SIGIR 1996). BM25’s `b` already implements a document-length pivot. Query length is a different axis.

**TF-IDF as information / PMI-like quantity.** Aizawa, *An information-theoretic perspective of tf-idf measures* (IP&M 2003). Church & Hanks, *Word association norms, mutual information, and lexicography* (Computational Linguistics 1990) for PMI. IDF is (approximately) self-information of document occurrence, `-log DF/N`. That interpretation predates Silajev and does not require a KL-of-reverse-engineered-events construction.

**Cross-query / inter-system score calibration.** Raw engine scores are not probabilities and are not comparable across queries or systems. Standard fusion normalizers: min-max, sum, z-score (Montague & Aslam, *Relevance score normalization for metasearch*, CIKM 2001; see also Lee 1997 on combining results). These local transforms are ranking-equivalent *within* a query and exist specifically to make scores comparable *across* lists. Using them as BM25 candidate gates is an application of an old idea.

**Query performance prediction from score distributions.** Cronen-Townsend, Zhou, Croft, *Predicting query performance* (SIGIR 2002, Clarity). Shtok, Kurland, Carmel, *Query performance prediction using reference lists* / NQC (normalized query commitment: variance of retrieval scores). WIG (weighted information gain, Zhou & Croft). These methods already treat the shape of BM25/LM score lists as a calibration / hardness signal. Empirical z-scores and top-ratio in this study are close relatives of NQC-style features.

**Candidate pruning before neural reranking.** Production pipelines are BM25/SPLADE top-k → cross-encoder (Nogueira & Cho, *Passage Re-ranking with BERT*, 2019; Nogueira, Yang, Cho, Lin, *Document ranking with a pretrained sequence-to-sequence model*). Dynamic pruning of the *inverted-index traversal* (WAND, Block-Max WAND) is a different problem (Ding & Suel 2011; Dimopoulos, Ntoulas, etc.). Adaptive cutoffs / rank-list truncation: work on “how many documents to rerank” and cutoff prediction (e.g. Culpepper/Mackenzie-style efficiency papers; Lien, Zamani, and others on truncation). A global BM25 threshold as a rerank gate is the cheap special case of cutoff prediction with a one-dimensional score.

**Novelty assessment.** The algebraic KL writing for Lucene BM25 appears to be Silajev’s contribution and, as a *representation*, is not claimed as new retrieval effectiveness. Using `BM25 / |q|^α` or a corpus-null Z-score as a **cross-query gate in front of a frozen reranker** is an empirical question. Close ancestors exist (score fusion z-scores, QPP, cutoff prediction). We do **not** treat the idea as unpublished physics. If experiments fail, the right report is “the representation does not yield a robust gate,” not “KL theory was refuted.”

## 2. Theoretical derivation used in the experiments

### 2.1 Paper normalization

With unique query terms scored once (documented protocol; query TF = 1):

```
paper(q, d) = BM25(q, d) / (|q|_tokens * (k1 + 1))
```

`k1+1` is constant across documents and queries in a run, so threshold orderings coincide with `BM25 / |q|` (`α = 1` in the power family). We still report the paper scaling so numbers match the formula.

Power family, **not** tuned on the evaluation fold:

```
power_α = BM25 / |q|^α,   α ∈ {0, 0.25, 0.5, 0.75, 1, 1.25, 1.5}
```

`α = 0` is raw BM25. Nested CV selects α on inner query folds.

### 2.2 Ceiling ratio

Each term contribution is at most `(k1+1) IDF_t` (saturation → 1, no BM25+ delta). Hence

```
ceiling(q, d) = BM25(q, d) / ((k1+1) * sum_t IDF_t)
```

is a [0, 1]-valued “fraction of a query-specific upper bound”. Unlike `|q|`, it tracks information mass rather than token count.

### 2.3 Corpus-null standardization

Let `X_t(D) = (k1+1) IDF_t u_t(D)` with `u_t = tf / (tf + k1(1-b+b dl/avgdl))` on the posting and `0` elsewhere. For `D` uniform on the collection:

```
μ_t = E[X_t],   v_t = Var(X_t)
μ_q = sum_t μ_t
v_q^diag = sum_t v_t
Z_diag(q, d) = (BM25(q, d) − μ_q) / sqrt(v_q^diag)
```

Pairwise `Cov(X_t, X_u)` from posting intersections (documents lacking a term contribute 0). If `|q| > 12` unique terms, covariance is computed on the 12 highest-IDF terms (documented approximation; needed for ArguAna-length queries).

**Scaling prediction.** If term contributions are i.i.d. with finite variance, `sd(BM25) ∼ sqrt(|q|)`. Positive dependence pushes the effective exponent toward 1. We test whether nested-CV α tracks mean pairwise term correlation, rather than assuming α = 1/2 or α = 1.

**Local nulls.** Per-query min-max, sum, top-ratio, empirical z-score, and median/MAD robust z use only the retrieved candidate list (or that list’s top score). They are ranking-equivalent within a query. Comparing them to `Z_diag` asks whether the *whole-corpus* null is the right reference, or whether a match-conditioned / retrieved-set null is enough (NQC-like).

**All listed transforms are ranking-equivalent within a query** (query-level scale/shift). They cannot improve in-query BM25 ranking. They can only change *cross-query* comparability and therefore global thresholds. That is the only mechanism by which they could reduce rerank cost.

### 2.4 FrozenMiniSearch vs this scorer

FrozenMiniSearch / MiniSearch 7 uses BM25+ with default `{k: 1.2, b: 0.7, d: 0.5}`. This study’s primary scorer is Lucene-like BM25 with `k1=1.2, b=0.75, d=0` so that BEIR/Pyserini comparisons remain meaningful. Sensitivity runs (documented in results JSON when executed) vary `k1/b` on cheap collections.

## 3. Data and protocol

Public BEIR dumps from
`https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/{name}.zip`
with SHA-256 of each zip recorded at download time. Qrels: `test.tsv` (or `dev.tsv` for MS MARCO). CQADupStack is pooled across forums with `forum:` prefixes. TREC DL 2019/2020, if the MS MARCO corpus is obtained, use NIST qrels.

Tokenizer: `(?u)\b\w\w+\b`, lowercase, no stemming, no stoplist. Top-K ∈ {50,100,200}; primary K=100; **no zero-score padding**. Nested 5×4 query CV; seed `20260915`. α, thresholds, and Platt scaling are fit on training queries only. Leave-one-dataset-out tests any “universal α”.

Reranker: `cross-encoder/ms-marco-MiniLM-L-6-v2`. Scores for the full BM25 top-100 are cached once; gating reuses them. Primary endpoint: nDCG@10 vs the “rerank all 100” baseline, paired bootstrap (≥10k resamples when cheap), non-inferiority margins −0.005 and −0.01. Candidate recall is secondary.

Phase B collections (planned): SciFact, NFCorpus, FiQA, ArguAna, TREC-COVID, Touché-2020, plus TREC DL if feasible. ArguAna is retained on purpose as a semantic/adversarial counterexample (counter-argument relevance).

## 4–7. Empirical sections

Filled from `research/bm25-calibration/results/*.json` after the corresponding jobs actually finish on this SHA. If a dataset is missing, the failure is recorded rather than dropped.

## 8. Preliminary branch (not evidence)

`research/bm25-kl-calibration-20260915` @ `8aaf0a9671234a4fd3debb41239e103b8d1bd6bf` ran four BEIR sets in GitHub Actions with a single 5-fold gate and no reranker. Useful as a smoke test of the BEIR download path; **not** used as a result in the verdict.

## Provenance

See `results/provenance.json` (written by the experiment runner).
