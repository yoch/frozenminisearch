import MiniSearch from './MiniSearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import { decodeFrozenSnapshot } from './binaryFormat'

const docs = [
  { id: 1, title: 'hello', text: 'world wide' },
  { id: 2, title: 'zen', text: 'art archery' },
]
const options = { fields: ['title', 'text'] }

describe('packed binary round-trip', () => {
  test('saveBinary/loadBinary preserves term lookup', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = mutable.freeze()
    expect(frozen.search('zen').length).toBeGreaterThan(0)

    const buf = frozen.saveBinarySync()
    const snap = decodeFrozenSnapshot(buf)
    expect(snap.packedTermIndex).toBeDefined()
    expect(snap.packedTermIndex.get('zen')).not.toBeUndefined()

    const loaded = FrozenMiniSearch.loadBinarySync(buf, options)
    expect(loaded.search('zen').length).toBeGreaterThan(0)
  })
})
