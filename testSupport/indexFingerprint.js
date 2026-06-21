import { MAX_FREQ } from '../src/compactPostings'

function clampFreq (freq) {
  return freq > MAX_FREQ ? MAX_FREQ : freq
}

function parseIndexEntry (entry, serializationVersion) {
  if (serializationVersion === 1 && entry != null && typeof entry === 'object' && 'ds' in entry) {
    return entry.ds
  }
  return entry
}

function fieldIdToName (fieldIds) {
  const names = {}
  for (const [name, id] of Object.entries(fieldIds)) {
    names[id] = name
  }
  return names
}

/**
 * Normalize a MiniSearch wire snapshot into term → fieldName → externalDocId → frequency.
 * Index entry order is ignored; frequencies above MAX_FREQ are clamped before compare.
 */
export function normalizeIndexFingerprint (snapshot) {
  const fieldNames = fieldIdToName(snapshot.fieldIds)
  const shortToExternal = {}
  for (const [shortId, externalId] of Object.entries(snapshot.documentIds)) {
    shortToExternal[shortId] = externalId
  }

  const fingerprint = {}
  const { index: entries, serializationVersion } = snapshot

  for (const [term, data] of entries) {
    const termEntry = fingerprint[term] ?? (fingerprint[term] = {})
    for (const fieldId of Object.keys(data)) {
      const fieldName = fieldNames[fieldId]
      const raw = data[fieldId]
      const indexEntry = parseIndexEntry(raw, serializationVersion)
      const fieldEntry = termEntry[fieldName] ?? (termEntry[fieldName] = {})
      for (const [docId, freq] of Object.entries(indexEntry)) {
        const externalId = shortToExternal[docId]
        if (externalId === undefined) continue
        fieldEntry[externalId] = clampFreq(freq)
      }
    }
  }

  return sortFingerprint(fingerprint)
}

function sortFingerprint (fingerprint) {
  const sorted = {}
  for (const term of Object.keys(fingerprint).sort()) {
    const termEntry = {}
    for (const fieldName of Object.keys(fingerprint[term]).sort()) {
      const fieldEntry = {}
      for (const docId of Object.keys(fingerprint[term][fieldName]).sort()) {
        fieldEntry[docId] = fingerprint[term][fieldName][docId]
      }
      termEntry[fieldName] = fieldEntry
    }
    sorted[term] = termEntry
  }
  return sorted
}

export function expectSameIndexFingerprint (msSnapshot, frSnapshot, { avgPrecision = 5 } = {}) {
  expect(normalizeIndexFingerprint(frSnapshot)).toEqual(normalizeIndexFingerprint(msSnapshot))

  const msAvg = msSnapshot.averageFieldLength
  const frAvg = frSnapshot.averageFieldLength
  expect(frAvg.length).toBe(msAvg.length)
  for (let i = 0; i < msAvg.length; i++) {
    expect(frAvg[i]).toBeCloseTo(msAvg[i], avgPrecision)
  }
}
