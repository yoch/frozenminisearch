import { loadData, setIndex, init, ready } from '../shared.js'
import FrozenMiniSearch from './frozenminisearch.js'

init(1965, 2015)

loadData('billboard_1965-2015.json')
  .then((allSongs) => {
    const index = FrozenMiniSearch.fromDocuments(allSongs, {
      fields: ['artist', 'title'],
      storeFields: ['year'],
    })
    setIndex(index)
  })
  .then(ready)