/** Activatable benchmark surfaces. */
export const ALL_SURFACES = ['build', 'search', 'search-levels', 'save', 'load', 'memory', 'breakdown', 'migrate', 'drift']

const STRUCTURAL_SURFACES = new Set(['build', 'save', 'load', 'memory', 'breakdown', 'migrate', 'drift'])

export function parseSurfaces(argv, profile) {
  const flag = argv.find(a => a.startsWith('--surfaces='))
  if (flag) {
    return normalizeSurfaceList(flag.split('=')[1].split(','))
  }
  if (profile === 'dev') return ['search']
  if (profile === 'vs-reference') {
    return ['search', 'search-levels', 'memory', 'build', 'save', 'load', 'migrate', 'drift']
  }
  return [...ALL_SURFACES]
}

/** Parse `BENCH_SURFACES` env (comma-separated) or return null when unset. */
export function surfacesFromEnv(envStr) {
  if (!envStr) return null
  return normalizeSurfaceList(envStr.split(','))
}

function normalizeSurfaceList(parts) {
  const list = parts.map(s => s.trim()).filter(Boolean)
  if (list.includes('all')) return [...ALL_SURFACES]
  return list
}

export function computeSurfaceNeeds(surfaces) {
  const s = new Set(surfaces)
  return {
    searchOnly: s.size === 1 && s.has('search'),
    search: s.has('search') || s.has('search-levels'),
    searchLevels: s.has('search-levels'),
    build: s.has('build'),
    save: s.has('save'),
    load: s.has('load'),
    memory: s.has('memory'),
    breakdown: s.has('breakdown'),
    migrate: s.has('migrate'),
    drift: s.has('drift'),
  }
}

export function hasStructuralSurfaces(surfaces) {
  return surfaces.some(name => STRUCTURAL_SURFACES.has(name))
}

export function isCpuOnlySurfaces(surfaces) {
  return !hasStructuralSurfaces(surfaces)
}
