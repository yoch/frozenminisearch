# BM25 Index-Derived Null / Ranked List Truncation Study

**Recast 2026-09-15.** Query-length powers `BM25/|q|^α` are diagnostic baselines, not the claim.

**Inspiration (secondary):** Silajev, arXiv:2609.14016 — kept only for the KL-representability caveat.

**Question:** can a *factorized* background model of BM25, built from posting statistics, produce a cross-query tail probability that truncates the BM25 candidate list before a frozen reranker without a material nDCG@10 loss, and does that beat Surprise and fixed-K?

## Git provenance (this file is updated after each result commit)

- Remote: `github.com/yoch/frozenminisearch`
- Default branch: `master` @ `e06eca31874c30071bee4cbccf4814a40bec8b5f`
- Research branch: `cursor/bm25-score-normalization-study-fb5b`
- Do not merge, do not open a PR, do not touch `master`.

## Verdict (filled only from JSON produced by the cited SHA)

Pending re-runs after the RLT/null pivot. Allowed labels:

- **A.** Already known; no interesting remainder
- **B.** Useful engineering heuristic
- **C.** Clean method, limited scientific novelty
- **D.** Beats modern RLT baselines, preserves downstream quality, original enough for a paper

D requires stronger evidence than query-length calibration anecdotes.

---

## 1. Literature (primary sources actually read)

### 1.1 Score distributions

**Manmatha, Rath & Feng, SIGIR 2001.** Mixture models (typically Gaussian relevant + exponential non-relevant) fitted to *retrieved* scores for metasearch. Not an index-derived generative model.

**Manmatha & Sever, 2002.** Score normalization via those fitted distributions.

**Nottelmann & Fuhr, 2003.** Map retrieval status values to P(relevance) (logistic/linear calibration). Training/mapping, not a posting-level null.

**Arampatzis, Kamps & Robertson, SIGIR 2009, “Where to Stop Reading a Ranked List?”** Rank cutoff as score-distributional thresholding. Truncated normal–exponential mixtures; F1@K on TREC Legal. Null/relevant densities are fitted on the **output list**, not computed from inverted-index postings.

**Kanoulas, Dai, Pavlu & Aslam, SIGIR 2010.** *This is the closest ancestor.* They start from a Poisson-process assumption on term occurrences, transform TF/DL through BM25 (and LM), and **derive an analytical score distribution** for retrieved documents; Gamma is a workable approximation; term independence is used when summing. Purpose: describe relevant vs non-relevant score *shapes*, not a training-free p-value for neural rerank truncation.

**Arampatzis & van Hameren:** CLT → Gaussian for relevant scores as |q| grows; not for non-relevant.

### 1.2 QPP / 1/sqrt(|q|) / variance

**Zhou & Croft, SIGIR 2007 (WIG).** Weighted information gain: average top-document LM score minus collection score, with **λ ∝ 1/sqrt(|features|)** so that the predictor is comparable across query lengths. Collection-background comparison + query-length scaling is **already standard QPP**, not a 2026 idea.

**NQC (Shtok, Kurland, Carmel, …).** Normalized standard deviation of retrieval scores as a post-retrieval QPP signal. Local list variance, not a corpus MGF.

Clarity (Cronen-Townsend, Zhou, Croft, SIGIR 2002) is a different KL: query LM vs collection LM.

### 1.3 Ranked list truncation / reranking cost

**BiCut (Lien et al., 2019), Choppy (Bahri et al., 2020), AttnCut (Wu et al., 2021), MtCut, LeCut.** Supervised cutoff predictors (BiLSTM / Transformer) on list features. Need labels.

**Bahri, Zheng, Tay, Metzler, Tomkins, SIGIR 2023 / arXiv:2010.09797, Surprise.** GPD on the **returned list’s excesses** (Pickands–Balkema–de Haan). Score `−log(1−GPD.cdf)` is a p-value-like *surprise under the list tail*, not under a random corpus document. Greedy Cramér–von Mises chooses the GPD sample. Two settings: local neighborhood vs global threshold on surprise. **Mandatory baseline.**

**Meng, Arabzadeh, Askari, Aliannejadi, de Rijke, SIGIR 2024.** RLT for retrieve-then-rerank (BM25/SPLADE/RepLLaMA × RankLLaMA/monoT5) on **TREC DL 19/20**. Central empirical finding we take as given unless we contradict it on our SHA: **fixed-k often matches supervised RLT on the cost/nDCG frontier**; Surprise on BM25→RankLLaMA kept ~700 of 1000 candidates (barely truncates). We therefore treat **fixed-k as the method to beat**, and we do **not** reimplement Choppy/AttnCut (Meng already did; they rarely dominate fixed-k).

**Rossi et al., 2024, Cosine Adapter (arXiv:2408.04887).** Learned query-dependent map from cosine to a calibrated score, then a **global threshold**. Trained, embedding-specific.

**TMP Adapter, ACL Findings 2025.** Threshold-margin penalty on top of adapter-style calibration. Trained.

Recent downstream-QPP / ECIR 2026 work is noted as context: QPP that does not improve a *downstream* decision is not a success. Our downstream decision is rerank truncation.

### 1.4 Metasearch z-scores

Montague & Aslam, CIKM 2001: min-max / z-score / sum normalization for fusion. Ranking-equivalent within a list.

### 1.5 Silajev KL (now secondary)

Any s ≥ 0 is KL(Q||P) for Q=(1,0), P=(e^{-s}, 1−e^{-s}). Representability is not identification. We stop testing “the paper’s KL” as a retrieval hypothesis.

### 1.6 What is already known vs what might remain

| Idea | Status |
|---|---|
| BM25 / \|q\| or / \|q\|^α | Old; WIG already uses 1/sqrt(\|q\|) |
| Z-score of a list | Metasearch / NQC |
| Score-distribution cutoff | Manmatha, Arampatzis 2009 |
| Analytical BM25 score law from TF/DL | **Kanoulas et al. 2010** |
| Dynamic cutoff / RLT | Large 2019–2025 literature |
| EVT p-value on the **result list** | **Surprise 2023** |
| Learned global threshold | Cosine/TMP adapters |
| Exact corpus CDF p0 = rank/N | Rank statistic; **cannot** cross-calibrate top-k |

**Not already packaged as a 2026 “new IR model”:** posting-empirical **factorized** tail `P_indep(sum X_t ≥ s)` (Gaussian / Chernoff / saddlepoint / MC) used as a **training-free RLT signal** in front of a frozen cross-encoder, compared to Surprise and fixed-k, with non-inferiority on nDCG@10.

That is an **engineering combination**. Kanoulas already assumed independence and derived BM25 laws; Surprise already produces list-tail p-values. If we do not beat fixed-k **and** remain competitive with Surprise on the Pareto curve, the honest verdict is **A or B**.

### 1.7 Critical modeling distinction (must not be fudged)

Let S_q(D) be BM25 for a uniform corpus document.

- **Joint empirical null:** p0 = |{d' : S(d') ≥ s}| / N. For the r-th unique top-k hit, p0 = r/N. Every query’s top-1 has the same p0. **Negative control.**
- **Factorized null:** X_t iid from empirical term marginals (zeros + postings). S_ind is **not** the BM25 histogram. Gaussian/saddlepoint p-values can differ across queries. This is the only index-derived tail that *could* be a cross-query signal.
- **Surprise null:** tail of the returned list (conditional excess). Different reference measure, typically cheaper, no postings required.

---

## 2. Protocol (RLT-first)

- BM25: Lucene-like, k1=1.2, b=0.75, unique query terms, tokenizer `(?u)\b\w\w+\b`, no stemming/stopwords, no zero padding.
- Primary K=100. Nested query CV. Seed 20260915.
- Document scores: raw, paper/power-α (diagnostic), ceiling, local z/minmax/sum/top, Z_diag, Z_full, I_saddle, I_gauss, Surprise, I_joint (negative control).
- **Primary endpoint:** nDCG@10 of frozen `cross-encoder/ms-marco-MiniLM-L-6-v2` on retained candidates vs rerank-all-100. Cache CE scores once.
- **Mandatory baselines:** fixed k ∈ {5,10,20,30,50,75,100}; Surprise; local list z; raw global threshold.
- Non-inferiority: ΔnDCG@10 ≥ −0.005 and −0.01, paired bootstrap ≥ 10k.
- Candidate recall is intermediate only.
- Choppy/AttnCut: not reimplemented; Meng 2024 is the reference.

---

## 3. Empirical results

Filled from `research/bm25-calibration/results/*.json` after jobs on the **same** SHA. Missing datasets are failures, not silent drops.

## 4. Answers demanded by the recast

1. Does an index-derived null already exist? **Yes, in essence (Kanoulas 2010; WIG collection baseline).**
2. Best P0 approximation? *pending*
3. Is independence OK? *pending (var_full vs var_diag, MC vs Gaussian)*
4. Is Z enough vs saddlepoint/EVT? *pending*
5. Is the tail better calibrated across queries? *pending*
6. Beat Surprise? *pending*
7. Beat fixed-k? *pending — Meng suggests this is hard*
8. Cut rerank cost without nDCG loss? *pending*
9. Transfer across collections? *pending*
10. Paper-worthy? Default **no** until 6–8 are clearly yes.

## Provenance

See `results/provenance.json`.
