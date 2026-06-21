import { camelCaseTokenize } from './camelCaseTokenizer.js'

const searchFields = ['category', 'subtitle', 'text', 'title', 'titles']
const storeFields = [
  'category', 'href', 'searchPriority', 'subtitle', 'text', 'title', 'titles', 'type',
]

function boostDocument (_id, _term, storedFields) {
  const priority = storedFields?.searchPriority ?? 1
  const href = storedFields?.href
  const isDocsPath = href?.startsWith('/docs/')
  const segments = href ? href.split('/').filter(Boolean).length : 1
  const depth = isDocsPath ? Math.max(segments - 1, 1) : segments
  const depthBoost = 1 / Math.max(depth, 1)
  const docsBoost = isDocsPath ? 1.5 : 1
  return priority * depthBoost * docsBoost
}

export const vocsIndexingDocs = [
  {
    category: '',
    href: '/config#configuration',
    id: '/docs/config.mdx#configuration',
    searchPriority: 1,
    subtitle: '',
    text: ' Config setup guide.',
    title: 'Configuration',
    titles: [],
    type: 'page',
  },
  {
    category: '',
    href: '/advanced#configuration',
    id: '/docs/advanced.mdx#configuration',
    searchPriority: 10,
    subtitle: '',
    text: ' Advanced configuration options.',
    title: 'Configuration',
    titles: [],
    type: 'page',
  },
  {
    category: 'API',
    href: '/docs/api/users#create-user',
    id: '/docs/api/users.mdx#create-user',
    searchPriority: undefined,
    subtitle: '',
    text: ' Create a new user with the API.',
    title: 'createUser',
    titles: ['Users'],
    type: 'section',
  },
]

export const vocsIndexingQueries = ['configuration', 'create', 'configration']

export const vocsIndexingOptions = {
  idField: 'id',
  fields: searchFields,
  storeFields,
  tokenize: camelCaseTokenize,
  searchOptions: {
    boost: { title: 4, subtitle: 3, text: 2, category: 1, titles: 1 },
    boostDocument,
    combineWith: 'AND',
    fuzzy: 0.2,
    prefix: true,
    tokenize: camelCaseTokenize,
  },
}
