import { writeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const MARKER_PREFIX = 'GC_AUDIT_MARKER\t'
const NVP_TIME_RE = /\]\s+([0-9.]+)\s+ms:/
const STANDARD_TIME_RE = /\]\s+([0-9.]+)\s+ms:\s+([A-Za-z-]+(?:\s+[A-Za-z-]+)*)/

function parseBool(value) {
  if (value == null) return false
  return value === '1' || value === 'true' || value === 'yes'
}

function argValue(flag, args = process.argv) {
  const eq = args.find(arg => arg.startsWith(`${flag}=`))
  if (eq) return eq.slice(flag.length + 1)
  const index = args.indexOf(flag)
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) {
    return args[index + 1]
  }
  return null
}

function gcKindFromCode(code) {
  if (code === 's') return { kind: 'scavenge', isMajor: false }
  if (code === 'ms') return { kind: 'mark-sweep', isMajor: true }
  if (code === 'mc') return { kind: 'mark-compact', isMajor: true }
  return { kind: code ?? 'unknown', isMajor: false }
}

function gcKindFromName(name) {
  const normalized = name.toLowerCase()
  if (normalized.includes('scavenge')) return { kind: 'scavenge', isMajor: false }
  if (normalized.includes('mark-compact')) return { kind: 'mark-compact', isMajor: true }
  if (normalized.includes('mark-sweep')) return { kind: 'mark-sweep', isMajor: true }
  return { kind: name, isMajor: false }
}

function parseKeyValuePairs(text) {
  const out = {}
  const pairs = text.match(/[A-Za-z0-9_.]+=[^\s]+/g) ?? []
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    out[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return out
}

function parseMarker(line) {
  if (!line.startsWith(MARKER_PREFIX)) return null
  try {
    return JSON.parse(line.slice(MARKER_PREFIX.length))
  } catch {
    return null
  }
}

function parseNvpEvent(line) {
  if (!line.includes(' gc=')) return null
  const timeMatch = line.match(NVP_TIME_RE)
  if (!timeMatch) return null
  const fields = parseKeyValuePairs(line)
  const { kind, isMajor } = gcKindFromCode(fields.gc)
  return {
    format: 'nvp',
    timeMs: Number(timeMatch[1]),
    pauseMs: Number(fields.pause ?? NaN),
    kind,
    kindCode: fields.gc ?? null,
    isMajor,
    reduceMemory: fields.reduce_memory === '1',
    raw: line,
  }
}

function parseStandardEvent(line) {
  const match = line.match(STANDARD_TIME_RE)
  if (!match) return null
  const { kind, isMajor } = gcKindFromName(match[2].trim())
  return {
    format: 'standard',
    timeMs: Number(match[1]),
    pauseMs: Number.NaN,
    kind,
    kindCode: null,
    isMajor,
    reduceMemory: false,
    raw: line,
  }
}

function buildWindows(markers) {
  const starts = new Map()
  const windows = []

  for (const marker of markers) {
    const phase = marker.phase
    if (typeof phase !== 'string') continue
    if (phase.endsWith('-start')) {
      const stem = phase.slice(0, -'-start'.length)
      starts.set(`${marker.scenarioId ?? ''}:${marker.run ?? ''}:${stem}`, { stem, marker })
      continue
    }
    if (!phase.endsWith('-end')) continue
    const stem = phase.slice(0, -'-end'.length)
    const key = `${marker.scenarioId ?? ''}:${marker.run ?? ''}:${stem}`
    const start = starts.get(key)
    if (start == null) continue
    starts.delete(key)
    windows.push({
      scenarioId: marker.scenarioId ?? start.marker.scenarioId ?? null,
      run: marker.run ?? start.marker.run ?? null,
      phase: stem,
      startMs: start.marker.timeMs,
      endMs: marker.timeMs,
      measureWindow: marker.measureWindow === true || start.marker.measureWindow === true,
      expectedMajorGc: marker.expectedMajorGc === true || start.marker.expectedMajorGc === true,
    })
  }

  return windows
}

function summarizeWindows(windows, events) {
  return windows.map(window => {
    const inWindow = events.filter(event => event.timeMs >= window.startMs && event.timeMs <= window.endMs)
    const majorGcCount = inWindow.filter(event => event.isMajor).length
    const unexpectedMajorGcCount = window.expectedMajorGc ? 0 : majorGcCount
    return {
      ...window,
      eventCount: inWindow.length,
      majorGcCount,
      unexpectedMajorGcCount,
      clean: unexpectedMajorGcCount === 0,
    }
  })
}

function summarizeByScenario(windows) {
  const grouped = new Map()
  for (const window of windows) {
    const key = `${window.scenarioId ?? 'unknown'}`
    const scenario = grouped.get(key) ?? {
      scenarioId: window.scenarioId ?? 'unknown',
      runs: new Map(),
    }
    const runKey = `${window.run ?? 0}`
    const run = scenario.runs.get(runKey) ?? {
      run: window.run ?? 0,
      clean: true,
      unexpectedMajorGcCount: 0,
      windows: [],
    }
    run.clean = run.clean && window.clean
    run.unexpectedMajorGcCount += window.unexpectedMajorGcCount
    run.windows.push(window)
    scenario.runs.set(runKey, run)
    grouped.set(key, scenario)
  }

  return [...grouped.values()].map(scenario => {
    const runs = [...scenario.runs.values()].sort((a, b) => a.run - b.run)
    return {
      scenarioId: scenario.scenarioId,
      clean: runs.every(run => run.clean),
      unexpectedMajorGcCount: runs.reduce((sum, run) => sum + run.unexpectedMajorGcCount, 0),
      runs,
    }
  })
}

export function gcAuditRequested(args = process.argv, env = process.env) {
  return parseBool(env.BENCH_GC_AUDIT) || args.includes('--gc-audit')
}

export function gcAuditChildEnabled(env = process.env) {
  return env.BENCH_GC_AUDIT_CHILD === '1'
}

export function gcAuditRuns(fallback, env = process.env) {
  const raw = Number(env.BENCH_GC_AUDIT_RUNS)
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return fallback
}

export function emitGcAuditMarker(phase, meta = {}) {
  if (!gcAuditChildEnabled()) return
  const marker = {
    phase,
    timeMs: Number(performance.now().toFixed(3)),
    ...meta,
  }
  writeSync(1, `${MARKER_PREFIX}${JSON.stringify(marker)}\n`)
}

export function parseGcAuditOutput(text) {
  const markers = []
  const events = []
  let format = 'none'

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    const marker = parseMarker(line)
    if (marker != null) {
      markers.push(marker)
      continue
    }

    const nvp = parseNvpEvent(line)
    if (nvp != null) {
      events.push(nvp)
      format = 'nvp'
      continue
    }

    const standard = parseStandardEvent(line)
    if (standard != null) {
      events.push(standard)
      if (format === 'none') format = 'standard'
    }
  }

  const windows = summarizeWindows(buildWindows(markers), events)
  const scenarios = summarizeByScenario(windows)
  const unexpectedMajorGcCount = windows.reduce((sum, window) => sum + window.unexpectedMajorGcCount, 0)

  return {
    format,
    markers,
    events,
    windows,
    scenarios,
    clean: unexpectedMajorGcCount === 0,
    unexpectedMajorGcCount,
  }
}

export function runGcAuditScript({
  scriptPath,
  scriptArgs = [],
  cwd = process.cwd(),
  env = process.env,
  extraNodeArgs = [],
}) {
  const spawnAudit = (traceArgs) => spawnSync(
    process.execPath,
    [...extraNodeArgs, '--expose-gc', ...traceArgs, scriptPath, ...scriptArgs],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...env,
        BENCH_GC_AUDIT_CHILD: '1',
      },
    },
  )

  let child = spawnAudit(['--trace-gc-nvp'])
  const combinedFirst = `${child.stdout ?? ''}\n${child.stderr ?? ''}`
  if (child.status !== 0 && /trace-gc-nvp|bad option|unknown option/i.test(combinedFirst)) {
    child = spawnAudit(['--trace-gc'])
  }

  const combined = `${child.stdout ?? ''}\n${child.stderr ?? ''}`
  if (child.status !== 0) {
    throw new Error(`GC audit child failed with code ${child.status}\n${combined}`)
  }

  return parseGcAuditOutput(combined)
}

export { argValue }
