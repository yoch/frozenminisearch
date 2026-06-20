import FrozenMiniSearch from '../../dist/browser/index.js'

const options = {
  fields: ['artist', 'title'],
  storeFields: ['year'],
}

const $app = document.querySelector('.App')
const $search = document.querySelector('.Search')
const $searchInput = document.querySelector('.Search input')
const $clearButton = document.querySelector('.Search button.clear')
const $songList = document.querySelector('.SongList')
const $suggestionList = document.querySelector('.SuggestionList')
const $options = document.querySelector('.AdvancedOptions form')

$app.classList.add('loading')
let songsById = {}
let miniSearch = null

fetch('../plain_js/billboard_1965-2015.json')
  .then(response => response.json())
  .then((allSongs) => {
    songsById = allSongs.reduce((byId, song) => {
      byId[song.id] = song
      return byId
    }, {})
    miniSearch = FrozenMiniSearch.fromDocuments(allSongs, options)
  }).then(() => {
    $app.classList.remove('loading')
  })

$searchInput.addEventListener('input', () => {
  const query = $searchInput.value
  const results = (query.length > 1) ? getSearchResults(query) : []
  renderSearchResults(results)
  const suggestions = (query.length > 1) ? getSuggestions(query) : []
  renderSuggestions(suggestions)
})

$clearButton.addEventListener('click', () => {
  $searchInput.value = ''
  $searchInput.focus()
  renderSearchResults([])
  renderSuggestions([])
})

$suggestionList.addEventListener('click', (event) => {
  const $suggestion = event.target
  if ($suggestion.classList.contains('Suggestion')) {
    const query = $suggestion.innerText.trim()
    $searchInput.value = query
    $searchInput.focus()
    renderSearchResults(getSearchResults(query))
    renderSuggestions([])
  }
})

$search.addEventListener('keydown', (event) => {
  const key = event.key
  if (key === 'ArrowDown') {
    selectSuggestion(+1)
  } else if (key === 'ArrowUp') {
    selectSuggestion(-1)
  } else if (key === 'Enter' || key === 'Escape') {
    $searchInput.blur()
    renderSuggestions([])
  } else {
    return
  }
  const query = $searchInput.value
  renderSearchResults(getSearchResults(query))
})

$app.addEventListener('click', () => {
  renderSuggestions([])
})

$options.addEventListener('change', () => {
  const query = $searchInput.value
  renderSearchResults(getSearchResults(query))
})

const getSearchResults = (query) => {
  if (miniSearch == null) return []
  return miniSearch.search(query, getSearchOptions()).map(({ id }) => songsById[id])
}

const getSuggestions = (query) => {
  if (miniSearch == null) return []
  return miniSearch.autoSuggest(query, { boost: { artist: 5 } })
    .filter(({ suggestion, score }, _, [first]) => score > first.score / 4)
    .slice(0, 5)
}

const renderSearchResults = (results) => {
  $songList.innerHTML = results.map(({ artist, title, year, rank }) => {
    return `<li class="Song">
      <h3>${capitalize(title)}</h3>
      <dl>
        <dt>Artist:</dt> <dd>${capitalize(artist)}</dd>
        <dt>Year:</dt> <dd>${year}</dd>
        <dt>Billbord Position:</dt> <dd>${rank}</dd>
      </dl>
    </li>`
  }).join('\n')

  if (results.length > 0) {
    $app.classList.add('hasResults')
  } else {
    $app.classList.remove('hasResults')
  }
}

const renderSuggestions = (suggestions) => {
  $suggestionList.innerHTML = suggestions.map(({ suggestion }) => {
    return `<li class="Suggestion">${suggestion}</li>`
  }).join('\n')

  if (suggestions.length > 0) {
    $app.classList.add('hasSuggestions')
  } else {
    $app.classList.remove('hasSuggestions')
  }
}

const selectSuggestion = (direction) => {
  const $suggestions = document.querySelectorAll('.Suggestion')
  const $selected = document.querySelector('.Suggestion.selected')
  const index = Array.from($suggestions).indexOf($selected)

  if (index > -1) {
    $suggestions[index].classList.remove('selected')
  }

  const nextIndex = Math.max(Math.min(index + direction, $suggestions.length - 1), 0)
  $suggestions[nextIndex].classList.add('selected')
  $searchInput.value = $suggestions[nextIndex].innerText
}

const getSearchOptions = () => {
  const formData = new FormData($options)
  const searchOptions = {}

  searchOptions.fuzzy = formData.has('fuzzy') ? 0.2 : false
  searchOptions.prefix = formData.has('prefix')
  searchOptions.fields = formData.getAll('fields')
  searchOptions.combineWith = formData.get('combineWith')

  const fromYear = parseInt(formData.get('fromYear'), 10)
  const toYear = parseInt(formData.get('toYear'), 10)

  searchOptions.filter = (result) => {
    const song = songsById[result.id]
    const year = parseInt(song.year, 10)
    return year >= fromYear && year <= toYear
  }

  return searchOptions
}

const capitalize = (string) => string.replace(/(\b\w)/gi, (char) => char.toUpperCase())
