# `trustedSource` et validation sur `fromJSON` (notes de design)

Document de référence pour une éventuelle exposition future d’une option
`trustedSource` sur le chemin migration JSON. **Non implémenté** à ce stade
(juin 2026) : `fromJSON` valide tout (`trustedSource: false` en interne).

## Contexte

Le freeze / `fromJSON` convertit un snapshot MiniSearch (`toJSON`) en index
`FrozenMiniSearch`. Le pipeline comporte plusieurs couches de vérification,
dont certaines re-parcourent des structures qu’on vient de construire.

Depuis la régression freeze liée au `PackedRadixTree` (commit `c216e26`), une
option interne `trusted` sur `fromRadixTree` sautait `validateRadixLeaves`, et
`assembleFrozenInternal(..., trustedSource: true)` sautait
`validateFrozenPostingsLayout` + `validateFrozenTermIndexLeaves` sur le chemin
JSON. Cela masquait une partie du coût sans résoudre le poste dominant (rebuild
du `RadixTree` intermédiaire).

## Quatre familles de validation

| Famille | Exemples | Rôle |
|--------|----------|------|
| **1 — Contrat / capacité** | `serializationVersion` supportée, `options.fields` vs `fieldIds`, forme du snapshot | Peut-on lire ce wire format avec cette version du package ? |
| **2 — Garde-fous bornes** | `shortId < nextId`, `fieldId < fieldCount`, tailles de matrices | Évite index silencieusement faux (fichier tronqué / édité) |
| **3 — Invariants producteur** | termes uniques, `storedFields` ⊆ `documentIds`, docIds triés par segment, cross-checks shell | MiniSearch « ne devrait jamais » émettre ça |
| **4 — Re-validation pipeline** | `validateRadixLeaves`, `validateFrozenTermIndexLeaves`, `validateFrozenPostingsLayout` | Notre conversion parse → pack → assemble n’a pas bugué |

### DocIds triés par segment (famille 3, non vérifié au parse)

La recherche suppose des postings **triés par docId** dans chaque segment
(binaire seek, gates, early break). `parseSnapshotIndex` **ne re-vérifie pas**
cet ordre : on fait confiance au producteur et au wire JSON.

- MiniSearch indexe avec des shortIds croissants ; `toJSON()` respecte cet ordre.
- Le remap dense (`shortIdRemap`) mappe les shortIds actifs en ordre croissant.
- En JavaScript, les clés entières d’un objet sont énumérées en ordre croissant
  (`for…in` / `Object.entries`), y compris après `JSON.parse`.

Un snapshot crafté avec docIds désordonnés pourrait produire un index
silencieusement faux ; ce n’est pas un cas supporté sur le chemin migration
MiniSearch → Frozen.

## Deux axes de confiance

- **Producteur** : « ce JSON vient d’un `MiniSearch.toJSON()` sain ».
- **Pipeline** : « notre code de conversion est correct sur cette entrée ».

`trustedSource` ne devrait **pas** signifier « faire confiance à frozenminisearch
pour ne pas avoir de bugs ».

Un changement de format MiniSearch (`serializationVersion: 3`) relève de la
**famille 1** : rejet dur, indépendant de `trustedSource`.

## Mesures perf (juin 2026, scénarios bench freeze)

Coût de la **famille 4** si on la réactive sur `fromJSON` (le code avait déjà
famille 4 désactivée en interne) :

| Scénario | Famille 4 (B+C) | Part de `buildFrozenParams` |
|----------|----------------:|----------------------------:|
| dense (101k termes) | ~33 ms | ~5 % |
| giant (50k termes) | ~17 ms | ~5 % |
| highFrequency | ~1 ms | négligeable |

Cross-checks **famille 3** dans le shell snapshot (hors index) :

| Scénario | ~ms |
|----------|----:|
| dense | ~45 |
| giant | ~20 |

Le poste dominant reste la **construction de l’index termes** (ancien
`RadixTree` via `setRadixLeaf`, ~75 %+ du chemin index). Optimisation livrée :
`packTermsFromList` — pack direct depuis `snapshot.index` sans `RadixTree`
intermédiaire (piste B).

## Proposition retenue pour plus tard

```ts
trustedSource?: boolean  // défaut: false sur fromJSON
```

| `trustedSource` | Famille 1 | Famille 2 | Famille 3 | Famille 4 |
|-----------------|-----------|-----------|-----------|-----------|
| `false` | oui | oui | oui | oui |
| `true` | oui | oui | non* | non |

\*Famille 3 : gain limité sans fast path parse dédié (checks entrelacés au parse).

Chemins qui restent **trusted en interne** (pas d’option exposée) :

- `FrozenIndexBuilder` / `fromDocuments` → `skipLeafValidation` sur
  `fromRadixTree` + `trustedSource: true` à l’assemble (`trusted-build`).
- `loadBinary` → validation au decode ; assemble trusted.

## Renommage interne

`FromRadixTreeOptions.trusted` a été renommé en `skipLeafValidation` pour
clarifier qu’il ne s’agit que de sauter `validateRadixLeaves` sur le chemin
builder, pas d’une option publique de confiance JSON.
