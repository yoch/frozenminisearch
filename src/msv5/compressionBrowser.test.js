import { browserZlibDeflateAsync, browserZlibInflateAsync } from './compressionBrowser'

describe('compressionBrowser', () => {
  test('zlib deflate/inflate round-trip', async () => {
    const input = new TextEncoder().encode('payload '.repeat(32))
    const compressed = await browserZlibDeflateAsync(input)
    expect(compressed.length).toBeLessThan(input.length)
    const restored = await browserZlibInflateAsync(compressed)
    expect(Buffer.from(restored)).toEqual(Buffer.from(input))
  })

  test('deflate rejects when CompressionStream is unavailable', async () => {
    const saved = globalThis.CompressionStream
    globalThis.CompressionStream = undefined
    try {
      await expect(browserZlibDeflateAsync(new Uint8Array([1, 2, 3])))
        .rejects.toThrow(/CompressionStream is unavailable/)
    } finally {
      globalThis.CompressionStream = saved
    }
  })

  test('inflate rejects when DecompressionStream is unavailable', async () => {
    const saved = globalThis.DecompressionStream
    globalThis.DecompressionStream = undefined
    try {
      await expect(browserZlibInflateAsync(new Uint8Array([1, 2, 3])))
        .rejects.toThrow(/DecompressionStream is unavailable/)
    } finally {
      globalThis.DecompressionStream = saved
    }
  })
})
