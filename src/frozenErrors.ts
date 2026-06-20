export function invalidFrozenIndex(detail: string): Error {
  return new Error(`Invalid frozen index: ${detail}`)
}
