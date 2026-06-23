import {
  decodeFrozenSnapshot,
  decodeFrozenSnapshotAsync,
  encodeFrozenSnapshot,
  encodeFrozenSnapshotAsync,
} from './binaryFormat'
import { assembleParamsFromBinarySnapshot, buildBinarySnapshotInput } from './frozenBinaryShared'
import {
  defaultFrozenLoadOptions,
} from './searchDefaults'
import type { FrozenAssembleParams } from './frozenTypes'
import type { SaveBinaryOptions, Options } from './searchTypes'
import FrozenMiniSearchCore, {
  assembleFrozenWithCtor,
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

/** @internal */
function assembleFrozen<T>(params: FrozenAssembleParams<T>): FrozenMiniSearch<T> {
  return assembleFrozenWithCtor(params, false, 'binary-load', FrozenMiniSearch)
}

export default class FrozenMiniSearch<T = any> extends FrozenMiniSearchCore<T> {
  /** Serialize this index as a frozen binary snapshot (synchronous). */
  saveBinarySync(saveOptions: SaveBinaryOptions = {}): Buffer {
    return encodeFrozenSnapshot(this._binarySnapshotInput(), undefined, this._index, saveOptions.compression)
  }

  /** Non-blocking snapshot serialization with the selected compression codec. */
  async saveBinaryAsync(saveOptions: SaveBinaryOptions = {}): Promise<Buffer> {
    return encodeFrozenSnapshotAsync(this._binarySnapshotInput(), undefined, this._index, saveOptions.compression)
  }

  private _binarySnapshotInput(): Parameters<typeof encodeFrozenSnapshot>[0] {
    return buildBinarySnapshotInput({
      documentCount: this._documentCount,
      nextId: this._nextId,
      fieldIds: this._fieldIds,
      fieldCount: this._fieldCount,
      avgFieldLength: this._avgFieldLength,
      externalIds: this._externalIds,
      storedFieldsLayout: this._storedFields,
      fieldLengthMatrix: this._fieldLengthMatrix,
      postings: this._postings,
    })
  }

  /** Load a frozen binary snapshot. */
  static loadBinarySync<T>(buffer: Buffer, options: Options<T> = {} as Options<T>): FrozenMiniSearch<T> {
    const storeFields = options.storeFields ?? defaultFrozenLoadOptions.storeFields
    const snap = decodeFrozenSnapshot(buffer, { storeFields })
    return FrozenMiniSearch._fromBinarySnapshot(snap, options)
  }

  /** Load a frozen binary snapshot with streaming decompression when needed (bounded memory). */
  static async loadBinaryAsync<T>(
    buffer: Buffer,
    options: Options<T> = {} as Options<T>,
  ): Promise<FrozenMiniSearch<T>> {
    const storeFields = options.storeFields ?? defaultFrozenLoadOptions.storeFields
    const snap = await decodeFrozenSnapshotAsync(buffer, { storeFields })
    return FrozenMiniSearch._fromBinarySnapshot(snap, options)
  }

  private static _fromBinarySnapshot<T>(
    snap: ReturnType<typeof decodeFrozenSnapshot>,
    options: Options<T>,
  ): FrozenMiniSearch<T> {
    return assembleFrozen(assembleParamsFromBinarySnapshot(snap, options))
  }
}
