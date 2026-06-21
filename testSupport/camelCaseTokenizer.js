/** CamelCase splitter (Vocs-style) — regression fixture for custom indexing tokenizers. */

export function camelCaseTokenize (text) {
  const tokens = []
  for (const word of text.split(/[\s\-._/:@]+/)) {
    if (!word) continue
    const lower = word.toLowerCase()
    tokens.push(lower)
    const split = word
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length > 0)
    if (split.length > 1) tokens.push(...split)
  }
  return tokens.filter((w) => w.length > 0)
}
