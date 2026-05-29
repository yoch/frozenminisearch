/**
 * Targeted benchmarks for scenarios that often fail benchmark:diff (noisy or extreme).
 * Uses the same {@link runScenario} path as the full suite.
 *
 * Run:
 *   node --expose-gc benchmarks/scripts/targeted-failures.mjs [--runs 3] [--out path.json]
 *
 * Compare two captures (e.g. before/after on detached HEAD):
 *   node benchmarks/scripts/targeted-failures.mjs --compare=before.json,after.json
 *   node benchmarks/scripts/targeted-failures.mjs --compare=before.json,after.json --reference=benchmarks/baselines/reference.json
 *
 * Exit 1 on --compare only when the second capture regresses vs the first (not vs reference).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { runScenario, buildScenarioList } from '../benchmarkSuite.js'
import {
  medianOf,
  parseBenchmarkArgs,
  loadBenchmarkPayload,
  argValue,
  DEFAULT_SEARCH_ITERATIONS,
} from '../benchmarkUtils.js'

const FAIL_IDS = [
  'extreme-giantVocabulary',
  'extreme-overflowFrequency',
  'denseNumericIds-100k',
  'genericStringIds-100k',
  'docIdUint16Boundary-65535',
  'docIdUint16Boundary-65536',
  'saveBinaryAfterNoTerms',
]

/** Same fail thresholds as benchmarks/diffBaseline.js (structural only). */
const THRESHOLDS = {
  freezeMs: { warnPct: 20, failPct: 40 },
  saveBinaryMs: { warnPct: 15, failPct: 30 },
  loadBinaryMs: { warnPct: 10, failPct: 20 },
}

function gitShort () {
  try {
    const head = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim()
    return `${head}${dirty ? ' (dirty)' : ''}`
  } catch {
    return '?'
  }
}

function pctDelta (base, cur) {
  if (base == null || cur == null || base === 0) return null
  return ((cur - base) / base) * 100
}

function formatPct (deltaPct) {
  if (deltaPct == null) return '—'
  const sign = deltaPct > 0 ? '+' : ''
  return `${sign}${deltaPct.toFixed(1)}%`
}

function classify (metricKey, deltaPct) {
  const t = THRESHOLDS[metricKey]
  if (t == null || deltaPct == null) return 'ok'
  if (deltaPct >= t.failPct) return 'fail'
  if (deltaPct >= t.warnPct) return 'warn'
  return 'ok'
}

function scenariosById (payload) {
  return Object.fromEntries(payload.scenarios.map((s) => [s.id, s]))
}

function benchScenario (scenario, runs, searchIterations) {
  const freezeSamples = []
  const saveSamples = []
  const loadSamples = []
  let last

  for (let i = 0; i < runs; i++) {
    const r = runScenario(scenario, searchIterations)
    last = r
    freezeSamples.push(r.indexing.freezeMs)
    saveSamples.push(r.indexing.saveBinaryMs)
    loadSamples.push(r.loadMs.binary)
  }

  return {
    id: scenario.id,
    docs: scenario.corpus.length,
    terms: last.termCount,
    freezeMs: Number(medianOf(freezeSamples).toFixed(2)),
    saveBinaryMs: Number(medianOf(saveSamples).toFixed(2)),
    loadBinaryMs: Number(medianOf(loadSamples).toFixed(2)),
    binaryMb: last.diskMb.binary,
    heapFrozenMb: last.heapMb.frozen,
    structuredMb: Number((last.memoryBreakdown.estimatedStructuredBytes / 1024 / 1024).toFixed(3)),
    freezeSamples,
    saveBinarySamples: saveSamples,
    loadBinarySamples: loadSamples,
  }
}

function runCapture () {
  const { runs, searchIterations } = parseBenchmarkArgs()
  const label = argValue('--label') ?? 'current'
  const outPath = argValue('--out')

  const scenarios = buildScenarioList().filter((s) => FAIL_IDS.includes(s.id))
  const payload = {
    label,
    git: gitShort(),
    runs,
    searchIterations,
    capturedAt: new Date().toISOString(),
    scenarios: scenarios.map((s) => benchScenario(s, runs, searchIterations)),
  }

  const json = JSON.stringify(payload, null, 2) + '\n'
  if (outPath) {
    writeFileSync(outPath, json)
    console.error(`Wrote ${outPath}`)
  }
  console.log(json)
}

function printCompareRow (label, baseVal, curVal, metricKey, bump) {
  const delta = pctDelta(baseVal, curVal)
  const status = classify(metricKey, delta)
  bump(status)
  const icon = status === 'fail' ? 'FAIL' : status === 'warn' ? 'warn' : 'ok  '
  console.log(
    `  ${icon} ${label.padEnd(11)} base=${String(baseVal).padEnd(8)} cur=${String(curVal).padEnd(8)} Δ ${formatPct(delta).padEnd(8)}`,
  )
  return status
}

function runCompare () {
  const pair = argValue('--compare')
  if (pair == null) {
    console.error('Usage: --compare=before.json,after.json')
    process.exit(1)
  }
  const [beforePath, afterPath] = pair.split(',').map((s) => s.trim())
  if (!beforePath || !afterPath) {
    console.error('--compare requires two comma-separated JSON paths')
    process.exit(1)
  }

  const before = loadBenchmarkPayload(beforePath)
  const after = loadBenchmarkPayload(afterPath)
  const referencePath = argValue('--reference')
  const reference = referencePath != null ? loadBenchmarkPayload(referencePath) : null
  const beforeBy = scenariosById(before)
  const afterBy = scenariosById(after)
  const refBy = reference != null ? scenariosById(reference) : null

  console.log('Targeted failure scenarios — pairwise compare (exit 1 if AFTER regresses vs BEFORE)')
  console.log(`  before: ${beforePath}  (${before.label ?? '?'} @ ${before.git ?? '?'})`)
  console.log(`  after:  ${afterPath}  (${after.label ?? '?'} @ ${after.git ?? '?'})`)
  if (reference != null) {
    console.log(`  reference (informational): ${referencePath}`)
  }
  console.log(`  runs: before=${before.runs ?? '?'} after=${after.runs ?? '?'}\n`)

  let worst = 'ok'
  const bump = (s) => {
    if (s === 'fail') worst = 'fail'
    else if (s === 'warn' && worst !== 'fail') worst = 'warn'
  }

  for (const id of FAIL_IDS) {
    const b = beforeBy[id]
    const a = afterBy[id]
    if (b == null || a == null) {
      console.log(`\n${id}: missing in capture (before=${Boolean(b)} after=${Boolean(a)})`)
      bump('fail')
      continue
    }

    console.log(`${'─'.repeat(72)}`)
    console.log(id)
    printCompareRow('freeze', b.freezeMs, a.freezeMs, 'freezeMs', bump)
    printCompareRow('saveBinary', b.saveBinaryMs, a.saveBinaryMs, 'saveBinaryMs', bump)
    printCompareRow('loadBinary', b.loadBinaryMs, a.loadBinaryMs, 'loadBinaryMs', bump)

    if (b.binaryMb !== a.binaryMb || b.structuredMb !== a.structuredMb) {
      console.log(`  note binaryMb ${b.binaryMb} → ${a.binaryMb}, structuredMb ${b.structuredMb} → ${a.structuredMb}`)
    }

    if (refBy?.[id] != null) {
      const r = refBy[id]
      const drFreeze = formatPct(pctDelta(r.freezeMs ?? r.indexing?.freezeMs, a.freezeMs))
      const drSave = formatPct(pctDelta(r.saveBinaryMs ?? r.indexing?.saveBinaryMs, a.saveBinaryMs))
      const drLoad = formatPct(pctDelta(r.loadBinaryMs ?? r.loadMs?.binary, a.loadBinaryMs))
      const rf = r.freezeMs ?? r.indexing?.freezeMs
      const rs = r.saveBinaryMs ?? r.indexing?.saveBinaryMs
      const rl = r.loadBinaryMs ?? r.loadMs?.binary
      console.log(`  ref→after (informational): freeze ${drFreeze}  save ${drSave}  load ${drLoad}  (ref ${rf}/${rs}/${rl} ms)`)
    }
  }

  console.log(`\n${'='.repeat(72)}`)
  if (worst === 'fail') {
    console.log('FAIL: after regressed vs before on at least one structural metric.')
    process.exit(1)
  }
  if (worst === 'warn') {
    console.log('WARN: after slower vs before within warn band; review if unexpected.')
  } else {
    console.log('OK: no structural regression after vs before.')
  }
}

const compareArg = process.argv.find((a) => a.startsWith('--compare'))
if (compareArg != null) {
  runCompare()
} else {
  runCapture()
}
