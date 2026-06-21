import { zlibSync, unzlibSync } from 'fflate'
import type { BinaryBytes } from '../binaryBytes'

export function browserZlibDeflateSync(uncompressed: BinaryBytes): BinaryBytes {
  return zlibSync(uncompressed)
}

export function browserZlibInflateSync(compressed: BinaryBytes): BinaryBytes {
  return unzlibSync(compressed)
}
