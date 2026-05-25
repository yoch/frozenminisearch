import type { Options } from './MiniSearch'
import {
  defaultSearchOptions,
  defaultAutoSuggestOptions,
  defaultFrozenLoadOptions
} from './searchDefaults'

export type IndexingOptions<T> = Options<T> & {
  storeFields: string[]
  idField: string
  extractField: (document: T, fieldName: string) => any
  stringifyField: (fieldValue: any, fieldName: string) => string
  tokenize: (text: string, fieldName: string) => string[]
  processTerm: (term: string, fieldName: string) => string | string[] | null | undefined | false
  searchOptions: typeof defaultSearchOptions
  autoSuggestOptions: typeof defaultAutoSuggestOptions
  fields: string[]
}

export function resolveIndexingOptions<T> (options: Options<T>): IndexingOptions<T> {
  if (options?.fields == null) {
    throw new Error('MiniSearch: option "fields" must be provided')
  }
  return {
    ...defaultFrozenLoadOptions,
    ...options,
    searchOptions: { ...defaultSearchOptions, ...(options.searchOptions || {}) },
    autoSuggestOptions: { ...defaultAutoSuggestOptions, ...(options.autoSuggestOptions || {}) }
  } as IndexingOptions<T>
}

export function buildFieldIds (fields: string[]): { [key: string]: number } {
  const fieldIds: { [key: string]: number } = {}
  for (let i = 0; i < fields.length; i++) {
    fieldIds[fields[i]] = i
  }
  return fieldIds
}

/** Token frequencies for one document field (after processTerm). */
export function collectFieldTermFreqs (
  tokens: string[],
  fieldName: string,
  processTerm: IndexingOptions<unknown>['processTerm']
): Map<string, number> {
  const localFreqs = new Map<string, number>()
  for (const term of tokens) {
    const processedTerm = processTerm(term, fieldName)
    if (Array.isArray(processedTerm)) {
      for (const t of processedTerm) {
        localFreqs.set(t, (localFreqs.get(t) || 0) + 1)
      }
    } else if (processedTerm) {
      localFreqs.set(processedTerm, (localFreqs.get(processedTerm) || 0) + 1)
    }
  }
  return localFreqs
}

/** Same running average as {@link MiniSearch} private addFieldLength. */
export function updateAvgFieldLength (
  avgFieldLength: number[],
  fieldId: number,
  count: number,
  length: number
): void {
  const averageFieldLength = avgFieldLength[fieldId] || 0
  const totalFieldLength = (averageFieldLength * count) + length
  avgFieldLength[fieldId] = totalFieldLength / (count + 1)
}

export function saveStoredFieldsForDocument<T> (
  storeFields: string[],
  extractField: IndexingOptions<T>['extractField'],
  document: T
): Record<string, unknown> | undefined {
  if (storeFields.length === 0) return undefined
  const documentFields: Record<string, unknown> = {}
  for (const fieldName of storeFields) {
    const fieldValue = extractField(document, fieldName)
    if (fieldValue !== undefined) documentFields[fieldName] = fieldValue
  }
  return documentFields
}
