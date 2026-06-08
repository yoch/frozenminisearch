# Contributing to `@yoch/frozenminisearch`

Thank you for helping improve this package. Issues and pull requests are welcome on [github.com/yoch/frozenminisearch](https://github.com/yoch/frozenminisearch).

## Development setup

```bash
yarn install
yarn test       # src/ unit tests + dev/parity/ vs MiniSearch
yarn test:fuzzysearch  # long fuzzy-sweep parity (dev/internal/; also CI nightly)
yarn build
node scripts/verify-npm-pack.cjs
```

Optional upstream clone for local reference builds:

```bash
git submodule update --init vendor/minisearch
./dev/scripts/build-reference-minisearch.sh
```

Parity expectations are documented in [`dev/parity/PARITY_CONTRACT.md`](dev/parity/PARITY_CONTRACT.md).

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
