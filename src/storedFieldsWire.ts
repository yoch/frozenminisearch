import { buildStoredFieldsSection, readStoredFieldsSection } from './binaryStructures'
import { invalidFrozenIndex } from './frozenErrors'
import {
  storedFieldsFromRows,
  type StoredFieldsLayout,
} from './storedFieldsLayout'

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
