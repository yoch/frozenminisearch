# Risk map — indexing & parity fast paths

| Risk | Severity | Detection | Notes |
|------|----------|-----------|-------|
| `isDefaultTokenize` fast path | **High** | [`indexing-parity.test.js`](indexing-parity.test.js) profile `camelCase` / `vocs`; [`indexingCore.test.js`](../../src/indexingCore.test.js) | Reference equality only — no split-equivalent heuristic |
| `fromDocuments` vs upstream index | **High** | [`indexing-parity.test.js`](indexing-parity.test.js) + [`indexFingerprint.js`](../../testSupport/indexFingerprint.js) | Catches missing terms before score drift |
| `functional-parity` snapshot-only blind spot | **High** | Addressed by indexing gate above | `fromMiniSearch` skips native tokenizer path |
| Field length vs `processTerm` | Medium | indexing profile `processTerm` | Fixed: raw unique token count (MiniSearch semantics) |
| Float32 `avgFieldLength` | Low | `toBeCloseTo` in fingerprint helper | Documented acceptable drift |
| Freq clamp 65535 | Low | overflow tests in functional-parity | Documented acceptable drift |
| AND-gate internals | Low | [`queryEngine.gate.test.js`](queryEngine.gate.test.js) | Frozen gated vs naive only |
| HMR `discard`/`add` incremental | Out of scope | — | Vocs dev friction; no upstream oracle |
| Browser dist smoke | Low | [`FrozenMiniSearchBrowser.test.js`](../../src/FrozenMiniSearchBrowser.test.js), [`dev/browser/browser.smoke.test.js`](../browser/browser.smoke.test.js) | CI runs `pnpm test:browser` after build (`.github/workflows/main.yml`); optional local PoC in `dev/poc-vocs/` |

## Coverage audit (manual)

`lcov.info` is aggregated — use it to spot **uncovered** lines, not to assert per-test branch ownership.

```bash
pnpm jest dev/parity/indexing-parity.test.js --coverage \
  --collectCoverageFrom='src/indexingCore.ts' \
  --collectCoverageFrom='src/frozenBuild.ts'
```

Codecov PR diffs flag new branches without tests.
