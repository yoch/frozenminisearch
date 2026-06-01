/**
 * Save benchmarks on existing corpora:
 *   1. saveBinarySync (MSv5) vs deprecated MSv4 / MSv3 — size + wall-clock
 *   2. saveBinarySync vs saveBinaryAsync (MSv5) — wall-clock + output size
 *
 *   npm run benchmark:binary-format
 */
import MiniSearch, { FrozenMiniSearch } from '../dist/es/index.js'
import { decodeFrozenSnapshot } from '../src/binaryDecode.ts'
import { encodeFrozenSnapshotMSv3, encodeFrozenSnapshotMSv4 } from '../src/binaryEncode.ts'
import { deserializeTermIndexTree } from '../src/binaryStructures.ts'
import type { FrozenSnapshot } from '../src/binaryStructures.ts'
import { resetDeprecatedBinaryWarningsForTests } from '../src/binaryDeprecation.ts'
import { CODEC_RAW, CODEC_ZSTD, MSV5_PAYLOAD_CODEC_OFFSET } from '../src/msv5/binaryMsv5Constants.ts'
import { gc, timedMs } from './benchmarkUtils.js'
import { loadDivinaLines } from './loadDivinaLines.js'
import {
  denseNumericIds,
  highFrequencyTerms,
  largeDocuments,
  manyFields,
  sparseFields,
} from './benchmarkScenarios.js'

const SAVE_RUNS = 7
const SAVE_WARMUP = 2

interface Scenario {
  id: string
  corpus: Array<Record<string, unknown>>
  options: { fields: string[], storeFields?: string[] }
}

interface SaveResult {
  id: string
  payload: 'raw' | 'zstd'
  syncKiB: number
  asyncKiB: number
  byteDelta: number
  msv4KiB: number
  msv3KiB: number | null
  saveSyncMs: number
  saveAsyncMs: number
  saveMsv4Ms: number
  saveMsv3Ms: number | null
}

function median (values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function pct (base: number, value: number): number {
  if (base === 0) return 0
  return ((value - base) / base) * 100
}

function payloadKind (buf: Buffer): 'raw' | 'zstd' {
  const codec = buf.readUInt8(MSV5_PAYLOAD_CODEC_OFFSET)
  return codec === CODEC_ZSTD ? 'zstd' : codec === CODEC_RAW ? 'raw' : 'raw'
}

function canEncodeMSv3 (snap: FrozenSnapshot): boolean {
  return snap.postings.layout === 'dense'
    && snap.postings.allDocIds instanceof Uint32Array
}

function benchSync (fn: () => void, runs = SAVE_RUNS, warmup = SAVE_WARMUP): number {
  for (let i = 0; i < warmup; i++) fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  return median(samples)
}

async function benchAsync (
  fn: () => Promise<unknown>,
  runs = SAVE_RUNS,
  warmup = SAVE_WARMUP,
): Promise<number> {
  for (let i = 0; i < warmup; i++) await fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    samples.push(performance.now() - t0)
  }
  return median(samples)
}

function buildScenarios (): Scenario[] {
  const many = manyFields(2000, 10)
  const sparse = sparseFields(5000, 20)
  return [
    { id: 'divina', corpus: loadDivinaLines() as Array<Record<string, unknown>>, options: { fields: ['txt'] } },
    { id: 'highFrequency-10k', corpus: highFrequencyTerms(10000) as Array<Record<string, unknown>>, options: { fields: ['txt'] } },
    { id: 'largeDocs-500', corpus: largeDocuments(500, 3000) as Array<Record<string, unknown>>, options: { fields: ['txt'] } },
    { id: 'denseNumeric-50k', corpus: denseNumericIds(50000) as Array<Record<string, unknown>>, options: { fields: ['txt'] } },
    { id: 'denseNumeric-70k', corpus: denseNumericIds(70000) as Array<Record<string, unknown>>, options: { fields: ['txt'] } },
    { id: 'manyFields-2k', corpus: many.docs as Array<Record<string, unknown>>, options: { fields: many.fields } },
    { id: 'sparseFields-5k', corpus: sparse.docs as Array<Record<string, unknown>>, options: { fields: sparse.fields } },
  ]
}

async function runScenario (scenario: Scenario): Promise<SaveResult> {
  const { corpus, options, id } = scenario
  resetDeprecatedBinaryWarningsForTests()

  const ms = new MiniSearch(options)
  ms.addAll(corpus)
  const frozen = ms.freeze()
  const snap = decodeFrozenSnapshot(frozen.saveBinarySync())

  const bufSync = frozen.saveBinarySync() as Buffer
  const saveSyncMs = benchSync(() => {
    frozen.saveBinarySync()
  })

  const bufAsync = await frozen.saveBinaryAsync()
  const saveAsyncMs = await benchAsync(async () => {
    await frozen.saveBinaryAsync()
  })

  const saveMsv4Ms = benchSync(() => {
    encodeFrozenSnapshotMSv4(snap)
  })
  const bufMsv4 = encodeFrozenSnapshotMSv4(snap) as Buffer

  let bufMsv3: Buffer | null = null
  let saveMsv3Ms: number | null = null
  if (canEncodeMSv3(snap)) {
    saveMsv3Ms = benchSync(() => {
      encodeFrozenSnapshotMSv3(snap, deserializeTermIndexTree(snap.treeShape))
    })
    bufMsv3 = encodeFrozenSnapshotMSv3(snap, deserializeTermIndexTree(snap.treeShape)) as Buffer
  }

  return {
    id,
    payload: payloadKind(bufSync),
    syncKiB: bufSync.length / 1024,
    asyncKiB: bufAsync.length / 1024,
    byteDelta: Math.abs(bufSync.length - bufAsync.length),
    msv4KiB: bufMsv4.length / 1024,
    msv3KiB: bufMsv3 != null ? bufMsv3.length / 1024 : null,
    saveSyncMs,
    saveAsyncMs,
    saveMsv4Ms,
    saveMsv3Ms,
  }
}

function pad (s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}

function printSaveVsLegacy (rows: SaveResult[]): void {
  console.log('\n═══════════════════════════════════════════════════════════════════════════════')
  console.log('  1. SAVE — saveBinarySync (MSv5) vs formats deprecated (MSv4 / MSv3)')
  console.log(`  median save wall-clock, ${SAVE_RUNS} runs (+${SAVE_WARMUP} warmup)  |  baseline = MSv5 sync`)
  console.log('═══════════════════════════════════════════════════════════════════════════════\n')

  console.log(
    pad('corpus', 22)
    + pad('pay', 6)
    + pad('MSv5 KiB', 10)
    + pad('MSv4 KiB', 10)
    + pad('size MSv4', 11)
    + pad('save sync', 11)
    + pad('save MSv4', 11)
    + pad('time MSv4', 11)
    + pad('MSv3 KiB', 10),
  )
  console.log('-'.repeat(102))

  for (const r of rows) {
    const sizePct = `${pct(r.syncKiB, r.msv4KiB) >= 0 ? '+' : ''}${pct(r.syncKiB, r.msv4KiB).toFixed(0)}%`
    const timePct = `${pct(r.saveSyncMs, r.saveMsv4Ms) >= 0 ? '+' : ''}${pct(r.saveSyncMs, r.saveMsv4Ms).toFixed(0)}%`
    const msv3KiB = r.msv3KiB != null ? `${r.msv3KiB.toFixed(1)}` : '—'
    console.log(
      pad(r.id, 22)
      + pad(r.payload, 6)
      + pad(r.syncKiB.toFixed(1), 10)
      + pad(r.msv4KiB.toFixed(1), 10)
      + pad(sizePct, 11)
      + pad(`${r.saveSyncMs.toFixed(1)} ms`, 11)
      + pad(`${r.saveMsv4Ms.toFixed(1)} ms`, 11)
      + pad(timePct, 11)
      + pad(msv3KiB, 10),
    )
  }

  const avgSize = rows.reduce((s, r) => s + pct(r.syncKiB, r.msv4KiB), 0) / rows.length
  const avgTime = rows.reduce((s, r) => s + pct(r.saveSyncMs, r.saveMsv4Ms), 0) / rows.length
  console.log('-'.repeat(102))
  console.log(`  moyenne : MSv4 ~${avgSize.toFixed(0)} % plus gros ; save MSv4 ~${avgTime.toFixed(0)} % vs MSv5 sync`)
}

function printSaveSyncVsAsync (rows: SaveResult[]): void {
  console.log('\n═══════════════════════════════════════════════════════════════════════════════')
  console.log('  2. SAVE — saveBinarySync vs saveBinaryAsync (même MSv5)')
  console.log(`  median wall-clock, ${SAVE_RUNS} runs (+${SAVE_WARMUP} warmup)  |  baseline = sync`)
  console.log('═══════════════════════════════════════════════════════════════════════════════\n')

  console.log(
    pad('corpus', 22)
    + pad('pay', 6)
    + pad('sync KiB', 10)
    + pad('async KiB', 10)
    + pad('|Δ| B', 8)
    + pad('save sync', 11)
    + pad('save async', 11)
    + pad('async/sync', 12),
  )
  console.log('-'.repeat(90))

  for (const r of rows) {
    const ratio = r.saveSyncMs > 0 ? (r.saveAsyncMs / r.saveSyncMs).toFixed(2) + '×' : '—'
    const timePct = `${pct(r.saveSyncMs, r.saveAsyncMs) >= 0 ? '+' : ''}${pct(r.saveSyncMs, r.saveAsyncMs).toFixed(0)}%`
    console.log(
      pad(r.id, 22)
      + pad(r.payload, 6)
      + pad(r.syncKiB.toFixed(1), 10)
      + pad(r.asyncKiB.toFixed(1), 10)
      + pad(String(r.byteDelta), 8)
      + pad(`${r.saveSyncMs.toFixed(1)} ms`, 11)
      + pad(`${r.saveAsyncMs.toFixed(1)} ms`, 11)
      + pad(`${ratio} ${timePct}`, 12),
    )
  }

  const syncAvg = rows.reduce((s, r) => s + r.saveSyncMs, 0) / rows.length
  const asyncAvg = rows.reduce((s, r) => s + r.saveAsyncMs, 0) / rows.length
  console.log('-'.repeat(90))
  console.log(
    pad('moyenne', 22)
    + pad('', 6)
    + pad('', 10)
    + pad('', 10)
    + pad('', 8)
    + pad(`${syncAvg.toFixed(1)} ms`, 11)
    + pad(`${asyncAvg.toFixed(1)} ms`, 11)
    + pad(`${(asyncAvg / syncAvg).toFixed(2)}× ${pct(syncAvg, asyncAvg) >= 0 ? '+' : ''}${pct(syncAvg, asyncAvg).toFixed(0)}%`, 12),
  )

  const maxDelta = Math.max(...rows.map((r) => r.byteDelta))
  console.log(`\n  Écart taille max sync/async : ${maxDelta} o (zstd peut varier légèrement ; payload décompressé identique).`)
}

function printNotes (): void {
  console.log(`
Notes
─────
• saveBinarySync  — zstdCompressSync sur le payload concaténé.
• saveBinaryAsync — zstd via callback async (même sémantique MSv5 ; taille compressée ± quelques octets).
• MSv4/MSv3       — sections non compressées (deprecated) ; encode via snap dérivé du MSv5.
• MSv3            — seulement si nextId > 65535 (doc ids Uint32) ; sinon colonne absente.
• « size MSv4 »   — % vs MSv5 sync (positif = MSv4 plus gros).
• « time MSv4 »   — % temps save MSv4 vs save MSv5 sync (négatif = MSv5 plus rapide).
`)
}

async function main (): Promise<void> {
  console.log('Binary format SAVE benchmark')
  console.log(`Node ${process.version}  ${new Date().toISOString()}`)

  const rows: SaveResult[] = []
  for (const scenario of buildScenarios()) {
    rows.push(await runScenario(scenario))
    gc()
  }

  printSaveVsLegacy(rows)
  printSaveSyncVsAsync(rows)
  printNotes()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
