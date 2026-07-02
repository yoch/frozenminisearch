import {
  buildMsv5PostingsSections,
  decodeMsv5PostingsSections,
  msv5PostingsFlags,
} from './binaryMsv5Postings'
import { FLAG_SPARSE_LAYOUT } from './binaryMsv5Constants'
import { readU32LE } from '../binaryBytes'

function densePostings(offsets, lengths, docIds = new Uint32Array([0, 1]), freqs = new Uint8Array([1, 1])) {
  const fieldCount = 1
  const termCount = offsets.length
  return {
    fieldCount,
    termCount,
    nextId: 2,
    layout: 'dense',
    docIdWidth: 32,
    allDocIds: docIds,
    allFreqs: freqs,
    denseOffsets: offsets,
    denseLengths: lengths,
  }
}

function sparsePostings({
  termStarts,
  fieldIds,
  offsets,
  lengths,
  docIds = new Uint32Array([0, 1, 2]),
  freqs = new Uint8Array([1, 1, 1]),
  fieldCount = 4,
  termCount = 3,
  nextId = 10,
}) {
  return {
    fieldCount,
    termCount,
    nextId,
    layout: 'sparse',
    docIdWidth: 32,
    sparseFieldIdWidth: 8,
    allDocIds: docIds,
    allFreqs: freqs,
    sparseTermStarts: termStarts,
    sparseFieldIds: fieldIds,
    sparseOffsets: offsets,
    sparseLengths: lengths,
  }
}

function decodeWire(wire, postings) {
  return decodeMsv5PostingsSections(
    wire.flags,
    postings.fieldCount,
    postings.termCount,
    postings.nextId,
    wire.meta,
    wire.fields,
    wire.optional,
    wire.docIds,
    wire.freqs,
  )
}

describe('binaryMsv5Postings wire metadata widths', () => {
  test.each([
    ['u8', new Uint8Array([0, 1]), new Uint8Array([1, 1]), Uint8Array],
    ['u16', new Uint16Array([0, 256]), new Uint16Array([1, 2]), Uint16Array],
    ['u32', new Uint32Array([0, 1]), new Uint32Array([1, 1]), Uint32Array],
  ])('dense round-trips %s metadata columns', (_label, offsets, lengths, Ctor) => {
    const postings = densePostings(offsets, lengths)
    const wire = buildMsv5PostingsSections(postings)
    const slotCount = postings.termCount * postings.fieldCount

    expect(wire.meta.byteLength).toBe(offsets.byteLength)
    expect(wire.fields.byteLength).toBe(lengths.byteLength)
    if (Ctor === Uint8Array) {
      expect(wire.meta.byteLength).toBe(slotCount)
      expect(wire.fields.byteLength).toBe(slotCount)
    }

    const decoded = decodeWire(wire, postings)
    expect(decoded.denseOffsets).toBeInstanceOf(Ctor)
    expect(decoded.denseLengths).toBeInstanceOf(Ctor)
    expect(Array.from(decoded.denseOffsets)).toEqual(Array.from(offsets))
    expect(Array.from(decoded.denseLengths)).toEqual(Array.from(lengths))
  })

  test('sparse round-trips compact u8 metadata columns', () => {
    const postings = sparsePostings({
      termStarts: new Uint8Array([0, 1, 2, 3]),
      fieldIds: new Uint8Array([1, 3, 5]),
      offsets: new Uint8Array([0, 1, 2]),
      lengths: new Uint8Array([1, 1, 1]),
    })
    const wire = buildMsv5PostingsSections(postings)

    expect(wire.flags & FLAG_SPARSE_LAYOUT).toBe(FLAG_SPARSE_LAYOUT)
    expect(wire.meta.byteLength).toBe(postings.sparseTermStarts.byteLength)
    expect(readU32LE(wire.optional, 0)).toBe(postings.sparseOffsets.byteLength)

    const decoded = decodeWire(wire, postings)
    expect(decoded.sparseTermStarts).toBeInstanceOf(Uint8Array)
    expect(decoded.sparseOffsets).toBeInstanceOf(Uint8Array)
    expect(decoded.sparseLengths).toBeInstanceOf(Uint8Array)
    expect(Array.from(decoded.sparseTermStarts)).toEqual(Array.from(postings.sparseTermStarts))
    expect(Array.from(decoded.sparseOffsets)).toEqual(Array.from(postings.sparseOffsets))
    expect(Array.from(decoded.sparseLengths)).toEqual(Array.from(postings.sparseLengths))
  })

  test('sparse round-trips legacy u32 metadata columns', () => {
    const postings = sparsePostings({
      termStarts: new Uint32Array([0, 1, 2, 3]),
      fieldIds: new Uint8Array([1, 3, 5]),
      offsets: new Uint32Array([0, 1, 2]),
      lengths: new Uint32Array([1, 1, 1]),
    })
    const wire = buildMsv5PostingsSections(postings)

    expect(wire.meta.byteLength).toBe(postings.sparseTermStarts.byteLength)
    expect(readU32LE(wire.optional, 0)).toBe(postings.sparseOffsets.byteLength)

    const decoded = decodeWire(wire, postings)
    expect(decoded.sparseTermStarts).toBeInstanceOf(Uint32Array)
    expect(decoded.sparseOffsets).toBeInstanceOf(Uint32Array)
    expect(decoded.sparseLengths).toBeInstanceOf(Uint32Array)
  })

  test('decodes empty dense metadata sections', () => {
    const postings = densePostings(new Uint8Array(0), new Uint8Array(0), new Uint8Array(0), new Uint8Array(0))
    postings.termCount = 0
    postings.nextId = 0
    const wire = buildMsv5PostingsSections(postings)
    const decoded = decodeWire(wire, postings)
    expect(decoded.denseOffsets).toEqual(new Uint8Array(0))
    expect(decoded.denseLengths).toEqual(new Uint8Array(0))
  })

  test('rejects dense metadata sections with invalid byte length ratios', () => {
    const postings = densePostings(new Uint8Array([0, 1]), new Uint8Array([1, 1]))
    const wire = buildMsv5PostingsSections(postings)
    const badMeta = new Uint8Array([0, 1, 99])
    const badFields = new Uint8Array([1, 1, 99])
    expect(() => decodeMsv5PostingsSections(
      msv5PostingsFlags(postings),
      postings.fieldCount,
      postings.termCount,
      postings.nextId,
      badMeta,
      wire.fields,
      wire.optional,
      wire.docIds,
      wire.freqs,
    )).toThrow(/postings denseOffsets size mismatch/)
    expect(() => decodeMsv5PostingsSections(
      msv5PostingsFlags(postings),
      postings.fieldCount,
      postings.termCount,
      postings.nextId,
      wire.meta,
      badFields,
      wire.optional,
      wire.docIds,
      wire.freqs,
    )).toThrow(/postings denseLengths size mismatch/)
  })

  test('rejects sparse optional metadata sections with invalid byte length ratios', () => {
    const postings = sparsePostings({
      termStarts: new Uint8Array([0, 1, 2, 3]),
      fieldIds: new Uint8Array([1, 3, 5]),
      offsets: new Uint8Array([0, 1, 2]),
      lengths: new Uint8Array([1, 1, 1]),
    })
    const wire = buildMsv5PostingsSections(postings)
    const badOptional = wire.optional.slice()
    badOptional[0] = 4
    expect(() => decodeMsv5PostingsSections(
      wire.flags,
      postings.fieldCount,
      postings.termCount,
      postings.nextId,
      wire.meta,
      wire.fields,
      badOptional,
      wire.docIds,
      wire.freqs,
    )).toThrow(/postings sparseOffsets size mismatch/)
  })
})
