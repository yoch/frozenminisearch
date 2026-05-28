import type { RadixTree } from './SearchableMap/types'
import { shouldEncodeBinaryAsMSv4 } from './frozenPostings'
import type PackedFrozenRadixTree from './packedRadixTree'
import { buildTermTreeSectionFromPacked } from './packedRadixBinary'
import {
  BINARY_MAGIC_V3,
  BINARY_MAGIC_V4,
  BINARY_VERSION_V3,
  BINARY_VERSION_V4,
  FLAG_DOC_ID_16,
  FLAG_FIELD_ID_16,
  FLAG_SPARSE_LAYOUT,
  HEADER_SIZE_V3,
  HEADER_SIZE_V4,
} from './binaryConstants'
import { bufferFromView, crc32Buffer, invalidFrozenIndex } from './binaryIo'
import {
  buildCoreSection,
  buildDictionarySection,
  buildExternalIdsSection,
  buildFieldNamesSection,
  buildStoredFieldsSection,
  buildTermTreeSection,
  deserializeTermIndexTree,
  fieldNamesFromFieldIds,
  validateFrozenSnapshotNumeric,
  validateTermTreeLeaves,
  type FrozenSnapshot,
} from './binaryStructures'

function assembleSections(
  magic: string,
  version: number,
  headerSize: number,
  flags: number,
  sections: Buffer[],
): Buffer {
  const sectionSizes = sections.map(s => s.length)
  const totalSize = headerSize + sectionSizes.reduce((a, b) => a + b, 0)
  const out = Buffer.alloc(totalSize)

  out.write(magic, 0, 4, 'ascii')
  out.writeUInt16LE(version, 4)
  out.writeUInt16LE(flags, 6)
  out.writeUInt32LE(0, 8)

  let sectionOff = headerSize
  for (let i = 0; i < sectionSizes.length; i++) {
    out.writeUInt32LE(sectionOff, 12 + i * 4)
    sectionOff += sectionSizes[i]
  }
  out.writeUInt32LE(sectionOff, 12 + sectionSizes.length * 4)

  let off = headerSize
  for (const section of sections) {
    section.copy(out, off)
    off += section.length
  }

  const crc = crc32Buffer(out, headerSize, out.length)
  out.writeUInt32LE(crc, 8)

  return out
}

type EncodeTreeSource =
  | { kind: 'packed', tree: PackedFrozenRadixTree }
  | { kind: 'radix', tree: RadixTree<number> }

function prepareEncodeSnapshot(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: PackedFrozenRadixTree,
): { snap: FrozenSnapshot, treeSource: EncodeTreeSource, fieldNames: string[] } {
  validateFrozenSnapshotNumeric(snap)
  const fieldNames = snap.fieldNames ?? fieldNamesFromFieldIds(snap.fieldIds)
  if (fieldNames.length !== snap.fieldCount) {
    throw invalidFrozenIndex('fieldNames length mismatch')
  }

  const packed = packedTermIndex ?? snap.packedTermIndex
  if (packed != null) {
    packed.validateLeaves(snap.terms.length)
    return { snap, treeSource: { kind: 'packed', tree: packed }, fieldNames }
  }

  const tree = termTree ?? deserializeTermIndexTree(snap.treeShape)
  validateTermTreeLeaves(tree, snap.terms.length)
  return { snap, treeSource: { kind: 'radix', tree }, fieldNames }
}

function buildTermTreeSectionFromSource(source: EncodeTreeSource): Buffer {
  if (source.kind === 'packed') {
    return buildTermTreeSectionFromPacked(source.tree)
  }
  return buildTermTreeSection(source.tree)
}

function encodeMSv3(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: PackedFrozenRadixTree,
): Buffer {
  const { snap: validated, treeSource, fieldNames } = prepareEncodeSnapshot(snap, termTree, packedTermIndex)
  const p = validated.postings
  if (p.layout !== 'dense' || p.docIdWidth !== 32) {
    throw invalidFrozenIndex('MSv3 encode requires dense layout with Uint32 doc ids')
  }
  if (!(p.allDocIds instanceof Uint32Array)) {
    throw invalidFrozenIndex('MSv3 encode requires Uint32Array allDocIds')
  }

  const sections = [
    buildCoreSection(validated),
    buildFieldNamesSection(fieldNames),
    buildExternalIdsSection(validated.externalIds, validated.nextId),
    buildStoredFieldsSection(validated.storedFields, validated.nextId),
    buildTermTreeSectionFromSource(treeSource),
    bufferFromView(validated.avgFieldLength),
    bufferFromView(validated.fieldLengthMatrix),
    buildDictionarySection(validated.terms),
    bufferFromView(p.denseOffsets!),
    bufferFromView(p.denseLengths!),
    bufferFromView(p.allDocIds),
    bufferFromView(p.allFreqs),
  ]

  return assembleSections(BINARY_MAGIC_V3, BINARY_VERSION_V3, HEADER_SIZE_V3, 0, sections)
}

function encodeMSv4(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: PackedFrozenRadixTree,
): Buffer {
  const { snap: validated, treeSource, fieldNames } = prepareEncodeSnapshot(snap, termTree, packedTermIndex)

  const p = validated.postings
  const flags = (p.docIdWidth === 16 ? FLAG_DOC_ID_16 : 0)
    | (p.layout === 'sparse' ? FLAG_SPARSE_LAYOUT : 0)
    | (p.sparseFieldIdWidth === 16 ? FLAG_FIELD_ID_16 : 0)

  let postMetaBuf: Buffer
  let postFieldsBuf: Buffer
  let postOffBuf: Buffer
  let postLenBuf: Buffer

  if (p.layout === 'dense') {
    postMetaBuf = bufferFromView(p.denseOffsets!)
    postFieldsBuf = bufferFromView(p.denseLengths!)
    postOffBuf = Buffer.alloc(0)
    postLenBuf = Buffer.alloc(0)
  } else {
    postMetaBuf = bufferFromView(p.sparseTermStarts!)
    postFieldsBuf = bufferFromView(p.sparseFieldIds!)
    postOffBuf = bufferFromView(p.sparseOffsets!)
    postLenBuf = bufferFromView(p.sparseLengths!)
  }

  const sections = [
    buildCoreSection(validated),
    buildFieldNamesSection(fieldNames),
    buildExternalIdsSection(validated.externalIds, validated.nextId),
    buildStoredFieldsSection(validated.storedFields, validated.nextId),
    buildTermTreeSectionFromSource(treeSource),
    bufferFromView(validated.avgFieldLength),
    bufferFromView(validated.fieldLengthMatrix),
    buildDictionarySection(validated.terms),
    postMetaBuf,
    postFieldsBuf,
    postOffBuf,
    postLenBuf,
    bufferFromView(p.allDocIds),
    bufferFromView(p.allFreqs),
  ]

  return assembleSections(BINARY_MAGIC_V4, BINARY_VERSION_V4, HEADER_SIZE_V4, flags, sections)
}

export function encodeFrozenSnapshot(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: PackedFrozenRadixTree,
): Buffer {
  const packed = packedTermIndex ?? snap.packedTermIndex
  if (shouldEncodeBinaryAsMSv4(snap.postings)) {
    return encodeMSv4(snap, termTree, packed)
  }
  return encodeMSv3(snap, termTree, packed)
}
