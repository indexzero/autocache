# cache-root — a real `waybackify cache` root, committed as a fixture

The four `status:"body"` entries in this directory are the VERBATIM output of
two real `waybackify cache` invocations against archive.org — not hand-built,
not synthesized. They are the offline ground truth for the serve-from-cache-root
tests: an FsStore pointed here must serve these pages exactly as the write-side
produced them, and the document bodies carry the Wayback Machine's REAL injected
chrome (toolbar markup, `web-static.archive.org/_static/` includes, `__wm.*`
bootstrap scripts), which is what the serve-time strip transform is tested
against.

Four further entries are SYNTHETIC (hand-authored, marked below): the three
bodiless statuses (`empty`/`redirect`/`error`) and one orphan `cap/` file. The
real corpus has ZERO `redirect` entries, so the synthetic redirect is the only
on-disk redirect coverage that exists. These carry no live-fetched bytes; their
sidecars are canonical `waybackify cache` shape (produced through
`cache.js#canonicalJSON`), with hashes derived from their captureKey via
`key.js` — byte-identical to what the writer would emit for the same entry.

## Provenance

Produced on 2026-07-12 by exactly these commands, run from the repo root in
this order — two SEPARATE invocations into the same root, so the fixture also
proves that independently-cached captures compose in one root:

```sh
node spv/waybackify-cli/bin/waybackify.js cache \
  'https://web.archive.org/web/19981202230410/http://www.google.com/' -o <root>
node spv/waybackify-cli/bin/waybackify.js cache \
  'https://web.archive.org/web/20140403040000/http://example.com/' -o <root>
```

Both runs completed with zero failures (summary lines:
`{"entries":3,"fetched":3,"skipped":0,"failed":0}` and
`{"entries":1,"fetched":1,"skipped":0,"failed":0}`). The empty `tmp/` ingest
scratch directory is not committed (git does not track empty directories);
consumers never read it.

## Contents

| key | hash prefix | status | contentType | origin |
|---|---|---|---|---|
| `19981202230410/http://www.google.com/` | `58a9d3a4` | body | `text/html` | real |
| `19981202230410/http://www.google.com/alpha.jpg` | `2017ddfc` | body | `text/html` | real |
| `19981202230410/http://www.google.com/google.jpg` | `497a08c2` | body | `image/jpeg` | real |
| `20140403040000/http://example.com/` | `77c4b856` | body | `text/html` | real |
| `20140403040000/http://example.com/empty` | `71790232` | empty | `""` | synthetic |
| `20140403040000/http://example.com/redirect` | `a0b0d94a` | redirect | `text/html; charset=utf-8` | synthetic |
| `20140403040000/http://example.com/missing.gif` | `fb56241b` | error | `""` | synthetic |
| `20140403040000/http://example.com/orphan` | `d325db35` | — (orphan `cap/`, no sidecar) | — | synthetic |

Notes:

- The 1998 www.google.com homepage was chosen deliberately: it is tiny, its
  replay carries the full modern wayback toolbar/chrome, and its two page
  requisites are referenced root-relative (`/web/19981202230410im_/…`) —
  exactly the paths a mirrored page asks the server for.
- `alpha.jpg` (the page background) has `contentType: text/html` because the
  archive never captured that image: the flagged replay redirect-chased to an
  HTML page, and `cache` stores what the replay returned, verbatim. This is
  real-world replay behavior, kept on purpose — it pins that serving takes
  the content type from the SIDECAR, never from the URL's extension.
- `20140403040000/http://example.com/` hashes to
  `77c4b856ffc51a15b686125ca9ce901456eee045e9639b95fbcd8ae3970dd1ac` — the
  digest both packages' suites pin as the cross-package key-derivation
  tripwire, so this fixture doubles as an on-disk instance of it.
- The four synthetic entries share the `20140403040000/http://example.com/…`
  prefix but hang off DISTINCT sub-paths (`/empty`, `/redirect`,
  `/missing.gif`, `/orphan`), so they never collide with the real
  `…/example.com/` document above. They are inert to `chicago.test.ts` (which
  requests only the real keys) and exist so the FsStore has committed, on-disk
  instances of every bodiless status + the orphan-is-absent case to read.
- `empty`/`error` carry `contentType:""` — the corpus norm for those statuses
  (as of 2026-07-13, most `''` sidecars are `error`), and the fixed point of
  the Store READ normalization rule: a store reads `''` back as
  `application/octet-stream` at `head()`/`get()`, while the sidecar keeps `''`
  verbatim on disk. The `redirect` carries a real content-type to cover the
  populated-bodiless case.

## Regenerating

The four real `body` entries: re-run the two commands above into a fresh
directory and replace their `cap/`+`meta/` files. Expect byte differences:
archive.org evolves its injected chrome, and every sidecar records a fresh
`fetchedAt`/`contentHash`. Tests therefore derive expectations from the
sidecars and document bytes at runtime instead of pinning body hashes.

The four synthetic entries are hand-authored, never re-fetched. To reproduce
them, write each sidecar through `spv/waybackify/cache.js#canonicalJSON` at the
`meta/<aa>/<hash>.json` path `key.js#metaPath` derives for its captureKey (the
orphan is raw bytes at `key.js#capturePath` with NO sidecar).
