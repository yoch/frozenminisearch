import {
  decodeFrozenSnapshot,
  decodeFrozenSnapshotAsync,
  encodeFrozenSnapshot,
  encodeFrozenSnapshotAsync,
  fieldNamesFromFieldIds,
} from './binaryFormat'
import { createIdToShortIdLookup } from './frozenIdLookup'
import {
  defaultSearchOptions,
  defaultAutoSuggestOptions,
  defaultFrozenLoadOptions,
} from './searchDefaults'
import { fieldLengthMatrixForWire } from './fieldLengthMatrix'
import type { FrozenAssembleParams } from './frozenTypes'
import type { SaveBinaryOptions, Options } from './searchTypes'
import { storedFieldsFromRows } from './storedFieldsLayout'
import type { OptionsWithDefaults } from './frozenTypes'
import FrozenMiniSearchCore, {
  assembleFrozenWithCtor,
  frozenMemoryBreakdown,
} from './FrozenMiniSearchCore'
import { buildFrozenParamsFromDocuments, type FrozenIndexBuilder } from './frozenBuild'

export {
  frozenMemoryBreakdown,
}
export type { FrozenAssembleParams, FrozenMemoryBreakdown } from './frozenTypes'
export type { MiniSearchSnapshot } from './fromMiniSearch'

/** Build a read-only Node index in one pass from documents. */
export function buildFrozenFromDocuments<T>(documents: readonly T[], options: Options<T>): FrozenMiniSearch<T> {
  return assembleFrozenWithCtor(
    buildFrozenParamsFromDocuments(documents, options),
    true,
    'trusted-build',
    FrozenMiniSearch,
  )
}

/** Finalize a {@link FrozenIndexBuilder} into a read-only Node index. */
export function freezeFrozenIndexBuilder<T>(builder: FrozenIndexBuilder<T>): FrozenMiniSearch<T> {
  return assembleFrozenWithCtor(builder.freezeParams(), true, 'trusted-build', FrozenMiniSearch)
}

function assertFieldsMatchSnapshot(
  optionsFields: readonly string[],
  snapFieldIds: { [field: string]: number },
): void {
  const snapNames = Object.keys(snapFieldIds).sort()
  const optNames = [...optionsFields].sort()
  if (snapNames.length !== optNames.length || snapNames.some((name, i) => name !== optNames[i])) {
    throw new Error(
      `FrozenMiniSearch: option "fields" must match the indexed fields exactly (expected: ${snapNames.join(', ')})`,
    )
  }
}

/** Instantiate {@link FrozenMiniSearch} from pre-built flat index parts (full validation). */
export function assembleFrozen<T>(params: FrozenAssembleParams<T>): FrozenMiniSearch<T> {
  return assembleFrozenWithCtor(params, false, 'binary-load', FrozenMiniSearch)
}

export default class FrozenMiniSearch<T = any> extends FrozenMiniSearchCore<T> {
  /** Serialize this index as a frozen binary snapshot (synchronous). */
  saveBinarySync(saveOptions: SaveBinaryOptions = {}): Buffer {
    return encodeFrozenSnapshot(this.binarySnapshotInput(), undefined, this._index, saveOptions.compression)
  }

  /** Non-blocking snapshot serialization with the selected compression codec. */
  async saveBinaryAsync(saveOptions: SaveBinaryOptions = {}): Promise<Buffer> {
    return encodeFrozenSnapshotAsync(this.binarySnapshotInput(), undefined, this._index, saveOptions.compression)
  }

  private binarySnapshotInput(): Parameters<typeof encodeFrozenSnapshot>[0] {
    return {
      documentCount: this._documentCount,
      nextId: this._nextId,
      fieldIds: this._fieldIds,
      fieldCount: this._fieldCount,
      fieldNames: fieldNamesFromFieldIds(this._fieldIds),
      avgFieldLength: this._avgFieldLength,
      externalIds: this._externalIds,
      storedFields: new Array(this._nextId),
      storedFieldsLayout: this._storedFields,
      fieldLengthMatrix: fieldLengthMatrixForWire(this._fieldLengthMatrix),
      treeShape: [],
      postings: this._postings,
    }
  }

  /** Load a frozen binary snapshot. */
  static loadBinarySync<T>(buffer: Buffer, options: Options<T> = {} as Options<T>): FrozenMiniSearch<T> {
    const storeFields = options.storeFields ?? defaultFrozenLoadOptions.storeFields
    const snap = decodeFrozenSnapshot(buffer, { storeFields })
    return FrozenMiniSearch.fromBinarySnapshot(snap, options)
  }

  /** Load a frozen binary snapshot with streaming decompression when needed (bounded memory). */
  static async loadBinaryAsync<T>(
    buffer: Buffer,
    options: Options<T> = {} as Options<T>,
  ): Promise<FrozenMiniSearch<T>> {
    const storeFields = options.storeFields ?? defaultFrozenLoadOptions.storeFields
    const snap = await decodeFrozenSnapshotAsync(buffer, { storeFields })
    return FrozenMiniSearch.fromBinarySnapshot(snap, options)
  }

  private static fromBinarySnapshot<T>(
    snap: ReturnType<typeof decodeFrozenSnapshot>,
    options: Options<T>,
  ): FrozenMiniSearch<T> {
    const snapshotFields = snap.fieldNames ?? fieldNamesFromFieldIds(snap.fieldIds)
    if (options.fields != null) {
      assertFieldsMatchSnapshot(options.fields, snap.fieldIds)
    }

    const opts: OptionsWithDefaults<T> = {
      ...defaultFrozenLoadOptions,
      ...options,
      fields: options.fields ?? snapshotFields,
      searchOptions: {
        ...defaultSearchOptions,
        ...(options.searchOptions || {}),
      },
      autoSuggestOptions: { ...defaultAutoSuggestOptions, ...(options.autoSuggestOptions || {}) },
    } as OptionsWithDefaults<T>

    const index = snap.packedTermIndex
    if (index == null) {
      throw new Error('FrozenMiniSearch: binary snapshot missing packed term index')
    }

    const idLookup = createIdToShortIdLookup(snap.externalIds, snap.nextId)

    return assembleFrozen({
      options: opts,
      documentCount: snap.documentCount,
      nextId: snap.nextId,
      fieldIds: snap.fieldIds,
      fieldCount: snap.fieldCount,
      externalIds: snap.externalIds,
      idLookup,
      storedFields: snap.storedFieldsLayout ?? storedFieldsFromRows(snap.storedFields, opts.storeFields),
      fieldLengthMatrix: snap.fieldLengthMatrix,
      avgFieldLength: snap.avgFieldLength,
      index,
      termCount: snap.postings.termCount,
      postings: snap.postings,
    })
  }
}
