---
status: "design — model accepted; implementation staged"
scope: "crawl coverage, storage identity, and serve-time policy for multi-representation captures"
audience: "maintainers of waybackify-cli, waybackify-crawl, and waybackify-serve"
related:
  - "CACHE.md"
  - "SERVE.md"
  - "BACKFILL.md"
on_conflict: "CACHE.md governs on-disk layout; SERVE.md governs response semantics; this document governs what the crawl must cover"
---

# The Scene Graph

A model for archiving and replaying web pages that renders differently
depending on who is looking at them.

## Contents

- [Part 1 — Technical design](#part-1--technical-design)
  - [1. Motivation: a URL is not one artifact](#1-motivation-a-url-is-not-one-artifact)
  - [2. Structure: the scene graph](#2-structure-the-scene-graph)
  - [3. Expansion techniques](#3-expansion-techniques)
  - [4. Limitations and ceilings](#4-limitations-and-ceilings)
- [Part 2 — Alternatives to consider](#part-2--alternatives-to-consider)
  - [A. Capability confinement over environment emulation](#a-capability-confinement-over-environment-emulation)
  - [B. Proportionality](#b-proportionality)
  - [C. Completeness rigor](#c-completeness-rigor)
  - [D. Cache-key framing](#d-cache-key-framing)
  - [E. Descriptive fidelity](#e-descriptive-fidelity)

---

# Part 1 — Technical design

## 1. Motivation: a URL is not one artifact

The mirror pipeline treats a capture as a document plus its requisites. It
fetches the archived page, rewrites every reference it can find into the
local `/web/<timestamp><flag>/<original-url>` form, localizes the referenced
bytes into the cache root, and serves the result. The model beneath that
pipeline is a graph whose nodes are URLs.

That model is wrong in a specific, observable way. A URL does not identify
one artifact. It identifies a *family of representations* — the distinct
render products a page yields depending on the client environment it finds
itself in. The environment includes the viewport dimensions, the
device-pixel-ratio, the user-agent class, interaction capabilities such as
`pointer` and `hover`, and user preferences such as `prefers-color-scheme`
and `prefers-reduced-motion`. Media Queries Level 4 and Level 5 define these
as first-class query axes precisely because pages branch on them.

Each representation has its own requisite closure. A stylesheet loads one
background image inside `@media (max-width: 600px)` and a different one
outside it. A `<picture>` element selects among sources by `media` and
`srcset` descriptors. A script reads `matchMedia`, `navigator.userAgent`, or
`window.innerWidth` and fetches different assets — or navigates to a
different document — on each side of the branch.

A crawl that renders a single representation therefore under-captures the
graph. It walks the requisites of *one* family member and never sees the
resources the other members need. When a client later triggers a branch the
crawler never took, the page reaches for a resource that was never captured
and never localized. The reference still points at `web.archive.org`. Under
the mirror's strict Content Security Policy — which, per the Content
Security Policy specification, blocks any fetch to an origin outside the
allow-list — the request dies, and the branch renders broken or blank.

This is not a hypothetical. It is the mirror's dominant standing failure
class: un-localized `web.archive.org` references surfacing on branches the
crawler's fixed desktop environment never exercised — most visibly, mobile
branches. The bug is not in the rewriter as such. The rewriter cannot
localize a reference the crawl never discovered. The bug is in the coverage
model.

The fix is to make the environment part of the model.

## 2. Structure: the scene graph

### The frontier is `[uri, environment]`, not `[uri]`

In the scene-graph model, the crawl frontier is a worklist of tuples:

```
[uri, environment-descriptor]
```

Crawling the same URI under two environments is two units of work. Each unit
produces its own set of discovered references, and each discovered reference
enters the frontier paired with the environment that discovered it.

### The environment descriptor

The environment descriptor is a first-class value with a canonical
serialization, shared verbatim across the crawler, the store's crawl ledger,
and the server. It records:

- **Viewport interval** — not a single width, but the interval between
  breakpoints that this environment represents (see
  [equivalence classes](#bounding-the-matrix-equivalence-classes)).
- **Device-pixel-ratio** — the `resolution` axis.
- **User-agent class** — a small enumeration (e.g. `desktop`, `mobile-era`),
  because era pages branch on coarse UA sniffing, not on exact strings.
- **Discrete capability and preference flags** — but *only the flags the
  page actually reads*: `pointer`, `hover`, `prefers-color-scheme`,
  `prefers-reduced-motion`, `forced-colors`, `scripting`, and so on, per
  Media Queries Levels 4 and 5.

Canonical serialization matters because the descriptor is a key. Two
components that spell the same environment differently would silently fork
the ledger.

### Storage collapses to a union

The scene graph is a **crawl-coverage** concern, not a serve-time-selection
concern. This is the load-bearing simplification of the whole design.

The store does not key captures by environment. It stores, at the document
level, the *union* of every representation's requisites: every image any
`srcset` candidate names, every font any `@font-face` block declares, every
asset any script branch fetches under any enumerated environment. All of
them are localized; all of them are present in the cache root.

Selection then happens where it always happened: in the archived page's own
CSS and JavaScript, at serve time, in the visitor's real browser. A phone
that loads the page evaluates the page's own media queries against its own
real viewport and requests the small image; a desktop requests the large
one. Both are in the store, so both requests resolve locally. The mirror
never needs to decide which representation a visitor should get. It only
needs to ensure that whichever branch fires, the branch's requisites exist.

This is why the union suffices: client-side adaptation is *re-executed* on
every visit by the visitor's engine. The mirror's job is closure, not
selection. (The one genuine exception — server-side content negotiation —
is treated honestly in [§4](#server-side-negotiation).)

### The ledger keeps the descriptor anyway

Although the store unions, the crawl ledger records, for every discovered
requisite, the environment descriptor under which it was discovered. This
costs almost nothing and buys two things:

- **Provenance.** When a served page still breaks, the ledger answers "which
  environments did we actually crawl, and which discovered this reference?"
  — the first question of every coverage investigation.
- **Debuggability of the expansion itself.** If an environment class
  systematically discovers nothing new, the equivalence-class computation
  can be audited against the ledger rather than re-derived from scratch.

## 3. Expansion techniques

Enumerating a page's representations combines a deterministic static pass
with a dynamic observed pass. The static pass is cheap and runs first; the
dynamic pass catches what static analysis provably cannot.

### Declarative extraction (deterministic — do first)

Most adaptation on the archived web is declarative, and declarative
adaptation can be *read*, not guessed.

Parse every stylesheet with a real tokenizer implementing the CSS Syntax
Module — not regular expressions, which fail on comments, strings, escapes,
and the error-recovery rules the module defines. From the parsed sheet,
enumerate:

- every `@media` condition, and within each conditional block, every
  `url()`, `@import`, and `@font-face` `src` — the requisites that branch;
- every `@import` with a media condition of its own;
- the media features each condition queries.

From the parsed HTML (see [parse fidelity](#parse-fidelity)), enumerate the
HTML Standard's responsive-images machinery: `<picture>` with per-`<source>`
`media` and `type` conditions, `srcset` with width and density descriptors,
`sizes`, CSS `image-set()`, and `<link media>`.

The critical observation: **the media features a page's stylesheets query
are the capability axes of that page.** A page whose CSS never mentions
`prefers-color-scheme` has no dark-mode fork to capture. The axes are read
out of the artifact itself. Nothing is enumerated speculatively.

### Bounding the matrix: equivalence classes

A naive cross-product of environments explodes. It does not have to, because
media features fall into two shapes:

- **Ranged features** — `width`, `height`, `resolution`. The page's own
  declared breakpoints partition the axis into intervals, and Media Queries
  Level 4 range semantics guarantee that every value inside an interval
  evaluates every declared condition identically. So sample *one
  representative per interval*. A page with breakpoints at 600px and 1024px
  has exactly three width-classes, regardless of how many devices exist.
- **Discrete features** — `pointer`, `hover`, `prefers-color-scheme`,
  `prefers-reduced-motion`, `forced-colors`, `scripting`. Enumerate only the
  values of only the features the page queries.

The environment matrix is the cross-product of *queried axes only*, with
ranged axes collapsed to their intervals. For real pages this yields a
handful of environments — typically single digits — not a combinatorial
explosion. Axes the page never reads contribute a factor of one.

### Imperative discovery: execute and observe

Script-driven adaptation cannot be extracted statically. A script performs
arbitrary computation over host state — it reads `matchMedia` results,
`navigator.userAgent`, `window.innerWidth`, `devicePixelRatio`, then
branches arbitrarily on the results. Deciding statically which URLs such a
program will fetch is deciding a property of arbitrary programs; it is
undecidable in general and impractical long before that.

So it is not decided. It is *observed*. Each capture is executed under each
enumerated environment with virtualized host objects — `fetch` (and its
elder siblings `XMLHttpRequest` and dynamic `<script>`/`<img>` insertion),
`matchMedia`, `navigator`, `innerWidth`/`innerHeight`, `devicePixelRatio` —
pinned to the environment descriptor's values. Every fetch and navigation
the execution attempts is recorded. That recorded set *is* the
representation's requisite closure, by construction: it is not an
approximation of what the page might load; it is what the page did load.
The web-archiving literature calls resources reachable only through such
post-load execution "deferred representations"; the scene graph makes them
ordinary frontier entries.

One subtlety: even *declarative* conditions need real engine evaluation to
know which fire. Dynamic viewport units (`dvh`, `svh` — CSS Values and
Units), `env()` insets, container queries, and `resolution` all resolve
against live engine state. Static analysis of the stylesheet yields
*candidate* branches; the engine, run under a concrete environment, yields
*verdicts*. The declarative pass proposes the environment matrix; the
execute-and-observe pass confirms what each cell actually pulls.

### Requisites as requests

A requisite is not a URL. It is a *request*: a URL plus the metadata that
determines what response it can elicit and where the response may be used —
mode, credentials mode, destination, and the relevant request headers, as
defined by the WHATWG Fetch Standard. Two references to the same URL with
different destinations (`style` vs `image`) are different edges and can fail
differently under the mirror's policy.

Accordingly:

- URLs are parsed and resolved with the WHATWG URL Standard's algorithm —
  including its non-obvious normalizations — never with ad-hoc string
  handling. A reference the resolver and the server normalize differently is
  a cache miss dressed as a bug.
- The framing and security boundary is the **origin** (scheme, host, port),
  not the hostname, matching both the Fetch Standard's same-origin
  machinery and the CSP specification's source-expression matching. Mirror
  policy decisions keyed on hostname alone will drift from what the
  browser actually enforces.

## 4. Limitations and ceilings

A design document that does not state where its model stops is advertising,
not design. The ceilings below are inherent; the model works within them and
records, rather than hides, what it cannot do.

### The archive ceiling

The mirror can only localize what the upstream archive actually captured.
The archive's own crawler ran under one environment — one UA, one effective
viewport — and a representation's requisites may simply never have been
archived. No crawl of ours, however complete its environment matrix, can
localize a resource that does not exist upstream.

Such requisites need a **serve-time policy**, chosen per class:

1. **Block cleanly** — the reference stays un-localizable; the mirror
   serves a deterministic local failure rather than leaking a request to
   `web.archive.org` that the CSP will kill anyway.
2. **Neutralize the trigger** — where the branch's *condition* can be made
   not to fire (for example, by the environment the serve-time shell
   presents), the page degrades to a representation that *is* complete,
   instead of blanking.
3. **Accept degradation** — serve the incomplete representation and say so.

Whichever policy applies, the gap is recorded as a fact in the ledger:
this URL, this environment, this requisite, absent upstream, this policy.
Honest gaps are part of the archive's record, not an embarrassment to be
smoothed over.

### Server-side negotiation

Everything above assumes client-side adaptation, which the union covers
because the visitor's browser re-runs the selection. There is one case it
does not cover: the same URL returning *different bytes* depending on
request headers — `Vary`-driven negotiation, or Client Hints (viewport
width, DPR) as specified in HTTP Client Hints. Here the divergence happened
on the origin server, at capture time, and no client-side machinery can
re-derive the variant that was not fetched.

In this case — and only in this case — the scene graph genuinely enters the
**store**: the capture key becomes `(url, negotiated-request-headers)` and
distinct variants are distinct entries. The model accommodates this without
strain; it is the frontier tuple made durable.

In practice it is usually moot. The upstream archive typically holds only
the single variant its own crawler's headers elicited. The other variants
hit the archive ceiling before they hit the store.

### Byte-preservation

A capture is never transformed to change its behavior. Editing a capture —
patching a UA-sniff, stubbing a script, "fixing" a broken branch in the
stored bytes — forks history and voids the archive: the mirror could no
longer attest that what it serves is what was captured. When behavior must
change, change the *environment* the capture executes in, or the serve-time
policy around it. The bytes are the record.

This discipline has a practical corollary for the execute-and-observe pass:
the execution sandbox must be **era-tolerant**. A large fraction of the
corpus is pre-strict-mode JavaScript that assumes sloppy-mode semantics,
`document.all`-style legacy globals, and long-deprecated host quirks. A
sandbox that runs only modern code fails to observe most of the archive.
The sandbox meets the corpus where it lived; the corpus is not modernized
to meet the sandbox.

### Encoding as an axis

Character encoding is not plumbing; it determines the representation.
The decoded document is what reference extraction runs over, so a
mis-sniffed charset yields a *different document* — different text,
different attribute values, potentially different extracted URLs. Decoding
follows the WHATWG Encoding Standard and the HTML Standard's
encoding-sniffing algorithm (BOM, `<meta charset>`, transport-layer
declarations, in that spec-defined order), and the stored bytes remain
lossless regardless of what the decode concluded, per the byte-preservation
rule above.

### The adaptation surface is wider than the viewport

Viewport, DPR, and UA class are the axes behind the mirror's known
failures, and they anchor the model. They are not the whole surface:

- **Container queries** (CSS Containment / CSS Conditional work on
  `@container`) adapt to an *ancestor's* size, not the viewport. The
  viewport axis does not subsume them; the same viewport can produce
  different container verdicts.
- **`@supports`** (CSS Conditional Rules) forks on engine feature support —
  an axis of the *engine*, not the device.
- **Writing mode and direction** — RTL and vertical text pull different
  assets (mirrored sprites, direction-specific stylesheets) and re-run
  layout-dependent script branches.
- **`@font-face` `unicode-range`** (CSS Fonts) makes *which font file
  loads* depend on which scripts appear in the content — a requisite forked
  by the document's own text.

The model's frontier tuple and descriptor extend to these axes without
structural change; they are additional discrete or ranged features. Where an
axis is not yet enumerated by the implementation, that deferral is stated in
the descriptor's schema documentation as an explicit exclusion — modeled or
declared deferred, never silently absent.

### Parse fidelity

Reference extraction is exactly as good as the parse that feeds it. The
HTML parse must match the HTML Standard's parsing algorithm — insertion
modes, foster-parenting of misplaced table content, the treatment of
unclosed and misnested tags, and `<base>`-aware URL resolution — because
era pages exercise every one of those recovery paths, and a near-miss parser
extracts a near-miss reference set. The parser and extractor are pinned by
a test suite built from real corpus pathologies, so that fidelity is a
regression-tested property rather than an assumption.

---

# Part 2 — Alternatives to consider

The design in Part 1 is one point in a space. The positions below are
coherent alternative framings, each stated with its rationale, what it
would do differently, and its trade-off against the Part 1 design. They are
recorded so that future revisitations start from the strongest version of
each position rather than from a caricature.

## A. Capability confinement over environment emulation

**Position.** The un-localized-fetch failure is an *authority* problem, not
a coverage problem, and should be made impossible by construction rather
than improbable by enumeration.

**Rationale.** Run each capture inside a hardened isolate or compartment
whose host objects — `fetch`, `matchMedia`, `navigator`, the DOM's
resource-loading surface — are all injected, virtualized values. The
isolate has *no ambient network authority*: there is no path from the
capture's code to the network except through the injected fetch, which
resolves only against the local store. Enumerating representations becomes
injecting different host-object bundles into the same isolate. A leak to
`web.archive.org` cannot occur, because nothing in scope can reach it. On
this view, the mirror's strict CSP is a blunt, allow-list approximation of
what precise capability attenuation does exactly: CSP polices origins after
the fact; confinement removes the authority up front.

**What it would do differently.** Make the isolate the *serving* primitive,
not just the crawl-discovery primitive: pages replay inside the
compartment, and the environment matrix is just the set of host bundles
ever injected.

**Trade-off.** The runtime is heavy — a compartmentalized execution
environment per served page — and it is not a primitive the deployed
serving stack (static store plus edge server plus visitor's own browser)
offers today. Part 1 adopts this position's mechanism where it is cheap
(the virtualized-host execute-and-observe pass *is* a confinement cell) and
declines its serving-side ambition. The position remains the correct answer
if the leak class ever proves un-closable by coverage.

## B. Proportionality

**Position.** The full environment matrix is over-engineering; ship the
declarative union plus a serve-time neutralizer, and stop.

**Rationale.** Most representations of most pages will never be served.
Coverage acquired for representations no visitor requests is a permanent
cost — crawl time, store bytes, ledger complexity — purchased against a
hypothetical. The declarative pass alone (real CSS parse, `srcset`,
`<picture>`) unions the large majority of real-world requisite divergence
at a fraction of the machinery, because era responsive design is
overwhelmingly declarative. For the remainder, a serve-time neutralizer
that degrades un-localizable branches — cleanly, per the archive-ceiling
policies — turns the worst case from "blank page" into "slightly degraded
page", which is an acceptable floor. Furthermore: mobile-era UA-sniffing
redirects are *bugs of their era*, not specifications; reproducing them
faithfully is fidelity to an accident.

**What it would do differently.** Cut the imperative execute-and-observe
pass and the environment matrix; keep declarative extraction, the union
store, and the neutralizer.

**Trade-off.** Some real representations go uncaptured — specifically the
script-selected ones, which are precisely the ones behind the observed
mobile breakage. Part 1 keeps the imperative pass for that reason, but
adopts this position's discipline everywhere else: axes are enumerated only
when queried, the matrix is bounded by equivalence classes, and the
serve-time neutralizer exists regardless, because the archive ceiling makes
it necessary even at full coverage.

## C. Completeness rigor

**Position.** Viewport-plus-UA is a convenient half-truth, and a model
indexed on it alone silently editorializes the archive by omission.

**Rationale.** Adaptation forks on axes the popular framing ignores:
container queries adapt to ancestor geometry; `@supports` forks on engine
capability; writing mode and direction fork assets and layout for a large
fraction of the world's text; `unicode-range` makes font requisites a
function of the content itself. An archive that enumerates only
viewport-shaped representations has quietly decided that the
representations it captures are the ones that matter — an editorial act
disguised as an engineering default. If an axis is out of scope, the model
must *say so*, in the schema, as a recorded deferral; scope decisions made
by silence are not decisions, they are accidents.

**What it would do differently.** Promote the full axis set to first-class
descriptor fields from day one, and treat any unenumerated axis as a
ledger-visible gap on every crawl.

**Trade-off.** Larger scope: more axes to virtualize, a bigger (though
still equivalence-class-bounded) matrix, more descriptor schema to
maintain. Part 1 absorbs this position's core demand — the descriptor
extends structurally to these axes, and deferrals must be explicit — while
phasing the axes behind the ones implicated in observed failures.

## D. Cache-key framing

**Position.** This is an HTTP cache-key problem wearing a rendering
costume. Fix the key, not the rendering.

**Rationale.** The upstream archive keyed captures on `(url, timestamp)`
and discarded the dimension along which responses varied. Everything
downstream — the missing mobile assets, the un-localized references — is
the ordinary consequence of a cache whose key is coarser than its content's
variance, and the ordinary remedy is cache-key expansion, exactly as HTTP
itself does with `Vary` and as HTTP Client Hints formalizes for
device-shaped negotiation. On this view the scene graph is not a new model;
it is the store admitting its real key. The clean consequence: union
*subresources* (their variance is client-side and re-derivable), but keep
request-varying *documents* as distinct store entries keyed on
`(url, negotiated-headers)` — because for those, the variance happened
server-side and nothing client-side can recover it.

**What it would do differently.** Put the negotiated dimension in the store
key for documents from the outset, rather than treating it as a §4 edge
case.

**Trade-off.** Reintroduces per-request document variants into a store
whose identity model (capture-key → content hash, one body per key) is
deliberately simple, and does so for a case the archive ceiling renders
mostly moot — the upstream usually holds one variant anyway. Part 1 adopts
this position's analysis wholesale (its §4 treatment of server-side
negotiation *is* cache-key expansion) but defers the store-key change until
a corpus actually presents multi-variant documents.

## E. Descriptive fidelity

**Position.** An archive preserves what *was* — ugliness, bugs, and dead
ends included. The mirror's job is description, not improvement.

**Rationale.** Every intervention that makes an old page "work better" is
an edit to the historical record. The UA-sniff that shunted phones to a
broken m-dot site is part of what that site *was* in that year; a mirror
that quietly routes around it serves a page that never existed. Where a
branch cannot be reproduced — the archive ceiling — the honest act is to
record the gap as a durable, queryable fact ("this representation existed;
its requisites were not archived; here is what happens instead") rather
than to erase the branch and pretend the family was smaller. Fidelity that
holds only for the flattering cases is curation, not preservation.

**What it would do differently.** Narrow the serve-time policy menu:
prefer "block cleanly and record" over "neutralize the trigger", on the
ground that neutralization is a behavioral edit even when the bytes are
untouched.

**Trade-off.** Served pages reproduce era bugs, including ones that make a
representation unusable, where a neutralized branch would have degraded
gracefully. Part 1 sides with this position on bytes (never transformed)
and on ledger-recorded gaps, but retains trigger-neutralization as an
available policy — applied per class, visibly, and recorded — accepting
that a mirror which serves *readers* must sometimes choose a page that
renders over a bug faithfully reproduced.
