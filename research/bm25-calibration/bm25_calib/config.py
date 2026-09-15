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
HIGH_DF_DROP_FRACTION = 0.95
TOKEN_PATTERN = r'(?u)\b\w\w+\b'

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
    'arguana',
    'trec-covid',
    'webis-touche2020',
)

RERANKER_MODEL = 'cross-encoder/ms-marco-MiniLM-L-6-v2'
TREC_DL19_QRELS = 'https://trec.nist.gov/data/deep/2019qrels-pass.txt'
TREC_DL20_QRELS = 'https://trec.nist.gov/data/deep/2020qrels-pass.txt'
TREC_DL19_QUERIES = 'https://msmarco.z22.web.core.windows.net/msmarcoranking/msmarco-test2019-queries.tsv.gz'
TREC_DL20_QUERIES = 'https://msmarco.z22.web.core.windows.net/msmarcoranking/msmarco-test2020-queries.tsv.gz'
