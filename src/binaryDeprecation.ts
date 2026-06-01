const warnedFormats = new Set<string>()
const warnedBinaryApi = new Set<'saveBinary' | 'loadBinary'>()

/** @internal Resets one-time deprecation warnings (tests only). */
export function resetDeprecatedBinaryWarningsForTests(): void {
  warnedFormats.clear()
  warnedBinaryApi.clear()
}

/** One `DeprecationWarning` per legacy magic per process when loading MSv3/MSv4 snapshots. */
export function warnDeprecatedBinaryFormat(magic: 'MSv3' | 'MSv4'): void {
  if (warnedFormats.has(magic)) return
  warnedFormats.add(magic)
  process.emitWarning(
    `${magic} frozen binary snapshots are deprecated; re-save with saveBinarySync() (MSv5). `
    + 'Support may be removed in a future major version.',
    { type: 'DeprecationWarning', code: `MINISEARCH_${magic}_DEPRECATED` },
  )
}

/** One `DeprecationWarning` per API name when using implicit sync save/load helpers. */
export function warnDeprecatedBinaryApi(api: 'saveBinary' | 'loadBinary'): void {
  if (warnedBinaryApi.has(api)) return
  warnedBinaryApi.add(api)
  const sync = `${api}Sync`
  const async = `${api}Async`
  process.emitWarning(
    `FrozenMiniSearch.${api}() is deprecated; use ${sync}() or ${async}() explicitly.`,
    { type: 'DeprecationWarning', code: `MINISEARCH_${api.toUpperCase()}_DEPRECATED` },
  )
}
