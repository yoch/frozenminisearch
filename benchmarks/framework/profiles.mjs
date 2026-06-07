/** Benchmark profile identifiers (plan § 6). */
export const PROFILES = {
  VS_REFERENCE: 'vs-reference',
  REGRESSION: 'regression',
  DEV: 'dev',
}

export function parseProfile(argv) {
  const flag = argv.find(a => a.startsWith('--profile='))
  if (flag) return flag.split('=')[1]
  if (argv.includes('--quick')) return PROFILES.DEV
  return PROFILES.REGRESSION
}
