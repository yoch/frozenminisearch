# Benchmarks FrozenMiniSearch

Mesures reproductibles pour suivre les optimisations mémoire/CPU.

## Commandes

| Commande | Description |
|----------|-------------|
| `yarn benchmark:compare` | Rapport lisible dans le terminal (6 scénarios) |
| `yarn benchmark:record` | Exécute la suite → `baselines/latest.json` |
| `yarn benchmark:diff` | Run actuel vs `baselines/reference.json` (seuils warn/fail) |
| `yarn benchmark:diff --latest` | `latest.json` vs `reference.json` (sans re-run) |
| `yarn benchmark:baseline:update` | `record` + copie vers `reference.json` |

Toujours avec GC exposé :

```bash
NODE_ENV=production node --expose-gc benchmarks/compare.js
```

Les scripts `yarn benchmark:*` lancent `yarn build` puis `node --expose-gc` automatiquement.

## Multi-run (optionnel)

Pour réduire la variabilité, ajoute `--runs N` :

```bash
yarn benchmark:compare --runs 3
yarn benchmark:record --runs 3
yarn benchmark:diff --runs 3
```

Les métriques sont agrégées via **médiane** par scénario.
`--runs` est ignoré avec `benchmark:diff --latest` (pas de re-run).

## Fichiers

- `benchmarkSuite.js` — logique commune (métriques JSON)
- `benchmarkScenarios.js` — corpus synthétiques extrêmes
- `baselines/reference.json` — **référence versionnée** (golden)
- `baselines/latest.json` — dernier run local (gitignored)

## Workflow optimisation

1. Modifier le code
2. `yarn benchmark:diff` — détecter régressions vs référence
3. Si gains intentionnels : `yarn benchmark:baseline:update` et committer `reference.json`

## Métriques enregistrées (par scénario)

- Heap isolé : mutable, frozen, loadJSON, loadBinary
- Indexing : addAll, freeze, saveBinary
- Disque : JSON vs binaire MSv2
- `memoryBreakdown` : postings typés, radix tree, stored fields
- Search : p50/p95 par requête
- `scoreDrift` : écart de score mutable vs frozen pour le scénario
  **overflow frequencies** (>255 occurrences du même terme)

## Seuils `benchmark:diff` (régression)

**Échec (exit code 1)** — métriques structurelles :

- Heap frozen : +10 %
- Gain % heap vs mutable : −10 points
- loadBinary : +20 %

**Avertissement seulement** — search p50 (bruit de mesure entre runs). Ajouter `--strict` pour inclure la recherche dans les échecs.

Comparer deux runs locaux (`latest` vs `reference` capturés à des moments différents) peut afficher des warns search sans régression réelle.
