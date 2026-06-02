/** Histogram of compressed edge label lengths on a packed tree. */

export function edgeLabelHistogram (tree) {
  const buckets = { '1': 0, '2': 0, '3-4': 0, '5-8': 0, '9+': 0 }
  let sum = 0
  let max = 0
  const n = tree.edgeCount

  for (let ei = 0; ei < n; ei++) {
    const len = tree.edgeLabelLength[ei]
    sum += len
    if (len > max) max = len
    if (len <= 1) buckets['1']++
    else if (len === 2) buckets['2']++
    else if (len <= 4) buckets['3-4']++
    else if (len <= 8) buckets['5-8']++
    else buckets['9+']++
  }

  return {
    edgeCount: n,
    mean: n > 0 ? Number((sum / n).toFixed(3)) : 0,
    max,
    buckets,
  }
}

export function printEdgeLabelHistogram (tree, label) {
  const h = edgeLabelHistogram(tree)
  console.log(`\nEdge label histogram${label ? ` (${label})` : ''}: ${h.edgeCount} edges`)
  console.log(`  mean=${h.mean}  max=${h.max}`)
  for (const [bucket, count] of Object.entries(h.buckets)) {
    const pct = h.edgeCount > 0 ? ((100 * count) / h.edgeCount).toFixed(1) : '0'
    console.log(`  len ${bucket}: ${count} (${pct}%)`)
  }
  return h
}
