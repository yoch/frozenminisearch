#!/usr/bin/env node
/**
 * Regenerate the vs-reference comparison block in README.md from a baseline JSON.
 *
 *   node benchmarks/scripts/generate-readme-comparison.mjs
 *   node benchmarks/scripts/generate-readme-comparison.mjs --from=benchmarks/baselines/latest.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatFrozenVsMutableDelta } from '../searchBenchTiming.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const README = join(root, 'README.md')
const DEFAULT_BASELINE = join(root, 'benchmarks/baselines/reference.json')

const START = '<!-- vs-reference:start'
const END = '<!-- vs-reference:end -->'

const argv = process.argv.slice(2)
const fromFlag = argv.find((a) => a.startsWith('--from='))
const baselinePath = fromFlag?.split('=')[1] ?? DEFAULT_BASELINE

const payload = JSON.parse(readFileSync(baselinePath, 'utf8'))

/** Scenarios shown in the public README table (order matters). */
const HERO_IDS = [
  'divina-storeFields',
  'divina-indexOnly',
  'extreme-highFrequency',
  'denseNumericIds-100k',
  'docIdUint16Boundary-65535',
]

/** `frozenVsMutableSavingPct` etc. — positive = frozen wins (smaller/faster). */
function fmtSaving (n) {
  if (n == null || Number.isNaN(n)) return '—'
  if (n <= 0) return `${n.toFixed(0)}%`
  return `~${n.toFixed(0)}% less`
}

function fmtFaster (n) {
  if (n == null || Number.isNaN(n)) return '—'
  if (n <= 0) return `${n.toFixed(0)}%`
  return `~${n.toFixed(0)}% faster`
}

function fmtMs (n, digits = 2) {
  if (n == null) return '—'
  if (n < 0.001) return `${(n * 1e6).toFixed(0)} ns`
  if (n < 0.1) return `${(n * 1000).toFixed(1)} µs`
  if (n < 10) return `${n.toFixed(digits)} ms`
  return `${n.toFixed(1)} ms`
}

function fmtHeapPair (scenario) {
  const mut = scenario.heapMb?.mutable
  const frz = scenario.heapMb?.frozen
  const save = scenario.heapMb?.frozenVsMutableSavingPct
  if (mut == null || frz == null) return fmtSaving(save)
  return `${frz.toFixed(1)} vs ${mut.toFixed(1)} MB (${fmtSaving(save)})`
}

function scenarioById (id) {
  return payload.scenarios.find((s) => s.id === id)
}

function searchGainPct (scenario) {
  return scenario?.summary?.searchFrozenP50AvgGainPct
}

function heroRow (scenario) {
  const docs = scenario.documentCount?.toLocaleString('en-US') ?? '—'
  const heap = fmtHeapPair(scenario)
  const disk = fmtSaving(scenario.diskMb?.binaryVsJsonSavingPct)
  const load = fmtFaster(scenario.loadMs?.binaryVsJsonSavingPct)
  const search = fmtFaster(searchGainPct(scenario))
  const label = scenario.name.replace(/^Divina Commedia — /, 'Divina ').replace(/^Extreme — /, '')
  return `| ${label} | ${docs} | ${heap} | ${disk} | ${load} | ${search} |`
}

function divinaExactLine () {
  const s = scenarioById('divina-storeFields')
  const ex = s?.search?.find((r) => r.label === 'exact')
  if (!ex) return null
  const delta = formatFrozenVsMutableDelta(ex.mutableP50, ex.frozenP50)
  const ratio = ex.pairedRatioP50?.toFixed(2) ?? '—'
  return `Divina \`inferno\` (exact, paired p50): mutable ${fmtMs(ex.mutableP50)} → frozen ${fmtMs(ex.frozenP50)} (**${delta}**, ratio ${ratio}).`
}

function levelInsight () {
  const lv = scenarioById('divina-storeFields')?.searchLevels?.exact
  if (!lv) return null
  const finalizeUs = Math.round((lv.L2.frozenP50 - lv.L1.frozenP50) * 1000)
  return (
    `Decomposition (Divina exact): L0 lookup ~${fmtMs(lv.L0.frozenP50)} frozen, `
    + `L1 \`executeQuery\` ~${fmtMs(lv.L1.frozenP50)}, L2 full \`search\` ~${fmtMs(lv.L2.frozenP50)} `
    + `(finalize ≈ ${finalizeUs} µs).`
  )
}

function aggregateSearchWins () {
  let wins = 0
  let total = 0
  for (const s of payload.scenarios) {
    for (const row of s.search ?? []) {
      total++
      if (row.pairedRatioP50 != null && row.pairedRatioP50 < 1) wins++
      else if (row.pairedRatioP50 == null && row.frozenP50 < row.mutableP50) wins++
    }
  }
  return { wins, total }
}

function buildBlock () {
  const proto = payload.searchBenchProtocol ?? {}
  const captured = payload.capturedAt?.slice(0, 10) ?? '—'
  const commit = (payload.baselineCommit ?? payload.git?.commit ?? '').slice(0, 7)
    || payload.git?.commitShort
    || '—'
  const node = payload.node ?? '—'
  const minisearch = payload.minisearchVersion ?? '—'
  const runs = payload.runs ?? '—'
  const { wins, total } = aggregateSearchWins()

  const heroes = HERO_IDS.map(scenarioById).filter(Boolean)
  const tableRows = heroes.map(heroRow).join('\n')

  const exactLine = divinaExactLine()
  const levels = levelInsight()

  return `${START} — npm run bench:readme -->
### Measured vs lucaong MiniSearch (reference baseline)

Same BM25 queries on identical corpora. **Frozen wins on what we optimize for**: RAM, disk, cold load, and search throughput on real workloads.

| Scenario | Docs | Index RAM¹ | Disk (binary vs JSON)² | Cold load³ | Search p50⁴ |
|----------|-----:|------------|------------------------:|-----------:|------------:|
${tableRows}

**Headline:** ${wins}/${total} query benchmarks favor frozen (paired **hrtime** protocol v${proto.protocolVersion ?? 2}). ${exactLine ?? ''}

${levels ? `${levels}\n` : ''}
| | lucaong \`minisearch\` | \`@yoch/frozenminisearch\` |
|---|------------------------|---------------------------|
| **Sweet spot** | Live index mutations | Fixed corpus, deploy from binary |
| **Production path** | \`addAll\` → \`toJSON\` | \`fromDocuments\` / \`fromMiniSearch\` → \`saveBinarySync\` → \`loadBinarySync\` |
| **Typical trade-off** | Higher RAM, JSON snapshots | One-time freeze, then compact binary |

<details>
<summary><strong>How to read these numbers (limits &amp; protocol)</strong></summary>

- **Captured:** ${captured} · commit \`${commit}\` · Node ${node} · minisearch **${minisearch}** · **${runs}** run(s)/scenario · protocol **v${proto.protocolVersion ?? 2}** (${proto.timing ?? 'hrtime-paired'}, batch target ${proto.batchTargetMs ?? 3} ms).
- ¹ **Index RAM** — \`measureHeap\` with \`--expose-gc\`, one index alive. V8 overhead is extra; treat as **trend**, not accounting. Sporadic outliers happen (e.g. index-only Divina).
- ² **Disk** — \`JSON.stringify(mutable)\` vs \`saveBinarySync\`.
- ³ **Cold load** — median wall time to searchable index after read from disk format.
- ⁴ **Search p50** — paired mutable/frozen samples per iteration; sub-0.1 ms baselines reported in **µs** in full reports. Fast queries use **${proto.fastIterations ?? 50}** iterations, others **${proto.defaultIterations ?? 20}**.
- **Not shown:** mutable \`add\`/\`remove\` (frozen is read-only by design). Freeze time is offline — see full suite for build metrics.
- **Reproduce:** \`npm run bench -- run --profile=vs-reference\` · **Update this block:** \`npm run bench:readme\` after refreshing \`benchmarks/baselines/reference.json\`.

</details>
${END}`
}

function patchReadme (block) {
  const readme = readFileSync(README, 'utf8')
  const startIdx = readme.indexOf(START)
  const endIdx = readme.indexOf(END)

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`README.md missing ${START} … ${END} markers`)
  }

  const before = readme.slice(0, startIdx)
  const after = readme.slice(endIdx + END.length)
  writeFileSync(README, `${before}${block}${after}`)
}

const block = buildBlock()
patchReadme(block)
console.log(`Updated README.md comparison from ${baselinePath}`)
