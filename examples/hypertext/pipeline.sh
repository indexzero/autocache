#!/usr/bin/env bash
# The hypertext example pipeline — the README's seven steps, run end to end:
# manifest → ledger → cache fill → cache verify → remaster build →
# remaster verify (static tier) → serve + probe.
#
# Network: `manifest` queries the CDX API for never-seen urls; `cache fill`
# fetches captures and their requisites from web.archive.org. Both resume on
# re-run. FILL_MAX bounds the fill for a quick pass; leave it unset to drive
# the cache to full closure.
#
# Exit semantics: mechanical failures (a command that cannot run, a serve
# probe that cannot answer) fail the pipeline. Closure findings from the two
# verify steps are REPORTED and carried into the summary instead — they are
# statements about the captures, not about the toolkit, and the honest run
# surfaces them. See README.md ("What verify reports here").
#
# The dynamic remaster tier and `cache crawl` need agent-browser; this
# pipeline stays on the static tier so it runs anywhere Node runs.
set -euo pipefail
cd "$(dirname "$0")"

wb() { npx --no-install waybackify "$@"; }

manifests=PASS
cache_verify=PASS
remaster_verify=PASS

# Resolution is resumable by design: the seen union keeps every verdict, and
# a rerun resolves only what is still missing. CDX weather (503s, timeouts)
# defers urls, so each source gets up to three passes before the shortfall
# is carried into the summary as a report.
echo "==> manifest (one per source, shared seen union)"
for dir in content/*/; do
  ok=false
  for attempt in 1 2 3; do
    if wb manifest "${dir}README.md" -u universe.json -s seen.json -o "${dir}wayback.json"; then
      ok=true
      break
    fi
    echo "(manifest ${dir}: attempt ${attempt} left unresolved urls; retrying)"
  done
  if [ "$ok" != true ]; then manifests=REPORTED; fi
done

echo "==> ledger"
wb ledger content

echo "==> cache fill"
fill=(cache fill content --root cache)
if [ -n "${FILL_MAX:-}" ]; then fill+=(--max "$FILL_MAX"); fi
wb "${fill[@]}"

echo "==> cache verify"
wb cache verify --root cache || cache_verify=REPORTED

echo "==> remaster build"
wb remaster build cache remastered

echo "==> remaster verify (static tier)"
wb remaster verify --root remastered --hermetic cache --tier static || remaster_verify=REPORTED

echo "==> serve + probe"
PORT="${PORT:-8199}"
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:${PORT}/"; then
  echo "port ${PORT} already answers — refusing to probe a squatter" >&2
  exit 1
fi
npx --no-install waybackify-serve --root remastered --port "$PORT" &
serve_pid=$!
trap 'kill "$serve_pid" 2>/dev/null || true' EXIT
sleep 2
if ! kill -0 "$serve_pid" 2>/dev/null; then
  echo "waybackify-serve exited before the probe" >&2
  exit 1
fi

probe="$(wb ledger content --root remastered | node ./probe-path.mjs)"
status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}${probe}")"
index="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/")"
echo "GET ${probe} -> ${status}"
echo "GET / -> ${index}"
if [ "$status" != "200" ] || [ "$index" != "200" ]; then
  echo "serve probe failed" >&2
  exit 1
fi

echo ""
echo "pipeline summary:"
echo "  ledger/fill/build/serve           PASS"
echo "  manifest resolution               ${manifests}"
echo "  cache verify                      ${cache_verify}"
echo "  remaster verify (static)          ${remaster_verify}"
