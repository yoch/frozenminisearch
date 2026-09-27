# Repository Guidelines

## Project Structure & Module Organization

Core TypeScript sources live in `src/`. Public exports start at `src/index.ts` and `src/FrozenMiniSearch.ts`; binary snapshot code is split between `src/binary*.ts` and `src/msv5/`; packed radix internals are in `src/PackedRadixTree/`. SearchableMap parity now uses upstream MiniSearch adapters under `testSupport/`, not an in-tree runtime fork. Unit tests sit beside sources as `*.test.js` or `*.test.ts`. Parity tests against upstream MiniSearch are under `dev/parity/`, longer internal sweeps under `dev/internal/`, shared test helpers under `testSupport/`, examples under `examples/`, and performance tooling plus baselines under `benchmarks/`. Generated outputs such as `dist/`, `coverage/`, and `docs/` should not be hand-edited.

## Build, Test, and Development Commands

Use Node `>=20`. Install with `pnpm install` to match the checked-in `pnpm-lock.yaml`.

All `package.json` scripts are thin aliases to a `Makefile` target (`make <target>`). Run `make help` for a quick overview. The Makefile centralises prerequisites (build, `--expose-gc`, `NODE_ENV=production`) that scripts previously duplicated as `pnpm build &&` prefixes. See [`benchmarks/SCRIPTS.md`](benchmarks/SCRIPTS.md) for the boundary between the profiled `bench:*` interface (via `benchmarks/framework/cli.mjs`) and the low-level `benchmark:*` interface (direct access to `*.js`).

- `pnpm test` (`make test`): runs vitest tests in `src/`, `dev/`, and `benchmarks/`.
- `pnpm test:fuzzysearch` (`make test-fuzzysearch`): runs long fuzzy parity sweeps from `dev/internal/`.
- `pnpm test:benchmarks` (`make test-benchmarks`): runs benchmark test files, separate from normal CI tests.
- `pnpm coverage` (`make coverage`): runs vitest coverage for `src/`, `dev/parity/`, and `dev/browser/` (requires `make build` for the browser bundle smoke).
- `pnpm lint` / `pnpm lint:fix` (`make lint` / `make lint-fix`): checks or fixes ESLint style issues in `src/`.
- `pnpm build` (`make build`): cleans `dist/`, builds ESM/CJS bundles with Rollup, and patches CJS output.
- `make bench`: quick local performance check (`cli.mjs run --profile=dev --quick`).
- `node scripts/verify-npm-pack.cjs`: validates package contents before publishing.

Build freshness is tracked by the real file `dist/es/index.js`. Make rebuilds automatically only when that file is absent; after editing `src/*.ts`, run `make build` explicitly to refresh `dist/`.

## Coding Style & Naming Conventions

This repo uses TypeScript/ES modules with neostandard plus `@stylistic/eslint-plugin`. Use 2-space indentation, single quotes, no semicolons, and 1TBS braces. Prefer explicit, domain-oriented names such as `binaryMsv5Encode`, `PackedRadixTree`, and `frozenPostings`. Keep tests named after the unit they cover, for example `src/binaryFormat.test.js`.

## Testing Guidelines

Add or update colocated vitest tests for behavior changes. For search semantics, include parity coverage in `dev/parity/` when behavior should match MiniSearch 7. For binary formats, test round trips and boundary cases, especially typed-array widths, doc id limits, and stored-field layouts. Run `pnpm test` before PRs; add targeted benchmark runs when changing postings, query execution, or binary encoding.

## Commit & Pull Request Guidelines

Recent commits use concise imperative subjects, for example `Fix lint failures blocking CI.` and `Add toJSON export and deprecate fromJson alias.` Keep commits focused and mention user-visible changes in `CHANGELOG.md`. PRs should describe the change, list tests or benchmarks run, link related issues, and call out compatibility, binary format, or parity impacts. Do not commit generated `docs/` HTML; published docs are produced by the release/docs workflows.

## Cursor Cloud specific instructions

Cloud Agent `install` puts the latest Node.js Current and Bun on `/usr/local/bin` (`/usr/local/bin/node`, `/usr/local/bin/bun`) and installs CPU/memory profilers: `strace`, `ltrace`, `perf`, `valgrind`, `heaptrack`, `bpftrace`, `gdb`, and `elfutils` (`eu-stack`). Dependencies stay on the pinned pnpm from `packageManager` via `pnpm install --frozen-lockfile`.

The agent PATH lists `/exec-daemon` before `/usr/local/bin`, so a bare `node` can be the older agent binary. Export `PATH="/usr/local/bin:$PATH"` before `pnpm lint`, `pnpm test`, `pnpm build`, and profiling. There is no dev server. Hello-world is `FrozenMiniSearch.fromDocuments`, `search` / `autoSuggest`, then `saveBinarySync` / `loadBinarySync`. The browser bundle check is `make test-browser` after `pnpm build`.

`/usr/bin/perf` refuses to start when Ubuntu's `linux-tools` package does not match `uname -r`. Install links the packaged `perf` binary at `/usr/local/bin/perf`. This VM does not expose hardware counters (`cycles`, `instructions`) or kernel BTF, so `bpftrace` cannot attach. Use `perf stat` for software counters, `node --cpu-prof` or `valgrind --tool=callgrind` for CPU, and `node --heap-prof`, `heaptrack`, or `valgrind --tool=massif` for memory. `strace -c` and `ltrace -c` remain available.
