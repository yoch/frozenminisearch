import type { BinaryBytes } from '../binaryBytes'

type NativeCompressionTransform = ReadableWritablePair<BufferSource, BufferSource>

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

async function streamToBytes(stream: ReadableStream<BufferSource>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function requireCompressionStream(): typeof CompressionStream {
  if (typeof CompressionStream !== 'function') {
    throw new Error(
      'CompressionStream is unavailable in this browser environment. '
      + 'Browser binary compression with "zlib" or "auto" requires a modern runtime.',
    )
  }
  return CompressionStream
}

function requireDecompressionStream(): typeof DecompressionStream {
  if (typeof DecompressionStream !== 'function') {
    throw new Error(
      'DecompressionStream is unavailable in this browser environment. '
      + 'Browser loading of zlib-compressed snapshots requires a modern runtime.',
    )
  }
  return DecompressionStream
}

export async function browserZlibDeflateAsync(uncompressed: BinaryBytes): Promise<BinaryBytes> {
  const CompressionStreamCtor = requireCompressionStream()
  return await streamToBytes(
    readStreamFromBytes(uncompressed)
      .pipeThrough(new CompressionStreamCtor('deflate') as unknown as NativeCompressionTransform),
  )
}

export async function browserZlibInflateAsync(compressed: BinaryBytes): Promise<BinaryBytes> {
  const DecompressionStreamCtor = requireDecompressionStream()
  return await streamToBytes(
    readStreamFromBytes(compressed)
      .pipeThrough(new DecompressionStreamCtor('deflate') as unknown as NativeCompressionTransform),
  )
}
