import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseGcAuditOutput,
  runGcAuditScript,
} from './gcAudit.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SMOKE_SCRIPT = join(__dirname, 'fixtures/gc-audit-smoke.mjs')

describe('gcAudit', () => {
  test('parses trace-gc-nvp output and correlates windows', () => {
    const sample = [
      'GC_AUDIT_MARKER\t{"phase":"add-start","timeMs":10,"scenarioId":"divina","run":0,"measureWindow":true}',
      '[2:0x352a2000:0]       12 ms: pause=1.3 mutator=26.2 gc=s reduce_memory=0 allocated=4859192 promoted=0',
      '[2:0x352a2000:0]       15 ms: pause=6.9 mutator=0.5 gc=mc reduce_memory=0 allocated=677896 promoted=2360432',
      'GC_AUDIT_MARKER\t{"phase":"add-end","timeMs":20,"scenarioId":"divina","run":0,"measureWindow":true}',
    ].join('\n')

    const parsed = parseGcAuditOutput(sample)

    expect(parsed.format).toBe('nvp')
    expect(parsed.events).toHaveLength(2)
    expect(parsed.windows).toHaveLength(1)
    expect(parsed.windows[0].phase).toBe('add')
    expect(parsed.windows[0].majorGcCount).toBe(1)
    expect(parsed.unexpectedMajorGcCount).toBe(1)
    expect(parsed.clean).toBe(false)
    expect(parsed.scenarios[0]).toMatchObject({
      scenarioId: 'divina',
      clean: false,
      unexpectedMajorGcCount: 1,
    })
  })

  test('audit child emits parseable markers on a real subprocess', () => {
    const audit = runGcAuditScript({
      scriptPath: SMOKE_SCRIPT,
      cwd: __dirname,
      env: process.env,
    })

    expect(audit.events.length).toBeGreaterThan(0)
    expect(audit.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scenarioId: 'smoke',
        phase: 'work',
        measureWindow: true,
      }),
    ]))
  })
})
