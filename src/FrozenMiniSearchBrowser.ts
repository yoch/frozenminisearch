import { decodeFrozenSnapshotMsv5Browser } from './msv5/binaryMsv5DecodeBrowser'
import { encodeFrozenSnapshotMsv5PackedBrowser } from './msv5/binaryMsv5EncodePacked'
import {
  defaultFrozenLoadOptions,
} from './searchDefaults'
import type { BrowserSaveBinaryAsyncOptions, Options } from './searchTypes'
import FrozenMiniSearchCore, {
  assembleFrozenFromBinarySnapshot,
  frozenFromDocumentsWithCtor,
  frozenFromIndexBuilderWithCtor,
} from './FrozenMiniSearchCore'
import { type FrozenIndexBuilder } from './frozenBuild'

/** Build a read-only browser index in one pass from documents. */
export function buildFrozenFromDocuments<T>(
  documents: readonly T[],
  options: Options<T>,
): FrozenMiniSearchBrowser<T> {
  return frozenFromDocumentsWithCtor(FrozenMiniSearchBrowser, documents, options)
}

/** Finalize a {@link FrozenIndexBuilder} into a read-only browser index. */
export function freezeFrozenIndexBuilder<T>(
  builder: FrozenIndexBuilder<T>,
): FrozenMiniSearchBrowser<T> {
  return frozenFromIndexBuilderWithCtor(FrozenMiniSearchBrowser, builder)
}

export default class FrozenMiniSearchBrowser<T = any> extends FrozenMiniSearchCore<T> {
  async saveBinaryAsync(saveOptions: BrowserSaveBinaryAsyncOptions = {}): Promise<Uint8Array> {
    return encodeFrozenSnapshotMsv5PackedBrowser(
      this._binarySnapshotInput(),
      this._index,
      saveOptions.compression,
    )
  }

  static async loadBinaryAsync<T>(
    buffer: Uint8Array,
    options: Options<T> = {} as Options<T>,
  ): Promise<FrozenMiniSearchBrowser<T>> {
    const storeFields = options.storeFields ?? defaultFrozenLoadOptions.storeFields
    const snap = await decodeFrozenSnapshotMsv5Browser(buffer, { storeFields })
    return FrozenMiniSearchBrowser._fromBinarySnapshot(snap, options, buffer)
  }

  private static _fromBinarySnapshot<T>(
    snap: Awaited<ReturnType<typeof decodeFrozenSnapshotMsv5Browser>>,
    options: Options<T>,
    buffer: Uint8Array,
  ): FrozenMiniSearchBrowser<T> {
    return assembleFrozenFromBinarySnapshot(snap, options, buffer, FrozenMiniSearchBrowser)
  }
}
