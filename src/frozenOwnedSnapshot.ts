import PackedRadixTree from './PackedRadixTree'
import type { PackedIndexArray } from './PackedRadixTree/types'
import type { FieldLengthArray } from './fieldLengthMatrix'
import type { FrozenPostingsLayout } from './frozenPostings'
import type { FrozenAssembleParams } from './frozenTypes'
import type { OptionsWithDefaults } from './searchTypes'
import { cloneStoredFields } from './storedFieldsLayout'

export type SnapshotOwnershipMode = 'trusted-build' | 'minisearch-json' | 'binary-load'

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

function ownedPostingsLayout(postings: FrozenPostingsLayout): FrozenPostingsLayout {
  const allDocIds = postings.docIdWidth === 16
    ? new Uint16Array(postings.allDocIds)
    : new Uint32Array(postings.allDocIds)
  const allFreqs = postings.allFreqs instanceof Uint8Array
    ? new Uint8Array(postings.allFreqs)
    : new Uint16Array(postings.allFreqs)

  if (postings.layout === 'dense') {
    return {
      ...postings,
      allDocIds,
      allFreqs,
      denseOffsets: new Uint32Array(postings.denseOffsets),
      denseLengths: new Uint32Array(postings.denseLengths),
    }
  }

  const sparseFieldIds = postings.sparseFieldIdWidth === 16
    ? new Uint16Array(postings.sparseFieldIds)
    : new Uint8Array(postings.sparseFieldIds)

  return {
    ...postings,
    allDocIds,
    allFreqs,
    sparseTermStarts: new Uint32Array(postings.sparseTermStarts),
    sparseFieldIds,
    sparseOffsets: new Uint32Array(postings.sparseOffsets),
    sparseLengths: new Uint32Array(postings.sparseLengths),
  }
}

function shallowCopyOptions<T>(options: OptionsWithDefaults<T>): OptionsWithDefaults<T> {
  return {
    ...options,
    fields: [...options.fields],
    searchOptions: { ...options.searchOptions },
    autoSuggestOptions: { ...options.autoSuggestOptions },
  }
}

function shallowCopyJsSnapshotFields<T>(
  params: FrozenAssembleParams<T>,
): Pick<FrozenAssembleParams<T>, 'fieldIds' | 'options' | 'storedFields'> {
  return {
    fieldIds: { ...params.fieldIds },
    options: shallowCopyOptions(params.options),
    storedFields: cloneStoredFields(params.storedFields),
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
  if (mode === 'trusted-build') {
    return params
  }

  if (mode === 'minisearch-json') {
    return { ...params, ...shallowCopyJsSnapshotFields(params) }
  }

  return {
    ...params,
    index: ownedPackedRadixTree(params.index),
    postings: ownedPostingsLayout(params.postings),
    fieldLengthMatrix: ownedFieldLengthMatrix(params.fieldLengthMatrix),
    avgFieldLength: new Float32Array(params.avgFieldLength),
  }
}
