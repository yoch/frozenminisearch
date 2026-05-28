# Scripts de suivi des performances

Historique versionné : [`../perf-history.jsonl`](../perf-history.jsonl) (une ligne JSON par commit enregistré).

## Après chaque commit important

```bash
# 1. Committer d'abord (arbre propre côté fichiers suivis)
git commit -m "..."

# 2. Enregistrer (médiane recommandée)
RUNS=3 benchmarks/scripts/record-history.sh

# 3. Analyser
benchmarks/scripts/analyze-history.sh --vs-mutable
benchmarks/scripts/analyze-history.sh --changelog

# 4. Si le delta est significatif : copier les puces dans CHANGELOG.md
# 5. Versionner l'historique
git add benchmarks/perf-history.jsonl CHANGELOG.md
git commit -m "Record benchmark history at $(git rev-parse --short HEAD)."
```

Seuls les fichiers **suivis** modifiés bloquent l'enregistrement ; `benchmarks/scripts/` peut rester non commité.

## Commandes

| Script | Rôle |
|--------|------|
| `record-history.sh` | Append une ligne dans `perf-history.jsonl` (HEAD, arbre propre) |
| `backfill-history.sh` | Rejouer les commits manquants depuis `db3707b` |
| `show-history.sh` | Tableau rapide |
| `analyze-history.sh` | Extraction, comparaison, puces CHANGELOG, **frozen vs mutable** |

### Analyse

```bash
benchmarks/scripts/analyze-history.sh                    # chronologie
benchmarks/scripts/analyze-history.sh --vs-mutable       # Frozen vs MiniSearch mutable
benchmarks/scripts/analyze-history.sh --compare db3707b 5305918
benchmarks/scripts/analyze-history.sh --changelog        # puces vs commit précédent dans l'historique
benchmarks/scripts/analyze-history.sh --changelog --commit 5305918
benchmarks/scripts/analyze-history.sh --retro            # jalons pour CHANGELOG rétroactif
```

## Hook post-commit (optionnel)

Copier [`post-commit.sample`](post-commit.sample) vers `.git/hooks/post-commit` et adapter `RUNS`.

Le hook **n'échoue pas** le commit si le benchmark échoue ; il journalise seulement.

## Métriques frozen vs mutable

Chaque scénario mesure déjà les deux index sur le même corpus :

- **Heap** : `heapMb.mutable` vs `heapMb.frozen` (+ `frozenVsMutableSavingPct`)
- **Recherche** : `search[].mutableP50` vs `search[].frozenP50` (+ `frozenP50VsMutablePct`)
- **Score** : `scoreDrift` sur `extreme-overflowFrequency` (freq > 255)

`analyze-history.sh --vs-mutable` résume ces colonnes sur le dernier enregistrement.

## Seuils « changement important » (CHANGELOG)

| Métrique | Seuil |
|----------|--------|
| Heap frozen | ±5 % |
| Heap saving vs mutable | ±3 points |
| loadBinary | ±10 % |
| freeze | ±15 % |
| Search frozen vs mutable p50 | ±5 points |

Affichés avec `--changelog` ; ajuster dans `analyze-history.mjs` (`THRESHOLDS`).

## Point de départ

Premier commit de la suite JSON : `db3707b` (*Flatten frozen postings and add benchmark baselines*).
