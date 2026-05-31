#!/usr/bin/env node
/**
 * Bootstrap benchmarks/packed-radix-history.jsonl from baselines on disk.
 * Idempotent: skips if history already has entries.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '../..')
const BASELINES = join(REPO, 'benchmarks/baselines')
const HISTORY = join(REPO, 'benchmarks/packed-radix-history.jsonl')
const benchUtils = pathToFileURL(join(REPO, 'benchmarks/benchmarkUtils.js')).href

const { packedRadixHistoryEntry } = await import(benchUtils)

function load (name) {
  return JSON.parse(readFileSync(join(BASELINES, name), 'utf8'))
}

function syntheticPrePhase1 () {
  const pre = load('packed-radix-pre-phase1.json')
  const corpora = {}
  for (const [id, row] of Object.entries(pre.corpora)) {
    corpora[id] = {
      structuredBytes: row.bytes.totalStructuredBytes,
      packedByteLength: row.bytes.packedByteLength,
      edgeCount: row.edgeCount,
    }
  }
  return {
    protocolVersion: 1,
    recordKind: 'synthetic-pre-phase1',
    capturedAt: pre.metadata?.capturedAt ?? '2026-05-31T19:00:00.000Z',
    packageVersion: pre.metadata?.packageVersion ?? null,
    git: {
      commit: null,
      commitShort: 'pre-phase1',
      subject: 'Avant suppression edgeFirstChar (mesures + extrapolation)',
      dirty: false,
    },
    baselineCommit: 'synthetic:pre-phase1',
    suiteFingerprint: Object.keys(corpora),
    corpora,
  }
}

function fromGolden (ref) {
  const payload = { metadata: ref.metadata, corpora: ref.corpora }
  const entry = packedRadixHistoryEntry(payload)
  entry.recordKind = ref.metadata?.recordKind ?? 'golden-import'
  entry.baselineCommit = ref.metadata?.baselineCommit ?? ref.metadata?.git?.commit ?? entry.baselineCommit
  if (ref.metadata?.git?.dirty) {
    entry.note = 'Importé depuis référence ; mesure initiale sur worktree dirty (re-enregistrer proprement après commit).'
  }
  return entry
}

if (existsSync(HISTORY) && readFileSync(HISTORY, 'utf8').trim()) {
  console.log(`Historique déjà présent : ${HISTORY}`)
  process.exit(0)
}

const lines = [syntheticPrePhase1(), fromGolden(load('packed-radix-reference.json'))]
writeFileSync(HISTORY, lines.map((e) => JSON.stringify(e)).join('\n') + '\n')
console.log(`Écrit ${lines.length} entrées → ${HISTORY}`)
