/**
 * Append one benchmark snapshot to benchmarks/perf-history.jsonl (clean tree required).
 * Called by record-history.sh / backfill-history.sh
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../..')
const HISTORY_PATH = join(REPO_ROOT, 'benchmarks/perf-history.jsonl')

function git (args) {
  return execSync(`git ${args}`, { encoding: 'utf8', cwd: REPO_ROOT }).trim()
}

function parseRuns () {
  let runs = 1
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs') runs = Math.max(1, Math.floor(Number(args[++i])))
    else if (args[i].startsWith('--runs=')) runs = Math.max(1, Math.floor(Number(args[i].split('=')[1])))
  }
  return runs
}

const force = process.argv.includes('--force')
const runs = parseRuns()

if (git('status --porcelain --untracked-files=no')) {
  console.error('Refusing: tracked files are modified')
  process.exit(1)
}

const headSha = git('rev-parse HEAD')
if (existsSync(HISTORY_PATH) && !force) {
  for (const line of readFileSync(HISTORY_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e.git?.commit === headSha) {
        console.error(`Already recorded: ${e.git.commitShort}`)
        process.exit(1)
      }
    } catch { /* skip bad lines */ }
  }
}

if (force && existsSync(HISTORY_PATH)) {
  const kept = readFileSync(HISTORY_PATH, 'utf8').split('\n').filter((line) => {
    if (!line.trim()) return false
    try {
      return JSON.parse(line).git?.commit !== headSha
    } catch {
      return true
    }
  })
  writeFileSync(HISTORY_PATH, kept.map((l) => l).join('\n') + (kept.length ? '\n' : ''), 'utf8')
}

const benchDir = pathToFileURL(join(REPO_ROOT, 'benchmarks/')).href
const { collectRunMetadata } = await import(new URL('benchmarkUtils.js', benchDir).href)
const { runBenchmarkSuite } = await import(new URL('benchmarkSuite.js', benchDir).href)

console.log(`Recording ${git('rev-parse --short HEAD')} (${runs} run(s))...`)
const scenarios = runBenchmarkSuite(undefined, runs)
const meta = collectRunMetadata()
const payload = {
  protocolVersion: 1,
  recordKind: 'clean-commit',
  ...meta,
  runs,
  suiteFingerprint: scenarios.map((s) => s.id),
  git: {
    ...meta.git,
    dirty: false,
    commitDate: git('log -1 --format=%cI'),
    subject: git('log -1 --format=%s')
  },
  scenarios
}

appendFileSync(HISTORY_PATH, JSON.stringify(payload) + '\n')
console.log(`Appended → ${HISTORY_PATH}`)
