# AND / AND_NOT gating parameters

Internal document (not exposed in the public API). Constants live in `src/queryEngineGateLimits.ts` and are consumed by `src/queryEngine.ts`.

## Behavior

For a combined `AND` query (or `AND_NOT` on the negative branch), the engine evaluates branches in order. After branch *i − 1*, the set of matching `docId`s forms the **gate** passed to branch *i*:

- **Selective gate**: only documents in the gate (`allowedDocs`) are scored for branch *i*. Same score semantics as the naive path (score then intersect), but less work.
- **Non-selective gate**: falls back to full scoring of branch *i*, then `combineResults` — equivalent to the no-gating path (validated by `dev/parity/queryEngine.gate.test.js`).

The empty gate is always treated as selective (useful short-circuit for AND+prefix with no match on the first branch).

## Formula

For an index of `N` documents:

```text
maxGateSize = min(maxAbsolute, max(100, floor(N × maxFraction)))
```

A gate of size `G` is **selective** if `G === 0`, if `G ≤ maxGateSize`, or if the [posting ratio](#posting-ratio) passes for the next branch.

When `G > maxGateSize`, the max posting length (exact + prefix + fuzzy) is estimated for the ratio. On the absolute path (`G ≤ maxGateSize`), this estimation is **not** repeated: selectivity is already determined by `G ≤ maxGateSize` (avoids an expensive fuzzy/prefix walk before each AND branch, e.g. Divina AND+fuzzy).

The selective gate is **always** passed as `allowedDocs` to the next branch. Do not condition this pass on `postingListLength > G`: on a common exact AND (e.g. `inferno paradiso`, 0 results), the `allowedDocs.has` filter avoids scoring docs outside the gate — removing the gate in this case costs more than it saves.

| Parameter | Current value | Role |
|-----------|-----------------|------|
| `maxAbsolute` | `5000` | Absolute cap: beyond this, gate filtering is not worth the cost of managing a large `Set` + partial scoring. |
| `maxFraction` | `0.1` | Relative cap: on a large corpus, a gate covering more than 10 % of docs is treated as "too wide." |
| Floor `100` | hardcoded | On small indexes, prevents a ridiculously low `maxGateSize` (e.g. 30 docs → gate max 100). |

**Defaults**: `maxAbsolute = 5000`, `maxFraction = 0.1` (`DEFAULT_AND_GATE_LIMITS`).

## Posting ratio

When the gate exceeds `maxGateSize` but remains **small relative to the posting** of the next branch, gating stays active (`allowedDocs` passed to the branch). Empirical calibration (script `benchmark:gate-posting-ratio`, not CI):

| Parameter | Value | Role |
|-----------|--------|------|
| `minLength` | `2048` | Posting too short → no ratio (avoids noise on small lists) |
| `ratioShift` | `2` | Gate OK if `G ≤ postingLength >>> 2` (max **25 %** of the posting) |

Helper: `passGateByPostingRatio` in `queryEngineGateLimits.ts`, integrated into `gateIsSelectiveEnough` when `estimateMaxPostingLengthForQuery` provides the max posting length of the branch (ratio path only).

**Examples**:

| Case | gate | posting | Ratio | Abs OK ? | Ratio OK ? |
|-----|------|---------|-------|----------|------------|
| giant AND+prefix branch 2 | 11 111 | 50 000 | 22 % | no | **yes** → seek + filtered scan |
| highFrequency AND | 10 000 | 10 000 | 100 % | no | no |
| parity 6000-doc alpha∧beta | ~6000 | ~6000 | ~100 % | no | no |

**Seek scoring** (`shouldSeekAllowedDocs` in `compactPostings.ts`) reuses the **same numeric thresholds** once `allowedDocs` is active: distinct decision (sequential scan vs binary search), not the same business function.

**Posting estimation**: `forEachQuerySpecTermRef` / `estimateMaxPostingLengthForQuery` — only when `G > maxGateSize` (ratio path). Do not estimate on the absolute path (`G ≤ maxGateSize`). The broad-first uses a separate estimator, `estimateCheapTwoPhasePostingLength*`, which rejects prefix/fuzzy specs to avoid an expensive upfront walk.

## Broad-first (exact-only, v1.2.3)

When all specs of a normalized query string have a cheap upfront estimate (currently: exact-only, no `prefix` or `fuzzy`), the engine can take a **two-phase** path before sequential gating:

- **AND** — if the 1st branch has a posting ≥ `minLength` (2048) and a later branch has a posting ≤ `firstPosting >>> ratioShift`, collect doc ids by increasing posting length, then score in query order with the final gate.
- **AND_NOT** — if the positive branch is "wide" (≥ max(2048, 50 % of N)) and a negative branch is too, first collect exclusions, then score the positive branch on survivors.

The two-phase estimator returns `undefined` for prefix/fuzzy (no expensive upfront estimate). Parity: `dev/parity/queryEngine.gate.test.js` (cases `common unique1`, prefix/fuzzy broad-first probe, nested AND, empty AND_NOT).

## Why these values

1. **Small gates (synthetic + Divina)** — e.g. AND `bucket5` then `shared` on 2 000 docs: gate ≈ 200, `maxGate` ≈ 200 → gating active, net gain vs naive (fewer postings scored on the 2nd branch).
2. **Large gates** — e.g. AND `alpha` then `beta` on 3 000 docs: gate = 3 000, `maxGate` = 300 → gating disabled; the naive path is already acceptable and avoids the overhead of an ineffective filter.
3. **Real corpora like Divina** — AND `inferno paradiso`: gate very small (~a few docs) → always selective with defaults.
4. **Absolute cap 5000** — Protects indexes with very large `N`: an 8 000 doc gate should not trigger a "selective" traversal that remains massive.

The thresholds are not exposed in the API: they are performance heuristics, not semantic guarantees (semantics remain those of naive combine when gating is off).

## AND branch order (performance)

The gate after branch 0 is `|branch 0 result|`. **Put the most selective term first** in the query (e.g. `bucket5 shared`, not `shared bucket5`). Wrong order is semantically correct but the gate stays large and gating does not activate — more postings scored on later branches.

**Iterative AND** (default when prefix/fuzzy is present, or when broad-first does not apply): branch 0 is always scored in full before the gate narrows branch 1. There is no automatic reordering by posting length on this path.

**Two-phase AND** (exact-only specs, see [Broad-first](#broad-first-exact-only-v123)): branches are collected by increasing posting length before scoring. This path does not apply to prefix/fuzzy queries.

## Tuning and validation

- Ratio calibration script: `pnpm benchmark:gate-posting-ratio` (`benchmarks/scripts/calibrate-gate-posting-ratio.mjs`).
- Optional script: `benchmarks/and-gate-tuning.mjs` (`pnpm benchmark:and-gate-tuning`).
- Oracle tests: `dev/parity/queryEngine.gate.test.js` (gated vs naive path comparison via `dev/parity/queryEngineHarness.js`).
- Perf regression suite: `pnpm benchmark:record` then `benchmark:diff` vs `benchmarks/baselines/reference.json` (**warm** measurement).

Do not change defaults without re-running the tuning and, if gains are intentional, updating `reference.json`.
