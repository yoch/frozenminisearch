import { allocBytes, bytesFromView, readU32LE, readUtf8, utf8Bytes, writeU32LE } from '../binaryBytes'
import type { BinaryBytes } from '../binaryBytes'
import { invalidFrozenIndex } from '../frozenErrors'
import PackedRadixTree from '../PackedRadixTree'
import type { PackedIndexArray, PackedRadixTreeData } from '../PackedRadixTree/types'
import { MSV5_TREE_COLUMN_COUNT } from './binaryMsv5Constants'

const TREE_SECTION_HEADER_BYTES = 16

function columnWidthCode(arr: PackedIndexArray): number {
  if (arr instanceof Uint8Array) return 0
  if (arr instanceof Uint16Array) return 1
  return 2
}

function termTreeColumns(tree: PackedRadixTree): PackedIndexArray[] {
  const columns: PackedIndexArray[] = [
    tree.nodeEdgeOffset,
    tree.nodeValue,
    tree.nodeLeafOrder,
    tree.edgeLabelStart,
    tree.edgeLabelLength,
    tree.edgeChild,
  ]
  if (columns.length !== MSV5_TREE_COLUMN_COUNT) {
    throw new Error('MSv5 tree column count mismatch')
  }
  return columns
}

export function columnWidthFlagsFromTree(tree: PackedRadixTree): number {
  const cols = termTreeColumns(tree)
  let flags = 0
  for (let i = 0; i < cols.length; i++) {
    flags |= columnWidthCode(cols[i])! << (i * 2)
  }
  return flags
}

function pad4(n: number): number {
  return (n + 3) & ~3
}

function writeColumnAt(out: BinaryBytes, offset: number, arr: PackedIndexArray): number {
  const raw = bytesFromView(arr)
  out.set(raw, offset)
  return offset + pad4(raw.length)
}

function termTreeColumnarPayloadLength(columns: PackedIndexArray[], labelBytes: BinaryBytes): number {
  let total = TREE_SECTION_HEADER_BYTES
  for (const col of columns) {
    total += pad4(bytesFromView(col).length)
  }
  return total + labelBytes.length
}

export function buildTermTreeSectionColumnar(tree: PackedRadixTree): Uint8Array {
  const columns = termTreeColumns(tree)
  const labelBytes = utf8Bytes(tree.labelHeap)
  const out = allocBytes(termTreeColumnarPayloadLength(columns, labelBytes))

  writeU32LE(out, 0, tree.size)
  writeU32LE(out, 4, tree.nodeCount)
  writeU32LE(out, 8, tree.edgeCount)
  writeU32LE(out, 12, columnWidthFlagsFromTree(tree))

  let offset = TREE_SECTION_HEADER_BYTES
  for (const col of columns) {
    offset = writeColumnAt(out, offset, col)
  }
  out.set(labelBytes, offset)

  return out
}

function widthFromFlags(flags: number, columnIndex: number): 1 | 2 | 4 {
  const code = (flags >> (columnIndex * 2)) & 3
  if (code === 0) return 1
  if (code === 1) return 2
  if (code === 2) return 4
  throw invalidFrozenIndex(`invalid tree column width code ${code}`)
}

function readColumn(
  buf: BinaryBytes,
  offset: number,
  elementCount: number,
  width: 1 | 2 | 4,
): { arr: PackedIndexArray, next: number } {
  const byteLength = elementCount * width
  const padded = pad4(byteLength)
  if (offset + padded > buf.length) {
    throw invalidFrozenIndex('term tree column truncated')
  }
  let arr: PackedIndexArray
  if (width === 1) {
    arr = elementCount === 0
      ? new Uint8Array(0)
      : new Uint8Array(buf.buffer, buf.byteOffset + offset, elementCount)
  } else if (width === 2) {
    // Columns are pad4-aligned at encode time; section buffers are 4-aligned in MSv5 payloads.
    if (offset % 2 !== 0) {
      throw invalidFrozenIndex('term tree Uint16 column misaligned')
    }
    arr = elementCount === 0
      ? new Uint16Array(0)
      : new Uint16Array(buf.buffer, buf.byteOffset + offset, elementCount)
  } else {
    if (offset % 4 !== 0) {
      throw invalidFrozenIndex('term tree Uint32 column misaligned')
    }
    arr = elementCount === 0
      ? new Uint32Array(0)
      : new Uint32Array(buf.buffer, buf.byteOffset + offset, elementCount)
  }
  return { arr, next: offset + padded }
}

/**
 * Decode the columnar packed term-tree section into a {@link PackedRadixTree}.
 *
 * This reads structural offsets/lengths but does NOT validate leaf ordering or
 * term coverage. Callers that load untrusted snapshots must run
 * {@link validateFrozenTermIndexLeaves} (or {@link validateFrozenSnapshot}, which
 * covers it) before treating the tree as trusted. The binary load path validates
 * via `validateFrozenSnapshot` during decode.
 */
export function readPackedTermTreeSectionColumnar(
  buf: BinaryBytes,
  termCount: number,
): PackedRadixTree {
  if (buf.length < TREE_SECTION_HEADER_BYTES) {
    throw invalidFrozenIndex('term tree section too short')
  }
  const size = readU32LE(buf, 0)
  const nodeCount = readU32LE(buf, 4)
  const edgeCount = readU32LE(buf, 8)
  const widthFlags = readU32LE(buf, 12)
  if (size !== termCount) {
    throw invalidFrozenIndex('term tree termCount mismatch')
  }

  let o = TREE_SECTION_HEADER_BYTES
  const edgeOffLen = nodeCount + 1

  const edgeOff = readColumn(buf, o, edgeOffLen, widthFromFlags(widthFlags, 0))
  o = edgeOff.next
  const nVal = readColumn(buf, o, nodeCount, widthFromFlags(widthFlags, 1))
  o = nVal.next
  const nLeaf = readColumn(buf, o, nodeCount, widthFromFlags(widthFlags, 2))
  o = nLeaf.next
  const eStart = readColumn(buf, o, edgeCount, widthFromFlags(widthFlags, 3))
  o = eStart.next
  const eLen = readColumn(buf, o, edgeCount, widthFromFlags(widthFlags, 4))
  o = eLen.next
  const eChild = readColumn(buf, o, edgeCount, widthFromFlags(widthFlags, 5))
  o = eChild.next

  if (o > buf.length) {
    throw invalidFrozenIndex('term tree label heap out of bounds')
  }
  const labelHeap = o === buf.length ? '' : readUtf8(buf, o, buf.length)

  const data: PackedRadixTreeData = {
    size,
    nodeCount,
    edgeCount,
    labelHeap,
    nodeEdgeOffset: edgeOff.arr,
    nodeValue: nVal.arr,
    nodeLeafOrder: nLeaf.arr,
    edgeLabelStart: eStart.arr,
    edgeLabelLength: eLen.arr,
    edgeChild: eChild.arr,
  }
  const tree = PackedRadixTree.fromData(data)
  return tree
}
