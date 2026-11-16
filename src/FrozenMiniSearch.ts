import {
  decodeFrozenSnapshotMsv5,
  decodeFrozenSnapshotMsv5Async,
} from './msv5/binaryMsv5Decode'
import {
  encodeFrozenSnapshotMsv5Packed,
  encodeFrozenSnapshotMsv5PackedAsync,
} from './msv5/binaryMsv5EncodePacked'
import { snapshotBytes } from './binaryBytes'
import { defaultFrozenLoadOptions } from './searchDefaults'
import type { SaveBinaryOptions, Options } from './searchTypes'
import FrozenMiniSearchCore, {
  assembleFrozenFromBinarySnapshot,
  frozenFromDocumentsWithCtor,
  frozenFromIndexBuilderWithCtor,
} from './FrozenMiniSearchCore'
import { type FrozenIndexBuilder } from './frozenBuild'

function asBuffer(input: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(input)) return input
  const bytes = snapshotBytes(input)
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Build a read-only Node index in one pass from documents. */
export function buildFrozenFromDocuments<T>(
  documents: readonly T[],
  options: Options<T>,
): FrozenMiniSearch<T> {
  return frozenFromDocumentsWithCtor(FrozenMiniSearch, documents, options)
}

/** Finalize a {@link FrozenIndexBuilder} into a read-only Node index. */
export function freezeFrozenIndexBuilder<T>(
  builder: FrozenIndexBuilder<T>,
): FrozenMiniSearch<T> {
  return frozenFromIndexBuilderWithCtor(FrozenMiniSearch, builder)
}

export default class FrozenMiniSearch<T = any> extends FrozenMiniSearchCore<T> {
  /** Serialize this index as a frozen binary snapshot (synchronous). */
  saveBinarySync(saveOptions: SaveBinaryOptions = {}): Buffer {
    return encodeFrozenSnapshotMsv5Packed(
      this._binarySnapshotInput(),
      this._index,
      saveOptions.compression,
    )
  }

  /** Non-blocking snapshot serialization with the selected compression codec. */
  async saveBinaryAsync(saveOptions: SaveBinaryOptions = {}): Promise<Buffer> {
    return encodeFrozenSnapshotMsv5PackedAsync(
      this._binarySnapshotInput(),
      this._index,
      saveOptions.compression,
    )
  }

  /** Load a frozen binary snapshot. */
  static loadBinarySync<T>(
    bytes: Buffer | Uint8Array | ArrayBuffer,
    options: Options<T> = {} as Options<T>,
  ): FrozenMiniSearch<T> {
    const buffer = asBuffer(bytes)
    const storeFields =
      options.storeFields ?? defaultFrozenLoadOptions.storeFields
    const snap = decodeFrozenSnapshotMsv5(buffer, { storeFields })
    return FrozenMiniSearch._fromBinarySnapshot(snap, options, buffer)
  }

  /** Load a frozen binary snapshot with streaming decompression when needed (bounded memory). */
  static async loadBinaryAsync<T>(
    bytes: Buffer | Uint8Array | ArrayBuffer,
    options: Options<T> = {} as Options<T>,
  ): Promise<FrozenMiniSearch<T>> {
    const buffer = asBuffer(bytes)
    const storeFields =
      options.storeFields ?? defaultFrozenLoadOptions.storeFields
    const snap = await decodeFrozenSnapshotMsv5Async(buffer, { storeFields })
    return FrozenMiniSearch._fromBinarySnapshot(snap, options, buffer)
  }

  private static _fromBinarySnapshot<T>(
    snap: ReturnType<typeof decodeFrozenSnapshotMsv5>,
    options: Options<T>,
    buffer: Buffer | Uint8Array,
  ): FrozenMiniSearch<T> {
    return assembleFrozenFromBinarySnapshot(
      snap,
      options,
      buffer,
      FrozenMiniSearch,
    )
  }
}
