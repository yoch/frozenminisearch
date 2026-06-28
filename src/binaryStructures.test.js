import { LEAF } from './radixTree'
import {
  validateFrozenSnapshot,
  validateFrozenSnapshotNumeric,
} from './binaryStructures'
import { buildStoredFieldsSectionWire } from './binaryWireIo'
import { readStoredFieldsRowsSection } from './storedFieldsWire'
import { allocBytes, writeU32LE } from './binaryBytes'

function densePostings(termCount, nextId) {
  return {
    fieldCount: 1,
    termCount,
    nextId,
    layout: 'dense',
    docIdWidth: 16,
    allDocIds: new Uint16Array(termCount),
    allFreqs: new Uint8Array(termCount).fill(1),
    denseOffsets: Uint32Array.from({ length: termCount }, (_, i) => i),
    denseLengths: new Uint32Array(termCount).fill(1),
  }
}

function validNumericSnap(overrides = {}) {
  return {
    fieldCount: 1,
    nextId: 2,
    documentCount: 2,
    postings: densePostings(2, 2),
    fieldLengthMatrix: new Uint32Array([1, 1]),
    avgFieldLength: new Float32Array([1]),
    fieldIds: { text: 0 },
    ...overrides,
  }
}

function validTreeShapeSnap(treeShape, overrides = {}) {
  return {
    documentCount: 2,
    nextId: 2,
    fieldIds: { text: 0 },
    fieldCount: 1,
    avgFieldLength: new Float32Array([1]),
    externalIds: ['a', 'b'],
    storedFields: [undefined, undefined],
    fieldLengthMatrix: new Uint32Array([1, 1]),
    treeShape,
    postings: densePostings(2, 2),
    ...overrides,
  }
}

describe('validateFrozenSnapshotNumeric', () => {
  test('accepts a consistent numeric snapshot', () => {
    expect(() => validateFrozenSnapshotNumeric(validNumericSnap())).not.toThrow()
  })

  test('rejects invalid numeric invariants', () => {
    expect(() => validateFrozenSnapshotNumeric(validNumericSnap({ fieldCount: 0 })))
      .toThrow(/fieldCount must be positive/)
    expect(() => validateFrozenSnapshotNumeric(validNumericSnap({ nextId: 0xffffffff })))
      .toThrow(/nextId out of range/)
    expect(() => validateFrozenSnapshotNumeric(validNumericSnap({ documentCount: 3, nextId: 2 })))
      .toThrow(/documentCount inconsistent/)
    expect(() => validateFrozenSnapshotNumeric(validNumericSnap({ avgFieldLength: new Float32Array() })))
      .toThrow(/avgFieldLength size mismatch/)
    expect(() => validateFrozenSnapshotNumeric(validNumericSnap({
      fieldCount: 2,
      fieldIds: { text: 0 },
      fieldLengthMatrix: new Uint32Array(4),
      avgFieldLength: new Float32Array(2),
      postings: densePostings(2, 2),
    }))).toThrow(/fieldIds count mismatch/)
    expect(() => validateFrozenSnapshotNumeric(validNumericSnap({
      fieldIds: { text: 1 },
      fieldCount: 1,
    }))).toThrow(/missing field id 0/)
  })
})

describe('validateFrozenSnapshot treeShape', () => {
  const goodShape = [
    ['alpha', [[LEAF, 0]]],
    ['beta', [[LEAF, 1]]],
  ]

  test('accepts a valid tree shape', () => {
    expect(() => validateFrozenSnapshot(validTreeShapeSnap(goodShape))).not.toThrow()
  })

  test('rejects malformed tree shape nodes and leaves', () => {
    expect(() => validateFrozenSnapshot(validTreeShapeSnap('bad')))
      .toThrow(/treeShape node must be an array/)
    expect(() => validateFrozenSnapshot(validTreeShapeSnap([['only-key']])))
      .toThrow(/treeShape entry must be a \[key, value\] pair/)
    expect(() => validateFrozenSnapshot(validTreeShapeSnap([
      ['alpha', [[LEAF, 99]]],
      ['beta', [[LEAF, 1]]],
    ]))).toThrow(/leaf term index out of range/)
    expect(() => validateFrozenSnapshot(validTreeShapeSnap([
      ['alpha', [[LEAF, 0]]],
      ['beta', [[LEAF, 0]]],
    ]))).toThrow(/duplicate leaf index/)
    expect(() => validateFrozenSnapshot(validTreeShapeSnap([
      ['alpha', [[LEAF, 0]]],
    ]))).toThrow(/leaf count .* !== termCount/)
  })
})

describe('readStoredFieldsRowsSection', () => {
  test('round-trips stored field rows', () => {
    const section = buildStoredFieldsSectionWire([{ txt: 'x' }, undefined, { txt: 'y' }], 3)
    expect(readStoredFieldsRowsSection(section, 0, 3, section.length)).toEqual([
      { txt: 'x' },
      undefined,
      { txt: 'y' },
    ])
  })

  test('rejects corrupted stored-fields sections', () => {
    const section = buildStoredFieldsSectionWire([{ txt: 'x' }], 1)
    expect(() => readStoredFieldsRowsSection(section, 0, 2, 4))
      .toThrow(/stored fields table out of bounds/)

    const tableOnly = allocBytes(4)
    writeU32LE(tableOnly, 0, 1)
    expect(() => readStoredFieldsRowsSection(tableOnly, 0, 1, 4))
      .toThrow(/stored fields entry offset out of bounds/)

    const badJsonLen = allocBytes(8)
    writeU32LE(badJsonLen, 0, 1)
    writeU32LE(badJsonLen, 4, 99)
    expect(() => readStoredFieldsRowsSection(badJsonLen, 0, 1, 8))
      .toThrow(/stored fields JSON out of bounds/)
  })
})
