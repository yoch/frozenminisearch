/** Shared packed radix size metrics (no side effects on import). */

export function measureStructuredBytes (tree) {
  const nodeBytes = (
    tree.nodeEdgeOffset.byteLength
    + tree.nodeValue.byteLength
    + tree.nodeLeafOrder.byteLength
  )
  const edgeBytes = (
    tree.edgeLabelStart.byteLength
    + tree.edgeLabelLength.byteLength
    + tree.edgeChild.byteLength
  )
  const labelBytesUtf16Estimate = tree.labelHeap.length * 2

  return {
    nodeBytes,
    edgeBytes,
    labelBytesUtf16Estimate,
    labelCodeUnits: tree.labelHeap.length,
    totalStructuredBytes: nodeBytes + edgeBytes + labelBytesUtf16Estimate,
    packedByteLength: tree.packedByteLength(),
  }
}
