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

La gate de taille `G` est **sélective** si `G === 0` ou `G ≤ maxGateSize`.

| Paramètre | Valeur actuelle | Rôle |
|-----------|-----------------|------|
| `maxAbsolute` | `5000` | Plafond absolu : au-delà, le filtrage par gate ne vaut pas le coût de gestion d’un gros `Set` + scoring partiel. |
| `maxFraction` | `0.1` | Plafond relatif : sur un gros corpus, une gate qui couvre plus de 10 % des docs est traitée comme « trop large ». |
| Plancher `100` | fixe dans le code | Sur les petits index, évite un `maxGateSize` ridiculement bas (ex. 30 docs → gate max 100). |

**Défauts** : `maxAbsolute = 5000`, `maxFraction = 0.1` (`DEFAULT_AND_GATE_LIMITS`).

## Pourquoi ces valeurs

1. **Petites gates (synthétique + Divina)** — Ex. AND `bucket5` puis `shared` sur 2 000 docs : gate ≈ 200, `maxGate` ≈ 200 → gating actif, gain net vs naïf (moins de postings scorés sur la 2ᵉ branche).
2. **Grosses gates** — Ex. AND `alpha` puis `beta` sur 3 000 docs : gate = 3 000, `maxGate` = 300 → gating désactivé ; le chemin naïf est déjà acceptable et évite le surcoût d’un filtre inefficace.
3. **Corpus réels type Divina** — AND `inferno paradiso` : gate très petite (~quelques docs) → toujours sélectif avec les défauts.
4. **Plafond absolu 5000** — Protège les index à très fort `N` : une gate de 8 000 docs ne doit pas déclencher un parcours « sélectif » qui reste massif.

Les seuils n’ont pas été exposés dans l’API : ce sont des heuristiques perf, pas des garanties sémantiques (la sémantique reste celle du combine naïf quand le gating est off).

## Ordre des branches AND

La gate après la branche 0 est `|résultat branche 0|`. **Le terme le plus sélectif doit être en première position** dans la requête (ex. `bucket5 shared`, pas `shared bucket5`). Sinon la gate est grosse et le gating ne s’active pas — comportement correct mais perf dégradée.

## Réglage et validation

- Script optionnel : `benchmarks/and-gate-tuning.mjs` (`npm run benchmark:and-gate-tuning` si le script est présent dans `package.json`).
- Tests oracle : `dev/parity/queryEngine.gate.test.js` (comparaison gated vs chemin naïf via `dev/parity/queryEngineHarness.js`).
- Suite de régression perf : `npm run benchmark:record` puis `benchmark:diff` vs `benchmarks/baselines/reference.json` (mesure **warm**).

Ne pas changer les défauts sans refaire le tuning et, si les gains sont intentionnels, mettre à jour `reference.json`.
