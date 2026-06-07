/**
 * Reconstruct a document corpus from a frozen .msbin snapshot by inverting postings.
 * Used to benchmark FrozenIndexBuilder peak as if indexing from an external corpus
 * (CSV/XML ETL output), not loadBinary().
 */
import { readFileSync } from 'node:fs'
import type { FrozenSnapshot } from '../src/binaryStructures.ts'
import { decodeFrozenSnapshotMsv5 } from '../src/msv5/binaryMsv5Decode.ts'
import { createFrozenFieldTermFlyweight } from '../src/frozenPostings.ts'

export type ExtractedMedicamentsCorpus = {
  documents: Record<string, unknown>[]
  options: { fields: string[], storeFields: string[] }
  meta: {
    documentCount: number
    termCount: number
    fieldCount: number
    fields: string[]
    corpusTextBytes: number
  }
}

function fieldNamesInOrder (snap: FrozenSnapshot): string[] {
  if (snap.fieldNames != null && snap.fieldNames.length === snap.fieldCount) {
    return snap.fieldNames
  }
  return Object.entries(snap.fieldIds)
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name)
}

function inferStoreFields (snap: FrozenSnapshot): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const row of snap.storedFields) {
    if (row == null) continue
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

/** Invert flat postings + term index into per-document field text (terms repeated by freq). */
export function extractCorpusFromSnapshot (snap: FrozenSnapshot): ExtractedMedicamentsCorpus {
  const fields = fieldNamesInOrder(snap)
  const { fieldCount, documentCount, postings, externalIds, storedFields } = snap
  const tree = snap.packedTermIndex
  if (tree == null) {
    throw new Error('extractCorpusFromSnapshot: packedTermIndex missing (legacy snapshot?)')
  }

  const fieldTokens: string[][][] = Array.from({ length: documentCount }, () =>
    Array.from({ length: fieldCount }, () => [] as string[]),
  )

  const flyweight = createFrozenFieldTermFlyweight(postings)
  for (let ti = 0; ti < postings.termCount; ti++) {
    const term = tree.termByIndex(ti)
    const fw = flyweight.bind(ti)
    for (let f = 0; f < fieldCount; f++) {
      const seg = fw.get(f)
      if (seg == null) continue
      seg.forEachDoc((docId, freq) => {
        const bucket = fieldTokens[docId][f]
        for (let k = 0; k < freq; k++) bucket.push(term)
      })
    }
  }

  const storeFields = inferStoreFields(snap)
  const documents: Record<string, unknown>[] = new Array(documentCount)
  let corpusTextBytes = 0

  for (let d = 0; d < documentCount; d++) {
    const doc: Record<string, unknown> = { id: externalIds[d] ?? d }
    for (let f = 0; f < fieldCount; f++) {
      const text = fieldTokens[d][f].join(' ')
      if (text.length > 0) {
        doc[fields[f]] = text
        corpusTextBytes += text.length
      }
    }
    const stored = storedFields[d]
    if (stored != null) Object.assign(doc, stored)
    documents[d] = doc
  }

  return {
    documents,
    options: { fields, storeFields },
    meta: {
      documentCount,
      termCount: postings.termCount,
      fieldCount,
      fields,
      corpusTextBytes,
    },
  }
}

export function extractCorpusFromMsbinFile (filePath: string): ExtractedMedicamentsCorpus {
  const snap = decodeFrozenSnapshotMsv5(readFileSync(filePath))
  return extractCorpusFromSnapshot(snap)
}
