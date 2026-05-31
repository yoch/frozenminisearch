#!/usr/bin/env node
/**
 * Analyse benchmarks/packed-radix-history.jsonl et comparaison pré-Phase 1.
 *
 *   yarn benchmark:packed-radix:history
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
  console.log('\n## Historique (bytes structurés)\n')
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
    console.log('Historique vide — lancez: node benchmarks/scripts/seed-packed-radix-history.mjs\n')
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

  console.log('=== PackedRadixTree — évolution mémoire structurée ===')
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
      `Comparaison ${label(a)} → ${label(b)} (négatif = moins de bytes, souhaité après optim)`,
    )
  }

  const scaleA = a?.corpora?.scale?.structuredBytes
  const scaleB = b?.corpora?.scale?.structuredBytes
  if (scaleA != null && scaleB != null) {
    const edges = 2651
    const expectedEdgeFirstChar = edges * 2
    const actual = scaleA - scaleB
    console.log('\n## Synthèse Phase 1 (edgeFirstChar)\n')
    console.log(`- corpus \`scale\` : ${scaleA} → ${scaleB} B (${pct(scaleA, scaleB)} %)`)
    console.log(`- économie attendue edgeFirstChar (2×${edges} arêtes) : ${expectedEdgeFirstChar} B`)
    console.log(`- écart observé sur scale : ${actual} B${actual === expectedEdgeFirstChar ? ' (cohérent)' : ''}`)
  }

  console.log('\n## Enregistrement baseline\n')
  console.log('- `yarn benchmark:packed-radix:record` exige un arbre git propre (fichiers suivis).')
  console.log('- Commit enregistré dans `metadata.baselineCommit` + ligne dans packed-radix-history.jsonl.')
}

main()
