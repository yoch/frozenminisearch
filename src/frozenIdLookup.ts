export type IdLookupMode = 'identity' | 'lazy-map'

export interface IdToShortIdLookup {
  readonly mode: IdLookupMode
  readonly mapEntryCount: number
  has(id: unknown): boolean
  get(id: unknown): number | undefined
}

function detectIdentityNumericIds(externalIds: readonly unknown[], nextId: number): boolean {
  if (nextId === 0) return true
  for (let i = 0; i < nextId; i++) {
    if (externalIds[i] !== i) return false
  }
  return true
}

function buildLazyMap(externalIds: readonly unknown[], nextId: number): Map<unknown, number> {
  const map = new Map<unknown, number>()
  for (let i = 0; i < nextId; i++) {
    const id = externalIds[i]
    if (id !== undefined) map.set(id, i)
  }
  return map
}

export function createIdToShortIdLookup(
  externalIds: readonly unknown[],
  nextId: number,
): IdToShortIdLookup {
  if (detectIdentityNumericIds(externalIds, nextId)) {
    return {
      mode: 'identity',
      mapEntryCount: 0,
      has(id) {
        return typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < nextId
      },
      get(id) {
        if (typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < nextId) {
          return id
        }
        return undefined
      },
    }
  }

  let map: Map<unknown, number> | undefined
  const ensureMap = (): Map<unknown, number> => {
    if (map == null) map = buildLazyMap(externalIds, nextId)
    return map
  }

  return {
    mode: 'lazy-map',
    get mapEntryCount() {
      return map?.size ?? 0
    },
    has(id) {
      return ensureMap().has(id)
    },
    get(id) {
      return ensureMap().get(id)
    },
  }
}
