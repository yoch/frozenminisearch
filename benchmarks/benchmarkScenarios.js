/** Synthetic corpora for extreme benchmark scenarios. */

export function giantVocabulary (count = 50000) {
  const docs = []
  for (let i = 0; i < count; i++) {
    docs.push({
      id: i,
      txt: `unique${i} common alpha beta`
    })
  }
  return docs
}

export function largeDocuments (count = 5000, bytesPerDoc = 5000) {
  const chunk = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(Math.ceil(bytesPerDoc / 56))
  const text = chunk.slice(0, bytesPerDoc)
  const docs = []
  for (let i = 0; i < count; i++) {
    docs.push({ id: i, txt: text + ` doc${i}` })
  }
  return docs
}

export function manyFields (docCount = 2000, fieldCount = 10) {
  const fields = Array.from({ length: fieldCount }, (_, i) => `f${i}`)
  const docs = []
  for (let d = 0; d < docCount; d++) {
    const doc = { id: d }
    for (const f of fields) {
      doc[f] = `${f} value ${d} sharedterm`
    }
    docs.push(doc)
  }
  return { docs, fields }
}

export function highFrequencyTerms (docCount = 10000) {
  const common = 'alpha beta gamma delta epsilon zeta eta theta'
  const docs = []
  for (let i = 0; i < docCount; i++) {
    docs.push({
      id: i,
      txt: `${common} variation${i % 50} extra${i % 200}`
    })
  }
  return docs
}

export function overflowFrequencies (docCount = 2000, repeat = 800) {
  const highFreq = `alpha ${'alpha '.repeat(repeat)}omega`
  const lowFreq = 'alpha beta gamma omega'
  const docs = []
  for (let i = 0; i < docCount; i++) {
    const txt = i % 2 === 0 ? highFreq : lowFreq
    docs.push({ id: i, txt })
  }
  return docs
}

/** Numeric ids 0..n-1 for identity id lookup elision. */
export function denseNumericIds (count = 100000) {
  const docs = []
  for (let i = 0; i < count; i++) {
    docs.push({ id: i, txt: `doc ${i} token${i % 1000}` })
  }
  return docs
}

/** Generic string ids for lazy-map id lookup. */
export function genericStringIds (count = 100000) {
  const docs = []
  for (let i = 0; i < count; i++) {
    docs.push({ id: `doc-${i}`, txt: `doc ${i} token${i % 1000}` })
  }
  return docs
}

/** Many terms, sparse field occupancy (one field per doc). */
export function sparseFields (docCount = 5000, fieldCount = 20) {
  const fields = Array.from({ length: fieldCount }, (_, i) => `f${i}`)
  const docs = []
  for (let d = 0; d < docCount; d++) {
    const doc = { id: d }
    const active = d % fieldCount
    doc[fields[active]] = `term${d} shared sparse`
    docs.push(doc)
  }
  return { docs, fields }
}

/** Document count at Uint16 doc-id boundary. */
export function docIdUint16Boundary (count) {
  const docs = []
  for (let i = 0; i < count; i++) {
    docs.push({ id: i, txt: `boundary ${i} alpha beta` })
  }
  return docs
}
