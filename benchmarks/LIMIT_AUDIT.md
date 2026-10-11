# Audit de `limit` dans FrozenMiniSearch

Audit du 11 octobre 2026, branche `codex/limit-audit`, référence
`e1339612c803a87c291e34082f7a134d0b8e5f97`.

## Conclusion

`limit` exploitait déjà la sélection top-k sans filtre, mais intervenait après
l'exécution complète de la requête. Les changements réduisent la finalisation et,
pour zéro et le wildcard sans boost, évitent du travail dans le moteur lui-même.
Les recherches ordinaires conservent le calcul complet des scores. Les filtres
qui rejettent presque tout peuvent encore rendre la recherche bornée plus chère
qu'une recherche complète suivie de `.slice()`.

Les chemins ajoutés répondent à des usages mesurés. Aucun traitement particulier
des scores `NaN` ni vérification de finitude n'est ajouté au moteur : un callback
qui produit des scores non finis sort du contrat d'équivalence audité.

## Contrat et couverture

Pour des scores finis, `search(query, { ...options, limit: k })` doit produire les
mêmes résultats que `search(query, { ...options, limit: Infinity }).slice(0, k)`.
Les filtres doivent être déterministes et ne pas modifier les scores. La limite
porte sur les résultats acceptés, pas sur les candidats avant filtrage.

- Entier non négatif ou `Infinity`. `undefined` et `Infinity` lèvent une limite
  globale ; les autres valeurs sont rejetées avant les callbacks de requête.
- Zéro renvoie immédiatement `[]`, sans tokenisation, scoring ni filtre. Cela
  signifie aussi que la requête et ses autres options ne sont pas évaluées.
- Les égalités conservent l'ordre d'insertion des candidats ; l'identifiant
  externe ne sert pas de critère de départage.
- Les scores incluent toutes les contributions des champs et termes, et le
  facteur final lié au nombre de termes de requête trouvés.
- Les résultats conservent `id`, `score`, `terms`, `queryTerms`, `match` et les
  champs stockés, y compris après import JSON et chargement binaire Node/browser.
- `autoSuggest` ignore les limites locales et globales, avec et sans filtre.
- Les filtres peuvent être appelés dans un ordre différent et moins souvent avec
  une limite : la recherche complète filtre avant de trier ; le chemin borné
  examine les candidats par rang jusqu'à en accepter assez.

La suite [de parité](../dev/parity/limit.test.js) compare les recherches bornées
à Frozen complet, à son exécution sans gating et à MiniSearch complet puis découpé.
Elle couvre OR, AND, AND_NOT, combinaisons imbriquées, préfixes, fuzzy, Unicode,
boosts, filtres, snapshots, réentrance et wildcard avec des documents supprimés.
Le test du document gagnant après agrégation empêche de remplacer les branches
par leurs seuls meilleurs résultats partiels.

## Exploitation par les optimisations

| Chemin | Travail évité | Travail conservé / raison |
|---|---|---|
| `limit: 0` | Toute exécution de requête | Validation de la limite avant retour |
| Wildcard borné sans boost | Map de résultats bruts, parcours des documents après suffisamment d'acceptations | Parcours dans l'ordre des short ids, trous sautés, champs et filtre des candidats visités |
| Un seul résultat sans filtre | Buffer de scores et tas | Scan des valeurs pour trouver le meilleur, puis résolution de son id |
| Tous les scores égaux, avec filtre ou grande limite | Sélection et tri | Détection sur le buffer ; insertion order suffit pour les égalités stables |
| Petit k sans filtre | Tri et matérialisation des candidats non retenus | Tas des k meilleurs, calcul de tous les scores, buffer de taille n |
| k au moins égal à n/2 sans filtre | Gestion d'un grand tas | Tri natif des indices puis matérialisation des k retenus |
| Petit k avec filtre | Souvent le tri complet | Tas construit en O(n), premier lot classé de `max(64, 4k)` candidats ; matérialisation et filtre uniquement jusqu'à assez d'acceptations |
| Filtre très sélectif | Tri des candidats déjà examinés | Tri natif du reste après le premier lot ; ordre d'insertion rétabli avant ce tri pour limiter son coût sur les nombreux ex aequo |
| k au moins égal à n/8 avec filtre | Construction du tas et lot initial | Tri natif direct, proche du chemin antérieur |
| Sans limite, `Infinity`, k au moins égal à n | Aucun nouvel algorithme de classement | Chemin complet existant ; le wildcard borné sans boost a son parcours direct |

Le seuil de tri sans filtre a été calibré : à n = 10 000, un seuil de n/8
dégradait nettement k = 1 250. Le tas est conservé jusqu'à n/2. Avec un filtre,
le budget de premier lot vise les taux d'acceptation courants ; son épuisement
déclenche un tri, sans réévaluer les candidats et sans changer leur ordre.

La détection des scores égaux reste en dehors de la boucle d'accumulation des
scores. Pour un classement non uniforme, elle s'arrête à la première différence.
Elle est évitée pour le petit top-k sans filtre : les mesures sur les données
réelles ont justifié de garder ce chemin simple et de l'isoler dans un helper.

Les chemins AND/AND_NOT, la collecte des documents exclus et la traversée
préfixe/fuzzy restent indépendants de `limit`. Tronquer une branche ou arrêter
le scoring après k candidats peut éliminer le gagnant final. Une interruption
correcte nécessiterait des bornes prouvées sur les contributions encore à venir,
y compris les boosts et la qualité finale ; le format actuel n'en fournit pas.

## Mesures

### Corpus réel BDPM — p50 de la recherche publique

| Cas | k | Candidats | Recherche avant (ms) | Recherche après (ms) | Évolution |
|---|---:|---:|---:|---:|---:|
| exact | 1 | 7,977 | 1.0277 | 0.9782 | -4.8 % |
| exact | 20 | 7,977 | 1.0311 | 1.0980 | +6.5 % |
| exact | near | 7,977 | 3.3175 | 2.3385 | -29.5 % |
| dense-OR | near | 9,526 | 4.5099 | 3.4360 | -23.8 % |
| prefix | 20 | 121 | 0.0170 | 0.0171 | +0.3 % |
| fuzzy | 20 | 18 | 0.0240 | 0.0250 | +4.1 % |
| wildcard | 20 | 15,848 | 0.9777 | 0.0007 | -99.9 % |
| wildcard-filter | 20 | 15,848 | 1.0942 | 0.0900 | -91.8 % |
| filter-half | 20 | 7,977 | 2.0644 | 1.2799 | -38.0 % |
| filter-one-percent | 20 | 7,977 | 2.3089 | 2.4347 | +5.4 % |
| filter-none | 20 | 7,977 | 2.4370 | 2.5860 | +6.1 % |

### Corpus synthétique — p50 de la recherche publique

| Cas | k | Candidats | Recherche avant (ms) | Recherche après (ms) | Évolution |
|---|---:|---:|---:|---:|---:|
| exact | 20 | 10,000 | 1.0057 | 1.0252 | +1.9 % |
| exact | near | 10,000 | 3.8912 | 2.8800 | -26.0 % |
| equal-scores | near | 10,000 | 3.2878 | 1.7683 | -46.2 % |
| filter-half | 20 | 10,000 | 2.1824 | 1.1645 | -46.6 % |
| filter-one-percent | 20 | 10,000 | 2.3391 | 2.4365 | +4.2 % |
| filter-none | 20 | 10,000 | 2.8971 | 2.9176 | +0.7 % |

`near` signifie n − 1 **candidats bruts**, avant filtre. Le filtre peut donc
renvoyer bien moins de résultats que cette limite. Les requêtes `comprime`,
`comprime gelule`, `comprime pellicule` produisent respectivement 7 977, 9 526 et
3 778 candidats ; le fuzzy `dolipran` en produit 18, donc k = 20 utilise le chemin
complet. Pour le filtre à environ 50 %, k = 20 examine 36 candidats BDPM ; à
faible acceptation, il en examine 2 394. Le filtre sans correspondance examine
les 7 977 candidats et retourne zéro résultat.

Sur BDPM, le filtre à environ 50 % passe de
0.9754 à
0.1292 ms de
finalisation. Le gain se retrouve dans la recherche complète, autour de 38–40 %.
Le wildcard borné évite la Map et la majorité du parcours : gain supérieur à
99 % pour k = 20 sans boost ; environ 92 % avec le filtre simulant 1 % d'acceptation.

Le petit top-k sans filtre ne revendique aucun gain général de débit. Les timings
publics varient de quelques pourcents selon les passages. Un contrôle supplémentaire
alterne ancien et nouveau finaliseur **sur la même Map et dans le même processus**
(8 passages, 100 warmups, 200 itérations). Pour `comprime`, p50 vaut
0.1560 ms avant et
0.1573 ms après ;
pour l'OR, 0.1397 et
0.1387 ms.
Le chemin courant conserve son algorithme. Les faibles taux d'acceptation gardent
un surcoût mesuré de quelques pourcents dû au premier lot et au tri de secours.
Pour ces cas, comparer aussi à la recherche complète puis `.slice()` : filtrer
avant de trier peut être moins cher que classer tous les candidats.

La sonde synthétique matérialise exactement 20 résultats sans filtre pour k = 20,
et 40 pour le filtre à 50 %. Les résultats conservés après GC occupent environ
7.0 Kio pour k = 20 contre
3.36 Mio sans limite sur la requête exacte.
Une recherche complète puis `.slice()` conserve une mémoire finale similaire
à la recherche bornée : son coût supplémentaire est temporaire. Le chemin k = 1
supprime le buffer de scores de 8n octets (80 000 octets pour n = 10 000),
mais les Map de candidats des requêtes ordinaires restent O(n).

## Protocole et reproduction

Node 24.19.0, Linux x86-64, CPU AMD EPYC 9V74. Dépendances de la référence
installées avec le lockfile existant (pnpm 10.34.4). Les mises à jour de
dépendances de la mission précédente restent dans le worktree original.

Deux corpus : 10 000 documents synthétiques déterministes avec fréquences,
égalités et champs stockés variables ; fixture réelle BDPM de 15 848 spécialités
pharmaceutiques, chargée depuis le binaire versionné. Ses termes sont normalisés
sans accents : requêtes `comprime`, `gelule`, `pellicule`, `amox`, `dolipran`.
Les filtres réels utilisent des groupes stables d'identifiants pour faire varier
leur sélectivité ; ils ne représentent pas un filtre métier pharmaceutique.

Chaque combinaison vérifie d'abord l'équivalence complète, puis mesure :
exécution brute, finalisation d'une Map réutilisée, recherche complète puis
`.slice()`, et recherche publique avec `limit`. L'ordre des modes tourne entre
passages. Synthétique : 3 passages, 12 warmups et 20 itérations. Le contrôle sans correspondance utilise 5 passages, 20 warmups
et 30 itérations ; BDPM : 5 passages,
20 warmups et 30 itérations. p50 et p95 sont les médianes des quantiles par passage.
Les processus de benchmark s'exécutent successivement. Des checks fonctionnels
ont pu s'exécuter pendant les essais préliminaires ; les tables finales proviennent
des passages de confirmation.

Les compteurs de matérialisation instrumentent la finalisation synthétique,
séparément des timings. Les lignes BDPM comptent les appels au filtre, sans
instrumenter la matérialisation. L'exécution brute est toujours mesurée même
quand la recherche publique évite cette phase (zéro et wildcard borné).

Les mesures mémoire facultatives retiennent les résultats de 20 recherches puis
effectuent un GC, sur 3 passages. Elles mesurent la mémoire des résultats gardés,
pas les allocations temporaires ni le pic RSS. Les petits temps inférieurs à
10 microsecondes donnent surtout un ordre de grandeur.

```bash
pnpm benchmark:limit RUNS=3 BENCH_WARMUP=12 SEARCH_ITERATIONS=20
pnpm benchmark:limit RUNS=5 BENCH_WARMUP=20 SEARCH_ITERATIONS=30 \
  LIMIT_BENCH_ARGS='--corpus=bdpm-specialites --limits=0,1,20,near,Infinity --output=/tmp/limit-bdpm.json'
pnpm benchmark:limit RUNS=3 BENCH_WARMUP=12 SEARCH_ITERATIONS=20 \
  LIMIT_BENCH_ARGS='--cases=exact,wildcard,filter-half --limits=20,Infinity --memory --output=/tmp/limit-memory.json'
```

Pour comparer une autre révision, copier le même script de benchmark dans son
checkout et exécuter les mêmes commandes, avec le même Node et les mêmes outils.
Les sorties comparées et les empreintes des sources sont dans
[limit-audit-results.json](limit-audit-results.json).

## Validation et suites possibles

- `make test` : **672 tests réussis, 8 ignorés** (sources et parité).
- `make test-benchmarks` : **7 tests réussis**.
- `make test-browser` : **14 tests réussis** sur le bundle généré.
- `make lint` : typecheck, ESLint et frontière des imports internes réussis.
- `make knip`, build Rollup et vérification des trois bundles publics réussis.
- [Tests natifs du package](../dev/runtime/limit.test.mjs) : **6 tests réussis sur
  Node 20.0.0, puis 6 sur Node 24.19.0**, couvrant ESM, CommonJS, browser et
  chargement binaire. Le build et Vitest tournent sur Node 24 ; le produit publié
  conserve sa compatibilité avec Node 20. Exécution : `pnpm test:limit-runtime`
  après build, ou `make test-limit-runtime NODE=/chemin/vers/node20`.
- 159 configurations de benchmark sont consignées, dont 155 avec une référence
  comparable. Chaque configuration vérifie l'équivalence avant mesure.

Les mesures ne couvrent pas les collisions de champs stockés avec les métadonnées
moteur (`score`, `match`, etc.), ni les filtres qui modifient les scores ; les champs
stockés de ces corpus restent distincts des métadonnées. Aucun traitement spécial
n'est ajouté pour ces configurations.

Priorités suivantes : profiler les allocations temporaires et les Map de résultats
bruts sur les requêtes larges ; étudier une accumulation compacte des scores et
une construction tardive de `match`/`terms`. Mesurer le coût d'un second parcours
des postings avant de retenir cette approche. Une sélection avec interruption du
scoring vient ensuite, uniquement avec des bornes de score correctes pour les
options prises en charge. Les filtres à faible taux d'acceptation restent un cas
à suivre : `limit` ne permet pas de deviner quels documents seront acceptés.
