# FrozenMiniSearch benchmarks

Reproducible memory and CPU measurements for regression tracking.

**Commit-by-commit history:** [`perf-history.jsonl`](perf-history.jsonl) + [`scripts/README.md`](scripts/README.md) (record after each commit, analyze frozen vs mutable).

## Commands

| Command | Description |
|---------|-------------|
| `yarn benchmark:compare` | Human-readable report (runs suite; default 3×50 search iters) |
| `yarn benchmark:compare --from baselines/latest.json` | Same report from saved JSON (no re-run) |
| `yarn benchmark:record` | Run suite → `baselines/latest.json` |
| `yarn benchmark:diff` | `latest.json` vs `reference.json` (no re-run) |
| `yarn benchmark:diff:run` | Re-run suite, update `latest.json`, then diff |
| `yarn benchmark:targeted` | Run failure-prone scenarios only → stdout or `--out file.json` |
| `yarn benchmark:targeted:compare` | Compare two targeted captures; fails only if **after** regresses vs **before** |
| `yarn benchmark:baseline:update` | `record` + copy to `reference.json` |
| `yarn benchmark:binary-format` | MSv5 vs MSv4/MSv3 size + save/load on benchmark corpora (no baseline file) |
| `benchmarks/scripts/record-history.sh` | Append HEAD → `perf-history.jsonl` (clean tree) |
| `benchmarks/scripts/analyze-history.sh` | Timeline, compare, CHANGELOG snippets, vs mutable |

Always run with GC exposed:

```bash
NODE_ENV=production node --expose-gc benchmarks/compare.js
```

### Packed radix fuzzy (algo isolé)

Compare `SearchableMap#fuzzyGet` vs `PackedRadixTree#fuzzyEntries` avec **chrono entrelacée** (un variant par round : map, packed, map, …) — médiane après warmup, pour limiter le biais GC/thermique.

```bash
yarn benchmark:packed-fuzzy              # défaut : scale + 3 synth + 2 BDPM (~1 min)
yarn benchmark:packed-fuzzy -- --quick   # smoke : scale + bdpm-presentations
yarn benchmark:packed-fuzzy -- --full    # tout : 5 synth + 7 médicaments + Divina
```

Le smoke CPU de `yarn benchmark:packed-radix` inclut aussi `fuzzy(query,k)` sur le corpus `scale` (k=1,2).

### emitSubtree / prefix iteration (production DFS)

Mesure `entries()` et `prefixEntries()` sur corpora synthétiques + BDPM, avec préfixes à fort fan-out découverts automatiquement :

```bash
yarn benchmark:packed-emit
yarn benchmark:packed-emit -- --baseline   # → benchmarks/baselines/packed-emit-latest.json
```

Profiling CPU :

```bash
npm run build-packed-radix-bench
node --cpu-prof --expose-gc benchmarks/dist/packedRadixEmitSubtree.cjs
```

### Index BDPM / vétérinaire (fixtures réelles)

Snapshots MSv5 copiés dans [`fixtures/medicaments-indexes/`](fixtures/medicaments-indexes/) (présentations, spécialités, compositions, etc.). Chargés via `decodeFrozenSnapshotMsv5` — même arbre packed qu’en production.

```bash
yarn benchmark:packed-fuzzy    # inclut l’analyse + map vs packed sur ces index
yarn benchmark:packed-radix    # bytes + smoke CPU sur presentations & specialites
```

### Fuzzy sweep (~6k–8k requêtes variées)

Termes **existants** de l’index, typos (sub/del/ins × début/milieu/fin), mutations à 2 edits, chaque paire testée avec `k=1,2,3` quand pertinent. Par requête : médiane de **5** exécutions (défaut), puis médiane / moyenne / p95 sur tout l’échantillon.

Défauts : **~10k** requêtes chronométrées, **~1k** préchauffage (échantillon de termes distinct, seed différent).

```bash
yarn benchmark:packed-fuzzy-sweep
QUERIES=10000 WARMUP=1000 ITERS=5 CORPUS=bdpm-presentations yarn benchmark:packed-fuzzy-sweep
NO_DOUBLE_EDITS=1 QUERIES=6000 yarn benchmark:packed-fuzzy-sweep   # 9 mutations simples seulement
```

`CORPUS` : `bdpm-presentations` (défaut), `bdpm-specialites`, `divina`, etc.

`yarn benchmark:*` scripts run `yarn build` then `node --expose-gc` automatically.

## Defaults (routine)

- **3 runs** per scenario (median aggregation)
- **50 timed searches** per query (`--iterations` to override)
- Override via env: `RUNS=2 SEARCH_ITERATIONS=30 yarn benchmark:record`

`benchmark:diff` does **not** re-run the suite: record once, diff as often as needed.
Compare another capture: `yarn benchmark:diff --current=path/to/run.json`.

Force a fresh measurement: `yarn benchmark:diff:run` (writes `latest.json` then diffs).

## What to watch when optimizing FrozenMiniSearch

When implementing changes from [README — suggested optimizations](../README.md#suggested-follow-ups-not-implemented-yet), compare at least:

- `indexing.freezeMs`, `indexing.saveBinaryMs`, `loadMs.binary`
- `heapMb.frozen`, `heapMb.frozenVsMutableSavingPct`
- Search p50/p95 on prefix and fuzzy scenarios (noisy; use median over `--runs 3`)

Update `baselines/reference.json` only after intentional wins: `yarn benchmark:baseline:update`.

## Files

- `benchmarkSuite.js` — shared metrics JSON (mutable + frozen on each scenario)
- `benchmarkScenarios.js` — extreme synthetic corpora
- `perf-history.jsonl` — **versioned timeline** (one JSON line per clean commit)
- `scripts/` — `record-history`, `analyze-history`, `backfill-history`, post-commit sample
- `baselines/reference.json` — **versioned golden** baseline for `benchmark:diff`
- `baselines/latest.json` — last local run (gitignored)

## Optimization workflow

1. Change code
2. `yarn benchmark:record` then `yarn benchmark:diff` — regressions vs reference
3. Commit; `benchmarks/scripts/record-history.sh` (uses same defaults)
4. `benchmarks/scripts/analyze-history.sh --changelog` — update CHANGELOG if significant
5. If gains are intentional: `yarn benchmark:baseline:update` and commit `reference.json` + `perf-history.jsonl`

## Recorded metrics (per scenario)

- **Frozen vs mutable MiniSearch** on the same corpus: heap, search p50/p95 per query,
  `frozenP50VsMutablePct`, `scoreDrift` on overflow frequencies
- Isolated heap: mutable, frozen, loadJSON, loadBinary
- Build heap: `addAll` + `freeze` vs `fromDocuments`
- Indexing time: addAll, freeze, fromDocuments, saveBinary
- Disk size: JSON vs MSv3/MSv4 binary
- `memoryBreakdown`: typed postings, radix tree, stored fields
- Search: p50/p95 per query
- `scoreDrift`: mutable vs frozen score delta on **overflow frequencies** (>255 occurrences of the same term)

## `benchmark:diff` thresholds (regression)

**Fail (exit code 1)** — structural metrics:

- Frozen heap: +10%
- Heap saving % vs mutable: −10 points
- loadBinary: +20%

**Warning only** — search p50 (noisy across runs). Add `--strict` to treat search regressions as failures.

Comparing two local captures (`latest` vs `reference` from different moments) may show search warns without a real regression.

### Targeted before/after (code change on same commit)

For noisy extreme scenarios, compare two captures without treating stale `reference.json` as the gate:

```bash
# on baseline tree (e.g. git stash / detached HEAD)
yarn benchmark:targeted --label before --out /tmp/targeted-before.json
# on candidate tree
yarn benchmark:targeted --label after --out /tmp/targeted-after.json
yarn benchmark:targeted:compare --compare=/tmp/targeted-before.json,/tmp/targeted-after.json
# optional context only (does not affect exit code):
yarn benchmark:targeted:compare --compare=/tmp/targeted-before.json,/tmp/targeted-after.json --reference=benchmarks/baselines/reference.json
```

Exit code 1 only when **after** is worse than **before** on freeze / saveBinary / loadBinary.

- Baseline ≥ 10 ms: % thresholds from `regressionPolicy.js` (freeze +40 %, saveBinary +30 %, loadBinary +20 %).
- Baseline &lt; 10 ms: **both** absolute (+2 ms warn, +5 ms fail) **and** % cap (+20 % warn, +35 % fail when base ≥ 0.5 ms), since either alone is too loose on tiny timings.

All structural timing rules live in `benchmarks/regressionPolicy.js` (shared by `benchmark:diff` and `benchmark:targeted:compare`).
