/**
 * Runtime stored fields. Single store field → one column (no per-doc Record at rest).
 * Wire format stays row JSON; encode/decode can skip intermediate row arrays when layout is known.
 */

import { invalidFrozenIndex } from './binaryIo'
import { buildStoredFieldsSection, readStoredFieldsSection } from './binaryStructures'

export type StoredFieldsLayout =
  | { kind: 'none' }
  | { kind: 'single', field: string, values: unknown[] }
  | { kind: 'multi', rows: (Record<string, unknown> | undefined)[] }

export function createStoredFieldsLayout(
  storeFields: readonly string[],
  capacity = 0,
): StoredFieldsLayout {
  if (storeFields.length === 0) return { kind: 'none' }
  if (storeFields.length === 1) {
    return { kind: 'single', field: storeFields[0], values: new Array(capacity) }
  }
  return { kind: 'multi', rows: new Array(capacity) }
}

export function writeStoredField<T>(
  layout: StoredFieldsLayout,
  shortId: number,
  storeFields: readonly string[],
  extractField: (document: T, fieldName: string) => unknown,
  document: T,
): void {
  if (layout.kind === 'none') return
  if (layout.kind === 'single') {
    layout.values[shortId] = extractField(document, layout.field)
    return
  }
  const row: Record<string, unknown> = {}
  for (const name of storeFields) {
    const value = extractField(document, name)
    if (value !== undefined) row[name] = value
  }
  layout.rows[shortId] = row
}

/** Materialize API/wire row for one document. */
export function readStoredFields(
  layout: StoredFieldsLayout,
  shortId: number,
): Record<string, unknown> | undefined {
  if (layout.kind === 'none') return undefined
  if (layout.kind === 'multi') return layout.rows[shortId]
  const value = layout.values[shortId]
  if (value === undefined) return {}
  return { [layout.field]: value }
}

export function resizeStoredFields(layout: StoredFieldsLayout, length: number): StoredFieldsLayout {
  if (layout.kind === 'none') return layout
  if (layout.kind === 'single') {
    return layout.values.length <= length
      ? layout
      : { kind: 'single', field: layout.field, values: layout.values.slice(0, length) }
  }
  return layout.rows.length <= length
    ? layout
    : { kind: 'multi', rows: layout.rows.slice(0, length) }
}

export function cloneStoredFields(layout: StoredFieldsLayout): StoredFieldsLayout {
  if (layout.kind === 'none') return layout
  if (layout.kind === 'single') {
    return { kind: 'single', field: layout.field, values: layout.values.slice() }
  }
  return { kind: 'multi', rows: layout.rows.slice() }
}

/** Import from wire rows or lucaong snapshot. Empty storeFields + non-empty rows → multi (binary load without options). */
export function storedFieldsFromRows(
  rows: (Record<string, unknown> | undefined)[],
  storeFields: readonly string[],
): StoredFieldsLayout {
  if (storeFields.length === 0) {
    const hasAny = rows.some(row => row != null && Object.keys(row).length > 0)
    return hasAny ? { kind: 'multi', rows } : { kind: 'none' }
  }
  if (storeFields.length === 1) {
    const field = storeFields[0]
    const values = rows.map(row => row?.[field])
    return { kind: 'single', field, values }
  }
  return { kind: 'multi', rows }
}

export function storedFieldsToWireRows(
  layout: StoredFieldsLayout,
  nextId: number,
): (Record<string, unknown> | undefined)[] {
  if (layout.kind === 'multi') {
    return layout.rows.length >= nextId
      ? layout.rows
      : layout.rows.concat(new Array(nextId - layout.rows.length))
  }
  const rows: (Record<string, unknown> | undefined)[] = new Array(nextId)
  if (layout.kind === 'none') return rows
  for (let i = 0; i < nextId; i++) rows[i] = readStoredFields(layout, i)
  return rows
}

export function storedFieldsJsonBytes(layout: StoredFieldsLayout): number {
  if (layout.kind === 'none') return 0
  if (layout.kind === 'multi') {
    let total = 0
    for (const row of layout.rows) {
      if (row != null) total += JSON.stringify(row).length
    }
    return total
  }
  let total = 0
  const { field, values } = layout
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (value !== undefined) total += JSON.stringify({ [field]: value }).length
  }
  return total
}

export function storedFieldsSlotCount(layout: StoredFieldsLayout): number {
  if (layout.kind === 'none') return 0
  return layout.kind === 'single' ? layout.values.length : layout.rows.length
}

function appendStoredFieldJsonEntry(
  table: Buffer,
  heapChunks: Buffer[],
  heapOffRef: { value: number },
  docIndex: number,
  jsonUtf8: Buffer,
): void {
  table.writeUInt32LE(heapOffRef.value + 1, docIndex * 4)
  const entry = Buffer.alloc(4 + jsonUtf8.length)
  entry.writeUInt32LE(jsonUtf8.length, 0)
  jsonUtf8.copy(entry, 4)
  heapChunks.push(entry)
  heapOffRef.value += entry.length
}

/** MSv5 StoredFields section from {@link StoredFieldsLayout} (no intermediate row array). */
export function buildStoredFieldsWireSection(layout: StoredFieldsLayout, nextId: number): Buffer {
  if (layout.kind === 'multi') {
    const rows = layout.rows.length >= nextId
      ? layout.rows
      : layout.rows.concat(new Array(nextId - layout.rows.length))
    return buildStoredFieldsSection(rows, nextId)
  }

  const table = Buffer.alloc(nextId * 4)
  if (layout.kind === 'none') return table

  const heapChunks: Buffer[] = []
  const heapOffRef = { value: 0 }
  const { field, values } = layout
  for (let i = 0; i < nextId; i++) {
    const value = values[i]
    if (value === undefined) continue
    const jsonUtf8 = Buffer.from(JSON.stringify({ [field]: value }), 'utf8')
    appendStoredFieldJsonEntry(table, heapChunks, heapOffRef, i, jsonUtf8)
  }
  return heapChunks.length === 0 ? table : Buffer.concat([table, ...heapChunks])
}

function storedFieldsTableEnd(storedOff: number, nextId: number, sectionEnd: number): number {
  const tableEnd = storedOff + nextId * 4
  if (tableEnd > sectionEnd) {
    throw invalidFrozenIndex('stored fields table out of bounds')
  }
  return tableEnd
}

function readStoredFieldJsonAt(
  buf: Buffer,
  tableEnd: number,
  sectionEnd: number,
  rel: number,
): Record<string, unknown> {
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
  return JSON.parse(buf.toString('utf8', jsonStart, jsonEnd)) as Record<string, unknown>
}

/** MSv5 StoredFields section → layout (skips row materialization when storeFields hint allows). */
export function readStoredFieldsWireSection(
  buf: Buffer,
  storedOff: number,
  nextId: number,
  sectionEnd: number,
  storeFields: readonly string[],
): StoredFieldsLayout {
  const tableEnd = storedFieldsTableEnd(storedOff, nextId, sectionEnd)

  if (storeFields.length === 1) {
    const field = storeFields[0]
    const values: unknown[] = new Array(nextId)
    for (let i = 0; i < nextId; i++) {
      const rel = buf.readUInt32LE(storedOff + i * 4)
      if (rel === 0) continue
      const row = readStoredFieldJsonAt(buf, tableEnd, sectionEnd, rel)
      values[i] = row[field]
    }
    return { kind: 'single', field, values }
  }

  if (storeFields.length === 0) {
    let hasAny = false
    for (let i = 0; i < nextId; i++) {
      if (buf.readUInt32LE(storedOff + i * 4) !== 0) {
        hasAny = true
        break
      }
    }
    if (!hasAny) return { kind: 'none' }
  }

  const rows = readStoredFieldsSection(buf, storedOff, nextId, sectionEnd)
  return storedFieldsFromRows(rows, storeFields)
}
