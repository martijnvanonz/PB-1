// Jellyfin active-sessions widget data. Zero dependencies.
//
// Credentials are read from src/settings.js on every call — never cached
// at module load — so a settings change takes effect on the next call.
//
// The pure logic (formatting, BlurHash colours, request paths, session
// mapping) lives in public/shared/jellyfin-core.js so the browser can run
// the exact same code when "Call from browser" is on. This file only adds
// settings lookup and the server-side caches.

const settings = require('./settings');
const core = require('../public/shared/jellyfin-core');

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
  return cached(cacheRef, force, CACHE_MS, () => core.loadItems(kind, creds, getServerId));
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
  return cached(nowPlayingCache, force, NOWPLAYING_CACHE_MS, () => core.loadNowPlaying(creds, getServerId));
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

module.exports = { configured, getSessions, resumeList, nextUpList, nowPlaying, listUsers, invalidate };
