import MiniSearch from 'minisearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import {
  createStoredFieldsLayout,
  readStoredFields,
  storedFieldsFromRows,
  storedFieldsToWireRows,
  writeStoredField,
} from './storedFieldsLayout'
import { buildStoredFieldsWireSection, readStoredFieldsWireSection } from './storedFieldsWire'
import { buildStoredFieldsSection } from './binaryStructures'

describe('storedFieldsLayout', () => {
  test('single store field: column at rest, Record on read', () => {
    const index = FrozenMiniSearch.fromDocuments(
      [{ id: 1, txt: 'alpha' }, { id: 2, txt: 'beta' }],
      { fields: ['txt'], storeFields: ['txt'] },
    )
    expect(index.getStoredFields(1)).toEqual({ txt: 'alpha' })
    expect(index.getStoredFields(2)).toEqual({ txt: 'beta' })
  })

  test('wire round-trip', () => {
    const layout = createStoredFieldsLayout(['txt'], 2)
    writeStoredField(layout, 0, ['txt'], (d, f) => d[f], { txt: 'x' })
    writeStoredField(layout, 1, ['txt'], (d, f) => d[f], { txt: 'y' })
    const back = storedFieldsFromRows(storedFieldsToWireRows(layout, 2), ['txt'])
    expect(readStoredFields(back, 0)).toEqual({ txt: 'x' })
  })

  test('wire section matches legacy row encode (single field)', () => {
    const layout = createStoredFieldsLayout(['txt'], 2)
    writeStoredField(layout, 0, ['txt'], (d, f) => d[f], { txt: 'x' })
    writeStoredField(layout, 1, ['txt'], (d, f) => d[f], { txt: 'y' })
    const legacy = buildStoredFieldsSection(storedFieldsToWireRows(layout, 2), 2)
    const direct = buildStoredFieldsWireSection(layout, 2)
    expect(Buffer.from(direct)).toEqual(legacy)
  })

  test('wire section read → single column', () => {
    const layout = createStoredFieldsLayout(['txt'], 2)
    writeStoredField(layout, 0, ['txt'], (d, f) => d[f], { txt: 'x' })
    writeStoredField(layout, 1, ['txt'], (d, f) => d[f], { txt: 'y' })
    const section = buildStoredFieldsWireSection(layout, 2)
    const loaded = readStoredFieldsWireSection(section, 0, 2, section.length, ['txt'])
    expect(loaded).toEqual({ kind: 'single', field: 'txt', values: ['x', 'y'] })
  })

  test('multi store fields keep row records', () => {
    const index = FrozenMiniSearch.fromDocuments(
      [{ id: 1, title: 'A', category: 'x' }],
      { fields: ['title', 'category'], storeFields: ['title', 'category'] },
    )
    expect(index.getStoredFields(1)).toEqual({ title: 'A', category: 'x' })
  })

  test('binary load without storeFields option', () => {
    const mutable = new MiniSearch({
      fields: ['title', 'text'],
      storeFields: ['title', 'category'],
    })
    mutable.add({ id: 1, title: 'Zen Motorcycle', text: 'zen art', category: 'fiction' })
    const frozen = FrozenMiniSearch._fromMiniSearch(mutable, {
      fields: ['title', 'text'],
      storeFields: ['title', 'category'],
    })
    const loaded = FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), {})
    expect(loaded.getStoredFields(1)).toEqual({ title: 'Zen Motorcycle', category: 'fiction' })
  })
})
