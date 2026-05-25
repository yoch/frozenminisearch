import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function loadDivinaLines () {
  const file = join(__dirname, 'divinaCommedia.js')
  const source = readFileSync(file, 'utf8')

  const startMarker = 'const lines = '
  const endMarker = '\n\nconst miniSearch ='
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Unable to locate lines dataset in benchmarks/divinaCommedia.js')
  }

  const json = source.slice(start + startMarker.length, end)
  return JSON.parse(json)
}
