# The temporal axis

A URL is not a document. It is a series of states indexed by time. Everything
autocache does — fetch the capture, keep the sidecar, verify the closure —
stands on the shoulders of the people who made time a first-class coordinate.

- **The Wayback Machine** — the public interface to the Internet Archive's
  crawl; retrieval by (URL, datetime). The canonical demonstration that a URL
  is a series, not a document. [web.archive.org](https://web.archive.org/),
  crawling since 1996, public since 2001.
- **Memento** — the HTTP framework that makes time a content-negotiation
  dimension: a Memento is the resource as it existed at time T, a TimeGate
  negotiates datetime, a TimeMap enumerates every known capture. Van de
  Sompel, Nelson, Sanderson, [RFC 7089](https://www.rfc-editor.org/rfc/rfc7089),
  December 2013.
- **Content negotiation and `Vary`** — HTTP's shipping mechanism for one
  resource with many representations, selected by request dimensions.
  [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110).
- **Link rot and content drift** — the two failure modes of citing a URL: the
  target disappears, or it silently changes underneath the citation. Content
  drift is autocache's direct motivation. See
  [temporal databases](https://en.wikipedia.org/wiki/Temporal_database) for
  the valid-time / transaction-time apparatus the archival literature leans on.
- **Event sourcing** — state is not stored; it is the fold of an append-only
  log. The current document is a derivation, not a record. Martin Fowler,
  ["Event Sourcing"](https://martinfowler.com/eaaDev/EventSourcing.html), 2005.
- **CRDTs** — replicas that converge without coordination. Shapiro, Preguiça,
  Baquero, Zawirski, ["Conflict-free Replicated Data Types"](https://inria.hal.science/inria-00555588),
  INRIA RR-7506, 2011.
- **Happens-before** — distributed events admit only a partial order; any
  total order is an arbitrary linearization. Leslie Lamport,
  ["Time, Clocks, and the Ordering of Events in a Distributed System"](https://dl.acm.org/doi/10.1145/359545.359563),
  *CACM* 21(7), 1978.
