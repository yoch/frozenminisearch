/* eslint-disable no-labels */

export type LeafType = '' & { readonly __tag: unique symbol }

export const LEAF = '' as LeafType

export interface RadixTree<T> extends Map<string, T | RadixTree<T>> {
  // Distinguish between an empty string indicating a leaf node and a non-empty
  // string indicating a subtree. Overriding these types avoids a lot of type
  // assertions elsewhere in the code. It is not 100% foolproof because callers
  // can still pass a blank string disguised as `string`.
  get(key: LeafType): T | undefined
  get(key: string): RadixTree<T> | undefined

  set(key: LeafType, value: T): this
  set(key: string, value: RadixTree<T>): this
}

export type RadixTreeShape = Array<[string, number | RadixTreeShape]>

export function createRadixPath<T>(node: RadixTree<T>, key: string): RadixTree<T> {
  const keyLength = key.length

  outer: for (let pos = 0; node && pos < keyLength;) {
    for (const k of node.keys()) {
      if (k !== LEAF && key[pos] === k[0]) {
        const len = Math.min(keyLength - pos, k.length)

        let offset = 1
        while (offset < len && key[pos + offset] === k[offset]) ++offset

        const child = node.get(k)!
        if (offset === k.length) {
          node = child
        } else {
          const intermediate = new Map() as RadixTree<T>
          intermediate.set(k.slice(offset), child)
          node.set(key.slice(pos, pos + offset), intermediate)
          node.delete(k)
          node = intermediate
        }

        pos += offset
        continue outer
      }
    }

    const child = new Map() as RadixTree<T>
    node.set(key.slice(pos), child)
    return child
  }

  return node
}

export function lookupRadixNode<T>(tree: RadixTree<T>, key: string): RadixTree<T> | undefined {
  if (key.length === 0 || tree == null) return tree

  for (const k of tree.keys()) {
    if (k !== LEAF && key.startsWith(k)) {
      return lookupRadixNode(tree.get(k)!, key.slice(k.length))
    }
  }
}

export function setRadixLeaf<T>(tree: RadixTree<T>, key: string, value: T): void {
  createRadixPath(tree, key).set(LEAF, value)
}

export function validateRadixLeaves(
  tree: RadixTree<number>,
  termCount: number,
  fail: (detail: string) => never,
): void {
  const seen = new Set<number>()

  function visit(node: RadixTree<number>): void {
    for (const [key, val] of node) {
      if (key === LEAF) {
        const idx = val as number
        if (!Number.isInteger(idx) || idx < 0 || idx >= termCount) {
          fail(`term tree leaf index out of range: ${idx}`)
        }
        if (seen.has(idx)) {
          fail(`term tree duplicate leaf index: ${idx}`)
        }
        seen.add(idx)
      } else {
        visit(val as RadixTree<number>)
      }
    }
  }

  visit(tree)
  if (seen.size !== termCount) {
    fail(`term tree leaf count ${seen.size} !== termCount ${termCount}`)
  }
}

export function deserializeRadixTreeShape(shape: RadixTreeShape): RadixTree<number> {
  const tree = new Map() as RadixTree<number>
  for (const [key, value] of shape) {
    if (key === LEAF) {
      tree.set(LEAF, value as number)
    } else {
      tree.set(key, deserializeRadixTreeShape(value as RadixTreeShape))
    }
  }
  return tree
}
