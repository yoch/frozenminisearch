#!/usr/bin/env node
'use strict'

// Local audit. Compare a published entry with dist/ in separate processes:
// node --expose-gc benchmarks/scripts/audit-memory-retention.cjs [entry] [output]
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { setImmediate: turn } = require('node:timers/promises')
const entry = path.resolve(process.argv[2] || path.join(__dirname, '../../dist/cjs/index.require.cjs'))
const output = path.resolve(process.argv[3] || path.join(__dirname, '../../tmp/memory-audit/retention.json'))
const { FrozenMiniSearch, createFrozenIndexBuilder, freezeFrozenIndexBuilder } = require(entry)
const fixtureDir = path.join(__dirname, '../fixtures/medicaments-indexes')
const report = { runtime: process.version, entry, samples: [], fixtures: [], searches: 0, loads: 0 }
const hash = crypto.createHash('sha256')
const weakIndexes = []
const weakResults = []
const weakWires = []

async function sample(label) {
  await turn()
  global.gc()
  await turn()
  global.gc()
  await turn()
  const sample = { label, memory: process.memoryUsage(), resources: process.getActiveResourcesInfo(),
    retired_indexes_alive: weakIndexes.filter(ref => ref.deref()).length,
    retired_results_alive: weakResults.filter(ref => ref.deref()).length,
    source_buffers_alive: weakWires.filter(ref => ref.deref()).length }
  report.samples.push(sample)
  console.log(`${label}: heap=${(sample.memory.heapUsed / 1048576).toFixed(2)} external=${(sample.memory.external / 1048576).toFixed(2)} rss=${(sample.memory.rss / 1048576).toFixed(2)}`)
  return sample
}

function failedBuilder() {
  const builder = createFrozenIndexBuilder({ fields: ['text'], storeFields: ['payload'] })
  builder.add({ id: 'bad', text: 'x'.repeat(65536), payload: new Uint8Array(8 * 1048576) })
  try { freezeFrozenIndexBuilder(builder) } catch (error) {
    if (!error.message.includes('edge label too long')) throw error
    return builder
  }
  throw new Error('expected radix packing to reject an oversized edge')
}

function callbackHolder() {
  const payload = new Uint8Array(16 * 1048576)
  const builder = createFrozenIndexBuilder({
    fields: ['text'],
    extractField(document, field) {
      if (payload.length === 0) throw new Error('unexpected empty payload')
      return document[field]
    },
  })
  builder.add({ id: 0, text: 'paracetamol' })
  return { builder, index: freezeFrozenIndexBuilder(builder), payload: new WeakRef(payload) }
}

function searchBatch(indexes, batch) {
  const queries = ['paracetamol', 'amoxicilline', 'dolip', 'a', '500', 'comprime']
  for (let i = 0; i < 300; i++) {
    const index = indexes[i % indexes.length]
    const query = i % 5 === 0 ? `inexistant${batch * 300 + i}` : queries[Math.floor(i / 6) % queries.length]
    const options = { prefix: true, fuzzy: 0.2 }
    let results
    switch (i % 6) {
      case 0: results = index.search(query, options); break
      case 1: results = index.search(query, { ...options, limit: 10 }); break
      case 2: results = index.searchPage(query, { ...options, offset: 5, limit: 10 }).results; break
      case 3: results = index.autoSuggest(query, options); break
      case 4: results = index.searchPage(FrozenMiniSearch.wildcard, { offset: 100, limit: 10 }).results; break
      case 5: results = index.search(query, { ...options, filter: hit => hit.score > 0, limit: 10 }); break
    }
    report.searches++
    hash.update(JSON.stringify(results))
    if (i % 25 === 0) weakResults.push(new WeakRef(results))
  }
}

async function loadFixtures(asyncLoad) {
  const indexes = []
  for (const fixture of report.fixtures) {
    const wire = fs.readFileSync(path.join(fixtureDir, fixture.file))
    weakWires.push(new WeakRef(wire.buffer))
    const index = asyncLoad ? await FrozenMiniSearch.loadBinaryAsync(wire) : FrozenMiniSearch.loadBinarySync(wire)
    // Exercise the optional external-id lookup once per generation.
    index.has(index.search(FrozenMiniSearch.wildcard, { limit: 1 })[0]?.id)
    indexes.push(index)
    report.loads++
  }
  return indexes
}

async function binaryCycles() {
  const docs = Array.from({ length: 200 }, (_, id) => ({ id, text: `medicament dose${id}`, payload: 'x'.repeat(100) }))
  const options = { fields: ['text'], storeFields: ['payload'] }
  const index = FrozenMiniSearch.fromDocuments(docs, options)
  for (let cycle = 0; cycle < 12; cycle++) {
    for (const compression of ['raw', 'zlib', 'zstd']) {
      const wire = await index.saveBinaryAsync({ compression })
      const copy = await FrozenMiniSearch.loadBinaryAsync(wire, options)
      if (copy.search('medicament').length !== docs.length) throw new Error('binary parity failure')
      weakWires.push(new WeakRef(wire.buffer))
      weakIndexes.push(new WeakRef(copy))
      report.loads++
      // Corrupt a payload without changing its header: decompression/CRC must reject.
      const corrupt = Buffer.from(wire)
      corrupt[corrupt.length - 1] ^= 255
      let rejected = false
      try { await FrozenMiniSearch.loadBinaryAsync(corrupt, options) } catch { rejected = true }
      if (!rejected) throw new Error('corrupt binary accepted')
    }
  }
}

async function main() {
  if (!global.gc) throw new Error('--expose-gc required')
  await sample('baseline')
  const failed = []
  for (let cycle = 0; cycle < 3; cycle++) {
    failed.push(failedBuilder())
    await sample(`failed_builder_${cycle + 1}`)
  }
  failed.length = 0
  await sample('failed_builders_dropped')
  let holder = callbackHolder()
  await sample('finished_builder_and_index_with_ingestion_closure')
  report.ingestion_closure_payload_alive = holder.payload.deref() !== undefined
  if (holder.builder.documentCount !== 1 || holder.index.search('paracetamol').length !== 1) {
    throw new Error('callback lifecycle parity failure')
  }
  holder = null
  await sample('callback_holder_dropped')
  const probe = FrozenMiniSearch.fromDocuments([{ id: 0, text: 'paracetamol' }], { fields: ['text'] })
  probe.search('para', { prefix: true })
  report.cursor_base_after_search = probe._index.termPaths.shared.base
  // A long fuzzy token allocates a quadratic matrix even when there is no match.
  probe.search('z'.repeat(4096), { fuzzy: 0.2 })
  report.after_long_fuzzy_token = process.memoryUsage()
  await sample('long_fuzzy_token_gc')
  for (const file of fs.readdirSync(fixtureDir).filter(file => file.endsWith('.msbin')).sort()) {
    const wire = fs.readFileSync(path.join(fixtureDir, file))
    report.fixtures.push({ file, bytes: wire.length, sha256: crypto.createHash('sha256').update(wire).digest('hex') })
  }
  let indexes = await loadFixtures(false)
  report.document_counts = indexes.map(index => index.documentCount)
  await sample('fixtures_loaded')
  for (let batch = 0; batch < 6; batch++) {
    searchBatch(indexes, batch)
    await sample(`search_batch_${batch + 1}`)
  }
  for (let cycle = 0; cycle < 6; cycle++) {
    indexes.forEach(index => weakIndexes.push(new WeakRef(index)))
    indexes = await loadFixtures(cycle % 2 === 0)
    await sample(`reload_${cycle + 1}`)
  }
  indexes.forEach(index => weakIndexes.push(new WeakRef(index)))
  indexes = null
  await sample('all_fixture_indexes_dropped')
  await binaryCycles()
  await sample('binary_cycles_completed')
  report.result_digest = hash.digest('hex')
  report.retired_indexes = weakIndexes.length
  report.retired_results = weakResults.length
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
