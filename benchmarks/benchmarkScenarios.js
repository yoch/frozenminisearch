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
