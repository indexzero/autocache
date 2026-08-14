# The mechanism layer

The least obvious cluster and the most load-bearing: the vocabulary that
describes what a cached page *is* without any archival vocabulary at all.

- **Thunk, lazy evaluation, call-by-need** — a suspended computation held in
  place of a value, forced on demand and then memoized. A cache entry is a
  forced thunk with the receipt kept.
- **Memoization** — caching the result of forcing, so the second read
  returns the first read's document. Donald Michie,
  ["Memo Functions and Machine Learning"](https://www.nature.com/articles/218019a0),
  *Nature* 218, 1968.
- **Virtual view vs materialized view** — SQL's distinction between a query
  stored as a definition and a query whose results are stored. A remastered
  root is a materialized view of the archive; staleness is the coherence
  problem.
- **Intension vs extension, type vs token** — the definition of a thing
  versus the things it picks out; the abstract pattern versus its concrete
  occurrences. Frege and Carnap; C. S. Peirce. The URL is the intension,
  the capture is the extension.
- **Referential transparency** — the property that an expression can be
  replaced by its value without changing behavior. Live pages lack it; a
  hermetic mirror restores it by force.
- **Provenance** — the record of what produced an artifact and from what.
  If a page can regenerate on read, provenance is the only thing that makes
  it citable. [W3C PROV](https://www.w3.org/TR/prov-overview/), 2013;
  [SLSA](https://slsa.dev).
