import { decodeFrozenSnapshotMsv5Browser } from './msv5/binaryMsv5DecodeBrowser'
import { encodeFrozenSnapshotMsv5Browser } from './msv5/binaryMsv5EncodeBrowser'
import { assembleParamsFromBinarySnapshot, buildBinarySnapshotInput } from './frozenBinaryShared'
import {
  defaultFrozenLoadOptions,
} from './searchDefaults'
import type { FrozenAssembleParams } from './frozenTypes'
import type { BrowserSaveBinaryOptions, Options } from './searchTypes'
import FrozenMiniSearchCore, {
  assembleFrozenWithCtor,
} from './FrozenMiniSearchCore'

export function assembleFrozen<T>(params: FrozenAssembleParams<T>): FrozenMiniSearchBrowser<T> {
  return assembleFrozenWithCtor(params, false, 'binary-load', FrozenMiniSearchBrowser)
}

export default class FrozenMiniSearchBrowser<T = any> extends FrozenMiniSearchCore<T> {
  saveBinarySync(saveOptions: BrowserSaveBinaryOptions = {}): Uint8Array {
    return encodeFrozenSnapshotMsv5Browser(
      this.binarySnapshotInput(),
      undefined,
      this._index,
      saveOptions.compression,
    )
  }

  private binarySnapshotInput(): Parameters<typeof encodeFrozenSnapshotMsv5Browser>[0] {
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

  static loadBinarySync<T>(buffer: Uint8Array, options: Options<T> = {} as Options<T>): FrozenMiniSearchBrowser<T> {
    const storeFields = options.storeFields ?? defaultFrozenLoadOptions.storeFields
    const snap = decodeFrozenSnapshotMsv5Browser(buffer, { storeFields })
    return FrozenMiniSearchBrowser.fromBinarySnapshot(snap, options)
  }

  private static fromBinarySnapshot<T>(
    snap: ReturnType<typeof decodeFrozenSnapshotMsv5Browser>,
    options: Options<T>,
  ): FrozenMiniSearchBrowser<T> {
    return assembleFrozen(assembleParamsFromBinarySnapshot(snap, options))
  }
}
