#!/usr/bin/env node
/**
 * Ensure published bundles (ES, CJS, browser, vectors) do not embed test/bench-only helpers,
 * legacy Map-radix encode fallbacks, or leak vector/PQ code into lexical bundles.
 */
const { accessSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const bundlePaths = [
  join(root, 'dist', 'es', 'index.js'),
  join(root, 'dist', 'cjs', 'index.cjs'),
  join(root, 'dist', 'browser', 'index.js'),
  join(root, 'dist', 'es', 'vectors.js'),
  join(root, 'dist', 'cjs', 'vectors.cjs'),
  join(root, 'dist', 'browser', 'vectors.js'),
  join(root, 'dist', 'es', 'vectorsTrain.js'),
  join(root, 'dist', 'cjs', 'vectorsTrain.cjs'),
]

const lexicalOnlyPaths = new Set([
  join(root, 'dist', 'es', 'index.js'),
  join(root, 'dist', 'cjs', 'index.cjs'),
  join(root, 'dist', 'browser', 'index.js'),
])

const vectorRuntimeOnlyPaths = new Set([
  join(root, 'dist', 'es', 'vectors.js'),
  join(root, 'dist', 'cjs', 'vectors.cjs'),
  join(root, 'dist', 'browser', 'vectors.js'),
])

const forbiddenPatterns = [
  { name: 'internal frozenInternals harness', pattern: /\bfrozenInternals\b/ },
  { name: 'SearchableMap runtime', pattern: /\bclass SearchableMap\b|\bnew SearchableMap\b|SearchableMap\/TreeIterator|SearchableMap\/fuzzySearch/ },
  { name: 'legacy Map-radix packer', pattern: /\bfromRadixTree\b|\bdeserializeRadixTreeShape\b|\bdeserializeTermIndexTree\b/ },
  { name: 'benchmark harness paths', pattern: /benchmarks\/|testSupport\/|dev\/parity/ },
  { name: 'incremental grow profiler hooks', pattern: /\bincrementalGrowProfiler\b|\brecordIncrementalGrow\b|\breadIncrementalGrowStats\b|\bresetIncrementalGrowStats\b|\bsimulateColumnGrowth\b/ },
  { name: 'legacy encode shared fallback module', pattern: /\bbinaryMsv5EncodeShared\b/ },
  { name: 'deprecated PackedRadix string wrappers', pattern: /\bprefixEntries\b|\bfuzzyEntries\b|\bpackedRadixFuzzyEntries\b|\bpackedPrefixEntries\b|\bdevStringIterators\b/ },
]

const forbiddenInLexical = [
  { name: 'FrozenVectorIndex runtime in lexical bundle', pattern: /\bFrozenVectorIndex\b|\bFXV1\b|\bbuildPqPayload\b/ },
]

const forbiddenInVectorRuntime = [
  { name: 'PQ k-means trainer in vector runtime bundle', pattern: /\bselectPqSampleIndices\b|\bbuildPqPayload\b/ },
]

function stripComments (source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

for (const bundlePath of bundlePaths) {
  try {
    accessSync(bundlePath)
  } catch {
    console.error(`assert-public-bundles: missing ${bundlePath} — run pnpm build first`)
    process.exit(1)
  }

  const bundle = stripComments(readFileSync(bundlePath, 'utf8'))
  const rel = bundlePath.slice(root.length + 1)

  for (const { name, pattern } of forbiddenPatterns) {
    if (pattern.test(bundle)) {
      console.error(`assert-public-bundles: forbidden ${name} found in ${rel}`)
      process.exit(1)
    }
  }
  if (lexicalOnlyPaths.has(bundlePath)) {
    for (const { name, pattern } of forbiddenInLexical) {
      if (pattern.test(bundle)) {
        console.error(`assert-public-bundles: forbidden ${name} found in ${rel}`)
        process.exit(1)
      }
    }
  }
  if (vectorRuntimeOnlyPaths.has(bundlePath)) {
    for (const { name, pattern } of forbiddenInVectorRuntime) {
      if (pattern.test(bundle)) {
        console.error(`assert-public-bundles: forbidden ${name} found in ${rel}`)
        process.exit(1)
      }
    }
  }
}

console.log(`assert-public-bundles: ok (${bundlePaths.length} bundles checked)`)
