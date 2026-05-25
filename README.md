# @yoch/minisearch

Moteur de recherche full-text en mémoire pour **Node.js**, dérivé de [MiniSearch](https://github.com/lucaong/minisearch) par [Luca Ongaro](https://github.com/lucaong).

Ce fork ajoute un index **lecture seule** (`FrozenMiniSearch`) et une sérialisation **binaire** pour servir ou recharger un index plus vite et avec moins de RAM que le JSON.

## Installation

```bash
npm install @yoch/minisearch
# ou
yarn add @yoch/minisearch
```

```javascript
import MiniSearch, { FrozenMiniSearch } from '@yoch/minisearch'

const MiniSearch = require('@yoch/minisearch')
const { FrozenMiniSearch } = require('@yoch/minisearch')
```

Build local : `yarn build` → `dist/` (ESM + CJS, sans source maps).

## FrozenMiniSearch

```javascript
import MiniSearch, { FrozenMiniSearch } from '@yoch/minisearch'

const options = { fields: ['title', 'text'], storeFields: ['title'] }

const index = new MiniSearch(options)
index.addAll(documents)

const frozen = index.freeze()
const buffer = frozen.saveBinary()

const loaded = FrozenMiniSearch.loadBinary(buffer, options)
loaded.search('ishmael')
loaded.autoSuggest('zen')
```

- `freeze()` : index immuable, postings compacts (TypedArrays), recherche plus rapide.
- `saveBinary()` / `loadBinary()` : format MSv2 (lecture MSv1) ; mêmes `fields` et, si personnalisés, mêmes `tokenize` / `processTerm` qu’à la construction.
- `add` / `remove` / `discard` : interdits sur frozen ; reconstruire depuis `MiniSearch` si le corpus change.
- `toJSON` / `loadJSON` sur `MiniSearch` : inchangés.

## MiniSearch (index mutable)

Même API que l’original pour l’indexation : champs indexés, prefix, fuzzy, boosting, `autoSuggest`, requêtes OR / AND / AND_NOT, etc.

```javascript
import MiniSearch from '@yoch/minisearch'

const miniSearch = new MiniSearch({ fields: ['title', 'text'] })
miniSearch.addAll(documents)
miniSearch.search('zen art motorcycle')
```

Types TypeScript : `dist/es/index.d.ts`.

## Compatibilité

Node.js **ES2018+** uniquement. Pas de bundle navigateur (UMD / CDN).

## Changelog

Voir [CHANGELOG.md](./CHANGELOG.md).

## Crédits

- **MiniSearch** — [Luca Ongaro](https://github.com/lucaong) — [lucaong/minisearch](https://github.com/lucaong/minisearch) (MIT).
- Ce dépôt : [yoch/minisearch](https://github.com/yoch/minisearch) — extensions `FrozenMiniSearch`, format binaire, build Node-only.

Pour la documentation historique et le contexte du projet d’origine : [site du projet](https://lucaong.github.io/minisearch/), [article de présentation](https://lucaongaro.eu/blog/2019/01/30/minisearch-client-side-fulltext-search-engine.html).
