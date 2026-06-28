# Audit Repo - Production Readiness

Date: 2026-06-28

## Perimetre et methode

Audit realise avec 3 objectifs:

1. Evaluer le niveau de maturite "production ready" du repo.
2. Identifier les zones de surcomplexite qui degradent la maintenabilite.
3. Identifier les opportunites realistes d'optimisation memoire / CPU sans grossir inutilement le code.

Travail effectue:

- cartographie du repo et des fichiers suivis par git
- lecture des points d'entree publics, du coeur de recherche, du build, des tests, de la CI et du bench tooling
- verification locale de l'etat courant via `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm test:browser`

## Etat actuel en une phrase

Le coeur produit est deja serieux, bien teste, et globalement bien cadre pour un usage production; la principale dette n'est pas dans l'algorithme central, mais dans la taille et le couplage de la surface interne/outillage autour de lui.

## Verification de l'etat courant

- Working tree git: propre
- `pnpm lint`: OK
- `pnpm build`: OK
- `pnpm test`: OK, 31 fichiers / 461 tests
- `pnpm test:browser`: OK, 1 fichier / 14 tests
- Note: `pnpm` a emis un warning `ERR_PNPM_META_FETCH_FAIL` sur son check de mise a jour; non bloquant dans cet environnement restreint

## Cartographie utile du repo

Fichiers suivis par git:

- `src/`: 100 fichiers, ~13.9k lignes
- `benchmarks/`: 107 fichiers, ~41.0k lignes
- `dev/`: 15 fichiers, ~2.4k lignes
- `scripts/`: 10 fichiers, ~393 lignes
- `testSupport/`: 9 fichiers, ~543 lignes

Observation structurante:

- Le coeur produit est de taille raisonnable.
- La plus grosse masse de code suivie n'est pas `src/`, mais `benchmarks/`.
- Le repo est donc davantage menace par la croissance de son outillage que par celle du moteur lui-meme.

## Forces du repo

### 1. Surface publique relativement compacte

Les points d'entree `src/index.ts`, `src/FrozenMiniSearch.ts` et `src/FrozenMiniSearchBrowser.ts` restent lisibles et bien separes. Le split Node/browser est propre, comprehensible, et favorable a la stabilite.

### 2. Architecture coeur globalement saine

La separation entre:

- index terme (`PackedRadixTree`)
- postings compacts (`frozenPostings`, `compactPostings`)
- moteur de requete (`queryEngine`)
- scoring (`scoring`)
- formats binaires (`binary*`, `msv5/*`)

est globalement bonne. Le design suit bien les objectifs du projet: index immutable, compacite memoire, chargement rapide, parite MiniSearch.

### 3. Veritable souci de robustesse runtime

Les validations sur les snapshots, la gestion explicite de l'ownership des buffers (`frozenOwnedSnapshot.ts`), la distinction raw/compressed dans la charge binaire, et les garde-fous MSv5 montrent un niveau de vigilance production rare et positif.

### 4. Bonne discipline de test

Le repo combine:

- tests unitaires colocalises
- tests de parite
- tests browser
- bench tooling documente

Le fait que la parite soit traitee comme un contrat explicite est un vrai point fort.

### 5. Hygiene release deja au-dessus de la moyenne

`verify-npm-pack.cjs`, `release-checks.cjs`, les workflows docs/CI, et la doc de release montrent un projet qui pense deja "artefact publiable", pas seulement "code qui marche chez moi".

## Constats prioritaires

## P0 - Resserer la frontiere entre API publique et internals

Constat:

- Les benches et tests consomment largement des elements internes ou semi-internes: `_fromMiniSearch`, `_fromMiniSearchSnapshot`, `_queryEngineParams`, `_index`, `_postings`.
- Plusieurs scripts bench importent directement `src/*.ts`.
- En pratique, cela etend la surface qu'il devient "dangereux" de refactorer, meme si elle n'est pas officiellement publique.

Pourquoi c'est important:

- C'est aujourd'hui le principal frein a la simplification du coeur.
- Chaque refactor interne risque de casser l'ecosysteme de bench/test plutot que le produit.
- Cela cree une "fausse API publique" diffuse.

Recommandation:

- Introduire une frontiere explicite `internal` reservee aux tests/benchmarks.
- Option simple: un module unique de harness interne, par exemple `src/internal/testing.ts` ou `testSupport/internalHarness.ts`, qui expose seulement ce dont les benches ont besoin.
- Interdire ensuite les acces directs a `_index`, `_postings`, `_queryEngineParams` hors de ce harness.

Impact attendu:

- refactors du coeur beaucoup plus surs
- reduction du couplage implicite
- moindre cout de maintenance

## P0 - Aligner la CI avec la promesse de compatibilite Node

Constat:

- `package.json` annonce `node >=20`
- la CI teste actuellement Node 22 uniquement

Pourquoi c'est important:

- Pour un package production, une promesse de compatibilite non testee est une dette concrete.
- Le sujet est particulierement sensible ici a cause des differences runtime autour de `zlib` / `zstd`.

Recommandation:

- Passer la CI sur une matrice minimale `20.x` + `22.x`
- Garder les assertions zstd conditionnelles sur la disponibilite runtime
- Optionnel: ajouter `24.x` si tu veux monitorer le futur sans changer la promesse supportee

Impact attendu:

- confiance bien plus forte sur la surface publiee
- regression support/runtime detectee plus tot

## P0 - Declarer un moratoire de croissance sur le bench tooling

Constat:

- `benchmarks/` pese environ 3x `src/`
- `package.json` expose une tres grande matrice de commandes bench
- `benchmarks/scripts/` seul represente ~4.7k lignes

Pourquoi c'est important:

- Le repo commence a payer un cout cognitif disproportionne sur son outillage.
- C'est exactement le type de croissance silencieuse qui rend les projets IA-assisted de plus en plus chers a maintenir.

Recommandation:

- Geler l'ajout de nouveaux scripts benchmark tant qu'une rationalisation n'a pas ete faite.
- Definir 3 niveaux:
  - `supported`: workflows quotidiens
  - `advanced`: outils experts conserves mais non encourages
  - `lab/archive`: scripts ponctuels de calibration ou investigation
- Ne garder dans `package.json` et `Makefile` que les workflows "supported"
- Basculer les autres derriere une doc unique, sans alias de premier niveau

Cible concrete:

- 6 a 8 commandes bench "officielles" maximum
- le reste documente mais de-promu

## P1 - Ne pas redecouper `queryEngine.ts` / `scoring.ts` sans motif concret

Constat revise:

- `src/queryEngine.ts`: ~825 lignes
- `src/scoring.ts`: ~604 lignes
- la zone est dense, mais l'entrelacement reste local et comprehensible
- il n'y a pas de cycle de dependance majeur, ni de fuite d'API publique a corriger ici

Decision:

- Reporter tout grand redecoupage.
- Garder `queryEngine.ts` et `scoring.ts` tels quels tant qu'un changement fonctionnel ou perf ne force pas une extraction.
- Appliquer la regle: extraire uniquement le bloc deja modifie par un travail concret.

Micro-refactor autorise sans autre motif:

- Sortir `finalizeSearchResults` / `finalizeRawSearchResults` vers un petit module dedie, si cela reduit effectivement les imports ou clarifie un changement en cours.

Hors scope pour l'instant:

- Ne pas extraire gating, prefix/fuzzy, two-phase AND/AND_NOT ou l'adaptateur d'index sans travail direct sur ces chemins.
- Ne pas creer de planner, strategie, registry, ou couche abstraite.

Critere de succes:

- Simplification percue, pas seulement moins de lignes par fichier.
- Aucun changement comportemental ou public.
- Toute extraction doit reduire la complexite d'un module important, pas seulement deplacer le code.

## P1 - Reduire la dette d'API heritee de MiniSearch

Constat:

`src/searchTypes.ts` transporte encore des options non pertinentes ou ambiguës pour un index frozen:

- `logger`
- `autoVacuum`
- alias de compatibilite `fromJson`

Le code lui-meme signale deja ce malaise via des TODO.

Pourquoi c'est important:

- Cela elargit la surface mentale sans valeur produit.
- Cela brouille le contrat: "qu'est-ce qui est vraiment supporte et utile ici ?"

Recommandation:

- Marquer clairement ces elements comme depreciés cote types et doc
- A terme, separer:
  - options coeur frozen
  - options de compatibilite amont MiniSearch

Le but n'est pas de casser la compatibilite brutalement, mais de retirer du bruit de l'API courante.

## P1 - Isoler le chemin d'import MiniSearch JSON comme un adaptateur

Constat:

`src/fromMiniSearch.ts` est un module dense, important, et legitime, mais il concentre une complexite qui ne sert pas le chemin de prod ideal.

Chemin produit ideal du projet:

- construire frozen directement
- sauver en binaire
- charger en binaire

Le chemin `fromJSON` / `_fromMiniSearch*` est surtout un chemin d'interoperabilite.

Recommandation:

- Le traiter explicitement comme un adaptateur de compatibilite
- Le documenter et le tester comme tel
- Eviter qu'il dicte l'architecture du coeur
- A moyen terme, envisager une entree ou sous-module de compatibilite si tu veux encore mieux separer les responsabilites

## P1 - Optimiser la memoire de build avant d'optimiser davantage la memoire runtime

Constat:

Le runtime est deja tres travaille. En revanche, le build garde encore des structures scratch JS relativement lourdes, notamment:

- `FrozenIndexBuilder._fieldLengthData` en `number[]`
- accumulations JS temporaires avant materialisation typed arrays

Pourquoi c'est interessant:

- Le gain marginal sur le runtime resident sera probablement plus dur a obtenir maintenant.
- Le pic memoire de build, lui, semble encore plus accessible.

Recommandation:

- Etudier en priorite la conversion de `fieldLengthData` vers une structure growable typée ou segmentee
- Eviter les doubles representations longues durees quand la version finale est deja une typed array
- Mesurer avant/apres avec `bench:build-peak` et `bench:build-heap-profile`

Ordre conseille:

1. `fieldLengthData`
2. scratch arrays les plus volumineux du builder
3. seulement ensuite micro-optimisations de scoring

## P2 - Ajouter un garde-fou CI sur le packaging publie

Constat:

- `scripts/verify-npm-pack.cjs` existe
- il n'est pas dans la CI principale

Recommandation:

- L'executer dans la CI PR/push apres `build`

Impact:

- prevention simple contre l'introduction accidentelle de contenu de dev dans le package npm

## P2 - Faire attention aux micro-optimisations CPU a faible rendement

Constat:

Le coeur contient encore quelques petits points perfectibles (`includes` lineaires dans l'agregation de termes, allocations par requete, merges d'options repetes), mais ils sont secondaires face aux sujets structurants ci-dessus.

Recommendation:

- Ne pas lancer une campagne de micro-tuning dispersee maintenant
- N'optimiser finement qu'apres avoir:
  - fige la frontiere interne/publique
  - reduit la surface outillage
  - redecoupe le moteur de requete

## Recommandations tres concretes pour les 3 prochaines iterations

### Iteration 1 - Production hardening

- ajouter matrice CI Node 20/22
- ajouter `node scripts/verify-npm-pack.cjs` a la CI
- creer une frontiere explicite pour les helpers internes utilises par bench/tests

### Iteration 2 - Reduction de complexite

- rationaliser les commandes bench exposees
- classer `benchmarks/scripts/*` en `supported` / `advanced` / `lab`
- ne pas redecouper `queryEngine.ts` / `scoring.ts` sans motif concret; extraire seulement un bloc deja touche

### Iteration 3 - Optimisation memoire pragmatique

- attaquer le pic memoire du builder
- mesurer `fieldLengthData` typed/segmented
- ne poursuivre que les optimisations dont le gain benchmarke justifie la complexite ajoutee

## Ce que je ne recommande pas

- Ajouter encore plus de scripts de bench ou de calibration avant simplification
- Introduire une couche d'abstraction generique "planner/executor" trop ambitieuse
- Chasser des micro-gains CPU tant que la complexite structurelle n'a pas baisse
- Toucher au format binaire ou aux invariants MSv5 sans besoin fort: cette zone est delicate mais globalement saine

## Conclusion

Le repo est deja plus proche d'un vrai produit que d'un prototype de recherche. Le risque principal n'est pas un manque de sophistication technique; c'est au contraire que l'outillage, les chemins de compatibilite et les hooks internes finissent par rendre le projet plus large que necessaire.

Si je devais resumer la priorite absolue: proteger le coeur en reduisant le couplage avec l'outillage, rationaliser ce qui grossit vraiment la maintenance, puis reprendre l'optimisation memoire cote build. C'est le meilleur levier pour conserver un projet rapide, robuste, et encore "humain" a maintenir.
