// Source identity is narrower than link matching: only scheme/host case,
// explicit default ports, and an empty root path are equivalent. Parse raw
// components instead of round-tripping through URL, which also rewrites dot
// segments, percent escapes in hosts, and other resource spellings.
const HTTP_ORIGINAL = /^(https?):\/\/((?:[^/?#@]*@)?)(\[[^\]]+\]|[^/?#:@]+)(:\d*)?(\/[^?#]*)?([?#].*)?$/i;
const quote = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Percent-encoding stays byte-exact, including in the authority. URI scheme
// and host letters otherwise have ASCII case-insensitive comparison.
const foldCase = value => value.replace(/%[0-9a-f]{2}|[a-z]/gi, token =>
  token.startsWith('%') ? token : token.toLowerCase());
const casePattern = value => value.replace(/%[0-9a-f]{2}|[a-z]|[^a-z]/gi, token =>
  /^[a-z]$/i.test(token) ? `[${token.toLowerCase()}${token.toUpperCase()}]` : quote(token));

function parts(url) {
  const match = HTTP_ORIGINAL.exec(url);
  if (!match) return null;
  const [, rawScheme, userinfo, rawHost, rawPort = '', rawPath = '', suffix = ''] = match;
  const scheme = rawScheme.toLowerCase();
  const defaultPort = scheme === 'http' ? ':80' : ':443';
  return {
    scheme, userinfo, host: foldCase(rawHost), defaultPort,
    port: rawPort === defaultPort ? '' : rawPort, path: rawPath || '/', suffix
  };
}

/** Comparison only: manifest keys and captured URLs always retain their spelling. */
export function sourceKey(url) {
  const p = parts(url);
  // Outside the recognized HTTP syntax, retain literal identity.
  if (!p) return url;
  return `${p.scheme}://${p.userinfo}${p.host}${p.port}${p.path}${p.suffix}`;
}

/** Java-compatible CDX regex for exactly the equivalences accepted by sourceKey. */
export function sourceFilter(url) {
  const p = parts(url);
  if (!p) return `^${quote(url)}$`;
  const port = p.port ? quote(p.port) : `(?:${p.defaultPort})?`;
  const path = p.path === '/' ? '/?' : quote(p.path);
  return `^${casePattern(p.scheme)}://${quote(p.userinfo)}${casePattern(p.host)}${port}${path}${quote(p.suffix)}$`;
}
