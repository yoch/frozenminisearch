/**
 * Load post-parse JSONL corpora from fr.gouv.medicaments.rest corpus-export.
 * Documents already contain only indexed fields + id (see buildIndexDocument).
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export const DEFAULT_CORPUS_EXPORT_DIR =
  '/home/yoch/fr.gouv.medicaments.rest/data/corpus-export'

function resolveCorpusDir (dir) {
  const candidate = dir ?? process.env.CORPUS_EXPORT_DIR ?? DEFAULT_CORPUS_EXPORT_DIR
  if (!existsSync(join(candidate, 'bdpm-corpus-manifest.json'))) {
    return null
  }
  return candidate
}

function loadManifest (corpusDir, prefix) {
  const path = join(corpusDir, `${prefix}-corpus-manifest.json`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * @param {object} doc
 * @param {string[]} fields
 */
export function documentFieldTextBytes (doc, fields) {
  let bytes = 0
  for (const field of fields) {
    const v = doc[field]
    if (v == null) continue
    if (Array.isArray(v)) {
      for (const item of v) bytes += String(item).length
    } else {
      bytes += String(v).length
    }
  }
  return bytes
}

/**
 * @param {string} filePath
 * @returns {AsyncGenerator<object>}
 */
export async function* streamJsonl (filePath) {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of rl) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      yield JSON.parse(trimmed)
    }
  } finally {
    rl.close()
  }
}

async function readJsonl (filePath) {
  const documents = []
  for await (const doc of streamJsonl(filePath)) {
    documents.push(doc)
  }
  return documents
}

function corpusTextBytes (documents, fields) {
  let bytes = 0
  for (const doc of documents) {
    bytes += documentFieldTextBytes(doc, fields)
  }
  return bytes
}

/**
 * @param {string} corpusDir
 * @returns {Promise<Array<{
 *   id: string,
 *   prefix: string,
 *   datasetKey: string,
 *   file: string,
 *   documents: object[],
 *   options: object,
 *   meta: object,
 * }>>}
 */
export async function loadAllCorpusExportSpecs (corpusDir) {
  const root = resolveCorpusDir(corpusDir)
  if (root == null) return []

  const specs = []
  for (const prefix of ['bdpm', 'vet']) {
    const manifestPath = join(root, `${prefix}-corpus-manifest.json`)
    if (!existsSync(manifestPath)) continue
    const manifest = loadManifest(root, prefix)
    for (const [datasetKey, entry] of Object.entries(manifest.datasets)) {
      if (entry.indexOptions == null) continue
      const filePath = join(root, entry.file)
      if (!existsSync(filePath)) continue
      const fields = entry.indexOptions.fields
      specs.push({
        id: `${prefix}-${datasetKey}`,
        prefix,
        datasetKey,
        file: entry.file,
        filePath,
        options: entry.indexOptions,
        manifestEntry: entry,
        fields,
      })
    }
  }
  specs.sort((a, b) => a.id.localeCompare(b.id))
  return specs.map((spec) => ({ ...spec, _root: root }))
}

/**
 * @param {ReturnType<typeof loadAllCorpusExportSpecs> extends Promise<infer T> ? T[number] : never} spec
 */
/**
 * Stream documents from a corpus-export JSONL file without retaining the full corpus.
 *
 * @param {ReturnType<typeof loadAllCorpusExportSpecs> extends Promise<infer T> ? T[number] : never} spec
 * @returns {AsyncGenerator<object>}
 */
export async function* streamCorpusExportDocuments (spec) {
  yield* streamJsonl(spec.filePath)
}

/**
 * Single-pass scan for document count and indexed text size (no document array).
 *
 * @param {ReturnType<typeof loadAllCorpusExportSpecs> extends Promise<infer T> ? T[number] : never} spec
 */
export async function scanCorpusExportStats (spec) {
  const fields = spec.fields ?? spec.options.fields
  let documentCount = 0
  let corpusTextBytes = 0
  for await (const doc of streamCorpusExportDocuments(spec)) {
    documentCount++
    corpusTextBytes += documentFieldTextBytes(doc, fields)
  }
  return {
    documentCount,
    fields,
    corpusTextBytes,
    source: 'corpus-jsonl-stream',
    file: spec.file,
  }
}

export async function loadCorpusExportDocuments (spec) {
  const documents = await readJsonl(spec.filePath)
  const fields = spec.fields ?? spec.options.fields
  return {
    documents,
    options: spec.options,
    meta: {
      documentCount: documents.length,
      fields,
      corpusTextBytes: corpusTextBytes(documents, fields),
      source: 'corpus-jsonl',
      file: spec.file,
    },
  }
}

export function corpusExportDirAvailable (dir) {
  return resolveCorpusDir(dir) != null
}
