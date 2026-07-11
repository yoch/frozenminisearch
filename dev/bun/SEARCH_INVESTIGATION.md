# Search investigation Node / Bun

Date : 2026-07-10  
Worktree : `/tmp/minisearch-bun-experiment`  
Runtimes disponibles : Node 20.20.2, 22.23.1, 24.18.0 ; Bun 1.4.0

## Statut

Les conclusions initiales ont été invalidées par l'audit méthodologique. Le
produit revient au comportement de référence pour le seuil de gating :

- `DEFAULT_POSTING_GATE_MIN_LENGTH = 2048` (pas de promotion de 1024 sans A/B produit corrigé) ;
- `FuzzyScratch` optionnel **conservé** (API + test de correction) mais **non branché** sur le chemin query par défaut ;
- aucun autre changement produit retenu.

Les anciens résultats `gate-policy` / `finalize-only` ne constituent plus une
preuve de promotion : le premier ne comparait pas deux builds produit complets,
le troisième était un contrôle biaisé par un ordre fixe. L'absence de gain
neutre sur `fuzzy-scratch` justifie seulement de ne pas l'activer par défaut,
pas de supprimer l'API.

## Protocole corrigé

### Baseline et phases

- 57 cas : exact, prefix, fuzzy, AND/AND_NOT, stored fields, u16/u32,
  médicaments et points de bascule du gating ;
- processus isolés, CPU fixé, ordre Node/Bun et ordre Frozen/MiniSearch
  alternés ;
- batches calibrés à 20–50 ms ;
- 7 répétitions, p50/p95/MAD, ratios appariés et bootstrap déterministe ;
- lignes brutes, courbes de chauffe et checksums structuraux archivés ;
- échec immédiat si un worker, runtime ou checksum requis échoue.

Le proxy `I = (F_bun/M_bun) / (F_node/M_node)` reste un outil de triage. Un cas
n'est prioritaire que si l'IC 95 % exclut 1, si l'écart Frozen absolu dépasse
0,05 ms, si l'effet vient principalement de Frozen et si les résultats ont la
même structure.

### A/B produit

`search-product-ab.mjs` compare deux worktrees construits depuis le même
commit. Chaque mesure lance un processus frais qui importe uniquement son
propre `dist/cjs`. L'ordre des variantes suit ABBA ; les ordres runtime et cas
sont alternés.

Le seuil 1024 est testé face à 2048 sur :

- postings 1023, 1024, 1536, 2047 et 2048 ;
- gate sous, sur et juste au-dessus du ratio `1/4` ;
- ordres séquentiel et broad-first/two-phase ;
- workloads représentatifs giant vocabulary, large documents et high
  frequency.

Critères :

- gagnant neutre : gain significatif ≥5 % sur les deux runtimes, ou ≥10 % sur
  un runtime sans régression mesurable sur l'autre ;
- no-op : IC 95 % recouvrant 1 et delta absolu négligeable ;
- trade-off : gain d'un côté et régression significative >3 % et >0,05 ms de
  l'autre ;
- promotion interdite si un cas représentatif régresse significativement de
  >3 %, si les checksums diffèrent, si le pic RSS augmente de >3 % ou si le
  bundle augmente de >1 %.

### Profils CPU

`search-profile-worker.mjs` construit et chauffe un seul index, puis exécute
uniquement une boucle chaude de search pendant huit secondes, sans GC forcé.
Les profils Node et Bun sont agrégés par fonction avec
`search-profile-analyze.mjs`. Le setup reste visible dans les profileurs CLI,
mais il est rendu négligeable par la durée de la boucle chaude.

## Résultats corrigés

Les campagnes corrigées sont en cours. Les artefacts autoritatifs seront :

- `tmp/bun-results/search-investigation-baseline.json` ;
- `tmp/bun-results/search-investigation-phases.json` ;
- `tmp/bun-results/search-product-ab-gate-1024.json` ;
- `tmp/bun-results/search-product-rss-gate-1024.json` ;
- `tmp/bun-results/profiles-clean/profile-analysis.json` ;
- `tmp/bun-results/search-runtime-matrix.json`.

Le comparatif de bundle 2048/1024 est déjà strictement identique :

- ESM : 196 171 octets des deux côtés ;
- CJS : 196 455 octets des deux côtés ;
- browser : 63 011 octets des deux côtés.

## Validation

Les affirmations antérieures de validation Node 20/22/24 sont retirées : les
commandes avaient échoué avec `pnpm: command not found`, puis l'erreur avait été
masquée. La nouvelle validation est fail-fast et doit exécuter réellement :

- tests, browser, benchmarks, typecheck, lint et build ;
- matrice search Node 20/22/24 + Bun ;
- compatibilité binaire Node↔Bun ;
- pic RSS OS et taille des bundles.

## Décision de promotion

**Ne pas promouvoir `minLength=1024`** sans campagne A/B produit courte et
corrigée. **Garder `FuzzyScratch` comme API optionnelle** (testée), sans
l'activer dans `queryEngine`.

## Reproduction

```bash
cd /tmp/minisearch-bun-experiment
pnpm build
export BUN_BIN="$HOME/.bun/bin/bun"

node dev/bun/search-product-ab.mjs \
  --baseline-root=/tmp/minisearch-bun-experiment \
  --treatment-root=/tmp/minisearch-gate-1024 \
  --reps=15

node --import tsx dev/bun/search-investigation.mjs \
  --phase=baseline --reps=7

node --import tsx dev/bun/search-investigation.mjs \
  --phase=phases --reps=7

node dev/bun/search-profile.mjs
node dev/bun/search-profile-analyze.mjs
```
