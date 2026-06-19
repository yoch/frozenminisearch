# Paramètres du gating AND / AND_NOT

Document interne (non exposé dans l’API publique). Les constantes vivent dans `src/queryEngineGateLimits.ts` et sont consommées par `src/queryEngine.ts`.

## Comportement

Pour une requête combinée `AND` (ou `AND_NOT` sur la branche négative), le moteur évalue les branches dans l’ordre. Après la branche *i − 1*, l’ensemble des `docId` matchants forme la **gate** passée à la branche *i* :

- **Gate sélective** : on ne score la branche *i* que sur les documents de la gate (`allowedDocs`). Même sémantique de scores que le chemin naïf (score puis intersection), mais moins de travail.
- **Gate non sélective** : on retombe sur le score complet de la branche *i*, puis `combineResults` — équivalent au chemin sans gating (validé par `dev/parity/queryEngine.gate.test.js`).

La gate vide est toujours traitée comme sélective (court-circuit utile pour AND+prefix sans match sur la première branche).

## Formule

Pour un index de `N` documents :

```text
maxGateSize = min(maxAbsolute, max(100, floor(N × maxFraction)))
```

La gate de taille `G` est **sélective** si `G === 0`, si `G ≤ maxGateSize`, ou si le [ratio posting](#ratio-posting) passe pour la branche suivante.

Quand `G > maxGateSize`, la longueur posting max (exact + prefix + fuzzy) est estimée pour le ratio. Sur le chemin absolu (`G ≤ maxGateSize`), cette estimation **n’est pas** refaite : la sélectivité est déjà fixée par `G ≤ maxGateSize` (évite un walk fuzzy/prefix coûteux avant chaque branche AND, ex. Divina AND+fuzzy).

La gate sélective est **toujours** passée en `allowedDocs` à la branche suivante. Ne pas conditionner ce passage à `postingListLength > G` : sur un AND exact courant (ex. `inferno paradiso`, 0 résultat), le filtre `allowedDocs.has` évite de scorer des docs hors gate — retirer la gate dans ce cas coûte plus cher qu’il ne rapporte.

| Paramètre | Valeur actuelle | Rôle |
|-----------|-----------------|------|
| `maxAbsolute` | `5000` | Plafond absolu : au-delà, le filtrage par gate ne vaut pas le coût de gestion d’un gros `Set` + scoring partiel. |
| `maxFraction` | `0.1` | Plafond relatif : sur un gros corpus, une gate qui couvre plus de 10 % des docs est traitée comme « trop large ». |
| Plancher `100` | fixe dans le code | Sur les petits index, évite un `maxGateSize` ridiculement bas (ex. 30 docs → gate max 100). |

**Défauts** : `maxAbsolute = 5000`, `maxFraction = 0.1` (`DEFAULT_AND_GATE_LIMITS`).

## Ratio posting

Quand la gate dépasse `maxGateSize` mais reste **petite par rapport au posting** de la branche suivante, le gating reste actif (`allowedDocs` passé à la branche). Calibration empirique (script `benchmark:gate-posting-ratio`, non CI) :

| Paramètre | Valeur | Rôle |
|-----------|--------|------|
| `minLength` | `2048` | Posting trop court → pas de ratio (évite bruit sur petites listes) |
| `ratioShift` | `2` | Gate OK si `G ≤ postingLength >>> 2` (max **25 %** du posting) |

Helper : `passGateByPostingRatio` dans `queryEngineGateLimits.ts`, intégrée à `gateIsSelectiveEnough` quand `estimateMaxPostingLengthForQuery` fournit la longueur max du posting de la branche (chemin ratio uniquement).

**Exemples** :

| Cas | gate | posting | Ratio | Abs OK ? | Ratio OK ? |
|-----|------|---------|-------|----------|------------|
| giant AND+prefix branche 2 | 11 111 | 50 000 | 22 % | non | **oui** → seek + scan filtré |
| highFrequency AND | 10 000 | 10 000 | 100 % | non | non |
| parity 6000-doc alpha∧beta | ~6000 | ~6000 | ~100 % | non | non |

**Seek scoring** (`shouldSeekAllowedDocs` dans `compactPostings.ts`) réutilise les **mêmes seuils numériques** une fois `allowedDocs` actif : décision distincte (scan séquentiel vs binary search), pas la même fonction métier.

**Estimation posting** : `forEachQuerySpecTermRef` / `estimateMaxPostingLengthForQuery` — uniquement quand `G > maxGateSize` (chemin ratio). Ne pas estimer sur le chemin absolu (`G ≤ maxGateSize`). Le broad-first utilise un estimateur séparé, `estimateCheapTwoPhasePostingLength*`, qui refuse les specs prefix/fuzzy pour éviter un walk upfront coûteux.

## Broad-first (exact-only, v1.2.3)

Quand toutes les specs d’une requête string normalisée ont une estimation upfront bon marché (aujourd’hui : exact-only, pas de `prefix` ni `fuzzy`), le moteur peut prendre un chemin **two-phase** avant le gating séquentiel :

- **AND** — si la 1ʳᵉ branche a un posting ≥ `minLength` (2048) et une branche ultérieure a un posting ≤ `firstPosting >>> ratioShift`, collecter les doc ids par longueur posting croissante, puis scorer dans l’ordre de la requête avec la gate finale.
- **AND_NOT** — si la branche positive est « large » (≥ max(2048, 50 % de N)) et une branche négative l’est aussi, collecter d’abord les exclusions, puis scorer la positive sur les survivants.

L’estimateur two-phase renvoie `undefined` pour prefix/fuzzy (pas d’estimation upfront coûteuse). Parité : `dev/parity/queryEngine.gate.test.js` (cas `common unique1`, prefix/fuzzy broad-first probe, nested AND, AND_NOT vide).

## Pourquoi ces valeurs

1. **Petites gates (synthétique + Divina)** — Ex. AND `bucket5` puis `shared` sur 2 000 docs : gate ≈ 200, `maxGate` ≈ 200 → gating actif, gain net vs naïf (moins de postings scorés sur la 2ᵉ branche).
2. **Grosses gates** — Ex. AND `alpha` puis `beta` sur 3 000 docs : gate = 3 000, `maxGate` = 300 → gating désactivé ; le chemin naïf est déjà acceptable et évite le surcoût d’un filtre inefficace.
3. **Corpus réels type Divina** — AND `inferno paradiso` : gate très petite (~quelques docs) → toujours sélectif avec les défauts.
4. **Plafond absolu 5000** — Protège les index à très fort `N` : une gate de 8 000 docs ne doit pas déclencher un parcours « sélectif » qui reste massif.

Les seuils n’ont pas été exposés dans l’API : ce sont des heuristiques perf, pas des garanties sémantiques (la sémantique reste celle du combine naïf quand le gating est off).

## Ordre des branches AND

La gate après la branche 0 est `|résultat branche 0|`. **Le terme le plus sélectif doit être en première position** dans la requête (ex. `bucket5 shared`, pas `shared bucket5`). Sinon la gate est grosse et le gating ne s’active pas — comportement correct mais perf dégradée.

## Réglage et validation

- Script calibration ratio : `npm run benchmark:gate-posting-ratio` (`benchmarks/scripts/calibrate-gate-posting-ratio.mjs`).
- Script optionnel : `benchmarks/and-gate-tuning.mjs` (`npm run benchmark:and-gate-tuning`).
- Tests oracle : `dev/parity/queryEngine.gate.test.js` (comparaison gated vs chemin naïf via `dev/parity/queryEngineHarness.js`).
- Suite de régression perf : `npm run benchmark:record` puis `benchmark:diff` vs `benchmarks/baselines/reference.json` (mesure **warm**).

Ne pas changer les défauts sans refaire le tuning et, si les gains sont intentionnels, mettre à jour `reference.json`.
