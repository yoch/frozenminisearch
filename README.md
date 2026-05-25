# @yoch/minisearch

Moteur de recherche full-text en mémoire pour **Node.js**, dérivé de [MiniSearch](https://github.com/lucaong/minisearch) par [Luca Ongaro](https://github.com/lucaong/minisearch).

Ce fork ajoute un index **lecture seule** (`FrozenMiniSearch`) et une sérialisation **binaire** pour servir ou recharger un index plus vite et avec moins de RAM que le JSON.

**Version actuelle :** `8.0.0-beta.1` (canal npm `beta`).

## Installation

```bash
npm install @yoch/minisearch
# ou
yarn add @yoch/minisearch
```

```javascript
// ESM
import MiniSearch, { FrozenMiniSearch, buildFrozenFromDocuments } from '@yoch/minisearch'

// CommonJS
const MiniSearch = require('@yoch/minisearch')
const { FrozenMiniSearch, buildFrozenFromDocuments } = require('@yoch/minisearch')
```

Build local : `yarn build` → `dist/` (ESM + CJS).

## Quel chemin utiliser ?

| Besoin | API |
|--------|-----|
| Index évolutif (`add`, `remove`, `discard`, vacuum) | `MiniSearch` puis `freeze()` si besoin |
| Corpus fixe, index frozen direct (one-shot) | `FrozenMiniSearch.fromDocuments(documents, options)` |
| Recharger un snapshot disque | `FrozenMiniSearch.loadBinary(buffer, options)` |
| Pipeline custom (buffers déjà construits) | `assembleFrozen(params)` ou `buildFrozenFromDocuments` |

`fromDocuments` produit les **mêmes résultats de recherche** que `new MiniSearch(options).addAll(documents).freeze()` pour le même corpus et les mêmes options (`fields`, `tokenize`, `processTerm`, etc.). Pas de `add` / `remove` sur un index frozen.

## FrozenMiniSearch

### Construction one-shot (recommandé si le corpus est fixe)

```javascript
import { FrozenMiniSearch } from '@yoch/minisearch'

const options = { fields: ['title', 'text'], storeFields: ['title'] }

const frozen = FrozenMiniSearch.fromDocuments(documents, options)
const buffer = frozen.saveBinary()

const loaded = FrozenMiniSearch.loadBinary(buffer, options)
loaded.search('ishmael')
loaded.autoSuggest('zen')
```

### Construction via index mutable

Utile si vous indexez progressivement ou devez `remove` / `discard` avant de figer l’index :

```javascript
import MiniSearch, { FrozenMiniSearch } from '@yoch/minisearch'

const options = { fields: ['title', 'text'], storeFields: ['title'] }

const index = new MiniSearch(options)
index.addAll(documents)

const frozen = index.freeze()
const buffer = frozen.saveBinary()
const loaded = FrozenMiniSearch.loadBinary(buffer, options)
```

### Détails

- **`freeze()`** : snapshot immuable, postings compacts (TypedArrays), recherche en général plus rapide qu’un index mutable.
- **`saveBinary()` / `loadBinary()`** : format **MSv2** en écriture, **MSv1** toujours lisible ; mêmes `fields` et, si personnalisés, mêmes `tokenize` / `processTerm` qu’à la construction.
- **Fréquences** : clamp à 255 par document/terme en frozen (Uint8) ; impact score seulement si tf très élevé.
- **`toJSON` / `loadJSON`** sur `MiniSearch` : inchangés.

### Exports avancés

```javascript
import {
  FrozenMiniSearch,
  buildFrozenFromDocuments,
  assembleFrozen,
  freezeFromMiniSearch,
  frozenMemoryBreakdown
} from '@yoch/minisearch'
```

- `buildFrozenFromDocuments` — équivalent à `FrozenMiniSearch.fromDocuments`
- `assembleFrozen` — instancier un frozen à partir de buffers déjà construits
- `freezeFromMiniSearch` — convertir un `MiniSearch` mutable existant
- `frozenMemoryBreakdown` — profil mémoire pour benchmarks / debug

## MiniSearch (index mutable)

Même API que l’original : champs indexés, prefix, fuzzy, boosting, `autoSuggest`, requêtes OR / AND / AND_NOT, etc.

```javascript
import MiniSearch from '@yoch/minisearch'

const miniSearch = new MiniSearch({ fields: ['title', 'text'] })
miniSearch.addAll(documents)
miniSearch.search('zen art motorcycle')
```

Types TypeScript : `dist/es/index.d.ts`.

## Développement

```bash
yarn install
yarn test
yarn build
yarn benchmark:compare    # mutable vs frozen vs binaire
yarn benchmark:diff       # vs baseline versionnée
```

## Compatibilité

Node.js **ES2018+** uniquement. Pas de bundle navigateur (UMD / CDN).

## Changelog

Voir [CHANGELOG.md](./CHANGELOG.md).

## Crédits

- **MiniSearch** — [Luca Ongaro](https://github.com/lucaong/minisearch) (MIT).
- Ce dépôt : [yoch/minisearch](https://github.com/yoch/minisearch) — extensions `FrozenMiniSearch`, format binaire MSv1/MSv2, build Node-only.

Documentation du projet d’origine : [site](https://lucaong.github.io/minisearch/), [article](https://lucaongaro.eu/blog/2019/01/30/minisearch-client-side-fulltext-search-engine.html).
