# PoC tooling notes

`dev/poc-*` directories are retained as exploratory fixtures and are not part of
the package build, public bundle, or CI test contract. Some nested PoC packages
carry their own package-manager metadata, so commands that shell out through
`pnpm exec` can print workspace-style warnings about nested `resolutions` or
`pnpm.overrides` fields.

Treat those warnings as PoC noise unless the command exits non-zero or reports a
root package issue. The product source graph remains governed by the root
`knip.json`, `Makefile`, and public bundle boundary scripts.
