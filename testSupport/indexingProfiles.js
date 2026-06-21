import { camelCaseTokenize } from './camelCaseTokenizer.js'
import {
  vocsIndexingDocs,
  vocsIndexingOptions,
  vocsIndexingQueries,
} from './vocsIndexingFixture.js'

const defaultDocs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea', category: 'fiction' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance', category: 'fiction' },
  { id: 3, title: 'Neuromancer', text: 'cyberspace matrix hacker', category: 'sci-fi' },
  { id: 4, title: 'Zen Archery', text: 'zen archery art practice', category: 'non-fiction' },
]

const defaultOptions = {
  fields: ['title', 'text'],
  storeFields: ['title', 'category'],
  searchOptions: { prefix: true, fuzzy: 0.2 },
}

const defaultQueries = [
  'zen',
  'zen whale',
  'neur',
  'ishmael',
]

const camelCaseDocs = [
  { id: 'create-user', title: 'createUser', text: 'Create a new user with the API.' },
]

const camelCaseOptions = {
  fields: ['title', 'text'],
  storeFields: ['title'],
  tokenize: camelCaseTokenize,
  searchOptions: { prefix: true, fuzzy: 0.2, tokenize: camelCaseTokenize },
}

const camelCaseQueries = ['create', 'user', 'createuser']

const processTermDocs = [
  { id: 1, text: 'the quick brown fox' },
  { id: 2, text: 'a lazy dog' },
]

const processTermOptions = {
  fields: ['text'],
  processTerm: term => {
    const lower = term.toLowerCase()
    if (lower === 'the') return false
    if (lower === 'a') return null
    return lower
  },
  searchOptions: { prefix: true },
}

const processTermQueries = ['quick', 'dog', 'lazy', 'the']

const processTermArrayDocs = [
  { id: 'combo', text: 'ComboTerm repeated repeated' },
  { id: 'plain', text: 'plain token' },
]

const processTermArrayOptions = {
  fields: ['text'],
  processTerm: term => {
    const lower = term.toLowerCase()
    if (lower === 'comboterm') return ['combo', 'term']
    return lower
  },
  searchOptions: { prefix: true },
}

const processTermArrayQueries = ['combo', 'term', 'repeated', 'comboterm']

const stringifyFieldDocs = [
  { id: 'string-title', title: 'VisibleTitle', tags: ['alpha', 'beta'] },
  { id: 'object-title', title: { label: 'ObjectTitle' }, tags: ['gamma'] },
]

const stringifyFieldOptions = {
  fields: ['title', 'tags'],
  storeFields: ['title'],
  stringifyField: (value, fieldName) => {
    if (fieldName === 'title' && typeof value === 'string') return `${value} stringified`
    if (fieldName === 'title' && value?.label != null) return value.label
    if (Array.isArray(value)) return value.join(' ')
    return String(value)
  },
  searchOptions: { prefix: true },
}

const stringifyFieldQueries = ['stringified', 'visibletitle', 'objecttitle', 'alpha']

/** @type {Array<{ name: string, docs: object[], options: object, queries: string[] }>} */
export const indexingProfiles = [
  { name: 'default', docs: defaultDocs, options: defaultOptions, queries: defaultQueries },
  { name: 'camelCase', docs: camelCaseDocs, options: camelCaseOptions, queries: camelCaseQueries },
  { name: 'processTerm', docs: processTermDocs, options: processTermOptions, queries: processTermQueries },
  {
    name: 'processTermArray',
    docs: processTermArrayDocs,
    options: processTermArrayOptions,
    queries: processTermArrayQueries,
  },
  {
    name: 'stringifyField',
    docs: stringifyFieldDocs,
    options: stringifyFieldOptions,
    queries: stringifyFieldQueries,
  },
  {
    name: 'vocs',
    docs: vocsIndexingDocs,
    options: vocsIndexingOptions,
    queries: vocsIndexingQueries,
  },
]

export {
  defaultDocs,
  defaultOptions,
  defaultQueries,
  camelCaseDocs,
  camelCaseOptions,
  camelCaseTokenize,
  vocsIndexingOptions,
}
