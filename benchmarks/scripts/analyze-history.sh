#!/usr/bin/env bash
exec node "$(dirname "$0")/analyze-history.mjs" "$@"
