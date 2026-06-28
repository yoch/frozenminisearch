import { emitGcAuditMarker } from '../gcAudit.js'

function runWork() {
  emitGcAuditMarker('baseline-gc-start', { scenarioId: 'smoke', run: 0 })
  global.gc?.()
  emitGcAuditMarker('baseline-gc-end', { scenarioId: 'smoke', run: 0 })

  emitGcAuditMarker('work-start', { scenarioId: 'smoke', run: 0, measureWindow: true })
  const values = []
  for (let i = 0; i < 20_000; i++) values.push({ i, label: `v${i}` })
  global.gc?.()
  emitGcAuditMarker('work-end', { scenarioId: 'smoke', run: 0, measureWindow: true })

  return {
    value: 42,
    retained: values.length,
  }
}

process.stdout.write(`${JSON.stringify(runWork())}\n`)
