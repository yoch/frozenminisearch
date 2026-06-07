#!/usr/bin/env node
/**
 * Extract and analyze benchmarks/perf-history.jsonl
 *
 *   node benchmarks/scripts/analyze-history.mjs
 *   node benchmarks/scripts/analyze-history.mjs --vs-mutable
 *   node benchmarks/scripts/analyze-history.mjs --compare db3707b 5305918
 *   node benchmarks/scripts/analyze-history.mjs --changelog
 *   node benchmarks/scripts/analyze-history.mjs --changelog --commit 5305918
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HISTORY_PATH = join(__dirname, '../perf-history.jsonl')

const REF_SCENARIO = 'divina-indexOnly'
const WATCH_SCENARIOS = [
  'divina-indexOnly',
  'divina-storeFields',
  'extreme-overflowFrequency',
  'denseNumericIds-100k'
]

const THRESHOLDS = {
  heapFrozenMb: 5,
  heapSavingPts: 3,
  loadBinaryMs: 10,
  freezeMs: 15,
  searchFrozenVsMutablePts: 5,
  diskBinaryMb: 5
}

function loadEntries () {
  if (!existsSync(HISTORY_PATH)) {
    console.error(`Missing ${HISTORY_PATH}`)
    process.exit(1)
  }
  return readFileSync(HISTORY_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l)
      } catch (e) {
        throw new Error(`Line ${i + 1}: ${e.message}`)
      }
    })
}

function findEntry (entries, ref) {
  const needle = ref.toLowerCase()
  return entries.find((e) =>
    e.git?.commit?.toLowerCase().startsWith(needle) ||
    e.git?.commitShort?.toLowerCase() === needle
  )
}

function scenario (entry, id) {
  return entry.scenarios?.find((s) => s.id === id)
}

function pctDelta (base, value) {
  if (base == null || value == null || base === 0) return null
  return Number((((value - base) / base) * 100).toFixed(1))
}

function ptsDelta (base, value) {
  if (base == null || value == null) return null
  return Number((value - base).toFixed(1))
}

function extract (entry, scenarioId = REF_SCENARIO) {
  const s = scenario(entry, scenarioId)
  if (!s) return null
  const search = s.search ?? []
  const avg = (fn) => {
    if (search.length === 0) return null
    const vals = search.map(fn).filter((v) => v != null)
    if (vals.length === 0) return null
    return Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2))
  }
  return {
    scenarioId,
    heapMutableMb: s.heapMb?.mutable,
    heapFrozenMb: s.heapMb?.frozen,
    heapSavingPct: s.heapMb?.frozenVsMutableSavingPct,
    loadJsonMs: s.loadMs?.json,
    loadBinaryMs: s.loadMs?.binary,
    diskJsonMb: s.diskMb?.json,
    diskBinaryMb: s.diskMb?.binary,
    freezeMs: s.indexing?.freezeMs,
    saveBinaryMs: s.indexing?.saveBinaryMs,
    binaryMagic: s.indexing?.binaryMagic,
    searchMutableP50: avg((r) => r.mutableP50),
    searchFrozenP50: avg((r) => r.frozenP50),
    searchFrozenVsMutablePct: avg((r) => r.frozenP50VsMutablePct),
    searchSummaryGainPct: s.summary?.searchFrozenP50AvgGainPct,
    scoreDriftMaxRel: s.scoreDrift?.[0]?.maxRelScoreDeltaPct
  }
}

function compareMetrics (before, after) {
  if (!before || !after) return []
  const rows = [
    ['heap frozen (MB)', before.heapFrozenMb, after.heapFrozenMb, pctDelta(before.heapFrozenMb, after.heapFrozenMb), '%', THRESHOLDS.heapFrozenMb, true],
    ['heap saving vs mutable (pts)', before.heapSavingPct, after.heapSavingPct, ptsDelta(before.heapSavingPct, after.heapSavingPct), ' pts', THRESHOLDS.heapSavingPts, false],
    ['loadBinary (ms)', before.loadBinaryMs, after.loadBinaryMs, pctDelta(before.loadBinaryMs, after.loadBinaryMs), '%', THRESHOLDS.loadBinaryMs, true],
    ['freeze (ms)', before.freezeMs, after.freezeMs, pctDelta(before.freezeMs, after.freezeMs), '%', THRESHOLDS.freezeMs, true],
    ['search frozen p50 avg (ms)', before.searchFrozenP50, after.searchFrozenP50, pctDelta(before.searchFrozenP50, after.searchFrozenP50), '%', THRESHOLDS.searchFrozenVsMutablePts, true],
    ['frozen vs mutable p50 (%)', before.searchFrozenVsMutablePct, after.searchFrozenVsMutablePct, ptsDelta(before.searchFrozenVsMutablePct, after.searchFrozenVsMutablePct), ' pts', THRESHOLDS.searchFrozenVsMutablePts, false],
    ['binary magic', before.binaryMagic, after.binaryMagic, null, '', 0, false]
  ]
  return rows.map(([label, b, a, delta, suffix, threshold, lowerIsBetter]) => {
    const significant = delta != null && (
      suffix === ' pts'
        ? Math.abs(delta) >= threshold
        : Math.abs(delta) >= threshold
    )
    const improved = delta != null && (lowerIsBetter ? delta < 0 : delta > 0)
    return { label, before: b, after: a, delta, suffix, significant, improved }
  })
}

function pad (s, n) {
  const t = String(s ?? '—')
  return t.length >= n ? t.slice(0, n) : t.padEnd(n)
}

function printTimeline (entries) {
  console.log(`\nperf-history (${entries.length} commits) — scenario ${REF_SCENARIO}\n`)
  console.log(
    pad('COMMIT', 8) +
    pad('DATE', 11) +
    pad('SCEN', 5) +
    pad('HEAP_M', 7) +
    pad('HEAP_F', 7) +
    pad('SAVE%', 6) +
    pad('LOAD_F', 8) +
    pad('SRCH_F', 8) +
    pad('SRCH_M', 8) +
    pad('FvsM%', 7) +
    pad('MAGIC', 6)
  )
  for (const e of entries) {
    const m = extract(e, REF_SCENARIO)
    if (!m) continue
    console.log(
      pad(e.git?.commitShort, 8) +
      pad((e.git?.commitDate ?? '').slice(0, 10), 11) +
      pad(e.scenarios?.length, 5) +
      pad(m.heapMutableMb, 7) +
      pad(m.heapFrozenMb, 7) +
      pad(m.heapSavingPct, 6) +
      pad(m.loadBinaryMs, 8) +
      pad(m.searchFrozenP50, 8) +
      pad(m.searchMutableP50, 8) +
      pad(m.searchFrozenVsMutablePct, 7) +
      pad(m.binaryMagic, 6)
    )
  }
}

function printVsMutable (entries) {
  console.log('\nFrozenMiniSearch vs mutable MiniSearch (latest entry per watched scenario)\n')
  const last = entries[entries.length - 1]
  console.log(`Commit ${last.git?.commitShort} — ${last.git?.subject}\n`)
  for (const id of WATCH_SCENARIOS) {
    const m = extract(last, id)
    if (!m) {
      console.log(`  ${id}: (not in this snapshot)`)
      continue
    }
    console.log(`  ${id}`)
    console.log(`    heap:  mutable ${m.heapMutableMb} MB → frozen ${m.heapFrozenMb} MB (${m.heapSavingPct}% smaller)`)
    console.log(`    load:  JSON ${m.loadJsonMs} ms → binary ${m.loadBinaryMs} ms`)
    console.log(`    search p50 avg: mutable ${m.searchMutableP50} ms, frozen ${m.searchFrozenP50} ms (${m.searchFrozenVsMutablePct}% vs mutable)`)
    if (m.scoreDriftMaxRel != null) {
      console.log(`    score drift (overflow): max rel delta ${m.scoreDriftMaxRel}%`)
    }
  }
}

function printCompare (entries, fromRef, toRef) {
  const a = findEntry(entries, fromRef)
  const b = findEntry(entries, toRef)
  if (!a || !b) {
    console.error('Commit not found in history')
    process.exit(1)
  }
  console.log(`\nCompare ${a.git.commitShort} → ${b.git.commitShort}`)
  console.log(`  ${a.git.subject}`)
  console.log(`  → ${b.git.subject}\n`)
  for (const id of WATCH_SCENARIOS) {
    const before = extract(a, id)
    const after = extract(b, id)
    if (!before || !after) continue
    console.log(`── ${id} ──`)
    for (const row of compareMetrics(before, after)) {
      const deltaStr = row.delta == null ? '—' : `${row.delta > 0 ? '+' : ''}${row.delta}${row.suffix}`
      const flag = row.significant ? (row.improved ? ' ✓' : ' !') : ''
      console.log(`  ${pad(row.label, 32)} ${pad(row.before, 10)} → ${pad(row.after, 10)}  Δ ${pad(deltaStr, 8)}${flag}`)
    }
    console.log('')
  }
}

function changelogBullets (entries, curRef, prevRef = null) {
  const cur = findEntry(entries, curRef ?? entries[entries.length - 1].git.commitShort)
  const idx = entries.indexOf(cur)
  const prev = prevRef
    ? findEntry(entries, prevRef)
    : idx > 0 ? entries[idx - 1] : null
  if (!cur) return []
  const bullets = []
  const m = extract(cur, REF_SCENARIO)
  const pm = prev ? extract(prev, REF_SCENARIO) : null

  if (pm && m) {
    const heapD = pctDelta(pm.heapFrozenMb, m.heapFrozenMb)
    if (heapD != null && Math.abs(heapD) >= THRESHOLDS.heapFrozenMb) {
      const dir = heapD < 0 ? 'lower' : 'higher'
      bullets.push(
        `Benchmark (${REF_SCENARIO}): frozen heap ${dir} ${Math.abs(heapD)}% vs ${prev.git.commitShort} (${pm.heapFrozenMb} → ${m.heapFrozenMb} MB isolated heap)`
      )
    }
    const saveD = ptsDelta(pm.heapSavingPct, m.heapSavingPct)
    if (saveD != null && Math.abs(saveD) >= THRESHOLDS.heapSavingPts) {
      bullets.push(
        `Benchmark: frozen index uses ${m.heapSavingPct}% less heap than mutable MiniSearch on same corpus (was ${pm.heapSavingPct}% at ${prev.git.commitShort})`
      )
    }
    if (pm.binaryMagic !== m.binaryMagic) {
      bullets.push(`Benchmark: binary snapshots now ${m.binaryMagic} (was ${pm.binaryMagic} at ${prev.git.commitShort})`)
    }
    const loadD = pctDelta(pm.loadBinaryMs, m.loadBinaryMs)
    if (loadD != null && Math.abs(loadD) >= THRESHOLDS.loadBinaryMs) {
      bullets.push(
        `Benchmark: loadBinary ${loadD > 0 ? '+' : ''}${loadD}% vs ${prev.git.commitShort} (${pm.loadBinaryMs} → ${m.loadBinaryMs} ms)`
      )
    }
    const searchD = ptsDelta(pm.searchFrozenVsMutablePct, m.searchFrozenVsMutablePct)
    if (searchD != null && Math.abs(searchD) >= THRESHOLDS.searchFrozenVsMutablePts) {
      bullets.push(
        `Benchmark: frozen search p50 avg ${m.searchFrozenVsMutablePct}% vs mutable (${pm.searchFrozenVsMutablePct}% at ${prev.git.commitShort}; negative = frozen faster)`
      )
    }
  }

  if (cur.scenarios?.length !== prev?.scenarios?.length) {
    bullets.push(`Benchmark suite: ${cur.scenarios.length} scenarios (was ${prev?.scenarios?.length ?? '?'})`)
  }

  return bullets
}

function printChangelog (entries, commitRef) {
  const cur = commitRef
    ? findEntry(entries, commitRef)
    : entries[entries.length - 1]
  const idx = entries.indexOf(cur)
  const prev = idx > 0 ? entries[idx - 1] : null
  console.log(`\n## Changelog snippet (${cur.git.commitShort})\n`)
  console.log(`  ${cur.git.subject}\n`)
  const bullets = changelogBullets(entries, cur.git.commitShort)
  if (bullets.length === 0) {
    console.log('  (no significant benchmark delta vs previous recorded commit)\n')
    return
  }
  for (const b of bullets) {
    console.log(`  - ${b}`)
  }
  console.log('')
}

function printRetroChangelog (entries) {
  console.log('\n## Benchmark milestones (from perf-history.jsonl)\n')
  const milestones = [
    { ref: 'db3707b', label: 'Suite introduced' },
    { ref: '62be8e9', label: 'Binary snapshots' },
    { ref: '5305918', label: 'Adaptive postings' }
  ]
  for (const { ref, label } of milestones) {
    const e = findEntry(entries, ref)
    if (!e) continue
    const m = extract(e, REF_SCENARIO)
    console.log(`### ${e.git.commitShort} — ${label}`)
    console.log(`  ${e.git.subject}`)
    if (m) {
      console.log(`  - divina-indexOnly: frozen heap ${m.heapFrozenMb} MB (${m.heapSavingPct}% vs mutable), loadBinary ${m.loadBinaryMs} ms, ${m.binaryMagic}`)
      console.log(`  - search p50: frozen ${m.searchFrozenP50} ms vs mutable ${m.searchMutableP50} ms (${m.searchFrozenVsMutablePct}%)`)
    }
    console.log('')
  }
  const first = extract(entries[0], REF_SCENARIO)
  const last = extract(entries[entries.length - 1], REF_SCENARIO)
  if (first && last) {
    console.log('### Overall (first → last recorded commit)')
    console.log(`  - frozen heap: ${first.heapFrozenMb} → ${last.heapFrozenMb} MB (${pctDelta(first.heapFrozenMb, last.heapFrozenMb)}%)`)
    console.log(`  - heap saving vs mutable: ${first.heapSavingPct}% → ${last.heapSavingPct}%`)
    console.log(`  - loadBinary: ${first.loadBinaryMs} → ${last.loadBinaryMs} ms`)
    console.log(`  - format: ${first.binaryMagic} → ${last.binaryMagic}`)
    console.log('')
  }
}

function usage () {
  console.log(`Usage: node benchmarks/scripts/analyze-history.mjs [options]

  (default)     Timeline table (${REF_SCENARIO})
  --vs-mutable  Frozen vs mutable MiniSearch on latest commit
  --compare A B Delta between two commits (short sha)
  --changelog   Markdown bullets for significant deltas vs previous line
  --commit SHA  With --changelog, target a specific commit
  --retro       Milestone summary for CHANGELOG backfill
`)
}

const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) {
  usage()
  process.exit(0)
}

const entries = loadEntries()

if (args.includes('--retro')) {
  printRetroChangelog(entries)
} else if (args.includes('--changelog')) {
  const ci = args.indexOf('--commit')
  const ref = ci >= 0 ? args[ci + 1] : null
  printChangelog(entries, ref)
} else if (args.includes('--compare')) {
  const ci = args.indexOf('--compare')
  printCompare(entries, args[ci + 1], args[ci + 2])
} else if (args.includes('--vs-mutable')) {
  printVsMutable(entries)
} else {
  printTimeline(entries)
}
