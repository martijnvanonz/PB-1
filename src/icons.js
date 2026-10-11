// Icon discovery. Reads a service's own HTML and follows what it actually
// declares — never guesses a path ahead of the markup. A small regex over
// <link> tags is enough for this narrow job; not a full HTML parser.
// Zero dependencies.
//
// The server only DISCOVERS the icon's URL — it never fetches or stores
// image bytes. The browser fetches the actual image itself (often via
// Pangolin's own magic DNS), which also gets it real HTTP caching for free.

const LINK_TAG_RE = /<link\b[^>]*>/gi;
const REL_RE = /\brel\s*=\s*["']([^"']*)["']/i;
const HREF_RE = /\bhref\s*=\s*["']([^"']*)["']/i;
const SIZES_RE = /\bsizes\s*=\s*["']([^"']*)["']/i;

// Pangolin reports each resource's destination relative to the Newt
// connector's own host — for a host-networked Newt that's 127.0.0.1, which
// only means "this host" from inside that same network namespace. A
// bridge-networked container needs INTERNAL_HOST to reach it instead. Only
// loopback gets substituted; an already-routable destination is untouched.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// Base URLs to try, internal (LAN-side) address first, falling back to the
// resource's public URL — not just when there's no internal address, but
// also when discovery against it comes back empty (unreachable, still
// starting up, etc). Deduped in case both point at the same place.
function candidateBaseUrls(resource) {
  const candidates = [];
  if (resource.destination && resource.destinationPort) {
    const scheme = resource.scheme || 'http';
    const internalHost = process.env.INTERNAL_HOST || '';
    const host = internalHost && LOOPBACK_HOSTS.has(resource.destination) ? internalHost : resource.destination;
    candidates.push(`${scheme}://${host}:${resource.destinationPort}`);
  }
  if (resource.url && !candidates.includes(resource.url)) candidates.push(resource.url);
  return candidates;
}

function parseIconLinks(html) {
  const icons = [];
  const tags = html.match(LINK_TAG_RE) || [];
  for (const tag of tags) {
    const relMatch = tag.match(REL_RE);
    if (!relMatch) continue;
    const rel = relMatch[1].toLowerCase();
    if (!rel.includes('icon')) continue;
    const hrefMatch = tag.match(HREF_RE);
    if (!hrefMatch || !hrefMatch[1]) continue;
    const sizesMatch = tag.match(SIZES_RE);
    const sizes = sizesMatch ? sizesMatch[1] : '';
    const maxSize = Math.max(
      0,
      ...sizes.split(/\s+/).map((s) => {
        const m = /^(\d+)x\d+$/i.exec(s);
        return m ? Number(m[1]) : 0;
      })
    );
    icons.push({ rel, href: hrefMatch[1], maxSize });
  }
  return icons;
}

// True if the HTML makes any attempt at all to declare an icon — including
// a malformed one with no href. Used to decide whether the /favicon.ico
// fallback is "the HTML declared nothing" (fallback applies) or "the HTML
// tried and failed" (a malformed <link rel="icon"> with no href means
// nothing to fetch — stay honest and report no icon, don't guess a path
// the markup never actually pointed at).
function hasAnyIconTag(html) {
  const tags = html.match(LINK_TAG_RE) || [];
  return tags.some((tag) => {
    const relMatch = tag.match(REL_RE);
    return Boolean(relMatch && relMatch[1].toLowerCase().includes('icon'));
  });
}

// apple-touch-icon first (properly designed, usually 180x180), then the
// largest declared size, then whatever plain <link rel="icon"> is left.
function pickBestIcon(icons) {
  if (!icons.length) return null;
  const appleTouch = icons.filter((i) => i.rel.includes('apple-touch-icon'));
  const pool = appleTouch.length ? appleTouch : icons;
  return pool.slice().sort((a, b) => b.maxSize - a.maxSize)[0];
}

// Fetches baseUrl's HTML (following redirects), parses declared icons, and
// resolves the chosen one to an absolute URL — critically, against the
// FINAL URL after redirects, not the one requested. A relative href is
// relative to wherever the page actually ended up (e.g. Jellyfin redirects
// / to /web/, and its icon hrefs are relative to /web/, not /). Falls back
// to /favicon.ico (resolved against the same final URL — an absolute path,
// so it lands at the origin root regardless) ONLY when the HTML declares no
// icon at all. Never throws; every failure mode is reported in the result.
async function discoverIconDetailed(baseUrl) {
  let res;
  try {
    res = await fetch(baseUrl, { redirect: 'follow', signal: AbortSignal.timeout(6000) });
  } catch (e) {
    return { ok: false, baseUrl, step: 'fetch', error: String((e && e.message) || e) };
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('html')) {
    return { ok: false, baseUrl, step: 'not-html', contentType };
  }
  let html;
  try {
    html = await res.text();
  } catch (e) {
    return { ok: false, baseUrl, step: 'read-body', error: String((e && e.message) || e) };
  }

  const finalUrl = res.url || baseUrl; // post-redirect
  const links = parseIconLinks(html);
  const chosen = pickBestIcon(links);
  let iconUrl = null;
  if (chosen) {
    try {
      iconUrl = new URL(chosen.href, finalUrl).toString();
    } catch { /* malformed href on the chosen tag — nothing usable came of it */ }
  }
  if (!iconUrl && !hasAnyIconTag(html)) {
    // Nothing declared at all (not even a malformed attempt) — the
    // documented /favicon.ico fallback applies here, not a guess ahead of
    // the markup.
    try {
      iconUrl = new URL('/favicon.ico', finalUrl).toString();
    } catch { /* malformed base — nothing more to try */ }
  }
  return { ok: true, baseUrl, finalUrl, links, chosen, iconUrl };
}

async function discoverIconUrl(baseUrl) {
  const result = await discoverIconDetailed(baseUrl);
  return result.ok ? result.iconUrl : null;
}

// A discovered icon URL may be rooted at the internal address we used to
// find it — meaningless to the browser. Re-root it onto the resource's
// public origin, keeping the discovered path/query, so the browser can
// reach it (often via Pangolin's own magic DNS). A no-op when discovery
// already ran against the public URL.
function rebaseOntoPublic(discoveredUrl, resource) {
  if (!resource.url) return discoveredUrl;
  try {
    const discovered = new URL(discoveredUrl);
    const publicOrigin = new URL(resource.url).origin;
    return `${publicOrigin}${discovered.pathname}${discovered.search}`;
  } catch {
    return discoveredUrl;
  }
}

function effectivePort(u) {
  return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
}

// The Pangolin resource whose internal target is the same host:port as
// `internalUrl` (e.g. the Jellyfin URL the server calls), or null. Uses the
// same internal address candidateBaseUrls builds, so the INTERNAL_HOST
// loopback substitution applies here too. Resources without a public URL
// and disabled resources are skipped: they cannot serve as a browser-reachable
// address (an old, disabled resource may still target the same port).
function findPublicResource(internalUrl, resources) {
  let target;
  try {
    target = new URL(internalUrl);
  } catch {
    return null;
  }
  for (const resource of Array.isArray(resources) ? resources : []) {
    if (resource.enabled === false || !resource.url || !resource.destination || !resource.destinationPort) continue;
    let internal;
    try {
      internal = new URL(candidateBaseUrls(resource)[0]);
    } catch {
      continue;
    }
    if (internal.hostname === target.hostname && effectivePort(internal) === effectivePort(target)) return resource;
  }
  return null;
}

module.exports = { findPublicResource, candidateBaseUrls, parseIconLinks, pickBestIcon, discoverIconUrl, discoverIconDetailed, rebaseOntoPublic };
