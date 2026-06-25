# Postings & binary naming — internal vocabulary

Developer note (not published npm API). Captures naming patterns around postings,
frozen layouts, and MSV5 wire code. **No renames planned** — glossary for future
refactors and onboarding.

## Public surface (`src/index.ts`, `src/browser.ts`)

Consumers import only symbols re-exported from the package entry points. Postings
internals are **not** part of the public API.

| Exported | Role |
|----------|------|
| `FrozenMiniSearch`, `FrozenIndexBuilder`, `buildFrozenFromDocuments`, … | Index lifecycle |
| `OR`, `AND`, `AND_NOT` | Query combination |
| `SearchResult`, `Query`, `Options`, `SearchOptions`, … | Types for search |

Nothing named `*Layout`, `*Flyweight`, `*Wire`, `*Accumulator`, or `*DataLike` is
exported. Users interact with `search()`, `saveBinary*()`, `loadBinary*()` — not
with posting buffers directly.

Bundled `.d.ts` files may declare internal interfaces (e.g. `FrozenPostingsLayout`
on `protected` members) for type-checking the single bundle; they are **not**
listed in the package `export { … }` block and must not be treated as semver API.

## Internal layers (by suffix / pattern)

| Pattern | Phase | Examples | Notes |
|---------|-------|----------|-------|
| `*Accumulator` | Build (mutable) | `IncrementalPostingsAccumulator` | Grows columns; `finalize()` → layout |
| `Growable*` | Build scratch | `GrowableUint32Column`, `GrowableFreqColumn` | Not `Layout`; narrowed at finalize |
| `*Layout` | Frozen snapshot | `FrozenPostingsLayout`, `StoredFieldsLayout` | Immutable columnar shape in RAM |
| `*Flyweight` | Query view | `FrozenFieldTermFlyweight` | One instance per index; `bind` + `get` |
| `Segment*` | Query view | `SegmentPostingList` | Slice into `allDocIds` / `allFreqs`; `rebind` |
| `*Like` | Scoring abstraction | `FieldTermDataLike`, `PostingListLike` | Parity with upstream MiniSearch interfaces |
| `*Wire` | Binary sections | `Msv5PostingsWire`, `buildFieldNamesSectionWire` | Bytes / flags for MSV5 encode-decode |
| `binaryMsv5*` | MSV5 subsystem | `binaryMsv5Postings`, `binaryMsv5Compression` | Node vs `*Browser` variants |

### Pipeline (read order)

```
IncrementalPostingsAccumulator  →  FrozenPostingsLayout  →  FrozenFieldTermFlyweight
        (build)                      (owned snapshot)           (query, via FieldTermDataLike)
                                           ↓
                              buildMsv5PostingsSections  →  Msv5PostingsWire  →  file bytes
```

## Known inconsistencies (cosmetic, deferred)

1. **`Layout` vs `Wire`** — same domain, different lifecycle stage; not obvious without this doc.
2. **`Flyweight` vs `SegmentPostingList`** — flyweight owns a segment; names do not reflect containment.
3. **`Like` vs concrete types** — `Like` is intentional for scoring portability; concrete types are frozen-specific.
4. **Missing `Frozen*` prefix** — e.g. `SegmentPostingList` is frozen-only but reads generic.

Renaming across these layers would be a large diff with no runtime benefit. Prefer
extending this glossary over mass renames unless a file is already being moved.

## MSV5 file naming (§8.4 — no action)

Most MSV5 modules follow `binaryMsv5*`. Exception:

| File | Role | Verdict |
|------|------|---------|
| `compressionBrowser.ts` | Low-level zlib via `CompressionStream` / `DecompressionStream` | Keep; imported by `binaryMsv5CompressionBrowser.ts` |
| `binaryMsv5CompressionBrowser.ts` | MSV5 assemble / load in the browser | Canonical browser entry |

Renaming `compressionBrowser.ts` to `binaryMsv5CompressionBrowser.ts` is **not**
possible (name taken). A cosmetic rename (e.g. `browserZlibStreams.ts`) is optional
and low priority; ignored until an `msv5/` touch justifies it.

## Related notes

- [AND_GATE_PARAMETERS.md](./AND_GATE_PARAMETERS.md) — `DEFAULT_POSTING_GATE_MIN_LENGTH` (replaces deprecated `SEEK_ALLOWED_MIN_LIST_LENGTH`).
- `postingSliceScratch` in `frozenPostings.ts` — module-level scratch; documented threading / reentrancy constraints.
