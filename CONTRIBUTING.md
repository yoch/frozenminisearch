# Contributing to `@yoch/frozenminisearch`

Thank you for helping improve this package. Issues and pull requests are welcome on [github.com/yoch/frozenminisearch](https://github.com/yoch/frozenminisearch).

## Development setup

```bash
yarn install
yarn test       # src/ unit tests + dev/parity/ vs MiniSearch
yarn test:fuzzysearch  # long fuzzy-sweep parity (dev/internal/; also CI nightly)
yarn test:benchmarks   # benchmarks/*.test (not part of yarn test)
yarn build
node scripts/verify-npm-pack.cjs
```

Optional upstream clone for local reference builds:

```bash
git submodule update --init vendor/minisearch
./dev/scripts/build-reference-minisearch.sh
```

Parity expectations are documented in [`dev/parity/PARITY_CONTRACT.md`](dev/parity/PARITY_CONTRACT.md).

## Documentation / GitHub Pages

- **Verify** (PR or push `master` touching doc sources): workflow [Docs](https://github.com/yoch/frozenminisearch/actions/workflows/docs.yml) runs `yarn build-docs` only.
- **Publish** (https://yoch.github.io/frozenminisearch/): push a release tag `vX.Y.Z` — the site header shows `@yoch/frozenminisearch vX.Y.Z`.
- Do not commit generated `docs/` HTML. GitHub Pages is built from the tagged commit.

Follow the full release runbook in [`RELEASE.md`](RELEASE.md). Manual docs redeploys are allowed from Actions → Docs → Run workflow, but release tags are the source of truth for published documentation.

## Benchmarks

```bash
npm run bench -- run --profile=dev --quick
npm run bench -- run --profile=vs-reference
```

See [`benchmarks/README.md`](benchmarks/README.md).

## Pull requests

- Keep changes focused; match existing TypeScript style (`yarn lint`).
- Update [`CHANGELOG.md`](CHANGELOG.md) for user-visible changes.
- Functional parity regressions must pass `dev/parity/`.

## Upstream MiniSearch

Search behaviour is derived from [MiniSearch](https://github.com/lucaong/minisearch) (MIT). For bugs in the **mutable** API, consider reporting upstream; for frozen-specific issues, open an issue here.
