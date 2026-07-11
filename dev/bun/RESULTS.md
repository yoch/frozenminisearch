# Qualification Bun — FrozenMiniSearch

Branche : `experiment/bun-runtime` (worktree `/tmp/minisearch-bun-experiment`)  
Commit : `e06eca31874c30071bee4cbccf4814a40bec8b5f`  
Date de campagne : 2026-07-10

---

## Comment lire les ratios

Tous les ratios sont **Bun ÷ Node**.

| Ratio | Signification |
|---|---|
| **0.69** | Bun prend **69 %** du temps (ou de la mémoire) de Node → **plus rapide / plus léger** d’environ **31 %** |
| **1.00** | Équivalent |
| **1.30** | Bun prend **30 % de plus** → **plus lent / plus gourmand** |

Exemples concrets tirés de cette campagne :

- `fromDocuments` médiane **0.69** → Bun construit l’index en ~**31 % moins de temps**
- `loadBinary` médiane **0.63** → Bun charge le snapshot en ~**37 % moins de temps**
- search médiane **1.10** → Bun est en moyenne ~**10 % plus lent** sur la recherche (mais très variable selon la requête)
- pic RSS build médiane **0.82** → Bun monte ~**18 % moins haut** en RSS process pendant le build

---

## Environnement

| Élément | Valeur |
|---|---|
| OS | Linux 6.8.0-134-lowlatency (Ubuntu), x86_64 |
| CPU | Intel Core i7-3770 @ 3.40 GHz (8 threads) |
| Node | v24.16.0 |
| Bun | **1.4.0-canary.1+c1076ce95** (canary, pas une release stable) |
| Package mesuré | `@yoch/frozenminisearch@1.8.0`, bundle `dist/` produit par le pipeline Node/Rollup |
| Isolation | dépôt principal resté sur `master` ; travail uniquement dans le worktree |

---

## Synthèse exécutive

FrozenMiniSearch **fonctionne sous Bun** comme consommateur du paquet publié (ESM, CJS, codecs binaires, round-trips Node↔Bun).

Sur cette machine :

1. **Build** (`fromDocuments`) : Bun est **plus rapide** (~0.69×) et a un **pic RSS souvent plus bas** (~0.82×).
2. **Chargement binaire** (`loadBinary`) : Bun est **nettement plus rapide** (~0.63×) ; RSS souvent plus bas aussi.
3. **Recherche** : **proche de Node**, légèrement plus lente en médiane (~1.10×), avec des cas où Bun gagne beaucoup et d’autres où il perd (jusqu’à ~2×).
4. **Mémoire heap V8-style** : **inutilisable pour comparer Node et Bun** (comptabilité JSC différente). Pour la prod, se fier au **pic RSS OS**.

**Verdict prod (consommateur)** : go prudent sur Bun pour load/search/build d’index, après revalidation sur le hardware réel.  
**Verdict tooling repo** : ne pas remplacer Node/pnpm/Vitest CI pour l’instant.

---

## 1. Compatibilité du paquet publié

| Check | Résultat | Commentaire |
|---|---|---|
| ESM `dist/es` | OK Node + Bun | Import + search + binary |
| CJS `require(dist/cjs/…)` | OK Node + Bun | Lacune historique côté Vitest comblée ici |
| Bundle browser + API async | OK | zlib async ; zstd rejeté comme prévu |
| Codecs `raw` / `zlib` / `zstd` | OK | Round-trip search identique |
| Matrice binaire Node→Bun et Bun→Node | **12/12 OK** | Snapshots interchangeables |
| `pnpm pack` puis `bun add` du `.tgz` | OK | Projet consommateur temporaire sous `/tmp` |

Conclusion : un service Bun peut installer le tarball npm et utiliser FrozenMiniSearch sans rebuild spécial.

---

## 2. Tests fonctionnels

| Runner | Pass | Fail | Durée | Rôle |
|---|---:|---:|---:|---|
| Vitest sous Node (`src/` + `dev/parity/`) | 539 | 0 | 15.7 s | Baseline officielle |
| Vitest sous Bun (+ probe `dev/bun`) | 540 | 0 | 13.9 s | **Gate Bun retenue** |
| `bun test` natif | 535 | 1 (+1 error) | 7.4 s | Diagnostic seulement |

### Échec `bun test` (pas un bug produit)

Fichier : `src/msv5/binaryMsv5DecodeShared.test.js`  
Cause : `import { vi } from 'vitest'` → Bun n’injecte plus les globals (`describe is not defined`).  
Classification : **différence de runner**, pas incompatibilité FrozenMiniSearch.

Gate recommandée :  
`bun --no-install ./node_modules/vitest/vitest.mjs run src/ dev/parity/`

---

## 3. Performance CPU (temps wall-clock)

### Lecture rapide

| Opération | Médiane Bun/Node | En clair |
|---|---:|---|
| `fromDocuments` (build) | **0.69** | Bun **plus rapide** (~−31 %) |
| `fromJSON` | **1.29** | Bun **plus lent** (~+29 %) |
| `saveBinary` (zlib) | **1.09** | Bun légèrement plus lent / variable |
| `loadBinary` (zlib) | **0.63** | Bun **plus rapide** (~−37 %) |
| `search` (toutes labels) | **1.10** | Bun un peu plus lent en moyenne |

### Points saillants

- **Bon pour un serveur qui charge un `.msbin` et sert des recherches** : le chemin chaud `loadBinary` + search est viable ; load est même avantageux.
- **`fromJSON` est le point faible Bun** ici (souvent 1.2–1.6×). Préférer build natif ou load binaire.
- **Search très hétérogène** :
  - Bun gagne fort sur certains AND/prefix lourds (ex. giant vocab AND+prefix **0.39×**, docId exact **0.37–0.47×**)
  - Bun perd sur des requêtes courtes / fuzzy (ex. fuzzy Divina **2.07×**, exact large docs **2.16×**)
- Les temps de search sont souvent **sub-milliseconde** : un ratio 2× sur 0.05 ms reste négligeable en absolu ; regarder surtout les requêtes > 1 ms.

### Tableau détaillé (médianes, ms)

| Scenario | Metric | Node ms | Bun ms | Bun/Node | Lecture |
|---|---|---:|---:|---:|---|
| divina-indexOnly | fromDocuments | 201.2 | 108.0 | 0.54 | Bun plus rapide |
| divina-indexOnly | fromJson | 148.9 | 210.4 | 1.41 | Bun plus lent |
| divina-indexOnly | saveBinary | 77.6 | 60.9 | 0.78 | Bun plus rapide |
| divina-indexOnly | loadBinary | 27.4 | 10.4 | 0.38 | Bun plus rapide |
| divina-indexOnly | search exact | 0.077 | 0.083 | 1.08 | ≈ |
| divina-indexOnly | search prefix | 0.177 | 0.162 | 0.91 | ≈ / Bun un peu mieux |
| divina-storeFields | fromDocuments | 201.2 | 115.8 | 0.58 | Bun plus rapide |
| divina-storeFields | fromJson | 164.4 | 193.4 | 1.18 | Bun plus lent |
| divina-storeFields | saveBinary | 167.6 | 96.6 | 0.58 | Bun plus rapide |
| divina-storeFields | loadBinary | 64.6 | 18.1 | 0.28 | Bun plus rapide |
| divina-storeFields | search fuzzy | 0.049 | 0.101 | 2.07 | Bun plus lent (absolu faible) |
| divina-storeFields | search AND | 0.043 | 0.078 | 1.83 | Bun plus lent (absolu faible) |
| extreme-giantVocabulary | fromDocuments | 248.6 | 172.1 | 0.69 | Bun plus rapide |
| extreme-giantVocabulary | fromJson | 318.4 | 409.4 | 1.29 | Bun plus lent |
| extreme-giantVocabulary | loadBinary | 21.1 | 17.4 | 0.82 | Bun plus rapide |
| extreme-giantVocabulary | search AND+prefix | 73.6 | 28.8 | 0.39 | Bun nettement plus rapide |
| extreme-giantVocabulary | search prefix | 32.8 | 20.2 | 0.62 | Bun plus rapide |
| extreme-largeDocuments | fromDocuments | 1467.6 | 1466.1 | 1.00 | égal |
| extreme-largeDocuments | saveBinary | 409.8 | 807.8 | 1.97 | Bun nettement plus lent |
| extreme-largeDocuments | loadBinary | 102.1 | 57.2 | 0.56 | Bun plus rapide |
| extreme-largeDocuments | search exact | 1.55 | 3.33 | 2.16 | Bun plus lent |
| extreme-largeDocuments | search AND | 8.71 | 3.36 | 0.39 | Bun plus rapide |
| extreme-highFrequency | fromDocuments | 89.8 | 71.1 | 0.79 | Bun plus rapide |
| extreme-highFrequency | fromJson | 62.7 | 102.1 | 1.63 | Bun plus lent |
| extreme-highFrequency | loadBinary | 4.6 | 2.9 | 0.63 | Bun plus rapide |
| extreme-highFrequency | search AND | 16.5 | 7.6 | 0.46 | Bun plus rapide |
| docIdUint16Boundary-65535 | fromDocuments | 303.5 | 259.1 | 0.85 | Bun plus rapide |
| docIdUint16Boundary-65535 | loadBinary | 31.2 | 20.0 | 0.64 | Bun plus rapide |
| docIdUint16Boundary-65535 | search exact | 63.7 | 29.9 | 0.47 | Bun plus rapide |
| docIdUint16Boundary-65536 | fromDocuments | 353.2 | 189.0 | 0.54 | Bun plus rapide |
| docIdUint16Boundary-65536 | fromJson | 362.8 | 490.5 | 1.35 | Bun plus lent |
| docIdUint16Boundary-65536 | saveBinary | 136.1 | 202.1 | 1.49 | Bun plus lent |
| docIdUint16Boundary-65536 | search exact | 65.2 | 23.8 | 0.37 | Bun plus rapide |

---

## 4. Mémoire — ce qui compte en production

### Deux familles de métriques (ne pas les mélanger)

| Métrique | Comparable Node↔Bun ? | Usage |
|---|---|---|
| **Pic RSS OS** (`resourceUsage().maxRSS`) | **Oui** (ordre de grandeur process) | OOM killer, sizing conteneur, prod |
| `heapUsed` / protocole heap V8 du repo | **Non** | Diagnostic **intra-runtime** seulement |

Sous Bun, le protocole heap retenu du dépôt donne des chiffres absurdes (ex. Divina : mutable≈0 MB, « −3700 % »). **Ignorer ces ratios Bun.** Sous Node, le même protocole reste cohérent (Divina frozen ~0.7 MB vs mutable ~14.9 MB, −95 %).

### Pic RSS OS — lecture rapide

| Workload | Médiane Bun/Node | En clair |
|---|---:|---|
| **build** (add+freeze) | **0.82** | Bun monte ~**18 % moins haut** |
| **loadBinary** (scénarios synthétiques) | **0.77** | Bun plus léger |
| **loadBinaryFile** (7 index médicaments) | **0.90** | Bun un peu plus léger / ≈ |
| **search** (index déjà en mémoire dans le process) | **0.85** | Bun souvent plus bas |
| **mutable-addAll** (MiniSearch) | **0.82** | même tendance |

### Cas où Bun consomme **plus** de RSS

| Workload | Scenario | Node MB | Bun MB | Bun/Node |
|---|---|---:|---:|---:|
| build | extreme-largeDocuments | 284 | 305 | **1.07** |
| loadBinary | extreme-largeDocuments | 427 | 480 | **1.12** |
| search | extreme-largeDocuments | 298 | 370 | **1.24** |
| mutable-addAll | extreme-largeDocuments | 291 | 324 | **1.11** |
| loadBinaryFile | bdpm-presentations | 69 | 72 | **1.05** |
| search | extreme-highFrequency | 280 | 285 | **1.02** |

Le scénario **gros documents** (`extreme-largeDocuments`) est le principal contre-exemple mémoire : Bun y est un peu plus gourmand.

### Snapshots médicaments (chemin prod typique : load fichier)

| Index | Node maxRSS MB | Bun maxRSS MB | Bun/Node | Lecture |
|---|---:|---:|---:|---|
| bdpm-compositions | 73.2 | 71.8 | 0.98 | ≈ |
| bdpm-generiques | 64.4 | 57.8 | 0.90 | Bun plus léger |
| bdpm-mitm | 62.6 | 54.9 | 0.88 | Bun plus léger |
| bdpm-presentations | 68.7 | 71.9 | 1.05 | Bun un peu plus haut |
| bdpm-specialites | 66.0 | 62.5 | 0.95 | Bun un peu plus léger |
| bdpm-substances | 59.7 | 50.3 | 0.84 | Bun plus léger |
| vet-medicaments | 60.4 | 51.8 | 0.86 | Bun plus léger |

Pour un service qui **charge un `.msbin` médicaments et sert des recherches**, le pic RSS Bun est en général **égal ou inférieur** à Node sur cette machine.

### Tableau RSS complet (synthétique)

| Workload | Scenario | Node MB | Bun MB | Bun/Node |
|---|---|---:|---:|---:|
| build | divina-indexOnly | 232 | 164 | 0.71 |
| build | divina-storeFields | 233 | 164 | 0.70 |
| build | extreme-giantVocabulary | 254 | 209 | 0.82 |
| build | extreme-highFrequency | 208 | 161 | 0.78 |
| build | extreme-largeDocuments | 284 | 305 | 1.07 |
| build | docIdUint16Boundary-65535 | 287 | 270 | 0.94 |
| build | docIdUint16Boundary-65536 | 283 | 267 | 0.94 |
| loadBinary | divina-indexOnly | 239 | 175 | 0.73 |
| loadBinary | divina-storeFields | 248 | 184 | 0.74 |
| loadBinary | extreme-giantVocabulary | 274 | 211 | 0.77 |
| loadBinary | extreme-highFrequency | 231 | 170 | 0.74 |
| loadBinary | extreme-largeDocuments | 427 | 480 | 1.12 |
| loadBinary | docIdUint16Boundary-65535 | 286 | 250 | 0.87 |
| loadBinary | docIdUint16Boundary-65536 | 289 | 255 | 0.88 |
| search | divina-indexOnly | 234 | 173 | 0.74 |
| search | divina-storeFields | 216 | 170 | 0.79 |
| search | extreme-giantVocabulary | 252 | 206 | 0.82 |
| search | extreme-highFrequency | 280 | 285 | 1.02 |
| search | extreme-largeDocuments | 298 | 370 | 1.24 |
| search | docIdUint16Boundary-65535 | 713 | 606 | 0.85 |
| search | docIdUint16Boundary-65536 | 739 | 627 | 0.85 |

---

## 5. Verdict par cas d’usage

| Question | Verdict | Pourquoi |
|---|---|---|
| Consommer le package sous Bun en prod ? | **Oui (avec revalidation machine)** | Compat + Vitest 540/540 + binaire croisé OK |
| Construire des index sous Bun ? | **Oui, souvent avantageux** | Build plus rapide ; RSS souvent plus bas (sauf gros docs) |
| Charger un `.msbin` et servir des recherches ? | **Oui, chemin le plus convaincant** | `loadBinary` plus rapide ; RSS médicaments OK ; search ≈ Node |
| Migrer le tooling/CI du dépôt vers Bun ? | **Non pour l’instant** | Heap protocol, coverage V8, `bun test`, Makefile Node-centriques |

---

## 6. Points d’achoppement rencontrés

### Produit / runtime

1. **Bun installé = canary** (`1.4.0-canary.1`), pas une release stable — à figer avant prod.
2. **`fromJSON` plus lent sous Bun** (médiane ~1.29×) — éviter ce chemin en hot path.
3. **`saveBinary` irrégulier** : parfois plus rapide, parfois jusqu’à ~2× plus lent (gros documents).
4. **Search hétérogène** : ratios de 0.37× à 2.16× selon la requête ; ne pas conclure sur une seule query.
5. **Scénario gros documents** : Bun plus gourmand en RSS (build/load/search) — retester avec le vrai corpus prod si documents longs.

### Outillage / mesure

6. **`bun test` natif ≠ Vitest** : ignore `vitest.config.ts` ; casse sur `import { vi } from 'vitest'`.
7. **Protocole heap du repo inutilisable sous Bun** : `heapUsed` JSC ≠ V8 ; ratios absurdes (−3700 %). Seul le **RSS OS** est comparable.
8. **`--expose-gc` / `global.gc`** : disponible sous Bun, mais sémantique GC différente de V8 ; utile pour forcer une collecte, pas pour comparer heap.
9. **Pas de `bun install` dans le repo** : on a réutilisé `node_modules` pnpm ; le seul `bun add` était dans un projet `/tmp` consommateur.
10. **Baselines officielles non touchées** : tout écrit dans `tmp/bun-results/` ; pas de pollution de `benchmarks/baselines/`.
11. **Workers Vitest sous Bun** : OK hors sandbox ; en sandbox Cursor on avait vu des erreurs d’embedder — les mesures finales ont tourné hors sandbox.
12. **Manifests médicaments sans `fields`** : `loadBinarySync({}, …)` suffit (noms embarqués dans le snapshot) ; passer `fields: []` **échoue** (validation stricte). Piège corrigé dans le harness.
13. **`timedMs()` du repo renvoie `{ ms, result }`**, pas un nombre — premier jet du worker CPU cassé puis corrigé.
14. **Worktree séparé obligatoire** pour ne pas polluer `master` ; artefacts et harnesses vivent sous `/tmp/minisearch-bun-experiment`.

### Périmètre non couvert

15. Pas de charge multi-process / multi-tenant.
16. Pas de soak test longue durée / fuite mémoire.
17. Une seule machine (i7-3770) — **revalider sur le hardware de prod**.
18. Pas de mesure navigateur réelle (seulement le bundle exécuté sous Bun/Node).

---

## 7. Reproduire

```bash
cd /tmp/minisearch-bun-experiment   # worktree experiment/bun-runtime
make build

node dev/bun/cross-runtime.mjs
./dev/bun/pack-consumer.sh

pnpm exec vitest run src/ dev/parity/
bun --no-install ./node_modules/vitest/vitest.mjs run src/ dev/parity/ dev/bun/bun-runtime.probe.test.js
bun test ./src ./dev/parity --timeout 30000   # diagnostic seulement

node dev/bun/run-comparison.mjs --mode=cpu --reps=3
node dev/bun/run-comparison.mjs --mode=memory --reps=3
node --expose-gc dev/bun/retained-heap-run.mjs
bun --no-install --expose-gc dev/bun/retained-heap-run.mjs
```

Artefacts JSON : `tmp/bun-results/`.  
Harnesses + ce rapport : `dev/bun/`.
