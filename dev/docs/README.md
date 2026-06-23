# Design Notes (developers)

Reference documents for internal mechanisms — **not** included in the public npm API.

| Document | Topic |
|----------|--------|
| [FREQ_ADAPTIVE_RECAP.md](./FREQ_ADAPTIVE_RECAP.md) | Adaptive u8/u16 width for `allFreqs`, BM25 parity, wire flags |
| [AND_GATE_PARAMETERS.md](./AND_GATE_PARAMETERS.md) | AND / AND_NOT gating heuristics (`queryEngineGateLimits.ts`) |

These files are the **versioned source**. `pnpm docs:build` also copies their content into `docs/media/` for the TypeDoc site (generated locally, gitignored).
