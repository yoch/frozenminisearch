import type { BinaryBytes } from '../binaryBytes'

type NativeCompressionTransform = ReadableWritablePair<
  BufferSource,
  BufferSource
>

// Browser wire buffers are regular Uint8Array instances; narrow once at the
// stream boundary instead of copying the full payload just to satisfy lib.dom.
function toBrowserBufferSource(bytes: BinaryBytes): BufferSource {
  return bytes as unknown as Uint8Array<ArrayBuffer>
}

function readStreamFromBytes(bytes: BinaryBytes): ReadableStream<BufferSource> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(toBrowserBufferSource(bytes))
      controller.close()
    },
  })
}

async function streamToBytes(
  stream: ReadableStream<BufferSource>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function requireCompressionStream(): typeof CompressionStream {
  if (typeof CompressionStream !== 'function') {
    throw new Error(
      'CompressionStream is unavailable in this browser environment. ' +
        'Browser binary compression with "zlib" or "auto" requires a modern runtime.',
    )
  }
  return CompressionStream
}

function requireDecompressionStream(): typeof DecompressionStream {
  if (typeof DecompressionStream !== 'function') {
    throw new Error(
      'DecompressionStream is unavailable in this browser environment. ' +
        'Browser loading of zlib-compressed snapshots requires a modern runtime.',
    )
  }
  return DecompressionStream
}

export async function browserZlibDeflateAsync(
  uncompressed: BinaryBytes,
): Promise<BinaryBytes> {
  const CompressionStreamCtor = requireCompressionStream()
  return await streamToBytes(
    readStreamFromBytes(uncompressed).pipeThrough(
      new CompressionStreamCtor(
        'deflate',
      ) as unknown as NativeCompressionTransform,
    ),
  )
}

/**
 * Inflate a stream declared to hold `expectedLength` bytes. Returns `undefined` when it
 * holds any other count; it is cancelled as soon as it overflows.
 */
export async function browserZlibInflateAsync(
  compressed: BinaryBytes,
  expectedLength: number,
): Promise<BinaryBytes | undefined> {
  const DecompressionStreamCtor = requireDecompressionStream()
  const reader = readStreamFromBytes(compressed)
    .pipeThrough(
      new DecompressionStreamCtor(
        'deflate',
      ) as unknown as NativeCompressionTransform,
    )
    .getReader()
  // Nothing is sized from the declared length until the stream has produced it.
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = value as Uint8Array
    length += chunk.length
    if (length > expectedLength) {
      await reader.cancel()
      return undefined
    }
    chunks.push(chunk)
  }
  if (length !== expectedLength) return undefined
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
