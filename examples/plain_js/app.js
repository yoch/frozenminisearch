import { loadData, setIndex, init, ready } from '../shared.js'

init(1965, 2015)

loadData('billboard_1965-2015.json')
  .then((allSongs) => {
    const miniSearch = new MiniSearch({
      fields: ['artist', 'title'],
      storeFields: ['year'],
    })
    setIndex(miniSearch)
    return miniSearch.addAll(allSongs)
  })
  .then(ready)