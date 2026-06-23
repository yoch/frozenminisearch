#!/usr/bin/env node
/**
 * Analyze benchmarks/packed-radix-history.jsonl and pre-Phase 1 comparison.
 *
 *   pnpm benchmark:packed-radix:history
 *   node benchmarks/scripts/analyze-packed-radix-history.mjs --compare pre-phase1 HEAD
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HISTORY = join(__dirname, '../packed-radix-history.jsonl')
const PRE = join(__dirname, '../baselines/packed-radix-pre-phase1.json')
const GOLDEN = join(__dirname, '../baselines/packed-radix-reference.json')

const argv = process.argv.slice(2)

function loadLines (path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l)
      } catch (e) {
        throw new Error(`${path}:${i + 1}: ${e.message}`)
      }
    })
}

function pad (s, n) {
  return String(s).padEnd(n)
}

function pct (base, val) {
  if (base == null || val == null || base === 0) return null
  return Number((((val - base) / base) * 100).toFixed(1))
}

function findEntry (entries, ref) {
  const needle = ref.toLowerCase()
  return entries.find((e) =>
    e.baselineCommit?.toLowerCase() === needle ||
    e.baselineCommit?.toLowerCase().endsWith(needle) ||
    e.git?.commit?.toLowerCase().startsWith(needle) ||
    e.git?.commitShort?.toLowerCase() === needle ||
    e.recordKind === needle ||
    (needle === 'pre-phase1' && e.recordKind === 'synthetic-pre-phase1'),
  )
}

function label (e) {
  return e.git?.commitShort ?? e.baselineCommit?.slice(0, 12) ?? '?'
}

function corpusIds (entries) {
  const ids = new Set()
  for (const e of entries) {
    for (const id of Object.keys(e.corpora ?? {})) ids.add(id)
  }
  return [...ids].sort()
}

function printStructuredTable (a, b, title) {
  console.log(`\n## ${title}\n`)
  console.log(`${pad('corpus', 24)} ${pad(label(a), 10)} ${pad(label(b), 10)} ${pad('Δ B', 10)} ${pad('Δ %', 8)}`)
  for (const id of corpusIds([a, b])) {
    const va = a.corpora?.[id]?.structuredBytes
    const vb = b.corpora?.[id]?.structuredBytes
    if (va == null || vb == null) continue
    const d = vb - va
    const p = pct(va, vb)
    const flag = d < 0 ? ' ✓' : d > 0 ? ' ⚠' : ''
    console.log(
      `${pad(id, 24)} ${pad(va, 10)} ${pad(vb, 10)} ${pad(d, 10)} ${pad(p == null ? '—' : `${p}%`, 8)}${flag}`,
    )
  }
}

function printTimeline (entries) {
  console.log('\n## History (structured bytes)\n')
  const ids = corpusIds(entries)
  const header = `${pad('commit / kind', 16)} ${pad('date', 11)} ${ids.map((id) => pad(id.slice(0, 10), 11)).join(' ')}`
  console.log(header)
  for (const e of entries) {
    const date = (e.git?.commitDate ?? e.capturedAt ?? '').slice(0, 10)
    const cols = ids.map((id) => {
      const v = e.corpora?.[id]?.structuredBytes
      return pad(v ?? '—', 11)
    })
    console.log(`${pad(label(e), 16)} ${pad(date, 11)} ${cols.join(' ')}`)
    if (e.git?.subject) console.log(`  ${e.git.subject}`)
    if (e.note) console.log(`  (${e.note})`)
  }
}

function main () {
  let entries = loadLines(HISTORY)
  if (entries.length === 0) {
    console.log('Empty history — run: node benchmarks/scripts/seed-packed-radix-history.mjs\n')
  }

  const compareA = argv.includes('--compare')
    ? argv[argv.indexOf('--compare') + 1]
    : 'pre-phase1'
  const compareB = argv.includes('--compare')
    ? argv[argv.indexOf('--compare') + 2] ?? 'HEAD'
    : null

  if (entries.length === 0 && existsSync(PRE) && existsSync(GOLDEN)) {
    const pre = JSON.parse(readFileSync(PRE, 'utf8'))
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
    const preEntry = {
      recordKind: 'synthetic-pre-phase1',
      git: { commitShort: 'pre-phase1' },
      corpora: Object.fromEntries(
        Object.entries(pre.corpora).map(([id, r]) => [id, { structuredBytes: r.bytes.totalStructuredBytes }]),
      ),
    }
    const goldEntry = {
      recordKind: golden.metadata?.recordKind,
      git: golden.metadata?.git,
      baselineCommit: golden.metadata?.baselineCommit ?? golden.metadata?.git?.commit,
      corpora: Object.fromEntries(
        Object.entries(golden.corpora).map(([id, r]) => [id, { structuredBytes: r.bytes.totalStructuredBytes }]),
      ),
    }
    entries = [preEntry, goldEntry]
  }

  console.log('=== PackedRadixTree — structured memory evolution ===')
  printTimeline(entries)

  const a = findEntry(entries, compareA) ?? findEntry(entries, 'synthetic-pre-phase1')
  let b = compareB ? findEntry(entries, compareB) : entries[entries.length - 1]
  if (!b && existsSync(GOLDEN)) {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
    b = {
      git: golden.metadata?.git,
      baselineCommit: golden.metadata?.baselineCommit,
      corpora: Object.fromEntries(
        Object.entries(golden.corpora).map(([id, r]) => [id, { structuredBytes: r.bytes.totalStructuredBytes }]),
      ),
    }
  }

  if (a && b) {
    printStructuredTable(
      a,
      b,
      `Comparison ${label(a)} → ${label(b)} (negative = fewer bytes, desired after optimization)`,
    )
  }

  const scaleA = a?.corpora?.scale?.structuredBytes
  const scaleB = b?.corpora?.scale?.structuredBytes
  if (scaleA != null && scaleB != null) {
    const edges = 2651
    const expectedEdgeFirstChar = edges * 2
    const actual = scaleA - scaleB
    console.log('\n## Phase 1 summary (edgeFirstChar)\n')
    console.log(`- corpus \`scale\` : ${scaleA} → ${scaleB} B (${pct(scaleA, scaleB)} %)`)
    console.log(`- expected edgeFirstChar saving (2×${edges} edges): ${expectedEdgeFirstChar} B`)
    console.log(`- observed delta on scale: ${actual} B${actual === expectedEdgeFirstChar ? ' (consistent)' : ''}`)
  }

  console.log('\n## Baseline recording\n')
  console.log('- `pnpm benchmark:packed-radix:record` requires a clean git tree (tracked files).')
  console.log('- Commit recorded in `metadata.baselineCommit` + line in packed-radix-history.jsonl.')
}

main()
