# Cache comparison report

`waybackify merge <base-root> <fetch-root> --report` compares two existing
cache directories. It writes JSONL to stdout and leaves both roots unchanged.
It creates no output corpus and selects no conflict winner.

Both roots must be quiescent throughout the call. There is no snapshot lock.
Each root must pass `fsck` with no findings and no fixes.
An existing empty directory is a valid empty cache. A missing directory fails.
The comparison uses current sidecars and the formal `readSidecar` reader.

## Library

```js
import { compareRoots } from '@autocache/waybackify/compare.js';

const { counts, conflicts } = await compareRoots(baseRoot, fetchRoot);
```

Capture keys identify entries. Each key belongs to exactly one set:

| Count | Membership |
|---|---|
| `newOnly` | Present only in the fetch root |
| `oldOnly` | Present only in the base root |
| `bothAgreeing` | Present in both roots with equal states |
| `bothConflicting` | Present in both roots with different states |

Two body entries agree when their `contentHash` values match.
Two bodiless entries agree when their `status` values match.
The bodiless statuses are `empty`, `redirect`, `error`, and `interstitial`.
Different statuses conflict. Different body hashes conflict.
Other sidecar fields do not affect agreement, including interstitial signatures
and targets. Agreement does not mean all sidecar metadata matches.

The result contains `counts` and `conflicts`, in that property order.
`counts` contains the four table fields, in table order.
`conflicts` contains `{ key, base, fetch }` records, sorted by capture key.
Sorting uses JavaScript string order over UTF-16 code units, independent of locale.

Each `base` and `fetch` record contains these fields, in this order:

```text
v, key, status, contentHash, contentLength, contentType, flag,
fetchedAt, signature, target
```

Absent fields become `null`. Present values remain unchanged.
The result has no root paths, run timestamp, or resolution field.
The promise rejects on invalid inputs and returns no partial result.

## JSONL and exit codes

The CLI emits one summary record, then one record per conflict:

```json
{"type":"summary","counts":{"newOnly":1,"oldOnly":1,"bothAgreeing":2,"bothConflicting":0}}
```

The summary always comes first, even for two empty roots.
Each conflict record has `{ type: "conflict", key, base, fetch }` in that order.
The CLI uses compact `JSON.stringify` encoding and one newline per record.
It finishes the comparison before writing any report bytes.

Exit `0` means a complete report, including reports that contain conflicts.
Exit `1` means an invalid input or read failure, with empty stdout.
Diagnostics go to stderr.
Exit `2` means invalid usage. `--report` is required.
Writer invocation, an output-root argument, and output flags are unsupported.
