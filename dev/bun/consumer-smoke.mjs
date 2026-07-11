#!/usr/bin/env node
/**
 * Consumer smoke for FrozenMiniSearch under Node or Bun.
 *
 * Usage:
 *   node --input-type=module /path/to/consumer-smoke.mjs [--entry=es|cjs|browser|pkg]
 *   bun /path/to/consumer-smoke.mjs [--entry=es|cjs|browser|pkg]
 *
 * Env:
 *   FMS_ENTRY  Absolute path or package specifier to import (overrides --entry)
 *   FMS_OUT    Optional JSON report path
 */
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeFileSync, mkdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const require = createRequire(import.meta.url)

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael. Some years ago' },
  { id: 2, title: 'The Odyssey', text: 'Sing to me of the man, Muse' },
  { id: 3, title: 'Zen and the Art', text: 'Quality is a characteristic of thought' },
]
const options = { fields: ['title', 'text'], storeFields: ['title'] }

function argValue (name) {
  const flag = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(flag))
  return hit ? hit.slice(flag.length) : null
}

function runtimeInfo () {
  const isBun = typeof globalThis.Bun !== 'undefined'
  return {
    runtime: isBun ? 'bun' : 'node',
    version: isBun ? Bun.version : process.version,
    revision: isBun ? Bun.revision : null,
    execPath: process.execPath,
  }
}

async function loadEntry (kind) {
  const override = process.env.FMS_ENTRY
  if (override) {
    if (kind === 'cjs' || override.endsWith('.cjs') || override.endsWith('.require.cjs')) {
      return { mod: require(override), kind: 'cjs', specifier: override }
    }
    const mod = await import(override.startsWith('.') || override.startsWith('/')
      ? pathToFileURL(resolve(override)).href
      : override)
    return { mod, kind: 'esm', specifier: override }
  }

  if (kind === 'cjs') {
    const specifier = join(ROOT, 'dist/cjs/index.require.cjs')
    return { mod: require(specifier), kind: 'cjs', specifier }
  }
  if (kind === 'browser') {
    const specifier = pathToFileURL(join(ROOT, 'dist/browser/index.js')).href
    return { mod: await import(specifier), kind: 'browser', specifier }
  }
  if (kind === 'pkg') {
    const specifier = '@yoch/frozenminisearch'
    return { mod: await import(specifier), kind: 'pkg', specifier }
  }
  const specifier = pathToFileURL(join(ROOT, 'dist/es/index.js')).href
  return { mod: await import(specifier), kind: 'es', specifier }
}

function unwrap (mod) {
  const FrozenMiniSearch = mod.default ?? mod.FrozenMiniSearch
  if (typeof FrozenMiniSearch !== 'function') {
    throw new Error('FrozenMiniSearch export missing')
  }
  return FrozenMiniSearch
}

function assert (cond, msg) {
  if (!cond) throw new Error(msg)
}

function idsOf (results) {
  return results.map((r) => r.id)
}

async function exerciseSync (FrozenMiniSearch, label) {
  const index = FrozenMiniSearch.fromDocuments(docs, options)
  const search = index.search('ishmael')
  assert(idsOf(search)[0] === 1, `${label}: search ishmael`)
  const prefix = index.search('zen', { prefix: true })
  assert(idsOf(prefix).includes(3), `${label}: prefix zen`)
  const suggest = index.autoSuggest('zen ar')
  assert(Array.isArray(suggest) && suggest.length > 0, `${label}: autoSuggest`)

  const codecs = {}
  for (const compression of ['raw', 'zlib', 'zstd']) {
    const buf = index.saveBinarySync({ compression })
    assert(Buffer.isBuffer(buf) || buf instanceof Uint8Array, `${label}: ${compression} buffer`)
    const loaded = FrozenMiniSearch.loadBinarySync(buf, options)
    assert(idsOf(loaded.search('ishmael'))[0] === 1, `${label}: load ${compression}`)
    codecs[compression] = { bytes: buf.byteLength }
  }
  return {
    searchIds: idsOf(search),
    prefixIds: idsOf(prefix),
    suggestTerms: suggest.map((s) => s.suggestion),
    codecs,
    snapshots: {
      raw: index.saveBinarySync({ compression: 'raw' }),
      zlib: index.saveBinarySync({ compression: 'zlib' }),
      zstd: index.saveBinarySync({ compression: 'zstd' }),
    },
  }
}

async function exerciseBrowser (FrozenMiniSearch, label) {
  const index = FrozenMiniSearch.fromDocuments(docs, options)
  const search = index.search('ishmael')
  assert(idsOf(search)[0] === 1, `${label}: search`)
  const buf = await index.saveBinaryAsync({ compression: 'zlib' })
  const loaded = await FrozenMiniSearch.loadBinaryAsync(buf, options)
  assert(idsOf(loaded.search('ishmael'))[0] === 1, `${label}: async zlib round-trip`)
  let zstdRejected = false
  try {
    await index.saveBinaryAsync({ compression: 'zstd' })
  } catch {
    zstdRejected = true
  }
  return {
    searchIds: idsOf(search),
    zlibBytes: buf.byteLength,
    zstdRejected,
  }
}

async function main () {
  const kind = argValue('entry') ?? 'es'
  const { mod, kind: resolved, specifier } = await loadEntry(kind)
  const FrozenMiniSearch = unwrap(mod)
  const info = runtimeInfo()

  let result
  if (resolved === 'browser') {
    result = await exerciseBrowser(FrozenMiniSearch, `${info.runtime}/${resolved}`)
  } else {
    result = await exerciseSync(FrozenMiniSearch, `${info.runtime}/${resolved}`)
  }

  const report = {
    ok: true,
    ...info,
    entry: resolved,
    specifier,
    result: {
      searchIds: result.searchIds,
      prefixIds: result.prefixIds,
      suggestTerms: result.suggestTerms,
      codecs: result.codecs,
      zlibBytes: result.zlibBytes,
      zstdRejected: result.zstdRejected,
    },
  }

  // Emit snapshots as base64 for cross-runtime checks when requested.
  if (result.snapshots && process.argv.includes('--emit-snapshots')) {
    report.snapshotsB64 = Object.fromEntries(
      Object.entries(result.snapshots).map(([k, buf]) => [k, Buffer.from(buf).toString('base64')]),
    )
  }

  const out = process.env.FMS_OUT
  if (out) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  }
  console.log(JSON.stringify(report))
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    ...runtimeInfo(),
    error: String(err?.stack || err),
  }))
  process.exit(1)
})
