import {
  allocBytes,
  ByteWriter,
  readU32LE,
  readUtf8,
  type BinaryBytes,
} from './binaryBytes'
import { invalidFrozenIndex, parseSnapshotJson } from './frozenErrors'
import {
  storedFieldsFromRows,
  type StoredFieldsLayout,
} from './storedFieldsLayout'

/**
 * Table of `nextId` u32 (heap offset + 1, 0 for no row), then the heap of
 * length-prefixed JSON rows in document order.
 */
function writeStoredFieldsSection(
  nextId: number,
  rowJson: (shortId: number) => string | undefined,
): BinaryBytes {
  const tableBytes = nextId * 4
  const writer = new ByteWriter(tableBytes)
  writer.skip(tableBytes)
  for (let i = 0; i < nextId; i++) {
    const json = rowJson(i)
    if (json === undefined) continue
    writer.setU32(i * 4, writer.length - tableBytes + 1)
    writer.lengthPrefixedUtf8(json)
  }
  return writer.finish()
}

export function buildStoredFieldsRowsWireSection(
  storedFields: (Record<string, unknown> | undefined)[],
  nextId: number,
): BinaryBytes {
  return writeStoredFieldsSection(nextId, (i) => {
    const row = storedFields[i]
    // A row that serialises to nothing is written as the text `undefined`, as before.
    return row == null ? undefined : String(JSON.stringify(row))
  })
}

/** MSv5 StoredFields section from {@link StoredFieldsLayout} (no intermediate row array). */
export function buildStoredFieldsWireSection(
  layout: StoredFieldsLayout,
  nextId: number,
): BinaryBytes {
  if (layout.kind === 'multi') {
    return buildStoredFieldsRowsWireSection(layout.rows, nextId)
  }
  if (layout.kind === 'none') return allocBytes(nextId * 4)

  const { field, values } = layout
  return writeStoredFieldsSection(nextId, (i) => {
    const value = values[i]
    return value === undefined ? undefined : JSON.stringify({ [field]: value })
  })
}

function storedFieldsTableEnd(
  storedOff: number,
  nextId: number,
  sectionEnd: number,
): number {
  const tableEnd = storedOff + nextId * 4
  if (tableEnd > sectionEnd) {
    throw invalidFrozenIndex('stored fields table out of bounds')
  }
  return tableEnd
}

/** Next expected heap offset (+1) while reading rows in document order. */
type StoredFieldsCursor = { rel: number }

/**
 * Rows are laid out in document order with no gap or overlap, as the encoder writes
 * them: a row can then be decoded once only, whatever the table says.
 */
function readStoredFieldJsonAt(
  buf: BinaryBytes,
  tableEnd: number,
  sectionEnd: number,
  rel: number,
  cursor: StoredFieldsCursor,
): Record<string, unknown> {
  if (rel !== cursor.rel) {
    throw invalidFrozenIndex('stored fields entry offset out of order')
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
  const row = parseSnapshotJson(
    readUtf8(buf, jsonStart, jsonEnd),
    'stored fields row',
  )
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw invalidFrozenIndex('stored fields row is not an object')
  }
  cursor.rel = rel + 4 + jsonLen
  return row as Record<string, unknown>
}

function assertStoredFieldsHeapConsumed(
  tableEnd: number,
  sectionEnd: number,
  cursor: StoredFieldsCursor,
): void {
  if (tableEnd + cursor.rel - 1 !== sectionEnd) {
    throw invalidFrozenIndex('stored fields section size mismatch')
  }
}

/** MSv5 StoredFields section → layout (skips row materialization when storeFields hint allows). */
export function readStoredFieldsWireSection(
  buf: BinaryBytes,
  storedOff: number,
  nextId: number,
  sectionEnd: number,
  storeFields: readonly string[],
): StoredFieldsLayout {
  const tableEnd = storedFieldsTableEnd(storedOff, nextId, sectionEnd)

  if (storeFields.length === 1) {
    const field = storeFields[0]
    const values: unknown[] = new Array(nextId)
    const cursor: StoredFieldsCursor = { rel: 1 }
    for (let i = 0; i < nextId; i++) {
      const rel = readU32LE(buf, storedOff + i * 4)
      if (rel === 0) continue
      const row = readStoredFieldJsonAt(buf, tableEnd, sectionEnd, rel, cursor)
      values[i] = Object.hasOwn(row, field) ? row[field] : undefined
    }
    assertStoredFieldsHeapConsumed(tableEnd, sectionEnd, cursor)
    return { kind: 'single', field, values }
  }

  if (storeFields.length === 0) {
    let hasAny = false
    for (let i = 0; i < nextId; i++) {
      if (readU32LE(buf, storedOff + i * 4) !== 0) {
        hasAny = true
        break
      }
    }
    if (!hasAny) {
      assertStoredFieldsHeapConsumed(tableEnd, sectionEnd, { rel: 1 })
      return { kind: 'none' }
    }
  }

  const rows = readStoredFieldsRowsSection(buf, storedOff, nextId, sectionEnd)
  return storedFieldsFromRows(rows, storeFields)
}

export function readStoredFieldsRowsSection(
  buf: BinaryBytes,
  storedOff: number,
  nextId: number,
  sectionEnd: number,
): (Record<string, unknown> | undefined)[] {
  const tableEnd = storedFieldsTableEnd(storedOff, nextId, sectionEnd)
  const rows: (Record<string, unknown> | undefined)[] = new Array(nextId)
  const cursor: StoredFieldsCursor = { rel: 1 }
  for (let i = 0; i < nextId; i++) {
    const rel = readU32LE(buf, storedOff + i * 4)
    if (rel === 0) {
      rows[i] = undefined
      continue
    }
    rows[i] = readStoredFieldJsonAt(buf, tableEnd, sectionEnd, rel, cursor)
  }
  assertStoredFieldsHeapConsumed(tableEnd, sectionEnd, cursor)
  return rows
}
