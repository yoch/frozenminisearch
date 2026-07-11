# Qualification Bun (expérimental)

Harnesses isolés pour comparer Node et Bun sur le **paquet publié** (`dist/`), sans toucher aux baselines officielles ni au Makefile.

## Fichiers

| Fichier | Rôle |
|---|---|
| `consumer-smoke.mjs` | Smoke ESM/CJS/browser + codecs |
| `cross-runtime.mjs` | Matrice binaire Node↔Bun |
| `pack-consumer.sh` | `pnpm pack` + `bun add` dans un projet temporaire |
| `cpu-worker.mjs` / `peak-rss-worker.mjs` | Workers isolés (1 process = 1 mesure) |
| `run-comparison.mjs` | Orchestrateur CPU / pic RSS |
| `retained-heap-run.mjs` | Suite heap retenu (diagnostic par runtime) |
| `bun-runtime.probe.test.js` | Probe Vitest sous Bun |
| `search-cases.mjs` | Registre de cas search (synthétique + médicaments) |
| `search-phase-worker.mjs` / `search-investigation.mjs` | Baseline + phases + proxy `I` |
| `search-profile.mjs` / `search-profile-worker.mjs` | Boucles chaudes dédiées et profils CPU V8/JSC |
| `search-profile-analyze.mjs` | Agrégation des self samples par fonction |
| `search-ab.mjs` / `search-ab-worker.mjs` | Expériences internes A/B en ordre ABBA |
| `search-product-ab.mjs` / `search-product-worker.mjs` | A/B de deux builds produit, un processus par variante |
| `search-runtime-matrix.mjs` | Matrice publique Node 20/22/24 + Bun |
| `RESULTS.md` | Rapport qualification runtime |
| `SEARCH_INVESTIGATION.md` | Rapport investigation / optimisations search |

## Sorties

Écritures uniquement sous `tmp/bun-results/` (couvert par `/tmp` dans `.gitignore`).

Les A/B produit exigent deux worktrees dérivés du même commit et déjà construits.
Les lignes brutes, p50/p95/MAD, checksums structuraux et seeds bootstrap sont
conservés dans les JSON. L'ordre variante suit ABBA et toute commande enfant en
échec arrête l'orchestrateur.

## Ne pas

- Exécuter `bun install` dans le dépôt
- Écrire dans `benchmarks/baselines/`
- Traiter `bun test` natif comme gate CI
- Comparer `heapUsed` V8 vs JSC
