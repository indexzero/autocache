---
status: "research — survey of prior art; no design decisions made here"
scope: "prior art from other web crawlers and archivers on the problems SCENE.GRAPH.md models"
audience: "maintainers of waybackify-cli, waybackify-crawl, and waybackify-serve"
related:
  - "SCENE.GRAPH.md"
sources: "every URL cited below was located and verified via live web search/fetch on 2026-08-07; claims that could not be verified are marked explicitly"
on_conflict: "SCENE.GRAPH.md governs the design; this document only reports what others have done"
---

# Crawlers and Archivers: Prior Art for the Scene Graph

[SCENE.GRAPH.md](./SCENE.GRAPH.md) models a URL as a family of
representations indexed by client environment, and argues that a
single-environment crawl under-captures the requisite closure — so branches
the crawler never took later reach for resources that were never localized,
and die under the mirror's strict CSP.

None of these problems is new. The web-archiving community — the Internet
Archive, the Webrecorder ecosystem, the academic Web Science and Digital
Libraries group at Old Dominion University, and a long tail of independent
tools — has been fighting each of them, under different names, for over a
decade. The scene graph's "deferred representations" citation is not a
courtesy: it is the literature's exact term for the imperative half of the
model, coined by the researchers surveyed below.

This document maps each project against the seven sub-problems the design
raises:

1. **Crawl fidelity** — non-rendering fetch vs real-browser rendering
2. **Deferred / JS-driven representations** — execute-and-observe vs miss
3. **Responsive / viewport / device axes** — multiple environments or one
4. **CSP and client-side rewriting at replay** — the live-leak problem
5. **Requisite / closure discovery** — how embedded resources are found
6. **Content negotiation** — `Vary`, cookies, Client Hints
7. **Byte-preservation and formats** — WARC/WACZ, transform-or-not

---

## 1. The academic spine: ODU WS-DL and "deferred representations"

The Web Science and Digital Libraries group at Old Dominion University
(Michael L. Nelson, Michele C. Weigle, and their students — Justin F.
Brunelle, Mat Kelly, Sawood Alam, John Berlin) produced the research line
closest to the whole scene-graph design. Read in order, it is nearly a
history of the design's motivation.

**The live-leak observation (2012).** Brunelle's blog post
["Zombies in the Archives"](https://ws-dl.blogspot.com/2012/10/2012-10-10-zombies-in-archives.html)
is the first documented account of the failure class SCENE.GRAPH.md calls
its dominant standing failure: archived pages whose JavaScript-held URIs
were never rewritten, so the replayed page "reaches out" from the archive
to the live web. The community's term for these is *zombie resources*.

**Naming the problem (2015–2016).** The journal paper
["The impact of JavaScript on archivability"](https://link.springer.com/article/10.1007/s00799-015-0140-8)
(Brunelle, Kelly, Weigle, Nelson — *IJDL* 17(2), 2016, DOI
10.1007/s00799-015-0140-8) measures how Ajax-loaded resources make mementos
incomplete and pull content from the live web. Its companion,
["Not all mementos are created equal: measuring the impact of missing resources"](https://link.springer.com/article/10.1007/s00799-015-0150-6)
(*IJDL* 16, 2015, DOI 10.1007/s00799-015-0150-6), shows that *which*
requisites are missing matters more than how many — users' perception of
damage is so uneven that raw missing-resource counts are a worse estimator
than random — and proposes a damage rating. This is the literature's
version of the design's insistence that gaps be recorded and classified,
not merely counted.

**Deferred representations (2015).** The iPRES 2015 paper
["Archiving Deferred Representations Using a Two-Tiered Crawling Approach"](https://arxiv.org/abs/1508.02315)
(arXiv:1508.02315) defines *deferred representations* — representations
whose embedded resources are loaded by client-side script after the initial
page load — and quantifies the fidelity/throughput trade: Heritrix crawled
12.15× faster than headless PhantomJS, but PhantomJS discovered 1.75× more
URIs. Their remedy is a classifier that predicts whether a page is
deferred and sends only those to the browser tier — a direct precedent for
the scene graph's "static pass first, execute-and-observe only where
needed" staging. Brunelle's dissertation,
["Scripts in a Frame: A Framework for Archiving Deferred Representations"](https://digitalcommons.odu.edu/computerscience_etds/10/),
consolidates the line.

**Interaction as a state graph (2016).** ["Adapting the Hypercube Model to
Archive Deferred Representations and Their
Descendants"](https://arxiv.org/abs/1601.05142) (arXiv:1601.05142) goes one
step past the scene graph: it crawls *descendant states* reachable only
through client-side events (70.9% via `onclick`), averaging 38.5
descendants per seed and adding 15.6× more embedded resources to the
frontier than Heritrix — at 38.9× slower. The environment axes are
interaction events rather than viewport/DPR/UA, but the structure is the
same: the frontier is `[uri, state]`, not `[uri]`. This is the closest
published analogue to the scene graph's frontier tuple.

**Replay-side failure case studies.** John Berlin's
["CNN.com has been unarchivable since November 1st, 2016"](https://ws-dl.blogspot.com/2017/01/2017-01-20-cnncom-has-been-unarchivable.html)
documents a page that was *captured* fine but unreplayable for years — the
failure was in replay (a `document.domain` assignment illegal under the
replay origin), not capture. The follow-up JCDL 2023 paper
["Right HTML, Wrong JSON: Challenges in Replaying Archived Webpages Built with Client-Side Rendering"](https://arxiv.org/abs/2305.01071)
(Weigle, Nelson, Alam, Graham — arXiv:2305.01071, also
[IEEE Xplore](https://ieeexplore.ieee.org/abstract/document/10265913))
finds ~15,000 CNN mementos whose HTML shell and JSON data were captured
more than two days apart — *temporal* incoherence between a document and
its requisites, invisible in the page itself. The scene graph's ledger
provenance is the right shape of answer to exactly this class of
undetectable mismatch.

**Client-side rewriting research.** Alam, Kelly, Weigle, and Nelson's JCDL
2017 paper
["Client-Side Reconstruction of Composite Mementos Using ServiceWorker"](https://doi.org/10.1109/JCDL.2017.7991579)
intercepts requests in a ServiceWorker and *reroutes* rather than rewrites,
preventing live-web leakage without touching the stored bytes; the
implementation is
[Reconstructive](https://oduwsdl.github.io/Reconstructive/). The
transformation-taxonomy paper
["To Re-experience the Web"](https://dl.acm.org/doi/10.1145/3589206)
(Kelly et al., *ACM TWEB* 2023;
[preprint](https://matkelly.com/papers/2023_tweb_preprint.pdf)) measures
that a generated client-side rewriter reduced requests blocked by the
Wayback Machine's CSP for 577 mementos by 87.5% and made previously
unreplayable mementos replayable — the most direct published quantification
of the CSP-kills-unrewritten-references problem the scene graph starts
from.

**Mapping to the sub-problems:** (1)–(2) origin of the fidelity/deferred
framing; (3) *not* covered — the axes studied are script and interaction,
not viewport/device (see §9); (4) the zombie/CSP/rewriting literature; (5)
measured empirically per tool; (6) see the cookie/language work in §7; (7)
their tools consume and produce standard WARC.

---

## 2. Internet Archive: Heritrix, Brozzler, Save Page Now, Wayback replay

### Heritrix — the non-rendering baseline

[Heritrix](https://github.com/internetarchive/heritrix3) is the IA's
archival-quality crawler: fetch, parse, extract, enqueue — no rendering,
no JS execution. Its own wiki page
["Unresolved Javascript Extraction Issues"](https://github.com/internetarchive/heritrix3/wiki/Unresolved-Javascript-Extraction-Issues)
concedes the consequence: the `ExtractorJS` heuristic both misses links
that are not hard-coded strings and extracts strings that were never URLs,
"often resulting in 404s noticed by webmasters." Speculative string-mining
is the alternative the scene graph's execute-and-observe pass exists to
avoid.

The single best artifact for the responsive-images gap is
[heritrix3#177 — "heritrix doesn't scrape rewrite srcset urls correctly"](https://github.com/internetarchive/heritrix3/issues/177)
(opened Feb 2017, now closed; no linked fix visible on the issue). A
webcomic archived via Heritrix had only its `src` URL captured and
rewritten; every `srcset` candidate still pointed at the origin server, so
the archived page loaded images from the live (HTTP) site and broke under
the Wayback Machine's HTTPS. That is the scene graph's motivating bug,
observed in the flagship community crawler, nine years ago: **declarative
responsive machinery names requisites a single-representation crawl never
collects.** Whether current Heritrix extracts all `srcset` candidates
could not be verified from the issue alone — treat as unverified.

A second Heritrix artifact matters for §7:
[heritrix3#202 — "Long-lived cookies might have unintended consequences on a crawling session"](https://github.com/internetarchive/heritrix3/issues/202),
filed out of the WS-DL Twitter-language investigation (§7).

### Brozzler — the IA's answer to fidelity

[Brozzler](https://github.com/internetarchive/brozzler) ("browser" +
"crawler", successor to Umbra) drives real Chrome/Chromium via the DevTools
protocol, runs a JavaScript *behavior* on each page (scrolling,
interaction), extracts outlinks from the rendered DOM, and records **all
browser traffic** through the
[warcprox](https://github.com/internetarchive/warcprox) MITM proxy into
WARC. Archive-It's
["The stack: High fidelity web collecting at scale with Brozzler"](https://archive-it.org/blog/the-stack-brozzler/)
describes the design goal as "automating the experience of a person at a
web browser." Note the architectural point: capture-by-proxy means the
requisite closure is *whatever the browser actually requested* — Brozzler
observes rather than extracts, exactly the execute-and-observe posture,
but only for the one environment the browser presents. There is no
environment matrix; one crawl is one viewport, one UA.
[LWN's 2018 survey "Archiving web sites"](https://lwn.net/Articles/766672/)
records the cost argument: browser-based crawling is so much more expensive
that it displaced Heritrix only for targeted, not wide, crawls — the same
proportionality trade SCENE.GRAPH.md Part 2-B wrestles with.

### Save Page Now 2

The Wayback Machine's on-demand capture was rewritten on Brozzler: the IA's
announcement
["The Wayback Machine's Save Page Now is New and Improved"](https://blog.archive.org/2019/10/23/the-wayback-machines-save-page-now-is-new-and-improved/)
says SPN2 "is capable of running web page JavaScript when saving a URL,
allowing the original to be replayed more faithfully," and adds outlink
capture and screenshots. The
[SPN2 public API docs](https://archive.org/details/spn-2-public-api-page-docs)
are archived on archive.org. Again: one environment per capture.

### Wayback replay, CSP, and the CDX index

The Wayback Machine's replay stack is where the CSP prior art lives. The
University of Washington security paper
["Rewriting History: Manipulating the Archived Web from the Present"](https://homes.cs.washington.edu/~franzi/pdf/Lerner-RewritingHistory-CCS17.pdf)
(Lerner, Kohno, Roesner — CCS 2017;
[project announcement](https://seclab.cs.washington.edu/2017/10/30/rewriting-history-manipulating-the-archived-web-from-the-present))
weaponized exactly the un-rewritten-reference leak: archived pages that
fetch from the live web can be made to show attacker-controlled present-day
content inside a historical snapshot. Per the project page, the Internet
Archive responded by deploying **Content-Security-Policy headers that
"instruct client browsers not to load content from outside the
Archive"** and a timestamp-provenance view for subresources. DSHR's
commentary
["Attacking (Users Of) The Wayback Machine"](https://blog.dshr.org/2017/09/attacking-users-of-wayback-machine.html)
gives the preservation-community view. So the mirror's strict CSP has a
direct ancestor: the Wayback Machine itself adopted CSP as the blunt
backstop for incomplete rewriting — which is precisely the role
SCENE.GRAPH.md assigns it, and precisely why coverage (not rewriting) is
the residual problem.

The CDX index keys captures on canonicalized-URL + timestamp only; no
environment, no negotiated headers. The consequences are documented in §7.
["Impact of URI Canonicalization on Memento Count"](https://arxiv.org/pdf/1703.03302)
(Alam et al.) shows even the *canonicalization* dimension changes what an
archive appears to hold — supporting the design's insistence on
spec-exact URL normalization shared across components.

**Mapping:** (1) both poles in one institution — Heritrix (no rendering)
and Brozzler/SPN2 (full rendering); (2) Brozzler observes deferred loads
for one environment; (3) no environment matrix anywhere in the IA stack —
no artifact was found of Wayback crawling desktop + mobile variants of the
same URL deliberately; (4) server-side rewriting + CSP backstop, adopted
after CCS 2017; (5) Heritrix extracts (speculatively, per its own wiki);
Brozzler observes via proxy; (6) CDX key has no negotiation dimension —
the known language/cookie failures follow; (7) WARC (ISO 28500) throughout,
raw bytes stored, rewriting done at replay time — the same
"bytes are the record, transform at serve" discipline as SCENE.GRAPH.md.

---

## 3. Webrecorder: pywb, wombat, Browsertrix, WACZ

The Webrecorder ecosystem (Ilya Kreymer) is the modern high-fidelity
lineage and the richest single source of prior art for the scene graph's
*union-of-requisites* store. Its
[developer tools catalog](https://webrecorder.net/developer-tools/) is the
front door to the whole set of de-facto standards — pywb, Browsertrix
Crawler and Behaviors, WARCIO, wabac.js, wombat, WARCIT/HAR2WARC, and the
WACZ/CDXJ specs — and is the single page to hand a newcomer to this
problem space.

### pywb + wombat.js — the rewriting benchmark

[pywb](https://github.com/webrecorder/pywb) rewrites HTML/CSS/headers
server-side and delegates JavaScript to
[wombat.js](https://github.com/webrecorder/wombat), which overrides the
browser's own APIs — `fetch`, XHR, `window.location`, DOM insertion — so
dynamically constructed URLs resolve into the archive at runtime
([rewriter documentation](https://pywb.readthedocs.io/en/latest/manual/rewriter.html)).
Wombat is the "virtualized host objects" idea deployed in production for a
decade, with a caveat the scene graph should note: wombat virtualizes to
*redirect authority* (all fetches go to the archive), not to *emulate
environment* (it does not lie about `innerWidth` or `matchMedia`). The
scene graph's execute-and-observe sandbox is wombat's mechanism pointed at
a different goal.

### The auto-fetch worker — union-of-requisites in production

The strongest single piece of prior art for the design's "storage collapses
to a union" claim: pywb's **auto-fetch system**
([configuration docs](https://pywb.readthedocs.io/en/latest/manual/configuring.html),
`enable_auto_fetch: true`), implemented as `autoFetchWorker.js` inside
wombat. During recording it detects and background-fetches "resources that
browsers don't normally load": **every URL in `img srcset`**, **every URL
inside CSS `@media` rules**, and `<picture>/<source>` candidates — "all
the resources... may be needed for future replay." The
[pywb changelog](https://github.com/webrecorder/pywb/blob/main/CHANGES.rst)
tracks its evolution (`picture > source[srcset]` extraction, relative
srcset resolution #415, media auto-fetch #427). Also on the replay side,
[pywb PR #269](https://github.com/ikreymer/pywb/pull/269) fixed `srcset`
*rewriting* (comma/whitespace splitting), showing the same machinery
biting at both capture and replay.

This is exactly the scene graph's declarative pass: read the responsive
machinery out of the artifact and fetch every branch's requisites into one
store, letting the visitor's browser re-select at replay. What pywb's
auto-fetch does **not** do is (a) parse CSS with a real tokenizer and
enumerate media-feature axes, (b) handle the imperative side under multiple
environments, or (c) record which environment discovered what. It is the
union store without the environment ledger or the matrix.

### Browsertrix Crawler + behaviors

[Browsertrix Crawler](https://github.com/webrecorder/browsertrix-crawler)
is the containerized browser-based crawler;
[browsertrix-behaviors](https://github.com/webrecorder/browsertrix-behaviors)
is its injected behavior system. Per the
[behaviors docs](https://crawler.docs.browsertrix.com/user-guide/behaviors/),
the defaults are `autoscroll,autoplay,autofetch,siteSpecific`: **autofetch**
(the same srcset/`@media`/`data-*`/lazy-load union-fetching as pywb's
worker, in-crawler), **autoscroll** (trigger scroll-driven lazy loads —
deferred representations by another name), and per-site behaviors.
[Issue #321](https://github.com/webrecorder/browsertrix-crawler/issues/321)
records resources going uncaptured when a page wasn't autoscrolled — an
everyday deferred-representation bug report.

On the environment axes, per the
[CLI options](https://crawler.docs.browsertrix.com/user-guide/cli-options/):
`--mobileDevice` (Puppeteer device descriptors), `--windowSize` (default
1360×1020), `--userAgent`, `--lang`. So the knobs exist — **but one crawl
runs one environment**. No option crawls the same page under several
devices; no artifact was found proposing an environment matrix (see §9 for
what was searched). The UK Web Archive's issue "Replace with
browsertrix-crawler" (ukwa/webrender-api#9, opened 2020-12-04; the repo
has since been deleted as UKWA moved onto the Webrecorder stack — the
issue survives in the
[Wayback Machine](https://web.archive.org/web/20220404010247/https://github.com/ukwa/webrender-api/issues/9))
lists "Viewport configuration" among required features — Kreymer replies
"Not yet supported, but would be easy to add as extra config options" —
and, under "Additional things we don't have yet but would like," asks for
"Patch mode, including device switching option." Evidence the need is
felt in national-library practice, and that it remained an ask rather
than a feature. The older
[Webrecorder Desktop](https://github.com/webrecorder/webrecorder-desktop)
shipped "an experimental mobile device emulation mode... act as a mobile
browser and allow for capturing of mobile only content" — the gap
acknowledged as early as 2019, addressed by manual re-capture per device.

### Replay: wabac.js, ReplayWeb.page, WACZ

[ReplayWeb.page](https://github.com/webrecorder/replayweb.page) replays
archives entirely client-side via a ServiceWorker (wabac.js) that
intercepts every request from the replayed page and serves it from the
archive — the lineage runs from Alam's JCDL 2017 ServiceWorker paper
through Rhizome's
[wabac.js announcement](https://blog.conifer.rhizome.org/2019/10/03/client-side-replay.html).
Interception-at-the-boundary makes the un-rewritten-reference leak
structurally harder, the same instinct as SCENE.GRAPH.md Part 2-A's
capability confinement.

The [WACZ spec](https://specs.webrecorder.net/wacz/1.1.1/)
([repo](https://github.com/webrecorder/specs),
[LoC format entry](https://www.loc.gov/preservation/digital/formats/fdd/fdd000586.shtml))
packages raw WARC + CDXJ index + metadata in ZIP for range-request random
access, with optional
[cryptographic signing](https://specs.webrecorder.net/wacz-auth/0.1.0/) for
provenance. Byte-preservation with attestation — the design's "the bytes
are the record," formalized.

### oldweb.today — the environment as a first-class replay axis

[oldweb.today](https://webrecorder.net/blog/2020-12-23-new-oldweb-today/)
(Kreymer + Dragan Espenschied /
[Rhizome, 2016 technical account](https://blog.dshr.org/2016/01/guest-post-ilya-kreymer-on-oldwebtoday.html))
replays archives through *emulated period browsers* — originally
Docker-hosted, since 2020 in-browser via WebAssembly — with no content
transformation at all. It is the strongest existing statement that **the
environment is part of the artifact**: the same mementos render differently
in Netscape 3 than in modern Chrome, and fidelity requires reproducing the
engine, not editing the bytes. The scene graph's environment descriptor is
this idea moved from replay-time (choose an old browser) to crawl-time
(enumerate the environments the page branches on).

**Mapping:** (1) full browser rendering; (2) behaviors + autoscroll +
site-specific scripts = operationalized deferred-representation capture;
(3) per-crawl device/viewport/UA/lang knobs, union auto-fetch for the
declarative subset, but no multi-environment matrix and no
environment-tagged provenance; (4) wombat + ServiceWorker interception +
CSP — the most sophisticated replay-side answer extant; (5) observed via
browser network capture, plus auto-fetch for branches not taken; (6) not
keyed — pywb replay negotiates only on datetime (see §7); (7) WARC/WACZ,
raw bytes, signing.

---

## 4. Common Crawl — the deliberate non-answer

Common Crawl's CCBot is an
[Apache Nutch-based crawler](https://commoncrawl.org/ccbot) (the
foundation maintains a
[Nutch fork](https://github.com/orgs/commoncrawl/repositories)); its
[FAQ](https://commoncrawl.org/faq) states plainly: "Currently, JavaScript
is not executed and Cookies are not used." One fetch, one UA, no rendering,
~3 billion pages per crawl, published as WARC plus derived
[WAT (metadata/links) and WET (extracted text)](https://skeptric.com/notebooks/WAT%20WET%20WARC%20-%20Common%20Crawl%20Archives.html).

Common Crawl is prior art by *contrast*: at corpus scale, rendering is
economically off the table, so the entire deferred/responsive problem is
accepted as loss. Its corpus is what the WS-DL hypercube paper used as a
baseline to measure that loss.

The mailing list confirms the loss is felt but not contested: in the
Common Crawl Google Group thread
["Incomplete crawl of a specific website?"](https://groups.google.com/g/common-crawl/c/XjLb_K0r5gI)
a user asks why the JS-heavy Drupal site jpl.nasa.gov shows a tiny
fraction of its pages in the index — noting they had needed headless
Chrome to crawl it usefully elsewhere — and a Common Crawl maintainer's
answer attributes the gap to per-domain sampling limits, without engaging
the rendering question. No thread was located in which adding rendering to
CCBot is actually debated; the FAQ statement remains the primary artifact
for the policy.

**Mapping:** (1) non-rendering by policy; (2)–(3) not attempted; (4) n/a
(no replay product); (5) parse-and-extract only; (6) no cookies, single
Accept posture; (7) WARC raw + explicitly *transformed* derivatives (WAT/
WET) — an interesting precedent for keeping raw bytes and derived
artifacts as separate, clearly-labeled layers.

---

## 5. archive.today — the single-representation extreme

Per the [ArchiveTeam wiki](https://wiki.archiveteam.org/index.php/Archive.today)
and [Bellingcat's toolkit entry](https://bellingcat.gitbook.io/toolkit/more/all-tools/archive.today),
archive.today captures with a rendering browser, then **flattens**: CSS is
converted to inline styles, "removing responsive web design and selectors
such as `:hover` and `:active`"; JS-generated content is frozen; the page
is rendered at a fixed 1,024px viewport; output is a static snapshot plus
a screenshot, not WARC.

This is the scene graph's counter-model, executed consistently: collapse
the family to exactly one representation, chosen by the archiver's fixed
environment, and destroy the adaptation machinery so no branch can ever
fire. It trades the entire representation family for replay that cannot
break. Every property SCENE.GRAPH.md wants — environment coverage, byte
preservation, re-executed client-side selection — is deliberately absent;
in exchange, nothing leaks and nothing blanks. Worth citing as the honest
floor of the design space (and as what "neutralize the trigger" looks like
when applied globally instead of per-gap).

**Mapping:** (1) rendered; (2) frozen at snapshot time; (3) exactly one
viewport, by design; (4) moot — no live references survive flattening; (5)
whatever the render loaded; (6) no; (7) explicitly transformative — the
anti-WARC.

---

## 6. Single-file capture: SingleFile, monolith, wget -p

The classical statement of requisite closure is
[GNU wget's `--page-requisites`](https://www.gnu.org/software/wget/manual/)
— "download all the files that are necessary to properly display a given
HTML page" — with the manual-acknowledged limitation that wget executes no
JavaScript, so the closure is the static one only.

[SingleFile](https://github.com/gildas-lormeau/singlefile) (browser
extension + CLI) saves the *rendered DOM* — the representation the user's
actual browser produced, one environment, high fidelity by construction.
[monolith](https://github.com/Y2Z/monolith) (Rust CLI) inlines all assets
as data URLs into one HTML document; it "does not execute JavaScript" and
documents piping headless Chromium's `--dump-dom` through it as the
workaround. Both collapse the family to one member, like archive.today but
personal-scale. Their inline-everything approach is also a data point for
the storage question: they solve the leak problem by making external
references impossible, at the cost of byte-preservation (the stored
artifact is a transformation, not the capture).

**Mapping:** (1) SingleFile rendered / monolith raw; (2) SingleFile
captures post-JS DOM state, monolith misses it; (3) one environment — the
capturing browser's; (4) moot by inlining; (5) DOM walk / static parse;
(6) no; (7) transformative single-file formats, not WARC.

---

## 7. Content negotiation: Memento, Vary, cookies, and the missing key

The Memento protocol
([RFC 7089](https://www.rfc-editor.org/rfc/rfc7089.html)) is content
negotiation *in the datetime dimension* — `Accept-Datetime` against a
TimeGate, advertised via `Vary: accept-datetime`. It is the proof that the
archiving world already models one axis of the scene graph's frontier
tuple as first-class negotiation; SCENE.GRAPH.md §4's
`(url, negotiated-request-headers)` key is Memento's move applied to the
remaining axes. The
["Uniform Access to Raw Mementos" proposals](https://mementoweb.org/rfc-extensions/raw-memento/)
extend negotiation further (via `Prefer`) to select *transformed vs raw*
captures — negotiation over representation policy, not just time. DSHR's
["Content negotiation and Memento"](https://blog.dshr.org/2016/08/content-negotiation-and-memento.html)
discusses the design space.

The failure evidence for ignoring negotiation is the WS-DL Twitter-language
line: ["Cookies Are Why Your Archived Twitter Page Is Not in English"](https://ws-dl.blogspot.com/2018/03/2018-03-21-cookies-are-why-your.html)
(Alam & Vargas, 2018) found only 53% of 9,000+ @BarackObama mementos in
English — 22% in Kannada — because crawler cookie state selected the
variant, Twitter sent no `Vary`, and the CDX key `(canonical-url,
timestamp)` collapsed all variants into one slot. The follow-up
["Cookie Violations Cause Archived Twitter Pages to Simultaneously Replay in Multiple Languages"](https://ws-dl.blogspot.com/2019/03/2019-03-18-cookie-violations-cause.html)
states the general principle: replay of a stateful, negotiated resource
from a store keyed without the negotiation dimension is *lossy*, and
"popular replay systems like OpenWayback and PyWB do not perform content
negotiation other than the Accept-Datetime header." This is the strongest
external validation of SCENE.GRAPH.md's cache-key analysis (Part 2-D):
the store's key really was coarser than the content's variance, and real
archives measurably serve the wrong family member because of it.

**On Client Hints specifically: no prior art found.** No paper, issue, or
thread was located in which any archive crawls or keys on `Sec-CH-*` /
viewport-width client hints. This appears to be genuinely unexplored
territory (unverified absence — but multiple searches found nothing).

---

## 8. Others worth knowing

- **[Squidwarc](https://github.com/N0taN3rd/Squidwarc)** (John Berlin, of
  the CNN post) — "high fidelity, user scriptable, archival crawler" on
  headless Chrome; its README frames itself explicitly as the answer to
  Heritrix's "no JavaScript execution." The user-script hook is a
  small-scale ancestor of Browsertrix behaviors.
- **[Conifer](https://blog.conifer.rhizome.org/2019/10/03/client-side-replay.html)**
  (Rhizome, formerly Webrecorder.io) — human-driven capture: a person
  browses, the session is recorded. The human *is* the behavior engine and
  the environment selector; coverage equals wherever the operator clicked
  at whatever window size they had.
- **[WARC / ISO 28500](https://iipc.github.io/warc-specifications/)** — the
  IIPC-maintained spec hub ([repo](https://github.com/iipc/warc-specifications));
  the IIPC's [awesome-web-archiving](https://github.com/iipc/awesome-web-archiving)
  list is the community's index of everything above. WARC stores raw
  request/response bytes; all rewriting in the WARC world is replay-time —
  the ecosystem-wide precedent for the byte-preservation rule.
- **[Wayback++](https://addons.mozilla.org/en-US/firefox/addon/waybackplusplus/)**
  and [cnnReplayService](https://github.com/N0taN3rd/cnnReplayService) —
  client-side environment-patching shims that make specific broken
  mementos replayable, i.e. "change the environment, not the bytes" as
  one-off tools.
- **Memento damage as a service** — the damage-rating work from §1 became
  a measurable QA notion; the scene graph's ledger-recorded gaps are the
  crawl-side version of the same accounting.

---

## 9. Synthesis: where the scene graph has prior art, and where it is alone

**Solid prior art (adopt the vocabulary, cite the results):**

- *Deferred representations* is an established, decade-old term of art
  with quantified results (Brunelle et al., §1). The scene graph's
  execute-and-observe pass is squarely in this tradition, and the
  two-tier "classify, then render only what needs it" result
  (arXiv:1508.02315) is directly reusable for crawl budgeting.
- *Union-of-requisites storage* is deployed practice: pywb/wombat
  auto-fetch and Browsertrix `autofetch` already background-collect all
  `srcset` and `@media` branch requisites into one store and let the
  visitor's browser re-select (§3). The design's load-bearing
  simplification is field-proven for the declarative subset.
- *CSP as replay backstop* is the Wayback Machine's own post-2017 posture
  (Lerner et al., §2), and the un-rewritten-reference leak is the
  documented "zombie" class going back to 2012. The 87.5%
  blocked-request reduction in the TWEB paper quantifies exactly the gap
  between rewriting and coverage.
- *Byte-preservation with replay-time transformation* is the entire
  WARC/WACZ world-view; WACZ signing formalizes the attestation argument.
- *The cache-key analysis* (Part 2-D) is validated by the Twitter
  cookie/language studies: archives that key without the negotiation
  dimension demonstrably serve wrong variants (§7). Memento shows what
  promoting one axis (time) to a first-class negotiated key looks like.
- *Environment-as-artifact* has a replay-side precedent in oldweb.today's
  emulated period browsers (§3).

**Genuinely novel in the scene graph (no prior art found):**

- **The environment matrix itself.** No located crawler crawls the same
  URL under multiple enumerated environments as distinct frontier entries.
  Browsertrix has the per-crawl knobs (`--mobileDevice`, `--windowSize`,
  `--lang`); nothing composes them into coverage. The closest artifacts
  are wishes: ukwa/webrender-api#9's "device switching option" (archived
  copy — see §3; the repo itself is gone) and
  Webrecorder Desktop's experimental mobile mode.
- **Deriving the axes from the artifact.** Nothing found parses
  stylesheets to enumerate *which media features a page actually queries*
  and bounds the environment set by breakpoint-interval equivalence
  classes. Auto-fetch unions `@media` URLs without modeling the axes;
  the hypercube work enumerates interaction events, not media features.
  This — the "queried axes only, one representative per interval"
  bounding — appears to be the design's most original contribution.
- **The environment-tagged ledger.** No located system records *which
  environment discovered which requisite* as provenance. The closest
  analogues are the Wayback's post-CCS-2017 subresource-timestamp view
  (provenance in time, not environment) and Memento damage ratings
  (gap accounting without discovery provenance).
- **Client Hints as an archival dimension** — untouched anywhere (§7).

**Who to learn from or engage:**

- The Webrecorder org is where a multi-environment-crawl discussion would
  land today: `autofetch` in
  [browsertrix-behaviors](https://github.com/webrecorder/browsertrix-behaviors)
  is the natural home for declarative-axis enumeration, and the
  [forum](https://forum.webrecorder.net/) currently has *no* thread on
  responsive/multi-viewport capture (searched "mobile device", "viewport"
  — only incidental hits), so the topic is open.
- The WS-DL group (Nelson/Weigle at ODU; Alam now at the Internet
  Archive) is the venue for the model's academic framing — the scene
  graph is, in their terms, "deferred representations extended from the
  script axis to the full Media Queries 4/5 environment, with a bounded
  matrix and union storage."
- Heritrix #177 and #202 are the concrete upstream issues to reference
  when explaining why the *upstream* archive (the archive ceiling) is
  missing mobile/responsive requisites in the first place.

**Honest gaps in this survey:**

- The Webrecorder forum yielded no responsive-capture threads via its
  search API (three queries, all negative — see Appendix); deeper forum
  crawling was not attempted, so a relevant thread could exist unfound.
- The one Common Crawl Group thread found (§4) raises JS rendering only
  in passing; no thread actually debating adding rendering to CCBot was
  located.
- Whether current Heritrix/Wayback capture pipelines now extract full
  `srcset` (post-#177, post-Brozzler) was not verified from primary
  sources.
- Browsertrix release notes reference a mobile-device-descriptor update
  (PR #947 per the [releases page](https://github.com/webrecorder/browsertrix-crawler/releases));
  the PR itself was not individually fetched.
- archive.today details rest on the ArchiveTeam wiki and Bellingcat
  toolkit (secondary but well-maintained sources); the service publishes
  no technical documentation of its own.

---

## Appendix: research trail — venues consulted

Where this survey actually looked, so a future pass knows what is covered
and what is untouched. Negative results are listed with the query venue,
because "we looked and found nothing" is itself a finding the synthesis
relies on.

**Consulted directly (fetched):**

- Webrecorder Discourse forum, via its public search API — three queries,
  all with no responsive/multi-viewport threads:
  [`search.json?q=mobile%20device`](https://forum.webrecorder.net/search.json?q=mobile%20device)
  (zero results),
  [`search.json?q=viewport`](https://forum.webrecorder.net/search.json?q=viewport)
  (two incidental hits: topics 937, 603 — viewport meta tags in embed
  contexts, not capture),
  [`search.json?q=responsive`](https://forum.webrecorder.net/search.json?q=responsive)
  (42 posts, none about responsive capture). Basis for the "topic is
  open on the forum" claim in §9.
- [github.com/internetarchive/heritrix3/issues/177](https://github.com/internetarchive/heritrix3/issues/177)
  — fetched to confirm opener, date, closed state, and absence of a
  visible linked fix.
- [crawler.docs.browsertrix.com/user-guide/cli-options/](https://crawler.docs.browsertrix.com/user-guide/cli-options/)
  — fetched to enumerate the environment knobs (`--mobileDevice`,
  `--windowSize`, `--userAgent`, `--lang`; no DPR option listed).
- [UW seclab project announcement](https://seclab.cs.washington.edu/2017/10/30/rewriting-history-manipulating-the-archived-web-from-the-present)
  — fetched to confirm the IA's deployed CSP mitigation wording.

**Mailing lists / groups:**

- Common Crawl Google Group
  ([groups.google.com/g/common-crawl](https://groups.google.com/g/common-crawl))
  — searched; one relevant thread found and cited in §4
  ([XjLb_K0r5gI](https://groups.google.com/g/common-crawl/c/XjLb_K0r5gI)).
- IIPC mailing lists were **not** searched directly; IIPC coverage here
  comes from its GitHub org
  ([warc-specifications](https://github.com/iipc/warc-specifications),
  [awesome-web-archiving](https://github.com/iipc/awesome-web-archiving))
  and netpreserve.org pages surfaced in web search. A pass over IIPC
  member-list archives is the most promising unexplored venue.
- The old Wayback/OpenWayback dev lists and archive.org forums were not
  searched directly (one archive.org forum thread on Twitter archiving
  surfaced incidentally via search).

**Search-engine passes (WebSearch), by topic:** WS-DL deferred
representations / damage / hypercube / archivability papers; ws-dl
blogspot posts (zombies, CNN, Twitter cookies ×2); Heritrix srcset and JS
extraction; Brozzler/warcprox/Umbra architecture; SPN2; Wayback CSP;
pywb/wombat rewriting and auto-fetch; Browsertrix behaviors, mobile
emulation, device profiles; Webrecorder Desktop; wabac.js/ReplayWeb.page;
WACZ; oldweb.today; Common Crawl CCBot/Nutch/WARC-WAT-WET and rendering
policy; archive.today internals; SingleFile/monolith; wget
`--page-requisites`; Memento RFC 7089 and raw-memento proposals;
Vary/CDX/canonicalization; Client Hints in archives (nothing found);
Squidwarc.

**Blocked / not completed:** two web searches were refused by the
harness's safety filter (both phrasings pairing pywb/Wayback CSP with
"leak"-style wording); the CSP story was assembled from the UW seclab
page, DSHR's posts, and the TWEB paper instead. Google Scholar, dblp
beyond one incidental hit, and direct GitHub issue-search across the
webrecorder org (beyond web-search surfacing) were not exhaustively
swept.

**Link check (2026-08-07):** every URL in this document (75 at time of
check) was HTTP-status-checked. All resolved except one: the original
`github.com/ukwa/webrender-api/issues/9` returned 404 — the repo was
deleted after UKWA adopted the Webrecorder stack (their org now carries
`browsertrix-crawler` / `browsertrix-cloud` forks). The citation was
repointed to the
[2022-04-04 Wayback snapshot](https://web.archive.org/web/20220404010247/https://github.com/ukwa/webrender-api/issues/9),
whose body was fetched and re-verified to contain the quoted "Viewport
configuration" and "Patch mode, including device switching option"
passages. Three other non-200s were transient or bot-blocking, re-verified
individually: `dl.acm.org/doi/10.1145/3589206` (403 — Cloudflare
bot-blocking; the TWEB paper is independently corroborated by the
matkelly.com preprint), `doi.org/10.1109/JCDL.2017.7991579` (202 —
resolver handshake; the handle API confirms it resolves to IEEE document
7991579), and `pywb/CHANGES.rst` (429 rate limit; 200 on retry).
Fittingly for
SCENE.GRAPH.md's subject matter: one of this survey's own primary
sources already exists only as a memento.
