# BM25 Index-Derived Null / Ranked List Truncation Study

**Recast 2026-09-15.** Query-length powers `BM25/|q|^α` are diagnostic baselines, not the claim.

**Inspiration (secondary):** Silajev, arXiv:2609.14016 — kept only for the KL-representability caveat.

**Question:** can a *factorized* background model of BM25, built from posting statistics, produce a cross-query tail probability that truncates the BM25 candidate list before a frozen reranker without a material nDCG@10 loss, and does that beat Surprise and fixed-K?

## Git provenance (this file is updated after each result commit)

- Remote: `github.com/yoch/frozenminisearch`
- Default branch: `master` @ `e06eca31874c30071bee4cbccf4814a40bec8b5f`
- Research branch: `cursor/bm25-score-normalization-study-fb5b` @ `ace100d5beee9cd2aee72307aeb942866bd6f076`
- Tracking PR (do not merge): https://github.com/yoch/frozenminisearch/pull/15
- Do not merge, do not touch `master`.

## Verdict (filled only from JSON produced by the cited SHA)

**Phase A only (SHA `ace100d`): B, leaning A.** Index-null Z_diag destandardizes query length and sometimes tightens a global gate (SciFact, ArguAna), but list-local Surprise/minmax match or beat it, the gate does not transfer, and there is **no** end-to-end nDCG vs fixed-k yet. D is not on the table.

Allowed labels:

- **A.** Already known; no interesting remainder
- **B.** Useful engineering heuristic
- **C.** Clean method, limited scientific novelty
- **D.** Beats modern RLT baselines, preserves downstream quality, original enough for a paper

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
- **Corpus: always full.** If a split has more than 400 judged queries, a seeded sample of 400 is used (`SEED=20260915`). That slice is labeled in `meta.query_slice` and is not the official BEIR query set.
- Primary K=100. Nested query CV. Seed 20260915.
- Document scores (this round): raw, paper/power-α (diagnostic), ceiling, local z/minmax/sum/top, Z_diag, I_gauss_diag, Surprise, I_joint (negative control).
- **Skipped this round** (see `SKIPPED.md`): saddlepoint, Chernoff, MC tails, Z_full covariance, Choppy/AttnCut, adapters, TREC DL 19/20.
- **Primary endpoint:** nDCG@10 of frozen `cross-encoder/ms-marco-MiniLM-L-6-v2` on retained candidates vs rerank-all-100. Cache CE scores once.
- **Mandatory baselines:** fixed k ∈ {5,10,20,30,50,75,100}; Surprise; local list z; raw global threshold.
- Non-inferiority: ΔnDCG@10 ≥ −0.005 and −0.01, paired bootstrap ≥ 10k.
- Candidate recall is intermediate only.
- Choppy/AttnCut: not reimplemented; Meng 2024 is the reference.

---

## 3. Empirical results

**SHA of this Phase A sweep:** `ace100d5beee9cd2aee72307aeb942866bd6f076`  
**Job:** `run_phase_a --force` on 7 collections, ~290 s wall.  
**Tails:** cheap Gaussian factorized-null + joint rank + Surprise (greedy CvM capped). Saddlepoint / MC / covariance **not** computed.

Corpus is always full. Query cap 400 (seed 20260915). Candidate recall at the 0.95 relevant-score quantile is **intermediate only**: the threshold is fit on train relevant scores, so recall ≈ 0.95 is nearly tautological. The useful number is **retained fraction**.

### 3.1 Collections

| dataset | docs | queries used / full | sliced | mean \|q\| | pool recall@100 | α* nested | sec |
|---|---:|---:|:---:|---:|---:|---:|---:|
| scifact | 5183 | 300 / 300 | no | 12.6 | 0.879 | 0.50 | 30 |
| nfcorpus | 3633 | 323 / 323 | no | 3.3 | 0.153 | 0.65 | 31 |
| fiqa | 57638 | 400 / 648 | yes | 10.4 | 0.470 | 0.50 | 38 |
| arguana | 8674 | 400 / 1406 | yes | 194 | 0.920 | 0.65 | 45 |
| scidocs | 25657 | 400 / 1000 | yes | 9.8 | 0.343 | 0.25 | 62 |
| trec-covid | 171332 | 50 / 50 | no | 11.5 | 0.087 | 0.45 | 21 |
| webis-touche2020 | 382545 | 49 / 49 | no | 6.5 | 0.518 | 0.55 | 62 |

`mean_term_corr` is 0 everywhere: pairwise covariance was skipped.

### 3.2 Pooled candidate AUROC and ρ(top-score, \|q\|)

`I_gauss_diag` is −log of the Gaussian survival. Within a query it is monotone in `Z_diag`; pooled AUROC is therefore almost identical. `I_joint_rank` is rank/N (negative control). `minmax` / `z_emp` / Surprise are **list-local**.

| dataset | raw AUROC (ρ_qlen) | Z_diag / I_gauss | Surprise | minmax | power_0.5 | paper α=1 |
|---|---|---|---|---|---|---|
| scifact | 0.919 (0.52) | **0.946** (0.05) | 0.955 | 0.958 | 0.939 | 0.921 |
| nfcorpus | 0.685 (0.52) | 0.786 (−0.55) | 0.648† | 0.762 | **0.815** | 0.803 |
| fiqa | 0.749 (0.63) | 0.753 (−0.15) | **0.807** | 0.805 | 0.780 | 0.711 |
| arguana | 0.793 (0.88) | 0.888 (0.44 / I: 0.07) | **0.899** | 0.894 | 0.882 | 0.840 |
| scidocs | 0.746 (0.60) | **0.762** (0.11) | 0.762 | 0.760 | 0.756 | 0.706 |
| trec-covid | 0.650 (0.61) | **0.684** (0.05) | 0.616 | 0.633 | 0.671 | 0.637 |
| touche | 0.666 (0.66) | 0.684 (0.08) | **0.747** | 0.747 | 0.696 | 0.656 |

† NFCorpus Surprise gating retained 100 % of candidates (degenerate GPD fit on short lists / weak score dynamic range). Treat as a failure mode, not a win.

### 3.3 Gating @ 0.95 relevant-score quantile (retained fraction; recall ≈ 0.95 by construction)

Lower retained at matched recall would be the only interesting Phase A cost signal.

| dataset | raw ret | Z_diag ret | Surprise ret | power_0.5 ret |
|---|---:|---:|---:|---:|
| scifact | 0.54 | **0.35** | 0.28 | 0.42 |
| nfcorpus | 0.85 | 0.78 | 1.00† | **0.75** |
| fiqa | 0.82 | 0.86 | **0.78** | 0.79 |
| arguana | 0.81 | 0.49 | **0.47** | 0.56 |
| scidocs | **0.81** | 0.83 | 0.86 | 0.81 |
| trec-covid | 0.90 | **0.88** | 0.93 | 0.89 |
| touche | **0.80** | 0.85 | 0.87 | 0.80 |

Index-null **helps** as a global gate on SciFact and ArguAna (long queries). It **does not** help on FiQA, SCIDOCS, Touché (keeps more than raw). List-local Surprise/minmax often match or beat it. `I_joint_rank` on SciFact retains 0.28 ≈ fixed-k 28, as expected for a pure rank statistic.

### 3.4 What this does *not* show

- No end-to-end nDCG@10 (Phase B not in this SHA’s JSON yet).
- No comparison to fixed-k rerank (the method to beat).
- No saddlepoint vs Gaussian (skipped).
- No independence check (covariance skipped). Nested α* ranges 0.25–0.65; without `mean_term_corr` we **cannot** test the “optimal α tracks term dependence” story. Drop that interpretation until covariance is cheap enough to revisit.
- BEIR qrels are sparse except TREC-COVID; candidate AUROC is not the primary claim.

### 3.5 Phase B

Pending: frozen MiniLM on SciFact, NFCorpus, FiQA, TREC-COVID, Touché. ArguAna rerank skipped (document-length queries).

## 4. Answers demanded by the recast

1. Index-derived null already in the literature? **Yes, in essence (Kanoulas 2010; WIG collection baseline).**
2. Best P0 approximation? **Unevaluated beyond Gaussian.** Saddlepoint/MC skipped on cost.
3. Independence OK? **Not measured this round.**
4. Z enough vs saddlepoint/EVT? **Z_diag ≈ I_gauss. List EVT (Surprise) wins pooled AUROC on FiQA/ArguAna/Touché; collapses on NFCorpus.**
5. Tail better calibrated across queries? **Z_diag reduces ρ with \|q\| vs raw BM25 on every set. That is cross-query scale, not downstream utility.**
6. Beat Surprise? **Not on Phase A AUROC. Mixed on gating retained.**
7. Beat fixed-k? **Not tested (needs Phase B).**
8. Cut rerank cost without nDCG loss? **Pending Phase B.**
9. Transfer? **Gating benefit of Z_diag does not transfer (helps SciFact/ArguAna, hurts or null on FiQA/SCIDOCS/Touché).**
10. Paper-worthy? **Not on Phase A evidence. Default remains no until 6–8 are yes.**

**Working verdict after Phase A only: B (engineering heuristic) leaning A**, unless Phase B shows a Pareto win vs fixed-k **and** Surprise on nDCG@10. D is not supported.

## Provenance

- Remote: `github.com/yoch/frozenminisearch`
- `master` @ `e06eca31874c30071bee4cbccf4814a40bec8b5f`
- Research HEAD for these JSON files: `ace100d5beee9cd2aee72307aeb942866bd6f076`
- `results/provenance.json`, `results/skipped.json`

