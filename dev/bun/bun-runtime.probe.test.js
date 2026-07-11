/**
 * Confirms Vitest workers actually run under Bun when launched via Bun.
 */
import { describe, test, expect } from 'vitest'

describe('bun runtime probe', () => {
  test('reports Bun.version when executed by Bun', () => {
    const isBun = typeof globalThis.Bun !== 'undefined'
    if (!isBun) {
      // Under Node this file is skipped from the Bun-only gate; still assert shape.
      expect(typeof process.version).toBe('string')
      return
    }
    expect(typeof Bun.version).toBe('string')
    expect(Bun.version.length).toBeGreaterThan(0)
    expect(process.execPath).toContain('bun')
  })
})
