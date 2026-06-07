# Design Document

This design document has the aim to explain the details of `MiniSearch`
design and implementation to library developers that intend to contribute to
this project, or that are simply curious about the internals.

**Latest update: May 29, 2026**

## Goals (and non-goals)

`MiniSearch` is aimed at providing rich full-text search functionalities in a
local setup (e.g. client side, in the browser). It is therefore optimized for:

  1. Small memory footprint of the index data structure
  2. Fast indexing of documents
  3. Versatile and performant search features, to the extent possible while
     meeting goals 1 and 2
  4. Small and simple API surface, on top of which more specific solutions can
     be built by application developers
  5. Possibility to add and remove documents from the index at any time

`MiniSearch` is therefore NOT directly aimed at offering:

  - A solution for use cases requiring large index data structure size
  - Distributed setup where the index resides on multiple nodes and need to be
    kept in sync
  - Turn-key opinionated solutions (e.g. supporting specific locales with custom
    stemmers, stopwords, etc.): `MiniSearch` _enables_ developer to build these
    on top of its core API, but does not provide them out of the box.

For these points listed as non-goals, other solutions exist that should be
preferred to `MiniSearch`. Adapting `MiniSearch` to support those goals would in
fact necessarily go against the primary project goals.


## Technical design

`MiniSearch` is composed of two layers:

  1. A compact and versatile data structure for indexing terms, providing
     lookup by exact match, prefix match, and fuzzy match.
  2. An API layer on top of this data structure, providing the search
     features.

Here follows a description of these two layers.

### Index data structure

The data structure chosen for the index is a [radix
tree](https://en.wikipedia.org/wiki/Radix_tree), which is a prefix tree where
nodes with no siblings are merged with the parent node. The reason for choosing
this data structure follows from the project goals:

  - The radix tree minimizes the memory footprint of the index, because common
    prefixes are stored only once, and nodes are compressed into a single
    multi-character node whenever possible.
  - Radix trees offer fast key lookup, with performance proportional to the key
    length, and fast lookup of subtrees sharing the same key prefix. These
    properties make it possible to offer performant exact match and prefix
    search.
  - On top of a radix tree it is possible to implement lookup of keys that are
    within a certain maximum edit distance from a given key. This search rapidly
    becomes complex as the maximum distance grows, but for practical search
    use-cases the maximum distance is small enough for this algorithm to be
    performant. Other more performant solutions for fuzzy search would require
    more space (e.g. n-gram indexes).

The class implementing the radix tree is called `SearchableMap`, because it
implements the standard JavaScript [`Map`
interface](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map),
adding on top of it some key lookup methods:

  - `SearchableMap.prototype.atPrefix(prefix)`, returning another
    `SearchableMap` representing a mutable view of the original one, containing
    only entries where the keys share the given prefix.
  - `SearchableMap.prototype.fuzzyGet(searchKey, maxEditDistance)`, returning
    all the entries where the key is within the given edit (Levenshtein)
    distance from `searchKey`.

As a trade-off for offering these additional features, `SearchableMap` is
restricted to use only string keys.

The `SearchableMap` data type is part of the public API of `MiniSearch`, exposed
as `MiniSearch.SearchableMap`. Its usefulness is in fact not limited to
providing a data structure for the inverted index, and developers can use it as
a building block for other solutions. When modifying this class, one should
think about it in terms of a generic data structure, that could in principle be
released as a separate library.

### Fuzzy search algorithm

Fuzzy search is performed by calculating the [Levenshtein
distance](https://en.wikipedia.org/wiki/Levenshtein_distance) between the search
term and the keys in the radix tree. The algorithm used is a variation on the
[Wagner-Fischer
algorithm](https://en.wikipedia.org/wiki/Wagner–Fischer_algorithm). This
algorithm constructs a matrix to calculate the edit distance between two terms.
Because the search terms are stored in a radix tree, the same matrix can be
reused for comparisons of child nodes if we do a depth-first traversal of the
tree.

The algorithm to find matching keys within a maximum edit distance from a given
term is the following:

  - Create a matrix with `query length + 1` columns and `query length + edit
    distance + 1` rows. The columns `1..n` correspond to the query characters
    `0..n-1`. The rows `1..m` correspond to the characters `0..m-1` for every
    key in the radix tree that is visited.
  - The first row and and first column is filled with consecutive numbers 0, 1,
    2, 3, ..., up to at least the edit distance. All other entries are set to
    `max distance + 1`.
  - The radix tree is traversed, starting from the root, visiting each node in a
    depth-first traversal and updating the matrix.
  - The matrix is updated according to the [Wagner-Fischer
    algorithm](https://en.wikipedia.org/wiki/Wagner–Fischer_algorithm): the keys
    for every child node are compared with the characters in the query, and the
    edit distance for the current matrix entry is calculated based on the
    positions in the previous column and previous row.
  - Only the diagonal band of `2 * edit distance + 1` needs to be calculated.
  - When the current row of the matrix only contains entries above the maximum
    edit distance, it is guaranteed that any child nodes below the current node
    will not yield any matches and the entire subtree can be skipped.
  - For every leaf node, if the edit distance in the lower right corner is equal
    to or below the maximum edit distance, it is recorded as a match.

Note that this algorithm can get complex if the maximum edit distance is large,
as many paths would be followed. The reason why this algorithm is employed is a
trade-off:

  - For full-text search purposes, the maximum edit distance is small, so the
    algorithm is performant enough.
  - A [Levenshtein
    automaton](https://en.wikipedia.org/wiki/Levenshtein_automaton) is a fast
    alternative for low edit distances (1 or 2), but can get excessively complex
    and memory hungry for edit distances above 3. It is also a much more complex
    algorithm.
  - Trigram indexes require much more space and often yield worse results (a
    trigram index cannot match `votka` to `vodka`).
  - As `MiniSearch` is optimized for local and possibly memory-constrained
    setup, higher computation complexity is traded in exchange for smaller space
    requirement for the index.

### Search API layer

The search API layer offers a small and simple API surface for application
developers. It does not assume that a specific locale is used in the indexed
documents, therefore no stemming nor stop-word filtering is performed, but
instead offers easy options for developers to provide their own implementation.
This heuristic will be followed in future development too: rather than providing
an opinionated solution, the project will offer simple building blocks for
application developers to implement their own solutions.

The inverted index is implemented with `SearchableMap`, and posting lists are
stored as values in the Map. This way, the same data structure provides both the
inverted index and the set of indexed terms. Different document fields are
indexed within the same index, to further save space. The index is therefore
structured as following:

```
term -> field -> document -> term frequency
```

The fields and documents are referenced in the index with a short numeric ID for
performance and to save space.

### Search result scoring

When performing a search, the entries corresponding to the search term are
looked up in the index (optionally searching the index with prefix or fuzzy
search). If the combination of term, field and document is found, then this
indicates that the term was present in this particular document field. But it is
not helpful to return all matching documents in an arbitrary order. We want to
return the results in order of _relevance_.

For every document field matching a term, a relevance score is calculated. It
indicates the quality of the match, with a higher score indicating a better
match. The variables that are used to calculate the score are:
  - The frequency of the term in the document field that is being scored.
  - The total number of documents with matching fields for this term.
  - The total number of indexed documents.
  - The length of this field.
  - The average length of this field for all indexed documents.

The scoring algorithm is based on
[BM25](https://en.wikipedia.org/wiki/Okapi_BM25) (and its derivative BM25+),
which is also used in other popular search engines such as Lucene. BM25 is an
improvement on [TF-IDF](https://en.wikipedia.org/wiki/Tf–idf) and incorporates
the following ideas:
  - If a term is less common, the score should be higher (like TD-IDF).
  - If a term occurs more frequently, the score should be higher (so far this is
    the same as TD-IDF). But the relationship is not linear. If a term occurs
    twice as often, the score is _not_ twice as high.
  - If a document field is shorter, it requires fewer term occurrences to be
    achieve the same relevance as a longer document field. This encodes the idea
    that a term occurring once in, say, a title is more relevant than a word
    occuring once in a long paragraph.

The scores are calculated for every document field matching a query term. The
results are added. To reward documents that match the most terms, the final
score is multiplied by the number of matching terms in the query.

## FrozenMiniSearch

`FrozenMiniSearch` is a read-only variant of the index, added in this fork. Its
existence follows directly from the project goals, and in particular from a
tension within them: goal 5 (adding and removing documents at any time) is what
makes `MiniSearch` mutable, but mutability has a cost that works against goal 1
(small memory footprint). Many real applications build an index once and then
only query it — a search box over a fixed documentation set, a product catalog
shipped to the client, a precomputed index loaded from disk. For those
workloads, paying the price of mutability buys nothing.

`FrozenMiniSearch` is the answer to that workload. It deliberately gives up the
ability to mutate the index (all `add`/`remove`/`discard`/`vacuum` methods throw)
and, in exchange, stores the index in a much more compact and cache-friendly
form. Giving up mutability is not just a footprint optimization: immutability is
what makes the compact representation possible in the first place, because the
data structures never need to grow, shrink, or be rebalanced after construction.

The guiding principle mirrors the rest of the project: rather than reimplement
search, `FrozenMiniSearch` reuses the existing search and scoring logic and only
changes how the index is stored. Search behavior — ranking, fuzzy/prefix
matching, query combinators — is identical to `MiniSearch` by construction.

### Sharing the search layer with MiniSearch

To guarantee that the two index types return the same results, the search API
layer (query parsing, fuzzy/prefix expansion, BM25 scoring, result combination)
was extracted into a shared layer that does not know how postings are stored.
The two storage backends plug into it through two small abstractions:

  - A `QueryIndexView`, which exposes exact/prefix/fuzzy term lookup and
    iteration over active documents. Both backends produce one by wrapping their
    own radix tree.
  - A per-term posting accessor (`FieldTermDataLike` → `PostingListLike`), which
    answers "give me the posting list for this term in this field". The mutable
    index backs it with nested `Map`s; the frozen index backs it with a window
    into flat arrays.

Because the scoring code only ever sees these interfaces, the same code path
serves both index types. This is a deliberate trade-off in favor of correctness
and maintainability: a single scoring implementation cannot drift between the
mutable and frozen variants.

### Index data structure: flat arrays instead of nested maps

This is the core difference from `MiniSearch`. The mutable index stores, at each
radix-tree leaf, a nested structure `field -> document -> term frequency` built
out of JavaScript `Map`s. That layout is excellent for incremental updates — any
posting can be inserted or deleted in (amortized) constant time — but it is
expensive at rest: every `Map` and every entry carries object and pointer
overhead, and the postings for a single term are scattered across the heap,
which is unfriendly to the CPU cache during scoring.

`FrozenMiniSearch` keeps a radix tree for term lookup (exact, prefix, and fuzzy —
see the sections above), but changes how that tree and the postings are stored:

  - **Leaves hold a numeric term index, not a posting structure.** The tree maps
    each term string to a small integer used to index the flat postings.
  - **The term tree is packed in memory.** At runtime and on disk (MSv5 columnar wire),
    frozen indexes use `PackedRadixTree`, an internal module under
    `src/PackedRadixTree/`: typed arrays for nodes and edges, a shared label heap,
    and the same sibling/leaf traversal order as `SearchableMap` so prefix,
    fuzzy, and `autoSuggest` parity are preserved. Mutable `MiniSearch` still uses
    `SearchableMap`; only the frozen path uses the packed representation.
  - **Postings live in flat typed arrays shared by the whole index.** All
    document ids and all term frequencies are concatenated into two global
    arrays, and a side table records, for each `(term, field)` slot, the
    `(offset, length)` window into those arrays.

With this layout a posting list is just a view over a contiguous slice of the
global arrays — no per-list object is allocated to read it. The footprint
shrinks because the per-entry overhead of thousands of small `Map`s is replaced
by a handful of large typed arrays, and scoring becomes a sequential scan over
contiguous memory. This is the same reasoning that motivated the radix tree in
the first place (goal 1), applied to the postings.

The element widths are chosen adaptively to save further space:

  - Document ids use `Uint16` when the index has at most 65535 documents,
    otherwise `Uint32`.
  - Term frequencies use adaptive `Uint8` / `Uint16` (never `Uint32`), chosen
    from the index max after clamping at 65535 on frozen paths. Typical corpora
    stay on one byte per posting; indexes with any `(term, field)` tf > 255 use
    `Uint16` and set `FLAG_FREQ_U16` in MSv5. Values above 65535 are clamped
    (rare; BM25+ is already flat well before that).

### Dense and sparse posting layouts

How the `(term, field)` slots map onto the flat arrays depends on the number of
fields, because the two regimes have very different sparsity:

  - **Single field (dense layout).** There is exactly one slot per term, so a
    plain offset/length table indexed by term is both the smallest and the
    fastest option.
  - **Multiple fields (sparse layout).** A full `term × field` table is mostly
    empty — most terms occur in only one or two fields — so storing every slot
    would waste space. Instead, only non-empty slots are stored, together with a
    field-id column and a per-term range into that column. Looking up a field
    for a term is a short linear scan over its (few, sorted) entries, which beats
    binary search at this size.

The layout is selected automatically from the field count; callers never choose
it.

### Build paths

There are three ways to obtain a frozen index, reflecting three different
starting points:

  1. **`MiniSearch.freeze()`** — convert an existing mutable index. This is the
     path to use when you need the mutable features (incremental `add`,
     `remove`, `discard`) *before* freezing. If documents were discarded, the
     short ids are no longer dense; `freeze()` optionally remaps them to a dense
     range so the frozen index does not carry holes.
  2. **`fromDocuments` / `FrozenIndexBuilder` / `fromAsyncIterable`** — build the
     flat representation directly from documents, without ever constructing the
     intermediate nested-`Map` postings. This is cheaper in both time and peak
     memory for the build-once case, and the async/iterator variants allow
     streaming large corpora. The builder supports `addAll` / `addAllAsync` (chunked,
     non-blocking) like mutable `MiniSearch`; `fromAsyncIterable` accepts optional
     `FrozenIndexBuilderHints` (e.g. `estimatedDocumentCount`) when the final size
     is known upfront.
  3. **`saveBinarySync` / `loadBinarySync` / `loadBinaryAsync`** — persist and restore a frozen index
     to/from disk.

`assembleFrozen` is the low-level entry point shared by all of these; it
validates the assembled parts (posting bounds, matrix sizes, radix leaf indices)
before handing back an instance, so custom pipelines fail fast on malformed
input.

### On-disk format

A frozen index can be serialized to a self-describing binary snapshot. The
design goals for the format are: validate aggressively on load (snapshots may
come from disk or the network and must not be trusted blindly), and mirror the
in-memory typed arrays closely enough that loading is mostly a matter of taking
views over the buffer rather than parsing.

A snapshot begins with a fixed header (magic bytes, version, global flags, and a
per-section catalogue) followed by independently addressable sections: core counts,
field names, external document ids, stored fields, the packed term tree, the
field-length data, and the flat postings. **`termCount` is stored in the 16-byte
core header** (no separate dictionary section; term strings live only in the
term-tree section).

**MSv5** (written by **`saveBinarySync()`**) lives in `src/msv5/`: columnar packed
radix tree (`packedRadixBinaryMsv5.ts`), unified postings wire (dense or sparse via
flags, same semantics as MSv4), adaptive `fieldLengthMatrix` width on disk, and
optional **single-payload zstd** (`node:zlib`): the 12 logical sections are
concatenated (with 4-byte alignment gaps), then compressed as **one** stream for a
better ratio than per-section compression. Raw payload when &lt; 64 B or when zstd does not strictly shrink the payload. The catalogue stores
uncompressed offsets and per-section CRC-32. `loadBinaryAsync()` feeds the zstd payload through Node streams and materializes
**one section at a time** (bounded JS heap).
Snapshots larger than 1 GiB (uncompressed payload) are rejected to avoid oversized allocations.
Each section has a CRC-32 over its uncompressed bytes. The term-tree section uses the
columnar wire in `packedRadixBinaryMsv5.ts`.

On load, the reader verifies section CRCs, monotonic file offsets, posting bounds,
and leaf invariants via `validateFrozenTermIndexLeaves` in `frozenTermIndex.ts`.

**`loadBinarySync()`** reads **MSv5** synchronously. **`loadBinaryAsync()`** is the
memory-bounded streaming path for compressed MSv5. Older `MSv1`–`MSv4` buffers are rejected.
Use **`saveBinarySync()`** / **`saveBinaryAsync()`** and **`loadBinarySync()`** / **`loadBinaryAsync()`** explicitly.

### PackedRadixTree module (internal)

The packed term tree is implemented as a focused module (`src/PackedRadixTree/`)
rather than as part of the public package API. Responsibilities are split as
follows:

  - **`PackedRadixTree`** — in-memory structure and query traversal (exact,
    prefix, fuzzy, `entries`).
  - **`adapters/searchableMap.ts`** — build from a mutable `RadixTree` via
    `fromRadixTree` (numeric leaves or custom `mapLeaf`).
  - **`src/msv5/packedRadixBinaryMsv5.ts`** — MSv5 columnar term-tree section (on-disk wire).
  - **`frozenTermIndex.ts`** — `FrozenTermIndex` type alias and
    `validateFrozenTermIndexLeaves` (frozen-only invariants: leaf count, term-index
    range, array bounds).

`PackedRadixTree` is not re-exported from the package entry point; consumers use
`FrozenMiniSearch` and binary snapshots. The module is structured so it could be
extracted or published separately later without pulling in MiniSearch scoring or
postings code.

### Design limits

These limits are consequences of the design choices above and are worth keeping
in mind when contributing:

  - **Term frequencies cap at 65535** (`Uint16` max; clamp on frozen build). No
    `Uint32` posting-frequency column.
  - **`tokenize` and `processTerm` are not persisted.** Functions cannot be
    serialized safely, so a snapshot only stores data. If you customized these
    functions at build time, you must pass the same ones to `loadBinarySync`/`loadBinaryAsync`,
    otherwise queries will be tokenized differently from the indexed terms.
  - **`fields` is optional on load** (the field names live in the snapshot), but
    if supplied it must match the indexed fields exactly — a mismatch is an
    error, not a silent subset.

### Suggested optimizations (future)

User-facing summary: [README — FrozenMiniSearch optimizations](./README.md#frozenminisearch--optimizations).
