import {
  decodeFrozenSnapshot,
  decodeFrozenSnapshotAsync,
} from './binaryFormat'
import { encodeFrozenSnapshotPacked, encodeFrozenSnapshotPackedAsync } from './binaryEncodePacked'
import {
  defaultFrozenLoadOptions,
} from './searchDefaults'
import type { SaveBinaryOptions, Options } from './searchTypes'
import FrozenMiniSearchCore, {
  assembleFrozenFromBinarySnapshot,
  frozenFromDocumentsWithCtor,
  frozenFromIndexBuilderWithCtor,
} from './FrozenMiniSearchCore'
import { type FrozenIndexBuilder } from './frozenBuild'

/** Build a read-only Node index in one pass from documents. */
export function buildFrozenFromDocuments<T>(documents: readonly T[], options: Options<T>): FrozenMiniSearch<T> {
  return frozenFromDocumentsWithCtor(FrozenMiniSearch, documents, options)
}

/** Finalize a {@link FrozenIndexBuilder} into a read-only Node index. */
export function freezeFrozenIndexBuilder<T>(builder: FrozenIndexBuilder<T>): FrozenMiniSearch<T> {
  return frozenFromIndexBuilderWithCtor(FrozenMiniSearch, builder)
}

export default class FrozenMiniSearch<T = any> extends FrozenMiniSearchCore<T> {
  /** Serialize this index as a frozen binary snapshot (synchronous). */
  saveBinarySync(saveOptions: SaveBinaryOptions = {}): Buffer {
    return encodeFrozenSnapshotPacked(this._binarySnapshotInput(), this._index, saveOptions.compression)
  }

  /** Non-blocking snapshot serialization with the selected compression codec. */
  async saveBinaryAsync(saveOptions: SaveBinaryOptions = {}): Promise<Buffer> {
    return encodeFrozenSnapshotPackedAsync(this._binarySnapshotInput(), this._index, saveOptions.compression)
  }

  /** Load a frozen binary snapshot. */
  static loadBinarySync<T>(buffer: Buffer, options: Options<T> = {} as Options<T>): FrozenMiniSearch<T> {
    const storeFields = options.storeFields ?? defaultFrozenLoadOptions.storeFields
    const snap = decodeFrozenSnapshot(buffer, { storeFields })
    return FrozenMiniSearch._fromBinarySnapshot(snap, options, buffer)
  }

  /** Load a frozen binary snapshot with streaming decompression when needed (bounded memory). */
  static async loadBinaryAsync<T>(
    buffer: Buffer,
    options: Options<T> = {} as Options<T>,
  ): Promise<FrozenMiniSearch<T>> {
    const storeFields = options.storeFields ?? defaultFrozenLoadOptions.storeFields
    const snap = await decodeFrozenSnapshotAsync(buffer, { storeFields })
    return FrozenMiniSearch._fromBinarySnapshot(snap, options, buffer)
  }

  private static _fromBinarySnapshot<T>(
    snap: ReturnType<typeof decodeFrozenSnapshot>,
    options: Options<T>,
    buffer: Buffer | Uint8Array,
  ): FrozenMiniSearch<T> {
    return assembleFrozenFromBinarySnapshot(snap, options, buffer, FrozenMiniSearch)
  }
}
