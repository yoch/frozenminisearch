import type { IdToShortIdLookup } from './frozenIdLookup'

/** Retained external ids; `null` means identity ids (`externalId === shortId` for every shortId below `nextId`). */
export type FrozenExternalIds = readonly unknown[] | null

export function compactExternalIds(
  externalIds: readonly unknown[],
  idLookup: IdToShortIdLookup,
): FrozenExternalIds {
  return idLookup.mode === 'identity' ? null : externalIds
}

function identityExternalId(docId: number): unknown {
  return docId
}

export function externalIdResolver(externalIds: FrozenExternalIds): (docId: number) => unknown {
  if (externalIds == null) return identityExternalId
  return docId => externalIds[docId]
}

/** Dense array form for export paths (JSON, binary save). */
export function materializeExternalIds(externalIds: FrozenExternalIds, nextId: number): unknown[] {
  if (externalIds != null) return externalIds as unknown[]
  const out: unknown[] = new Array(nextId)
  for (let i = 0; i < nextId; i++) out[i] = i
  return out
}
