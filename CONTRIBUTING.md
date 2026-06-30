# Contributing to `@yoch/frozenminisearch`

Thank you for helping improve this package. Issues and pull requests are welcome on [github.com/yoch/frozenminisearch](https://github.com/yoch/frozenminisearch).

## Development setup

```bash
pnpm install
pnpm test       # src/ unit tests + dev/parity/ vs MiniSearch
pnpm test:fuzzysearch  # long fuzzy-sweep parity (dev/internal/; also CI nightly)
pnpm test:benchmarks   # benchmarks/*.test (not part of pnpm test)
pnpm build
node scripts/verify-npm-pack.cjs
```

Optional upstream clone for local reference builds:

```bash
git submodule update --init vendor/minisearch
./dev/scripts/build-reference-minisearch.sh
```

Parity expectations are documented in [`dev/parity/PARITY_CONTRACT.md`](dev/parity/PARITY_CONTRACT.md).

## Documentation / GitHub Pages

- **Verify** (PR or push `master` touching doc sources): workflow [Docs](https://github.com/yoch/frozenminisearch/actions/workflows/docs.yml) runs `pnpm docs:build` only.
- **Publish** (https://yoch.github.io/frozenminisearch/): push a release tag `vX.Y.Z` — the site header shows `@yoch/frozenminisearch vX.Y.Z`.
- Do not commit generated `docs/` HTML. GitHub Pages is built from the tagged commit.

Follow the full release runbook in [`RELEASE.md`](RELEASE.md). Manual docs redeploys are allowed from Actions → Docs → Run workflow, but release tags are the source of truth for published documentation.

## Benchmarks

```bash
pnpm bench              # quick smoke (dev profile, 1 run × 10 iterations)
pnpm bench:run          # full suite: frozen vs MiniSearch (regression profile)
pnpm bench:record       # capture benchmarks/baselines/latest.json
pnpm bench:diff         # diff latest.json vs reference.json (run record first)
```

For the `vs-reference` profile (reference corpus, e.g. before refreshing `reference.json`):

```bash
NODE_OPTIONS='--expose-gc' node benchmarks/framework/cli.mjs run --profile=vs-reference
```

See [`benchmarks/README.md`](benchmarks/README.md) and [`benchmarks/SCRIPTS.md`](benchmarks/SCRIPTS.md).

**Bench tooling moratorium (active):** do not add bench scripts, top-level `bench:*` / `benchmark:*` aliases, or versioned baselines without a documented exception. See [`PLAN_MORATOIRE_BENCH.md`](PLAN_MORATOIRE_BENCH.md).

## Pull requests

- Keep changes focused; match existing TypeScript style (`pnpm lint`).
- Update [`CHANGELOG.md`](CHANGELOG.md) for user-visible changes.
- Functional parity regressions must pass `dev/parity/`.

## Upstream MiniSearch

Search behaviour is derived from [MiniSearch](https://github.com/lucaong/minisearch) (MIT). For bugs in the **mutable** API, consider reporting upstream; for frozen-specific issues, open an issue here.
