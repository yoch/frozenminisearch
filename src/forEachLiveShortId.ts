/** Visit shortIds with a defined external id (holes in `externalIds` are skipped). */
export function forEachLiveShortId(
  nextId: number,
  externalIds: readonly unknown[],
  callback: (shortId: number, externalId: unknown) => void,
): void {
  for (let shortId = 0; shortId < nextId; shortId++) {
    const externalId = externalIds[shortId]
    if (externalId === undefined) continue
    callback(shortId, externalId)
  }
}
