import type { FrozenExternalIds } from './frozenExternalIds'

/** Visit shortIds with a defined external id (holes in `externalIds` are skipped). */
export function forEachLiveShortId(
  nextId: number,
  externalIds: FrozenExternalIds,
  callback: (shortId: number, externalId: unknown) => void,
): void {
  if (externalIds == null) {
    for (let shortId = 0; shortId < nextId; shortId++) callback(shortId, shortId)
    return
  }
  for (let shortId = 0; shortId < nextId; shortId++) {
    const externalId = externalIds[shortId]
    if (externalId === undefined) continue
    callback(shortId, externalId)
  }
}
