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

## Suivi de l'audit

Mise a jour de suivi realisee par inspection du repo et de la CI le 2026-06-28.

Legende:

- `fait`: recommandation implementee de maniere claire
- `partiel`: direction prise, mais la cible de l'audit n'est pas encore atteinte
- `pas fait`: le constat d'origine reste globalement vrai
- `evalue mais non prioritaire`: piste analysee et volontairement non engagee a ce stade

| Priorite | Sujet | Statut | Commentaire court |
|---|---|---|---|
| P0 | Frontiere API publique / internals | `fait` | frontiere explicite deja mise en place; les acces restants passent par les harness autorises |
| P0 | CI alignee sur Node `>=20` | `fait` | matrice `20.x` + `22.x` en place, avec `24.x` en suivi |
| P0 | Moratoire / rationalisation bench tooling | `partiel` | meilleure documentation des couches bench, mais la surface exposee reste tres large |
| P1 | Ne pas redecouper `queryEngine.ts` / `scoring.ts` sans motif | `fait` | pas de grand redecoupage artificiel observe |
| P1 | Reduire la dette d'API heritee MiniSearch | `partiel` | `fromJson` et `autoVacuum` sont sortis; `logger` est conserve intentionnellement comme point d'extension no-op |
| P1 | Isoler `fromMiniSearch` / `fromJSON` comme adaptateur | `partiel` | le role d'import/migration est mieux explicite, mais pas encore separe en sous-module distinct |
| P1 | Optimiser la memoire de build avant le runtime | `evalue mais non prioritaire` | piste analysee, jugee peu rentable a ce stade, donc volontairement non implementee |
| P2 | Ajouter `verify-npm-pack` a la CI | `fait` | verification package publiee executee dans la CI |
| P2 | Eviter une campagne de micro-optimisations CPU diffuse | `fait` | pas de campagne large observee; la priorite structurelle reste dominante |

### Detail par point

#### P0 - Frontiere entre API publique et internals

Statut: `fait`

Constat actuel:

- un point d'entree interne explicite existe dans [`src/internal/frozenInternals.ts`](src/internal/frozenInternals.ts)
- un harness benchmark dedie existe dans [`benchmarks/harness/frozenDistInternals.mjs`](benchmarks/harness/frozenDistInternals.mjs)
- un garde-fou automatise existe dans [`scripts/assert-internal-boundary.cjs`](scripts/assert-internal-boundary.cjs)
- ce garde-fou est deja branche dans la routine de lint

Lecture revisee:

- le fait que tests et benches consomment `src/internal/frozenInternals.ts` n'est plus en soi un probleme: c'est justement la frontiere interne explicite introduite pour eviter la diffusion des acces prives
- le harness benchmark `dist` continue a lire des champs prives (`_index`, `_postings`, `_fieldLengthMatrix`, etc.), mais de maniere centralisee et volontaire dans un point autorise
- le sujet ne me parait plus relever d'un manque de frontiere, mais plutot d'un choix de maintenance sur la taille du harness interne

Verdict:

- le point P0 me parait traite
- les evolutions futures devraient surtout viser a garder cette frontiere stable et etroite, pas a relancer un chantier structurel sur ce sujet

#### P0 - CI alignee sur la promesse Node

Statut: `fait`

Constat actuel:

- [`package.json`](package.json) annonce toujours `node >=20`
- la CI principale dans [`.github/workflows/main.yml`](.github/workflows/main.yml) teste `20.x`, `22.x` et `24.x`

Impact:

- la recommandation de l'audit est couverte
- le `24.x` ajoute un suivi du futur sans changer la promesse officielle

#### P0 - Moratoire / rationalisation bench tooling

Statut: `partiel`

Ce qui a ete fait:

- [`benchmarks/SCRIPTS.md`](benchmarks/SCRIPTS.md) distingue clairement `bench:*` (profiled) et `benchmark:*` (expert)
- la doc bench a gagne en structure et en vocabulaire de frontiere

Ce qui n'est pas encore fait:

- [`package.json`](package.json) expose toujours une matrice tres large de commandes top-level bench et benchmark
- la cible "6 a 8 commandes bench officielles maximum" n'est pas atteinte
- il n'y a pas encore de vraie de-promotion de la surface experte hors du premier niveau

Verdict:

- le probleme est mieux documente
- il n'est pas encore reellement resolu

#### P1 - Ne pas redecouper `queryEngine.ts` / `scoring.ts` sans motif concret

Statut: `fait`

Constat actuel:

- pas de grand redecoupage "cosmetique" observe
- la logique principale reste regroupee dans les modules coeur
- les nettoyages recents vont plutot dans le sens de la simplification locale que d'une abstraction supplementaire

Verdict:

- la recommandation a ete respectee

#### P1 - Reduire la dette d'API heritee MiniSearch

Statut: `partiel`

Ce qui a ete fait:

- l'alias public `fromJson` a ete retire; les tests verifient que seul `fromJSON` reste expose
- `autoVacuum` n'est plus expose comme option par defaut frozen; un test le verrouille dans [`src/getDefault.test.js`](src/getDefault.test.js)
- le `CHANGELOG` documente explicitement ce nettoyage

Ce qui reste ouvert:

- [`src/searchTypes.ts`](src/searchTypes.ts) conserve `logger` dans `Options<T>`
- ce `logger` est documente comme hook de compatibilite/no-op; il peut aussi servir de point d'instrumentation strategique si une politique de logging est introduite
- il n'y a pas encore de separation nette entre options coeur frozen et options de compatibilite amont

Verdict:

- le bruit le plus visible a ete reduit
- `logger` ne doit pas etre lu comme un reliquat a supprimer d'office: c'est un point d'extension acceptable tant qu'il reste no-op par defaut

#### P1 - Isoler le chemin d'import MiniSearch JSON comme adaptateur

Statut: `partiel`

Ce qui a ete fait:

- [`src/FrozenMiniSearchCore.ts`](src/FrozenMiniSearchCore.ts) documente clairement `fromJSON` comme un chemin "import / migration"
- [`src/internal/frozenInternals.ts`](src/internal/frozenInternals.ts) concentre les helpers internes lies a ce chemin

Ce qui reste ouvert:

- [`src/fromMiniSearch.ts`](src/fromMiniSearch.ts) reste un module coeur de `src/`, pas un sous-module de compatibilite explicite
- l'architecture n'a pas encore separe visiblement le chemin ideal "build frozen direct + binaire" du chemin d'interoperabilite JSON

Verdict:

- le cadrage conceptuel est meilleur
- la separation structurelle reste incomplete

#### P1 - Optimiser la memoire de build avant le runtime

Statut: `evalue mais non prioritaire`

Constat actuel:

- [`src/frozenBuild.ts`](src/frozenBuild.ts) conserve `_fieldLengthData` en `number[]`
- la recommandation centrale de l'audit reste techniquement valide, mais elle a deja ete evaluee comme peu rentable a court terme

Nuance utile:

- l'outillage de mesure existe bien (`bench:build-peak`, `bench:build-heap-profile`, `bench:medicaments-build-peak`)
- autrement dit, la mesure est la, la piste a ete regardee, puis volontairement laissee de cote faute de ROI suffisant a ce stade

#### P2 - Garde-fou CI sur le packaging publie

Statut: `fait`

Constat actuel:

- [`.github/workflows/main.yml`](.github/workflows/main.yml) execute `node scripts/verify-npm-pack.cjs`
- le check est limite a la variante Node `22.x`, ce qui est raisonnable pour eviter de dupliquer inutilement le meme controle sur chaque job

#### P2 - Eviter une campagne de micro-optimisations CPU diffuse

Statut: `fait`

Constat actuel:

- pas de signal d'une campagne large et dispersee de micro-tuning
- les changements recents semblent rester concentres sur des simplifications locales ou des sujets structurels

## Verification de l'etat courant

Cette section est le snapshot de verification du jour de l'audit initial. Le suivi ci-dessus decrit l'etat d'avancement des recommandations sans rerouler ici l'integralite de cette verification.

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
