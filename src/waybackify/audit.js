// Wayback-404 capture verdict engine (#248).
//
// A wayback URL can lie: web.archive.org returns HTTP 200 for a replay page
// whose CAPTURED content is itself a 404, a soft-error page, a parked domain,
// or an empty shell. `auditCapture` classifies one capture as
//
//   good        — verified: real content (or a non-HTML asset) behind the replay
//   wayback404  — confidently junk: archived AS an error, or the replayed body
//                 is unmistakably a 404 / error / parked-domain page
//   suspect     — anything uncertain (weak markers, near-empty body, transient
//                 fetch failures). NEVER silently good: when the signals don't
//                 agree, a human looks.
//
// Signals, in order:
//   1. CDX exact-capture lookup (WaybackMachine#getCapture) — the capture's own
//      archived `statuscode`. 4xx/5xx captures are wayback404 without touching
//      the replay.
//   1.5 Named interstitial species (#363) on the RAW replay body — wrapper stubs
//      and redirect interstitials (the archive talking ABOUT content, not
//      serving it) → wayback404 with a `signature` and a decoded `target`; the
//      weaker extension-mismatch signature → suspect. See Signal 1.5 below.
//   2. Soft-404 content heuristics on the replay body — wayback toolbar chrome
//      stripped first so markers match the CAPTURED page, not archive.org's UI.
//
// Every verdict carries `reason` + a short `evidence` snippet so the human
// pass over the audit report has context without re-fetching anything.
//
// Layering note (#254): this module is LIBRARY plumbing — the future
// spv/waybackify-cli `check` command is a thin wrapper over `auditCapture`.

import { WaybackMachine } from './index.js';
// Import cycle (safe): interstitial.js imports parseWaybackUrl from THIS module.
// Both bindings are referenced only at call-time (inside function bodies), never
// at module-evaluation time, so ESM resolves the live bindings before either is
// invoked. The offline suite loading audit.js is the standing proof.
import { detectInterstitial, INTERSTITIAL_SIGNATURES } from './interstitial.js';

/**
 * Parse a wayback replay URL into its parts. Tolerates replay flags on the
 * timestamp (`if_`, `id_`, `im_`, ...) — they're preserved in `flags` and
 * excluded from `timestamp`. Returns null for anything that isn't a
 * web.archive.org/web/ replay URL.
 * @param {string} url
 * @returns {{ timestamp: string, flags: string, original: string } | null}
 */
export function parseWaybackUrl(url) {
  const m = /^https?:\/\/web\.archive\.org\/web\/(\d{4,14})([a-z]{2}_)?\/(.+)$/.exec(url);
  if (!m) return null;
  let original = m[3];
  // Repair the proxy-collapsed scheme wayback itself tolerates (http:/host).
  original = original.replace(/^(https?):\/(?!\/)/, '$1://');
  if (original.startsWith('//')) original = 'https:' + original;
  return { timestamp: m[1], flags: m[2] ?? '', original };
}

// ---------------------------------------------------------------------------
// Replay-chrome stripping
// ---------------------------------------------------------------------------

// The wayback replay wraps the captured page in: an injected <script>/<link>
// block in <head> (ending at the "End Wayback Rewrite JS Include" comment),
// the toolbar between the BEGIN/END WAYBACK TOOLBAR INSERT comments, and
// trailing "FILE ARCHIVED ON ..." / "playback timings" comments. All of it
// must go BEFORE heuristics run — the toolbar contains text and the injects
// contain markup that would otherwise mask a near-empty captured body.
const CHROME_PATTERNS = [
  // Head inject: first archive.org/_static script through the closing marker.
  /<script[^>]*src=["'][^"']*(?:archive\.org\/includes\/analytics|\/_static\/js\/)[^"']*["'][\s\S]*?<!--\s*End Wayback Rewrite JS Include\s*-->/i,
  // Toolbar block.
  /<!--\s*BEGIN WAYBACK TOOLBAR INSERT\s*-->[\s\S]*?<!--\s*END WAYBACK TOOLBAR INSERT\s*-->/i,
  // Trailing archive provenance + timing comments. Tempered scan — the
  // marker must occur INSIDE the comment ((?!-->) at every step), otherwise
  // any early comment in the captured page would anchor a match that devours
  // the whole document down to the trailing provenance block.
  /<!--(?:(?!-->)[\s\S])*?FILE ARCHIVED ON(?:(?!-->)[\s\S])*-->/gi,
  /<!--\s*playback timings(?:(?!-->)[\s\S])*-->/gi,
  // Defensive sweep for stragglers when the head-inject span didn't match
  // (older replay layouts): individual _static assets and __wm bootstrap.
  /<script[^>]*src=["'][^"']*\/_static\/js\/[^"']*["'][^>]*>\s*<\/script>/gi,
  /<link[^>]*href=["'][^"']*\/_static\/css\/[^"']*["'][^>]*\/?>/gi,
  /<script[^>]*>[^<]*__wm\.(?:init|wombat|bt)\([\s\S]*?<\/script>/gi
];

/**
 * Remove archive.org's replay chrome from a replayed HTML body, leaving (an
 * approximation of) the captured page. Pure string surgery — decade-old tag
 * soup doesn't survive DOM round-trips.
 * @param {string} html
 * @returns {string}
 */
export function stripWaybackChrome(html) {
  let out = html;
  for (const p of CHROME_PATTERNS) out = out.replace(p, '');
  return out;
}

// ---------------------------------------------------------------------------
// Soft-404 content heuristics
// ---------------------------------------------------------------------------

// HARD markers → wayback404. Deliberately long-winded phrases: "404" alone is
// a legitimate blog-post topic; "HTTP Error 404" is not.
const HARD_TITLE_MARKERS = [
  /^\s*(?:404|error(?:\s+\d{3})?|not found|404 not found|page not found|file not found|object not found)\s*$/i,
  /\b(?:404|page|file|object|document)\s+not\s+found\b/i,
  /\bpage\s+can(?:no|')t\s+be\s+(?:displayed|found)\b/i,
  /\bpage\s+cannot\s+be\s+(?:displayed|found)\b/i
];
const HARD_BODY_MARKERS = [
  /\bHTTP\s+Error\s+(?:404|410)\b/i,
  /\b(?:404|410)\s*[-–—:.]?\s*(?:file or directory |page |resource )?not\s+found\b/i,
  /\bthe\s+page\s+cannot\s+be\s+(?:found|displayed)\b/i,
  /\bpage\s+can(?:no|')t\s+be\s+(?:found|displayed)\b/i,
  /\bthe\s+(?:page|resource|document|file)\s+you\s+(?:are\s+looking\s+for|requested|were\s+looking\s+for)\s+(?:was\s+not\s+found|cannot\s+be\s+found|could\s+not\s+be\s+found|does\s?n[o']t\s+exist|no\s+longer\s+exists|might\s+have\s+been\s+removed)/i,
  /\bthe\s+resource\s+cannot\s+be\s+found\b/i, // ASP.NET
  /\bserver\s+error\s+in\s+'[^']*'\s+application\b/i, // ASP.NET yellow screen
  // Parked / expired domain boilerplate.
  /\bthis\s+domain\s+(?:name\s+)?(?:may\s+be|is)\s+for\s+sale\b/i,
  /\bbuy\s+this\s+domain\b/i,
  /\bis\s+parked\s+free,?\s+courtesy\s+of\b/i, // GoDaddy
  /\bthis\s+(?:web\s+)?(?:page|site|domain)\s+is\s+parked\b/i,
  /\bdomain\s+(?:name\s+)?(?:has\s+)?expired\b/i,
  /\brelated\s+searches\b[\s\S]{0,400}\bsponsored\s+listings\b/i, // Sedo-style lander
  // Dead hosting account.
  /\b(?:this\s+)?account\s+has\s+been\s+suspended\b/i,
  /\bbandwidth\s+limit\s+exceeded\b/i,
  // The wayback machine's OWN error page leaking through a replay.
  /\bwayback\s+machine\s+has\s+not\s+archived\s+that\s+url\b/i,
  /\bgot\s+an\s+HTTP\s+\d{3}\s+response\s+at\s+crawl\s+time\b/i
];

// SOFT markers → suspect. Real posts occasionally say these, so a human looks.
const SOFT_MARKERS = [
  /\bunder\s+construction\b/i,
  /\bcoming\s+soon\b/i,
  /^\s*it\s+works!?\s*$/i, // bare Apache default page (matched against full text)
  /\bdefault\s+(?:web\s+site\s+)?page\b/i, // cPanel/IIS placeholder
  /\bwebsite\s+is\s+temporarily\s+unavailable\b/i,
  /\bno\s+longer\s+available\b/i
];

// Below this many characters of visible text, a captured page is an empty
// shell (frameset stubs, JS-only redirects, blank templates) → suspect.
const NEAR_EMPTY_CHARS = 40;

/** <title> text, entity-decoded and whitespace-collapsed ('' if absent). */
function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/** Crude visible-text projection: drop script/style/comments/tags, decode, collapse. */
function textOf(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

/** Short human-readable evidence snippet: the title plus leading body text. */
function snippet(title, text, matched) {
  const parts = [];
  if (matched) parts.push(`matched: ${String(matched)}`);
  if (title) parts.push(`title: ${title.slice(0, 120)}`);
  parts.push(`text: ${text.slice(0, 180) || '(empty)'}`);
  return parts.join(' | ');
}

/**
 * Pure soft-404 heuristics over a replayed HTML body. Strips the wayback
 * chrome, then checks title/body against the marker lists above.
 * @param {string} html - Raw replay body (chrome-stripping is done here)
 * @returns {{ verdict: 'good'|'wayback404'|'suspect', reason: string, evidence: string }}
 */
export function classifyReplayHtml(html) {
  const stripped = stripWaybackChrome(html);
  const title = titleOf(stripped);
  const text = textOf(stripped);

  for (const p of HARD_TITLE_MARKERS) {
    if (p.test(title)) {
      return { verdict: 'wayback404', reason: 'soft-404 title marker', evidence: snippet(title, text, p) };
    }
  }
  // Scope body scanning to the head of the visible text — error boilerplate
  // leads; a long real article that MENTIONS an error phrase deep in its body
  // shouldn't trip (e.g. a post quoting a 404 page).
  const head = text.slice(0, 2000);
  for (const p of HARD_BODY_MARKERS) {
    if (p.test(head)) {
      return { verdict: 'wayback404', reason: 'soft-404 body marker', evidence: snippet(title, text, p) };
    }
  }
  if (text.length < NEAR_EMPTY_CHARS) {
    return {
      verdict: 'suspect',
      reason: `near-empty body (${text.length} visible chars after chrome strip)`,
      evidence: snippet(title, text)
    };
  }
  for (const p of SOFT_MARKERS) {
    if (p.test(head) || p.test(title)) {
      return { verdict: 'suspect', reason: 'soft error/placeholder marker', evidence: snippet(title, text, p) };
    }
  }
  return { verdict: 'good', reason: 'content heuristics clean', evidence: snippet(title, text) };
}

// ---------------------------------------------------------------------------
// The verdict orchestrator
// ---------------------------------------------------------------------------

/** Does a CDX statuscode string denote an archived error capture? */
const isErrorStatus = code => /^[45]\d\d$/.test(code);
const isRedirectStatus = code => /^3\d\d$/.test(code);

/** Content types the soft-404 heuristics apply to (unknown → assume HTML, conservative). */
const isHtmlish = ct => !ct || /html|xhtml|^text\/plain/i.test(ct);

/**
 * Full wayback-404 verdict for one capture.
 *
 * @param {string} waybackUrl - Full web.archive.org/web/<ts>/<original> URL
 * @param {Object} [options]
 * @param {WaybackMachine} [options.wayback] - CDX client (injectable for tests;
 *   give it a generous timeout for bulk runs — archive.org takes 25–60s)
 * @param {Function} [options.fetch] - fetch-like for the replay body
 *   (defaults to the wayback instance's impit fetch)
 * @returns {Promise<{ verdict: 'good'|'wayback404'|'suspect', statuscode: string|null,
 *   reason: string, checkedAt: string, evidence: string,
 *   url: string, timestamp: string, original: string,
 *   signature?: string, target?: { url: string, timestamp: string } }>}
 *   `signature`/`target` are present only when Signal 1.5 (interstitial
 *   detection, #363) fired — `target` only for a redirect interstitial.
 */
export async function auditCapture(waybackUrl, options = {}) {
  const parsed = parseWaybackUrl(waybackUrl);
  if (!parsed) throw new TypeError(`auditCapture: not a wayback replay URL: ${waybackUrl}`);
  const { timestamp, original } = parsed;

  const wayback = options.wayback ?? new WaybackMachine({ timeout: 60000 });
  const fetchImpl = options.fetch ?? (url => wayback.impit.fetch(url));
  const checkedAt = new Date().toISOString();
  const base = { url: waybackUrl, timestamp, original, checkedAt };
  const done = (verdict, statuscode, reason, evidence = '') => ({
    verdict, statuscode, reason, evidence, ...base
  });

  // Signal 1: the capture's own archived statuscode from the CDX index.
  let cdx = null;
  let cdxFailed = null;
  try {
    cdx = await wayback.getCapture(original, timestamp);
  } catch (error) {
    cdxFailed = error?.message ?? String(error); // throttle/outage — content decides, noted in evidence
  }
  const statuscode = cdx?.statuscode ?? null;
  if (statuscode && isErrorStatus(statuscode)) {
    return done('wayback404', statuscode, `capture archived as HTTP ${statuscode} (CDX statuscode)`,
      `cdx: ${cdx.timestamp} ${cdx.original} ${cdx.statuscode} ${cdx.mimetype}`);
  }

  // Signal 2: soft-404 heuristics on the replay body. Fetch the plain replay
  // (what a reader clicks); redirect captures (3xx) follow to their target,
  // so the final body is still the right thing to judge.
  let res;
  try {
    res = await fetchImpl(waybackUrl);
  } catch (error) {
    return done('suspect', statuscode, `replay fetch failed: ${error?.message ?? error}`,
      cdxFailed ? `cdx lookup also failed: ${cdxFailed}` : 'cdx statuscode was clean; body unverified');
  }

  if (res.status === 404) {
    return done('wayback404', statuscode, 'replay returned HTTP 404 — capture missing from the archive');
  }
  if (res.status !== 200) {
    return done('suspect', statuscode, `replay returned HTTP ${res.status}`,
      'non-200 replay — possibly transient archive.org trouble; retry before trusting');
  }

  const contentType = res.headers?.get?.('content-type') || cdx?.mimetype || '';
  if (!isHtmlish(contentType)) {
    // Assets (images, PDFs, tarballs…) that replay with HTTP 200 and a clean
    // CDX statuscode are good — there is no soft-404 story for bytes.
    return done('good', statuscode, `non-HTML capture (${contentType}) replayed cleanly`);
  }

  const body = await res.text();

  const { verdict, reason, evidence } = classifyReplayHtml(body);

  // Signal 1.5: named interstitial species (#363) — the archive talking ABOUT
  // content rather than serving it. Runs on the RAW body: the distinctive
  // markers (webComponentLoaderConfig, setTimeout(go,5000), the id="playback"
  // viewer iframe) live in <script> bodies and tag attributes that
  // classifyReplayHtml's chrome-strip + text projection erases, so a redirect
  // interstitial lacking a prose crawl-time phrase would otherwise slip through
  // as good/suspect. Severity follows the strength of the signature:
  //   - wrapper-stub (≈ #248's "empty shell") and redirect-interstitial
  //     (#248's "redirect-to-garbage") each need TWO co-occurring archive-owned
  //     markers → confidently not-content → wayback404. Redirect interstitials
  //     carry the decoded `target` the #248 re-point pass needs. (Caveat: the
  //     target is best-effort — decodeRedirectTarget scans the raw body, where a
  //     toolbar link could in principle be latched; the human reviews it.)
  //   - extension-mismatch inspects NO body (extension vs content-type alone),
  //     maps to none of #248's dead-link classes, and a `.pdf`/`.txt` URL can
  //     legitimately replay as HTML — so it is only SUSPECT here, surfaced for a
  //     human, never a confident wayback404. (At cache-commit time, #363 still
  //     refuses it; the live audit is deliberately more conservative.)
  // cdxStatus is NOT passed: the archived-error signature is already covered by
  // Signal 1's CDX statuscode check above. The classifyReplayHtml evidence rides
  // along so the human pass keeps a body snippet (#248's false-positive guard).
  const species = detectInterstitial({ key: `${timestamp}/${original}`, contentType, body });
  if (species) {
    const interstitialVerdict =
      species.signature === INTERSTITIAL_SIGNATURES.extensionMismatch ? 'suspect' : 'wayback404';
    const ev = species.target
      ? `interstitial ${species.signature} → ${species.target.timestamp}/${species.target.url} | ${evidence}`
      : `interstitial ${species.signature} | ${evidence}`;
    return {
      ...done(interstitialVerdict, statuscode, `interstitial: ${species.signature}`, ev),
      signature: species.signature,
      ...(species.target ? { target: species.target } : {})
    };
  }

  const notes = [];
  if (statuscode && isRedirectStatus(statuscode)) notes.push(`capture archived as HTTP ${statuscode} redirect; judged its destination`);
  if (cdxFailed) notes.push(`cdx lookup failed (${cdxFailed}); verdict is content-only`);
  if (!cdx && !cdxFailed) notes.push('exact capture not in CDX; replay likely served nearest capture');

  if (verdict === 'good' && cdxFailed) {
    // Content looked clean but the statuscode signal is missing — not silently good.
    return done('suspect', statuscode, `content clean but CDX unverifiable: ${cdxFailed}`, evidence);
  }
  const fullReason = notes.length > 0 ? `${reason} (${notes.join('; ')})` : reason;
  return done(verdict, statuscode, fullReason, evidence);
}
