import { invalidFrozenIndex } from '../frozenErrors'
import PackedRadixTree from '../PackedRadixTree'
import type { PackedIndexArray, PackedRadixTreeData } from '../PackedRadixTree/types'
import { validateFrozenTermIndexLeaves } from '../frozenTermIndex'
import { MSV5_TREE_COLUMN_COUNT } from './binaryMsv5Constants'

const TREE_SECTION_HEADER_BYTES = 16

function columnWidthCode(arr: PackedIndexArray): number {
  if (arr instanceof Uint8Array) return 0
  if (arr instanceof Uint16Array) return 1
  return 2
}

export function columnWidthFlagsFromTree(tree: PackedRadixTree): number {
  const cols: PackedIndexArray[] = [
    tree.nodeEdgeOffset,
    tree.nodeValue,
    tree.nodeLeafOrder,
    tree.edgeLabelStart,
    tree.edgeLabelLength,
    tree.edgeChild,
  ]
  if (cols.length !== MSV5_TREE_COLUMN_COUNT) {
    throw new Error('MSv5 tree column count mismatch')
  }
  let flags = 0
  for (let i = 0; i < cols.length; i++) {
    flags |= columnWidthCode(cols[i])! << (i * 2)
  }
  return flags
}

function pad4(n: number): number {
  return (n + 3) & ~3
}

function appendColumn(chunks: Buffer[], arr: PackedIndexArray): void {
  const raw = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
  chunks.push(raw)
  const pad = pad4(raw.length) - raw.length
  if (pad > 0) chunks.push(Buffer.alloc(pad))
}

export function buildTermTreeSectionColumnar(tree: PackedRadixTree): Buffer {
  const header = Buffer.alloc(TREE_SECTION_HEADER_BYTES)
  header.writeUInt32LE(tree.size, 0)
  header.writeUInt32LE(tree.nodeCount, 4)
  header.writeUInt32LE(tree.edgeCount, 8)
  header.writeUInt32LE(columnWidthFlagsFromTree(tree), 12)

  const chunks: Buffer[] = [header]
  appendColumn(chunks, tree.nodeEdgeOffset)
  appendColumn(chunks, tree.nodeValue)
  appendColumn(chunks, tree.nodeLeafOrder)
  appendColumn(chunks, tree.edgeLabelStart)
  appendColumn(chunks, tree.edgeLabelLength)
  appendColumn(chunks, tree.edgeChild)

  const labelBuf = Buffer.from(tree.labelHeap, 'utf8')
  chunks.push(labelBuf)
  return Buffer.concat(chunks)
}

function widthFromFlags(flags: number, columnIndex: number): 1 | 2 | 4 {
  const code = (flags >> (columnIndex * 2)) & 3
  if (code === 0) return 1
  if (code === 1) return 2
  if (code === 2) return 4
  throw invalidFrozenIndex(`invalid tree column width code ${code}`)
}

function readColumn(
  buf: Buffer,
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

export function readPackedTermTreeSectionColumnar(
  buf: Buffer,
  termCount: number,
): PackedRadixTree {
  if (buf.length < TREE_SECTION_HEADER_BYTES) {
    throw invalidFrozenIndex('term tree section too short')
  }
  const size = buf.readUInt32LE(0)
  const nodeCount = buf.readUInt32LE(4)
  const edgeCount = buf.readUInt32LE(8)
  const widthFlags = buf.readUInt32LE(12)
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
  const labelHeap = o === buf.length ? '' : buf.toString('utf8', o, buf.length)

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
  validateFrozenTermIndexLeaves(tree, termCount)
  return tree
}
