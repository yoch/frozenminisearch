import type {
  Options,
  OptionsWithDefaults,
  SearchOptions,
  SearchOptionsWithDefaults,
} from './searchTypes'
import {
  defaultAutoSuggestOptions,
  defaultFrozenLoadOptions,
  defaultSearchOptions,
} from './searchDefaults'

export function resolveSearchFilter(
  base: SearchOptions,
  override: SearchOptions,
): SearchOptions['filter'] {
  if (base.filter === undefined) return override.filter
  return override.filter !== undefined || Object.hasOwn(override, 'filter')
    ? override.filter
    : base.filter
}

export function resolveBoostDocument(
  base: SearchOptions,
  override: SearchOptions,
): SearchOptions['boostDocument'] {
  if (base.boostDocument === undefined) return override.boostDocument
  return override.boostDocument !== undefined ||
    Object.hasOwn(override, 'boostDocument')
    ? override.boostDocument
    : base.boostDocument
}

export function resolveSearchLimit(
  base: SearchOptions,
  override: SearchOptions,
): number | undefined {
  if (base.limit === undefined) return override.limit
  return override.limit !== undefined || Object.hasOwn(override, 'limit')
    ? override.limit
    : base.limit
}

export function mergeSearchOptions(
  base: SearchOptions,
  override?: SearchOptions,
): SearchOptions {
  if (override == null) {
    return {
      fields: base.fields,
      filter: base.filter,
      boost: base.boost,
      boostTerm: base.boostTerm,
      weights: base.weights,
      boostDocument: base.boostDocument,
      prefix: base.prefix,
      fuzzy: base.fuzzy,
      maxFuzzy: base.maxFuzzy,
      combineWith: base.combineWith,
      tokenize: base.tokenize,
      processTerm: base.processTerm,
      bm25: base.bm25,
      limit: base.limit,
    }
  }
  return {
    fields: override.fields ?? base.fields,
    filter: resolveSearchFilter(base, override),
    boost: override.boost ?? base.boost,
    boostTerm: override.boostTerm ?? base.boostTerm,
    weights: override.weights ?? base.weights,
    boostDocument: resolveBoostDocument(base, override),
    prefix: override.prefix ?? base.prefix,
    fuzzy: override.fuzzy ?? base.fuzzy,
    maxFuzzy: override.maxFuzzy ?? base.maxFuzzy,
    combineWith: override.combineWith ?? base.combineWith,
    tokenize: override.tokenize ?? base.tokenize,
    processTerm: override.processTerm ?? base.processTerm,
    bm25: override.bm25 ?? base.bm25,
    limit: resolveSearchLimit(base, override),
  }
}

export function mergeSearchOptionsWithDefaults(
  base: SearchOptionsWithDefaults,
  override?: SearchOptions,
): SearchOptionsWithDefaults {
  return mergeSearchOptions(base, override) as SearchOptionsWithDefaults
}

/** Keep query callbacks, but discard ingestion-only closures after building. */
export function frozenRuntimeOptions<T>(
  options: OptionsWithDefaults<T>,
): OptionsWithDefaults<T> {
  return {
    fields: options.fields,
    idField: options.idField,
    storeFields: options.storeFields,
    extractField: defaultFrozenLoadOptions.extractField,
    stringifyField: defaultFrozenLoadOptions.stringifyField,
    tokenize: options.tokenize,
    processTerm: options.processTerm,
    searchOptions: options.searchOptions,
    autoSuggestOptions: options.autoSuggestOptions,
  }
}

export function assertFieldsMatchSnapshot(
  optionsFields: readonly string[],
  indexedFieldIds: { [field: string]: number },
): void {
  const snapNames = Object.keys(indexedFieldIds).sort()
  const optNames = [...optionsFields].sort()
  if (
    snapNames.length !== optNames.length ||
    snapNames.some((name, i) => name !== optNames[i])
  ) {
    throw new Error(
      `FrozenMiniSearch: option "fields" must match the indexed fields exactly (expected: ${snapNames.join(', ')})`,
    )
  }
}

export function resolveFrozenOptions<T>(
  options: Options<T>,
  fallbackFields?: readonly string[],
): OptionsWithDefaults<T> {
  const fields =
    fallbackFields !== undefined && !options?.fields?.length
      ? fallbackFields
      : (options?.fields ?? fallbackFields)
  if (fields == null) {
    throw new Error('FrozenMiniSearch: option "fields" must be provided')
  }
  const searchOptions = mergeSearchOptionsWithDefaults(
    defaultSearchOptions,
    options.searchOptions,
  )
  const autoSuggestOptions = mergeSearchOptions(
    defaultAutoSuggestOptions,
    options.autoSuggestOptions,
  )
  if (
    options.autoSuggestOptions == null ||
    !Object.hasOwn(options.autoSuggestOptions, 'filter')
  ) {
    autoSuggestOptions.filter = searchOptions.filter
  }
  if (
    options.autoSuggestOptions == null ||
    !Object.hasOwn(options.autoSuggestOptions, 'boostDocument')
  ) {
    autoSuggestOptions.boostDocument = searchOptions.boostDocument
  }
  return {
    fields: fields as string[],
    idField: options.idField ?? defaultFrozenLoadOptions.idField,
    storeFields: options.storeFields ?? defaultFrozenLoadOptions.storeFields,
    extractField: options.extractField ?? defaultFrozenLoadOptions.extractField,
    stringifyField:
      options.stringifyField ?? defaultFrozenLoadOptions.stringifyField,
    tokenize: options.tokenize ?? defaultFrozenLoadOptions.tokenize,
    processTerm: options.processTerm ?? defaultFrozenLoadOptions.processTerm,
    searchOptions,
    autoSuggestOptions,
  }
}
