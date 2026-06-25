export type { LeafType, RadixTree } from '../radixTree'
import type { RadixTree } from '../radixTree'

export type Entry<T> = [string, T]

export type Path<T> = [RadixTree<T> | undefined, string][]
