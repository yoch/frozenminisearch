import type { Options, OptionsWithDefaults } from './searchTypes'
import {
  defaultAutoSuggestOptions,
  defaultFrozenLoadOptions,
  defaultSearchOptions,
} from './searchDefaults'

export function assertFieldsMatchSnapshot(
  optionsFields: readonly string[],
  indexedFieldIds: { [field: string]: number },
): void {
  const snapNames = Object.keys(indexedFieldIds).sort()
  const optNames = [...optionsFields].sort()
  if (snapNames.length !== optNames.length || snapNames.some((name, i) => name !== optNames[i])) {
    throw new Error(
      `FrozenMiniSearch: option "fields" must match the indexed fields exactly (expected: ${snapNames.join(', ')})`,
    )
  }
}

export function resolveFrozenOptions<T>(
  options: Options<T>,
  fallbackFields?: readonly string[],
): OptionsWithDefaults<T> {
  const fields = options?.fields ?? fallbackFields
  if (fields == null) {
    throw new Error('FrozenMiniSearch: option "fields" must be provided')
  }
  return {
    ...defaultFrozenLoadOptions,
    ...options,
    fields,
    searchOptions: { ...defaultSearchOptions, ...(options.searchOptions || {}) },
    autoSuggestOptions: { ...defaultAutoSuggestOptions, ...(options.autoSuggestOptions || {}) },
  } as OptionsWithDefaults<T>
}
