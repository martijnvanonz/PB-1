// Jellyfin active-sessions widget data. Zero dependencies.
//
// Credentials are read from src/settings.js on every call — never cached
// at module load — so a settings change takes effect on the next call.
//
// The pure logic (formatting, BlurHash colours, request paths, session
// mapping) lives in src/jellyfin-core.js. This file adds settings lookup,
// the server-side caches, the public click-through link and the image proxy.
//
// The configured URL is an INTERNAL address the server calls. The browser
// never sees it, and never sees the API key: posters and logos are fetched
// through image(), and cassette links are rebased onto a public hostname.

const settings = require('./settings');
const core = require('./jellyfin-core');
const pangolin = require('./pangolin');
const icons = require('./icons');

const CACHE_MS = 30 * 1000;

// Now-playing is live playback state (position, pause flag). A stale value
// here reads as wrong (a paused stream shown as playing), so this cache is
// much shorter than the others.
const NOWPLAYING_CACHE_MS = 5 * 1000;

let cache = { at: 0, data: null };
let resumeCache = { at: 0, data: null };
let nextUpCache = { at: 0, data: null };
let nowPlayingCache = { at: 0, data: null };

// The server's own internal id, needed to build a deep link into a
// specific item. Rarely if ever changes, so it is cached once per
// urlBase — re-fetched only if the configured Jellyfin URL changes.
let serverIdCache = { url: null, id: null };

// Discards every in-memory cache (sessions, resume list, server id). Call
// after a successful settings save so the very next request re-reads
// under the new URL/key/user instead of serving a result computed under
// the old ones — e.g. switching the selected Jellyfin user must not keep
// showing the previous user's resume list for up to 30 more seconds.
function invalidate() {
  cache = { at: 0, data: null };
  resumeCache = { at: 0, data: null };
  nextUpCache = { at: 0, data: null };
  nowPlayingCache = { at: 0, data: null };
  serverIdCache = { url: null, id: null };
}

async function getServerId(urlBase, apiKey) {
  if (serverIdCache.url === urlBase && serverIdCache.id) return serverIdCache.id;
  const id = await core.getServerId(urlBase, apiKey);
  serverIdCache = { url: urlBase, id };
  return id;
}

// Serves `cacheRef` while it is fresh, otherwise runs `load` and stores the
// answer — failures included, so a down Jellyfin is not hammered. `cacheRef`
// is mutated in place; each one MUST also be cleared in invalidate().
async function cached(cacheRef, force, ttl, load) {
  const now = Date.now();
  if (!force && cacheRef.data && now - cacheRef.at < ttl) return cacheRef.data;
  const data = await load();
  cacheRef.at = now;
  cacheRef.data = data;
  return data;
}

// Base URL for the cassette click-through links: the public URL of the
// Pangolin resource that targets the same host:port as the configured
// (internal) Jellyfin URL, so the link opens from outside the house. Falls
// back to the configured URL when Pangolin is off, unreachable or has no
// matching resource — a failed lookup must never fail the widget.
async function publicLinkBase(urlBase) {
  try {
    const snap = await pangolin.snapshot(false);
    const resource = icons.findPublicResource(urlBase, snap && snap.resources);
    if (resource) return core.trimBase(icons.rebaseOntoPublic(urlBase, resource));
  } catch {
    /* fall through to the configured URL */
  }
  return urlBase;
}

async function configured() {
  const s = await settings.load();
  return Boolean(s.jellyfin.url && s.jellyfin.apiKey);
}

async function getSessions(force = false) {
  const s = await settings.load();
  const creds = { url: core.trimBase(s.jellyfin.url), apiKey: s.jellyfin.apiKey || '' };
  if (!creds.url || !creds.apiKey) return null;
  return cached(cache, force, CACHE_MS, () => core.loadSessions(creds));
}

// Shared plumbing for the resume and next-up widgets.
async function fetchItemWidget(cacheRef, force, kind) {
  const s = await settings.load();
  const creds = { url: s.jellyfin.url, apiKey: s.jellyfin.apiKey, userId: s.jellyfin.userId };
  // Not-configured answers are never cached — they cost nothing to rebuild.
  if (!core.trimBase(creds.url) || !creds.apiKey || !(creds.userId || '').trim()) {
    return core.loadItems(kind, creds);
  }
  return cached(cacheRef, force, CACHE_MS, async () =>
    core.loadItems(kind, { ...creds, linkBase: await publicLinkBase(core.trimBase(creds.url)) }, getServerId)
  );
}

// Continue-watching data for the "jump into your next episode" widget.
// Never throws; on any failure returns ok:false with a message that
// never contains the API key.
async function resumeList(force = false) {
  return fetchItemWidget(resumeCache, force, 'resume');
}

// "Up next" data — episodes not yet started, for a separate widget next
// to continue-watching.
async function nextUpList(force = false) {
  return fetchItemWidget(nextUpCache, force, 'nextup');
}

// Live "now playing" data for the VHS-cassette now-playing widget. Cached
// for only NOWPLAYING_CACHE_MS (5s, not the usual 30s) since a stale
// paused/playing flag or position is worse than a slightly higher call
// rate. Never throws; on failure returns ok:false with a message that
// never contains the API key.
async function nowPlaying(force = false) {
  const s = await settings.load();
  const creds = { url: s.jellyfin.url, apiKey: s.jellyfin.apiKey };
  if (!core.trimBase(creds.url) || !creds.apiKey) return core.loadNowPlaying(creds);
  return cached(nowPlayingCache, force, NOWPLAYING_CACHE_MS, async () =>
    core.loadNowPlaying({ ...creds, linkBase: await publicLinkBase(core.trimBase(creds.url)) }, getServerId)
  );
}

// Lists Jellyfin accounts so the settings page can render a picker. Must
// work with only url+apiKey saved, before a userId has been chosen.
// Never includes the API key in the response or in an error message.
async function listUsers() {
  const s = await settings.load();
  const urlBase = core.trimBase(s.jellyfin.url);
  const apiKey = s.jellyfin.apiKey || '';
  if (!urlBase || !apiKey) {
    return { ok: false, users: [], error: 'Jellyfin is not configured.' };
  }
  try {
    const list = await core.getJson(urlBase, '/Users', apiKey);
    const users = Array.isArray(list) ? list.map((u) => ({ id: u.Id, name: u.Name || 'Unknown' })) : [];
    return { ok: true, users, error: null };
  } catch (e) {
    return { ok: false, users: [], error: core.describeFetchFailure(e, urlBase).message };
  }
}

// --- image proxy -------------------------------------------------------------

const IMAGE_TYPES = new Set(['Primary', 'Logo']);
const IMAGE_ID_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const IMAGE_MIN_WIDTH = 32;
const IMAGE_MAX_WIDTH = 800;
const IMAGE_DEFAULT_WIDTH = 200;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 8000;

// One poster or logo from Jellyfin, for GET /api/jellyfin/image. The upstream
// URL is built here from the configured Jellyfin URL; the request supplies
// only an item id, an image type from a whitelist and a clamped width, so no
// request-controlled URL or host ever reaches fetch. The API key goes in a
// header, never a URL, and never appears in the result. Never throws.
// Returns { status, contentType, body } on success, else { status, error }.
async function image({ id, type, maxWidth }) {
  if (!IMAGE_ID_RE.test(id || '')) return { status: 400, error: 'id must be a Jellyfin item id.' };
  if (!IMAGE_TYPES.has(type)) return { status: 400, error: 'type must be Primary or Logo.' };
  let width = IMAGE_DEFAULT_WIDTH;
  if (maxWidth !== null && maxWidth !== undefined && maxWidth !== '') {
    if (!/^\d{1,6}$/.test(maxWidth)) return { status: 400, error: 'maxWidth must be an integer.' };
    width = Math.min(IMAGE_MAX_WIDTH, Math.max(IMAGE_MIN_WIDTH, Number(maxWidth)));
  }

  const s = await settings.load();
  const urlBase = core.trimBase(s.jellyfin.url);
  const apiKey = s.jellyfin.apiKey || '';
  if (!urlBase || !apiKey) return { status: 404, error: 'Jellyfin is not configured.' };

  try {
    const res = await fetch(`${urlBase}/Items/${id}/Images/${type}?maxWidth=${width}`, {
      headers: { Authorization: `MediaBrowser Token="${apiKey}"` },
      redirect: 'manual', // a redirect could move the key to another host
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return { status: 404, error: 'No such image.' };
    }
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !/^image\//i.test(contentType)) {
      await res.body?.cancel();
      return { status: 502, error: 'Jellyfin did not return an image.' };
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared > IMAGE_MAX_BYTES) {
      await res.body?.cancel();
      return { status: 502, error: 'Image is too large.' };
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > IMAGE_MAX_BYTES) return { status: 502, error: 'Image is too large.' };
      chunks.push(chunk);
    }
    return { status: 200, contentType, body: Buffer.concat(chunks) };
  } catch (e) {
    return { status: 502, error: core.describeFetchFailure(e, urlBase).message };
  }
}

module.exports = { configured, image, getSessions, resumeList, nextUpList, nowPlaying, listUsers, invalidate };
