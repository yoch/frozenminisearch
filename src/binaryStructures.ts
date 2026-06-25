import {
  LEAF,
  deserializeRadixTreeShape,
  validateRadixLeaves,
  type RadixTree,
  type RadixTreeShape,
} from './radixTree'
import type { FieldLengthArray } from './fieldLengthMatrix'
import type { FrozenPostingsLayout } from './frozenPostings'
import { validateFrozenPostingsLayout } from './frozenPostings'
import type { FrozenTermIndex } from './frozenTermIndex'
import { validateFrozenTermIndexLeaves } from './frozenTermIndex'
import { invalidFrozenIndex } from './frozenErrors'
import {
  readExternalId,
  readLengthPrefixedUtf8,
} from './binaryWireIo'
import { readU32LE, readUtf8 } from './binaryBytes'
import type { BinaryBytes } from './binaryBytes'
import type { StoredFieldsLayout } from './storedFieldsLayout'

export type TreeShape = RadixTreeShape

/** Flat frozen snapshot (runtime; on disk use {@link encodeFrozenSnapshot}). */
export interface FrozenSnapshot {
  documentCount: number
  nextId: number
  fieldIds: { [fieldName: string]: number }
  fieldCount: number
  /** Field names in index order (0..fieldCount-1); populated on decode. */
  fieldNames?: string[]
  avgFieldLength: Float32Array
  externalIds: unknown[]
  storedFields: (Record<string, unknown> | undefined)[]
  /** When set, MSv5 wire path uses layout directly; storedFields may be a length-only placeholder. */
  storedFieldsLayout?: StoredFieldsLayout
  fieldLengthMatrix: FieldLengthArray
  treeShape: TreeShape
  /** Radix tree from JSON snapshot wire; absent when {@link packedTermIndex} is set (MSv5 binary). */
  termTree?: RadixTree<number>
  /** Preferred runtime term index after binary decode. */
  packedTermIndex?: FrozenTermIndex
  postings: FrozenPostingsLayout
}

function validateTreeShape(shape: TreeShape, termCount: number): void {
  const seen = new Set<number>()

  function visit(node: TreeShape): void {
    if (!Array.isArray(node)) {
      throw invalidFrozenIndex('treeShape node must be an array')
    }
    for (const entry of node) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw invalidFrozenIndex('treeShape entry must be a [key, value] pair')
      }
      const [key, value] = entry
      if (key === LEAF) {
        const idx = value as number
        if (!Number.isInteger(idx) || idx < 0 || idx >= termCount) {
          throw invalidFrozenIndex(`treeShape leaf term index out of range: ${idx}`)
        }
        if (seen.has(idx)) {
          throw invalidFrozenIndex(`treeShape duplicate leaf index: ${idx}`)
        }
        seen.add(idx)
      } else {
        visit(value as TreeShape)
      }
    }
  }

  visit(shape)
  if (seen.size !== termCount) {
    throw invalidFrozenIndex(`treeShape leaf count ${seen.size} !== termCount ${termCount}`)
  }
}

export function termCountOf(snap: { postings: FrozenPostingsLayout }): number {
  return snap.postings.termCount
}

/**
 * Numeric/structural invariants shared by both the decode path (untrusted binary)
 * and the build path (trusted internal code).
 */
export function validateFrozenSnapshotNumeric(snap: {
  fieldCount: number
  nextId: number
  documentCount: number
  postings: FrozenPostingsLayout
  fieldLengthMatrix: FieldLengthArray
  avgFieldLength: Float32Array
  fieldIds: { [field: string]: number }
}): void {
  if (snap.fieldCount <= 0) {
    throw invalidFrozenIndex('fieldCount must be positive')
  }
  if (snap.nextId < 0 || snap.nextId >= 0xffffffff) {
    throw invalidFrozenIndex('nextId out of range')
  }
  if (snap.documentCount < 0 || snap.documentCount > snap.nextId) {
    throw invalidFrozenIndex('documentCount inconsistent with nextId')
  }
  if (snap.fieldLengthMatrix.length !== snap.nextId * snap.fieldCount) {
    throw invalidFrozenIndex('fieldLengthMatrix size mismatch')
  }
  if (snap.avgFieldLength.length !== snap.fieldCount) {
    throw invalidFrozenIndex('avgFieldLength size mismatch')
  }

  validateFrozenPostingsLayout(snap.postings, snap.documentCount, snap.nextId, (detail) => {
    throw invalidFrozenIndex(detail)
  })

  const indexedFields = Object.keys(snap.fieldIds)
  if (indexedFields.length !== snap.fieldCount) {
    throw invalidFrozenIndex('fieldIds count mismatch')
  }
  for (let f = 0; f < snap.fieldCount; f++) {
    const found = indexedFields.some(name => snap.fieldIds[name] === f)
    if (!found) {
      throw invalidFrozenIndex(`missing field id ${f}`)
    }
  }
}

export function readFieldNamesSection(
  buf: BinaryBytes,
  fieldNamesOff: number,
  fieldCount: number,
  externalIdsOff: number,
): string[] {
  const fieldNames: string[] = []
  let o = fieldNamesOff
  for (let f = 0; f < fieldCount; f++) {
    const { value, next } = readLengthPrefixedUtf8(buf, o)
    fieldNames.push(value)
    o = next
  }
  if (o !== externalIdsOff) {
    throw invalidFrozenIndex('field names section size mismatch')
  }
  return fieldNames
}

export function readExternalIdsSection(
  buf: BinaryBytes,
  externalIdsOff: number,
  nextId: number,
  storedOff: number,
): unknown[] {
  const externalIds: unknown[] = new Array(nextId)
  let o = externalIdsOff
  for (let i = 0; i < nextId; i++) {
    const { value, next } = readExternalId(buf, o)
    externalIds[i] = value
    o = next
  }
  if (o !== storedOff) {
    throw invalidFrozenIndex('external ids section size mismatch')
  }
  return externalIds
}

export function readStoredFieldsSection(
  buf: BinaryBytes,
  storedOff: number,
  nextId: number,
  sectionEnd: number,
): (Record<string, unknown> | undefined)[] {
  const storedFields: (Record<string, unknown> | undefined)[] = new Array(nextId)
  const tableEnd = storedOff + nextId * 4
  if (tableEnd > sectionEnd) {
    throw invalidFrozenIndex('stored fields table out of bounds')
  }
  for (let i = 0; i < nextId; i++) {
    const rel = readU32LE(buf, storedOff + i * 4)
    if (rel === 0) {
      storedFields[i] = undefined
      continue
    }
    const entryOff = tableEnd + rel - 1
    if (entryOff + 4 > sectionEnd) {
      throw invalidFrozenIndex('stored fields entry offset out of bounds')
    }
    const jsonLen = readU32LE(buf, entryOff)
    const jsonStart = entryOff + 4
    const jsonEnd = jsonStart + jsonLen
    if (jsonEnd > sectionEnd) {
      throw invalidFrozenIndex('stored fields JSON out of bounds')
    }
    storedFields[i] = JSON.parse(readUtf8(buf, jsonStart, jsonEnd)) as Record<string, unknown>
  }
  return storedFields
}

/** Validate structural invariants of a decoded or assembled frozen snapshot. */
export function validateFrozenSnapshot(snap: FrozenSnapshot): void {
  validateFrozenSnapshotNumeric(snap)
  const termCount = termCountOf(snap)
  if (snap.packedTermIndex != null) {
    validateFrozenTermIndexLeaves(snap.packedTermIndex, termCount)
  } else if (snap.termTree != null) {
    validateTermTreeLeaves(snap.termTree, termCount)
  } else {
    validateTreeShape(snap.treeShape, termCount)
  }
}

export function fieldNamesFromFieldIds(fieldIds: { [field: string]: number }): string[] {
  const names = Object.keys(fieldIds)
  names.sort((a, b) => fieldIds[a] - fieldIds[b])
  return names
}

export function validateTermTreeLeaves(tree: RadixTree<number>, termCount: number): void {
  validateRadixLeaves(tree, termCount, (detail) => { throw invalidFrozenIndex(detail) })
}

export function deserializeTermIndexTree(shape: TreeShape): RadixTree<number> {
  return deserializeRadixTreeShape(shape)
}
