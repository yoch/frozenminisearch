/**
 * Compare PackedRadixTree structured-byte captures against the golden reference.
 * Mirrors benchmarks/diffBaseline.js semantics:
 *
 *   pnpm benchmark:packed-radix:diff        → packed-radix-latest.json vs reference (no re-run)
 *   pnpm benchmark:packed-radix:diff:run    → re-run bench → latest.json, then diff
 *   --current=... --reference=...           → compare arbitrary captures
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { argValue, pctDeltaRound } from './benchmarkUtils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINES = join(__dirname, 'baselines')
const GOLDEN = join(BASELINES, 'packed-radix-reference.json')
const LATEST = join(BASELINES, 'packed-radix-latest.json')

const argv = process.argv.slice(2)
const forceRun = argv.includes('--run')

function loadJson (path, hint) {
  if (!existsSync(path)) {
    console.error(`Fichier manquant : ${path}`)
    if (hint) console.error(hint)
    process.exit(1)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

function formatSigned (n, suffix = '') {
  if (n == null) return '—'
  const sign = n > 0 ? '+' : ''
  return `${sign}${n}${suffix}`
}

function compareCorpus (id, ref, cur) {
  const refBytes = ref?.bytes?.totalStructuredBytes
  const curBytes = cur?.bytes?.totalStructuredBytes
  if (refBytes == null || curBytes == null) {
    return { id, skip: true, reason: 'métrique absente' }
  }
  const delta = curBytes - refBytes
  const pct = pctDeltaRound(refBytes, curBytes)
  return { id, refBytes, curBytes, delta, pct, edges: cur?.edgeCount ?? ref?.edgeCount }
}

function printTable (rows, { refLabel, curLabel }) {
  console.log(`\n${refLabel} → ${curLabel} (bytes structurés ; plus bas = mieux)\n`)
  console.log('corpus                  ref        cur        Δ B      Δ %')
  for (const r of rows) {
    if (r.skip) {
      console.log(`${r.id.padEnd(22)}  —          —          —        ${r.reason}`)
      continue
    }
    const pctStr = r.pct == null ? '—' : formatSigned(r.pct, '%')
    const flag = r.delta < 0 ? ' ✓' : r.delta > 0 ? ' ⚠' : ''
    console.log(
      `${r.id.padEnd(22)}  ${String(r.refBytes).padStart(9)}  ${String(r.curBytes).padStart(9)}  `
      + `${formatSigned(r.delta).padStart(8)}  ${pctStr.padStart(7)}${flag}`,
    )
  }
}

function main () {
  const referencePath = argValue('--reference', argv) ?? GOLDEN
  const currentPath = forceRun ? LATEST : (argValue('--current', argv) ?? LATEST)

  if (forceRun) {
    console.log('Exécution benchmark:packed-radix → packed-radix-latest.json, puis comparaison au golden\n')
    execSync(
      'pnpm build-packed-radix-bench && node --expose-gc benchmarks/dist/packedRadixTree.cjs --record',
      { cwd: join(__dirname, '..'), stdio: 'inherit' },
    )
  } else {
    console.log(`Comparaison ${currentPath} → ${referencePath} (sans relance ; --run pour mesurer à nouveau)\n`)
  }

  const reference = loadJson(referencePath)
  const current = loadJson(
    currentPath,
    'Lancez : pnpm benchmark:packed-radix:diff:run (mesure puis compare).',
  )

  const refMeta = reference.metadata
  const curMeta = current.metadata
  if (refMeta?.capturedAt) {
    console.log(`Référence : ${referencePath} (${refMeta.capturedAt})`)
    if (refMeta.baselineCommit) console.log(`  commit référence : ${refMeta.baselineCommit.slice(0, 12)}…`)
  }
  if (curMeta?.capturedAt) {
    console.log(`Actuel    : ${currentPath} (${curMeta.capturedAt})${curMeta.git?.dirty ? ' (dirty)' : ''}`)
  }

  const ids = [...new Set([
    ...Object.keys(reference.corpora ?? {}),
    ...Object.keys(current.corpora ?? {}),
  ])].sort()

  const rows = ids.map((id) => compareCorpus(
    id,
    reference.corpora[id],
    current.corpora[id],
  ))
  printTable(rows, { refLabel: 'référence (golden)', curLabel: 'mesure' })
}

main()
