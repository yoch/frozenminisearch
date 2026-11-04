import PackedRadixTree from './PackedRadixTree'
import type { PackedIndexArray } from './PackedRadixTree/types'
import type { FieldLengthArray } from './fieldLengthMatrix'
import type { FrozenPostingsLayout } from './frozenPostings'
import type { FrozenAssembleParams } from './frozenTypes'
import {
  mergeSearchOptions,
  mergeSearchOptionsWithDefaults,
} from './frozenOptions'
import type { OptionsWithDefaults } from './searchTypes'
import { cloneStoredFields } from './storedFieldsLayout'
import { CODEC_RAW } from './msv5/binaryMsv5Constants'

export type SnapshotOwnershipMode =
  'trusted-build' | 'minisearch-json' | 'binary-load' | 'binary-load-wire'

export function binaryLoadOwnershipModeFromCodec(
  codec: number,
): SnapshotOwnershipMode {
  return codec === CODEC_RAW ? 'binary-load-wire' : 'binary-load'
}

function ownedIndexArray(arr: PackedIndexArray): PackedIndexArray {
  if (arr instanceof Uint8Array) return new Uint8Array(arr)
  if (arr instanceof Uint16Array) return new Uint16Array(arr)
  return new Uint32Array(arr)
}

function ownedFieldLengthMatrix(matrix: FieldLengthArray): FieldLengthArray {
  return ownedIndexArray(matrix)
}

function ownedPackedRadixTree(index: PackedRadixTree): PackedRadixTree {
  return PackedRadixTree.fromData({
    size: index.size,
    nodeCount: index.nodeCount,
    edgeCount: index.edgeCount,
    labelHeap: index.labelHeap,
    nodeEdgeOffset: ownedIndexArray(index.nodeEdgeOffset),
    nodeValue: ownedIndexArray(index.nodeValue),
    nodeLeafOrder: ownedIndexArray(index.nodeLeafOrder),
    edgeLabelStart: ownedIndexArray(index.edgeLabelStart),
    edgeLabelLength: ownedIndexArray(index.edgeLabelLength),
    edgeChild: ownedIndexArray(index.edgeChild),
  })
}

function ownedPostingsLayout(
  postings: FrozenPostingsLayout,
): FrozenPostingsLayout {
  const allDocIds =
    postings.docIdWidth === 16
      ? new Uint16Array(postings.allDocIds)
      : new Uint32Array(postings.allDocIds)
  const allFreqs =
    postings.allFreqs instanceof Uint8Array
      ? new Uint8Array(postings.allFreqs)
      : new Uint16Array(postings.allFreqs)

  if (postings.layout === 'dense') {
    return {
      layout: 'dense',
      fieldCount: postings.fieldCount,
      termCount: postings.termCount,
      nextId: postings.nextId,
      docIdWidth: postings.docIdWidth,
      allDocIds,
      allFreqs,
      denseOffsets: ownedIndexArray(postings.denseOffsets),
      denseLengths: ownedIndexArray(postings.denseLengths),
    }
  }

  const sparseFieldIds =
    postings.sparseFieldIdWidth === 16
      ? new Uint16Array(postings.sparseFieldIds)
      : new Uint8Array(postings.sparseFieldIds)

  return {
    layout: 'sparse',
    fieldCount: postings.fieldCount,
    termCount: postings.termCount,
    nextId: postings.nextId,
    docIdWidth: postings.docIdWidth,
    allDocIds,
    allFreqs,
    sparseFieldIdWidth: postings.sparseFieldIdWidth,
    sparseTermStarts: ownedIndexArray(postings.sparseTermStarts),
    sparseFieldIds,
    sparseOffsets: ownedIndexArray(postings.sparseOffsets),
    sparseLengths: ownedIndexArray(postings.sparseLengths),
  }
}

function shallowCopyOptions<T>(
  options: OptionsWithDefaults<T>,
): OptionsWithDefaults<T> {
  return {
    fields: [...options.fields],
    idField: options.idField,
    storeFields: options.storeFields,
    extractField: options.extractField,
    stringifyField: options.stringifyField,
    tokenize: options.tokenize,
    processTerm: options.processTerm,
    searchOptions: mergeSearchOptionsWithDefaults(options.searchOptions),
    autoSuggestOptions: mergeSearchOptions(options.autoSuggestOptions),
  }
}

/**
 * Ensure {@link FrozenMiniSearch} owns its snapshot data (no aliases on source MiniSearch,
 * no TypedArray views on wire buffers after binary load).
 */
export function materializeOwnedSnapshot<T>(
  params: FrozenAssembleParams<T>,
  mode: SnapshotOwnershipMode,
): FrozenAssembleParams<T> {
  switch (mode) {
    case 'trusted-build':
      return params

    case 'minisearch-json':
      return {
        options: shallowCopyOptions(params.options),
        documentCount: params.documentCount,
        nextId: params.nextId,
        fieldIds: { ...params.fieldIds },
        fieldCount: params.fieldCount,
        externalIds: params.externalIds,
        idLookup: params.idLookup,
        storedFields: cloneStoredFields(params.storedFields),
        fieldLengthMatrix: params.fieldLengthMatrix,
        avgFieldLength: params.avgFieldLength,
        index: params.index,
        termCount: params.termCount,
        postings: params.postings,
      }

    // Raw MSv5 sections alias the caller's wire buffer. Compressed sections are views
    // on the decoded payload, which also holds stored fields, ids and label bytes
    // already materialized as JS values. Copying the typed arrays in both cases lets
    // the source allocation be collected.
    case 'binary-load':
    case 'binary-load-wire':
      return {
        options: params.options,
        documentCount: params.documentCount,
        nextId: params.nextId,
        fieldIds: params.fieldIds,
        fieldCount: params.fieldCount,
        externalIds: params.externalIds,
        idLookup: params.idLookup,
        storedFields: params.storedFields,
        fieldLengthMatrix: ownedFieldLengthMatrix(params.fieldLengthMatrix),
        avgFieldLength: new Float32Array(params.avgFieldLength),
        index: ownedPackedRadixTree(params.index),
        termCount: params.termCount,
        postings: ownedPostingsLayout(params.postings),
      }

    default: {
      const exhaustive: never = mode
      return exhaustive
    }
  }
}
