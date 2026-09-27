export function invalidFrozenIndex(detail: string): Error {
  return new Error(`Invalid frozen index: ${detail}`)
}

/** `JSON.parse` for snapshot payloads: malformed text reports as an invalid frozen index. */
export function parseSnapshotJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw invalidFrozenIndex(`${what} is not valid JSON`)
  }
}
