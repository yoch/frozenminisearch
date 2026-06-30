#!/usr/bin/env node

const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')

const allowedFiles = new Set([
  'src/internal/frozenInternals.ts',
  'benchmarks/harness/frozenDistInternals.mjs',
])

const codeFile = /\.(?:cjs|js|mjs|ts)$/

const forbidden = [
  {
    label: 'legacy protected MiniSearch import helpers',
    pattern: /(?:\bFrozenMiniSearch|\w+)\._fromMiniSearch(?:Snapshot)?\b/g,
  },
  {
    label: 'legacy protected memory helper',
    pattern: /\._memoryBreakdown\s*\(/g,
  },
  {
    label: 'direct Frozen private query-engine params',
    pattern: /\._queryEngineParams\b/g,
  },
  {
    label: 'direct Frozen private postings layout',
    pattern: /\._postings\b/g,
  },
  {
    label: 'direct Frozen private field access',
    pattern: /\bfrozen(?:Index)?\._[A-Za-z]\w*\b/g,
  },
  {
    label: 'low-level assembly outside internal harness',
    pattern: /\bassembleFrozenWithCtor\b/g,
  },
]

function isConsumerFile(file) {
  if (!codeFile.test(file)) return false
  if (allowedFiles.has(file)) return false
  if (file.startsWith('benchmarks/')) return true
  if (file.startsWith('dev/')) return true
  if (file.startsWith('testSupport/')) return true
  return /^src\/.*\.test\.[jt]s$/.test(file)
}

function lineNumberForOffset(source, offset) {
  let line = 1
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) line++
  }
  return line
}

const gitLsFiles = spawnSync('git', ['ls-files'], { encoding: 'utf8' })
if (gitLsFiles.error != null && !gitLsFiles.stdout) {
  throw gitLsFiles.error
}
if (gitLsFiles.status != null && gitLsFiles.status !== 0) {
  process.stderr.write(gitLsFiles.stderr)
  process.exit(gitLsFiles.status)
}

const files = gitLsFiles.stdout
  .trim()
  .split('\n')
  .filter(Boolean)
  .filter(isConsumerFile)

const violations = []

for (const file of files) {
  if (!existsSync(file)) continue
  const source = readFileSync(file, 'utf8')
  for (const rule of forbidden) {
    rule.pattern.lastIndex = 0
    for (let match = rule.pattern.exec(source); match != null; match = rule.pattern.exec(source)) {
      violations.push({
        file,
        line: lineNumberForOffset(source, match.index),
        rule: rule.label,
        match: match[0],
      })
    }
  }
}

if (violations.length > 0) {
  console.error('Internal boundary violations found:')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} ${v.rule}: ${v.match}`)
  }
  console.error('\nUse src/internal/frozenInternals.ts or benchmarks/harness/frozenDistInternals.mjs instead.')
  process.exit(1)
}

console.log(`Internal boundary OK (${files.length} files checked).`)
