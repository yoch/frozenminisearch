#!/usr/bin/env bash
# Optional: build lucaong/minisearch from vendor submodule when present.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ -d "$ROOT/vendor/minisearch" ]]; then
  echo "Building vendor/minisearch submodule..."
  (cd "$ROOT/vendor/minisearch" && yarn install --frozen-lockfile && yarn build)
else
  echo "No vendor/minisearch submodule; using devDependency minisearch from node_modules."
fi
