import { LEAF } from './SearchableMap/TreeIterator'
import type { RadixTree } from './SearchableMap/types'
import type { FieldLengthArray } from './fieldLengthMatrix'
import type { FrozenPostingsLayout } from './frozenPostings'
import { validateFrozenPostingsLayout } from './frozenPostings'
import type { FrozenTermIndex } from './frozenTermIndex'
import { validateFrozenTermIndexLeaves } from './frozenTermIndex'
import {
  TREE_NODE_EDGE,
  TREE_NODE_LEAF,
} from './binaryConstants'
import {
  invalidFrozenIndex,
  readExternalId,
  readLengthPrefixedUtf8,
  writeExternalId,
} from './binaryIo'

export type TreeShape = Array<[string, number | TreeShape]>

/** Flat frozen snapshot (runtime + MSv3 on disk). */
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
  fieldLengthMatrix: FieldLengthArray
  treeShape: TreeShape
  /** Populated on decode; legacy path when {@link packedTermIndex} is absent. */
  termTree?: RadixTree<number>
  /** Preferred runtime term index after binary decode. */
  packedTermIndex?: FrozenTermIndex
  postings: FrozenPostingsLayout
}

function validateTreeShape(shape: TreeShape, termCount: number): void {
  if (!Array.isArray(shape)) {
    throw invalidFrozenIndex('treeShape node must be an array')
  }
  for (const entry of shape) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw invalidFrozenIndex('treeShape entry must be a [key, value] pair')
    }
    const [key, value] = entry
    if (key === LEAF) {
      const idx = value as number
      if (!Number.isInteger(idx) || idx < 0 || idx >= termCount) {
        throw invalidFrozenIndex(`treeShape leaf term index out of range: ${idx}`)
      }
    } else {
      validateTreeShape(value as TreeShape, termCount)
    }
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

  validateFrozenPostingsLayout(snap.postings, snap.documentCount, snap.nextId, detail => {
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
  buf: Buffer,
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
  buf: Buffer,
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
  buf: Buffer,
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
    const rel = buf.readUInt32LE(storedOff + i * 4)
    if (rel === 0) {
      storedFields[i] = undefined
      continue
    }
    const entryOff = tableEnd + rel - 1
    if (entryOff + 4 > sectionEnd) {
      throw invalidFrozenIndex('stored fields entry offset out of bounds')
    }
    const jsonLen = buf.readUInt32LE(entryOff)
    const jsonStart = entryOff + 4
    const jsonEnd = jsonStart + jsonLen
    if (jsonEnd > sectionEnd) {
      throw invalidFrozenIndex('stored fields JSON out of bounds')
    }
    storedFields[i] = JSON.parse(buf.toString('utf8', jsonStart, jsonEnd)) as Record<string, unknown>
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

/** Core with explicit {@link termCountOf} (MSv3/MSv4 on-disk; no dictionary section). */
export function buildCoreSectionWithTermCount(snap: FrozenSnapshot): Buffer {
  const out = Buffer.alloc(16)
  out.writeUInt32LE(snap.documentCount, 0)
  out.writeUInt32LE(snap.nextId, 4)
  out.writeUInt32LE(snap.fieldCount, 8)
  out.writeUInt32LE(termCountOf(snap), 12)
  return out
}

export function buildFieldNamesSection(fieldNames: string[]): Buffer {
  const chunks: Buffer[] = []
  for (const name of fieldNames) {
    const body = Buffer.from(name, 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(body.length, 0)
    chunks.push(header, body)
  }
  return Buffer.concat(chunks)
}

export function buildExternalIdsSection(externalIds: unknown[], nextId: number): Buffer {
  const chunks: Buffer[] = []
  for (let i = 0; i < nextId; i++) {
    writeExternalId(chunks, externalIds[i])
  }
  return Buffer.concat(chunks)
}

export function buildStoredFieldsSection(
  storedFields: (Record<string, unknown> | undefined)[],
  nextId: number,
): Buffer {
  const table = Buffer.alloc(nextId * 4)
  const heapChunks: Buffer[] = []
  let heapOff = 0
  for (let i = 0; i < nextId; i++) {
    const row = storedFields[i]
    if (row == null) {
      table.writeUInt32LE(0, i * 4)
      continue
    }
    table.writeUInt32LE(heapOff + 1, i * 4)
    const json = Buffer.from(JSON.stringify(row), 'utf8')
    const entry = Buffer.alloc(4 + json.length)
    entry.writeUInt32LE(json.length, 0)
    json.copy(entry, 4)
    heapChunks.push(entry)
    heapOff += entry.length
  }
  return Buffer.concat([table, ...heapChunks])
}

function writeTermTreeNode(chunks: Buffer[], tree: RadixTree<number>): void {
  const entries: Array<[string, number | RadixTree<number>]> = []
  for (const [key, val] of tree) {
    entries.push([key, val as number | RadixTree<number>])
  }

  const countBuf = Buffer.alloc(2)
  countBuf.writeUInt16LE(entries.length, 0)
  chunks.push(countBuf)

  for (const [key, val] of entries) {
    if (key === LEAF) {
      const node = Buffer.alloc(1 + 4)
      node.writeUInt8(TREE_NODE_LEAF, 0)
      node.writeUInt32LE(val as number, 1)
      chunks.push(node)
    } else {
      const keyBuf = Buffer.from(key, 'utf8')
      if (keyBuf.length > 0xffff) {
        throw invalidFrozenIndex('term tree edge key too long')
      }
      const header = Buffer.alloc(1 + 2 + keyBuf.length)
      header.writeUInt8(TREE_NODE_EDGE, 0)
      header.writeUInt16LE(keyBuf.length, 1)
      keyBuf.copy(header, 3)
      chunks.push(header)
      writeTermTreeNode(chunks, val as RadixTree<number>)
    }
  }
}

export function buildTermTreeSection(tree: RadixTree<number>): Buffer {
  const chunks: Buffer[] = []
  writeTermTreeNode(chunks, tree)
  return Buffer.concat(chunks)
}

function readTermTreeNode(buf: Buffer, offset: number, end: number): { tree: RadixTree<number>, next: number } {
  if (offset + 2 > end) {
    throw invalidFrozenIndex('term tree node child count truncated')
  }
  const childCount = buf.readUInt16LE(offset)
  const tree = new Map() as RadixTree<number>
  let o = offset + 2

  for (let c = 0; c < childCount; c++) {
    if (o >= end) {
      throw invalidFrozenIndex('term tree child truncated')
    }
    const tag = buf.readUInt8(o)
    if (tag === TREE_NODE_LEAF) {
      if (o + 5 > end) {
        throw invalidFrozenIndex('term tree leaf truncated')
      }
      tree.set(LEAF, buf.readUInt32LE(o + 1))
      o += 5
      continue
    }
    if (tag === TREE_NODE_EDGE) {
      if (o + 3 > end) {
        throw invalidFrozenIndex('term tree edge header truncated')
      }
      const keyLen = buf.readUInt16LE(o + 1)
      const keyStart = o + 3
      const keyEnd = keyStart + keyLen
      if (keyEnd > end) {
        throw invalidFrozenIndex('term tree edge key out of bounds')
      }
      const key = buf.toString('utf8', keyStart, keyEnd)
      const { tree: child, next } = readTermTreeNode(buf, keyEnd, end)
      tree.set(key, child)
      o = next
      continue
    }
    throw invalidFrozenIndex(`unknown term tree node tag ${tag}`)
  }

  return { tree, next: o }
}

export function readTermTreeSection(buf: Buffer, offset: number, end: number): RadixTree<number> {
  const { tree, next } = readTermTreeNode(buf, offset, end)
  if (next !== end) {
    throw invalidFrozenIndex('term tree section has trailing bytes')
  }
  return tree
}

export function validateTermTreeLeaves(tree: RadixTree<number>, termCount: number): void {
  for (const [key, val] of tree) {
    if (key === LEAF) {
      const idx = val as number
      if (!Number.isInteger(idx) || idx < 0 || idx >= termCount) {
        throw invalidFrozenIndex(`term tree leaf index out of range: ${idx}`)
      }
    } else {
      validateTermTreeLeaves(val as RadixTree<number>, termCount)
    }
  }
}

export function deserializeTermIndexTree(shape: TreeShape): RadixTree<number> {
  const tree = new Map() as RadixTree<number>
  for (const [key, value] of shape) {
    if (key === LEAF) {
      tree.set(LEAF, value as number)
    } else {
      tree.set(key, deserializeTermIndexTree(value as TreeShape))
    }
  }
  return tree
}

export function serializeTermIndexTree(tree: RadixTree<number>): TreeShape {
  const shape: TreeShape = []
  const entries: Array<[string, number | RadixTree<number>]> = []
  for (const [key, val] of tree) {
    entries.push([key, val as number | RadixTree<number>])
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]))
  for (const [key, val] of entries) {
    if (key === LEAF) {
      shape.push([key, val as number])
    } else {
      shape.push([key, serializeTermIndexTree(val as RadixTree<number>)])
    }
  }
  return shape
}
