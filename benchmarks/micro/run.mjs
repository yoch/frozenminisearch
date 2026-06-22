#!/usr/bin/env node
/**
 * Micro-benchmarks: Benchmark.js ops/sec on lucaong MiniSearch + SearchableMap (Divina corpus).
 *
 *   pnpm bench:micro
 *   pnpm bench:micro -- --only=fuzzy,ranking
 *   pnpm bench:micro -- --list
 */
import { lines, miniSearch } from '../divinaCommedia.js'
import { MICRO_SUITES, resolveMicroSuites } from './registry.mjs'

const argv = process.argv.slice(2)

function parseOnlyFlag() {
  const flag = argv.find(a => a.startsWith('--only='))
  if (!flag) return null
  return flag.split('=')[1].split(',').map(s => s.trim()).filter(Boolean)
}

function printIndexStats() {
  const terms = miniSearch.termCount
  const documents = miniSearch.documentCount
  let serializedMb = '—'
  try {
    serializedMb = (JSON.stringify(miniSearch).length / (1024 * 1024)).toFixed(2)
  } catch {
    // ignore oversized stringify failures
  }
  console.log(
    `Corpus: ${lines.length} lines indexed as ${documents} documents, `
    + `${terms} terms, ~${serializedMb} MB JSON (lucaong MiniSearch).\n`,
  )
}

function runSuite(suite) {
  return new Promise((resolve, reject) => {
    suite
      .on('start', () => {
        console.log(`${suite.name}:`)
        console.log('='.repeat(suite.name.length + 1))
      })
      .on('cycle', ({ target: benchmark }) => {
        console.log(`  * ${benchmark}`)
      })
      .on('complete', () => {
        console.log('')
        resolve()
      })
      .on('error', reject)
      .run({ async: true })
  })
}

async function main() {
  if (argv.includes('--list')) {
    console.log('Micro-benchmark suites (--only=<id>[,...]):\n')
    for (const { id, suite } of MICRO_SUITES) {
      console.log(`  ${id.padEnd(12)} ${suite.name}`)
    }
    return
  }

  const only = parseOnlyFlag()
  const suites = resolveMicroSuites(only)

  console.log('Micro-benchmarks (Benchmark.js, Divina Commedia)\n')
  printIndexStats()

  for (const { suite } of suites) {
    await runSuite(suite)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
