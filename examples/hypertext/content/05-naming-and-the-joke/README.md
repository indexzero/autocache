# Naming, addressing, and the joke

autocache sits exactly on Karlton's fault line. Serving an archived page is
a cache-coherence problem wearing a costume; addressing it is a naming
problem wearing a costume. The two hard things are not two examples here.
They are the two axes.

- **URI, URL, URN** — identifier, locator, name. The web collapsed the three
  in practice; an archive forces them apart again. The capture has a name,
  its body has a content address, and neither is a location.
  [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986).
- **HTTP caching** — the machinery for deciding whether a stored copy still
  stands for the thing it copied: staleness, TTL, ETag.
  [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111).
- **The two hard things** — "There are only two hard things in Computer
  Science: cache invalidation and naming things." Phil Karlton — CMU, SGI,
  Netscape — who died young, and whose attribution matters. Martin Fowler
  hosts [the canonical citation](https://www.martinfowler.com/bliki/TwoHardThings.html);
  Karlton's son David has
  [confirmed the provenance](https://www.karlton.org/2017/12/naming-things-hard/).
  The off-by-one riff is Leon Bambrick's.
