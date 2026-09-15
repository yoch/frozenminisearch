"""Study-wide constants. Do not tune these against evaluation folds."""

from __future__ import annotations

SEED = 20260915
K1 = 1.2
B = 0.75
DELTA = 0.0
PRIMARY_K = 100
KS = (50, 100, 200)
ALPHAS = (0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5)
OUTER_FOLDS = 5
INNER_FOLDS = 4
BOOTSTRAP_RESAMPLES = 10_000
NONINFERIORITY = (-0.005, -0.01)
Z_FULL_TERM_CAP = 12
# Factorized tail / MGF uses the highest-IDF query terms only. Retrieval still
# scores every unique query term. This is an explicit approximation, not a claim
# that the remaining terms have measure zero.
NULL_TAIL_TERM_CAP = 16
NULL_MC_TERM_CAP = 8
NULL_MC_DRAWS = 250
HIGH_DF_DROP_FRACTION = 0.95
TOKEN_PATTERN = r'(?u)\b\w\w+\b'
# Full corpus always. If a collection has more queries than this, draw a
# seeded subset and keep every document. Results on a capped set are labeled
# in metadata and are not the official full-query BEIR split.
MAX_QUERIES = 400

BEIR_BASE = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets'
BEIR_DATASETS = (
    'scifact',
    'nfcorpus',
    'fiqa',
    'arguana',
    'trec-covid',
    'scidocs',
    'webis-touche2020',
    'quora',
    'cqadupstack',
    'fever',
    'climate-fever',
    'dbpedia-entity',
    'nq',
    'hotpotqa',
    'msmarco',
)

# Phase A prefers diversity over size. Large wiki/web dumps are attempted
# after the cheap collections; failures must be recorded, not dropped silently.
PHASE_A_ORDER = (
    'scifact',
    'nfcorpus',
    'fiqa',
    'arguana',
    'scidocs',
    'trec-covid',
    'webis-touche2020',
    'quora',
    'cqadupstack',
    'fever',
    'climate-fever',
    'dbpedia-entity',
    'nq',
    'hotpotqa',
    'msmarco',
)

PHASE_B_DATASETS = (
    'scifact',
    'nfcorpus',
    'fiqa',
    'trec-covid',
    'webis-touche2020',
)

# Skip expensive *methods*, not large collections. Large collections keep
# every document and subsample queries to MAX_QUERIES.
SKIPPED_METHODS = (
    {
        'id': 'saddlepoint_lugannani_rice',
        'reason': 'per-query posting MGF + Newton is too slow on long queries (ArguAna hung)',
    },
    {
        'id': 'chernoff_mgf',
        'reason': 'same MGF cost as saddlepoint',
    },
    {
        'id': 'independence_mc_tail',
        'reason': 'sampling all term postings per query is too slow',
    },
    {
        'id': 'exact_convolution',
        'reason': 'intractable except on tiny synthetic indexes',
    },
    {
        'id': 'pairwise_covariance_z_full',
        'reason': 'O(T^2) posting intersections; skipped in the cheap path',
    },
    {
        'id': 'supervised_rlt_choppy_attncut',
        'reason': 'reproduction cost; Meng 2024 already vs fixed-k',
    },
    {
        'id': 'cosine_tmp_adapters',
        'reason': 'trained methods, out of scope for a training-free index null',
    },
)

SKIPPED_DATASETS = (
    'trec-dl-2019',
    'trec-dl-2020',
)
SKIPPED_DATASET_REASONS = {
    'trec-dl-2019': 'needs the full MS MARCO passage corpus; revisit when that dump is local',
    'trec-dl-2020': 'needs the full MS MARCO passage corpus; revisit when that dump is local',
}

PHASE_B_SKIP = (
    'arguana',  # document-length queries; MiniLM@512 on top-100 is too costly on CPU
)

RERANKER_MODEL = 'cross-encoder/ms-marco-MiniLM-L-6-v2'
TREC_DL19_QRELS = 'https://trec.nist.gov/data/deep/2019qrels-pass.txt'
TREC_DL20_QRELS = 'https://trec.nist.gov/data/deep/2020qrels-pass.txt'
TREC_DL19_QUERIES = 'https://msmarco.z22.web.core.windows.net/msmarcoranking/msmarco-test2019-queries.tsv.gz'
TREC_DL20_QUERIES = 'https://msmarco.z22.web.core.windows.net/msmarcoranking/msmarco-test2020-queries.tsv.gz'
