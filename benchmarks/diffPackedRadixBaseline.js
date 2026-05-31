/**
 * Compare PackedRadixTree benchmark JSON captures.
 *
 *   yarn benchmark:packed-radix:diff
 *     → packed-radix-reference.json vs packed-radix-pre-phase1.json (gains Phase 1)
 *
 *   yarn benchmark:packed-radix:diff --run
 *     → re-run bench, compare to golden reference (régression structurée)
 *
 *   --current=... --reference=...  → comparaison libre
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { argValue, pctDeltaRound } from './benchmarkUtils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINES = join(__dirname, 'baselines')
const GOLDEN = join(BASELINES, 'packed-radix-reference.json')
const PRE_PHASE1 = join(BASELINES, 'packed-radix-pre-phase1.json')
const LATEST = join(BASELINES, 'packed-radix-latest.json')

const argv = process.argv.slice(2)
const forceRun = argv.includes('--run')
const phase1Mode = !forceRun && !argv.some((a) => a.startsWith('--current=') || a.startsWith('--reference='))

function loadJson (path) {
  if (!existsSync(path)) {
    console.error(`Fichier manquant : ${path}`)
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

function printTable (rows, { refLabel, curLabel, lowerIsBetter }) {
  console.log(`\n${refLabel} → ${curLabel} (bytes structurés)\n`)
  console.log('corpus                  ref        cur        Δ B      Δ %')
  for (const r of rows) {
    if (r.skip) {
      console.log(`${r.id.padEnd(22)}  —          —          —        ${r.reason}`)
      continue
    }
    const pctStr = r.pct == null ? '—' : formatSigned(r.pct, '%')
    const flag = lowerIsBetter
      ? (r.delta < 0 ? ' ✓' : r.delta > 0 ? ' ⚠' : '')
      : (r.delta > 0 ? ' ✓' : r.delta < 0 ? ' ⚠' : '')
    console.log(
      `${r.id.padEnd(22)}  ${String(r.refBytes).padStart(9)}  ${String(r.curBytes).padStart(9)}  `
      + `${formatSigned(r.delta).padStart(8)}  ${pctStr.padStart(7)}${flag}`,
    )
  }
}

function main () {
  let currentPath = argValue('--current', argv)
  let referencePath = argValue('--reference', argv)

  if (forceRun) {
    referencePath = referencePath ?? GOLDEN
    currentPath = LATEST
    console.log('Exécution benchmark:packed-radix → packed-radix-latest.json\n')
    execSync(
      'npm run build-packed-radix-bench && node --expose-gc benchmarks/dist/packedRadixTree.cjs --record baselines/packed-radix-latest.json',
      { cwd: join(__dirname, '..'), stdio: 'inherit' },
    )
  } else if (phase1Mode) {
    referencePath = PRE_PHASE1
    currentPath = currentPath ?? GOLDEN
    console.log('Comparaison Phase 1 : pré-optimisation (edgeFirstChar) → référence actuelle (post-optimisation)\n')
    const pre = loadJson(PRE_PHASE1)
    if (pre.metadata?.note) console.log(`Note : ${pre.metadata.note}\n`)
  } else {
    referencePath = referencePath ?? GOLDEN
    currentPath = currentPath ?? LATEST
    if (!existsSync(currentPath)) {
      console.error('Spécifiez --current= ou utilisez --run pour mesurer.')
      process.exit(1)
    }
  }

  const reference = loadJson(referencePath)
  const current = loadJson(currentPath)

  const refMeta = reference.metadata
  const curMeta = current.metadata
  if (refMeta?.capturedAt) {
    console.log(`Référence : ${referencePath} (${refMeta.capturedAt})`)
    if (refMeta.baselineCommit) console.log(`  commit référence : ${refMeta.baselineCommit.slice(0, 12)}…`)
  }
  if (curMeta?.capturedAt) {
    console.log(`Actuel    : ${currentPath} (${curMeta.capturedAt})`)
    if (curMeta.baselineCommit) console.log(`  commit actuel    : ${curMeta.baselineCommit.slice(0, 12)}…`)
  }

  const ids = [...new Set([
    ...Object.keys(reference.corpora ?? {}),
    ...Object.keys(current.corpora ?? {}),
  ])].sort()

  const lowerIsBetter = phase1Mode || referencePath === PRE_PHASE1
  const rows = ids.map((id) => compareCorpus(
    id,
    reference.corpora[id],
    current.corpora[id],
  ))
  printTable(rows, {
    refLabel: phase1Mode ? 'avant Phase 1' : 'référence',
    curLabel: phase1Mode ? 'après Phase 1 (golden)' : 'mesure',
    lowerIsBetter,
  })

  if (phase1Mode) {
    console.log('\nPour vérifier qu’aucune régression n’a été introduite depuis le golden :')
    console.log('  yarn benchmark:packed-radix:diff --run')
    console.log('\nComparer run courant au golden sans ré-enregistrer la référence :')
    console.log('  yarn benchmark:packed-radix:record  # → latest via --record baselines/packed-radix-latest.json')
  }
}

main()
