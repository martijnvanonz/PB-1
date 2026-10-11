// Jellyfin logic: BlurHash colours, item formatting, request paths and the
// transport. Pure apart from fetch/AbortSignal. Caching and settings stay in
// src/jellyfin.js.

  const REQUEST_TIMEOUT_MS = 5000;

// Jellyfin RunTimeTicks are 100-nanosecond units. 1 minute = 60s * 1e7
// ticks/second = 600,000,000 ticks.
const TICKS_PER_MINUTE = 600000000;

// --- BlurHash -> band colour --------------------------------------------
//
// We only ever need the DC (average colour) component, decoded in plain JS
// from the BlurHash Jellyfin already returns in ImageBlurHashes — no image
// fetch, no canvas. The base83 alphabet used by BlurHash starts with the
// digits, NOT 'A' — getting this wrong makes every decode silently wrong
// while still looking plausible, so it is written out in full here rather
// than derived.
const BLURHASH_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function decode83(str) {
  let value = 0;
  for (let i = 0; i < str.length; i++) {
    const digit = BLURHASH_ALPHABET.indexOf(str[i]);
    if (digit === -1) return null;
    value = value * 83 + digit;
  }
  return value;
}

// Decodes only the DC (average colour) component of a BlurHash, validating
// the header against the string length first. Returns {r,g,b} sRGB bytes,
// or null if the hash is malformed/unusable — callers must fall back to a
// neutral grey rather than trust a partially-decoded value.
function averageColorFromBlurHash(hash) {
  if (typeof hash !== 'string' || hash.length < 6) return null;
  const sizeFlag = decode83(hash[0]);
  if (sizeFlag === null) return null;
  const numY = Math.floor(sizeFlag / 9) + 1;
  const numX = (sizeFlag % 9) + 1;
  const expectedLength = 4 + 2 * numX * numY;
  if (hash.length !== expectedLength) return null;
  const dc = decode83(hash.slice(2, 6));
  if (dc === null || dc > 0xffffff) return null;
  return { r: (dc >> 16) & 255, g: (dc >> 8) & 255, b: dc & 255 };
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
  }
  h *= 60;
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1, g1, b1;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

function srgbToLinear(c) {
  const cs = c / 255;
  return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

function relativeLuminance(r, g, b) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

// Jellyfin's ImageBlurHashes is keyed by image type, then by image tag:
// { Primary: { "<tag>": "hash" }, Backdrop: { ... }, ... }. Prefer
// Primary, then Thumb, then Backdrop.
function pickBlurHash(item) {
  const bh = item && item.ImageBlurHashes;
  if (!bh || typeof bh !== 'object') return null;
  for (const key of ['Primary', 'Thumb', 'Backdrop']) {
    const map = bh[key];
    if (map && typeof map === 'object') {
      const hash = Object.values(map)[0];
      if (typeof hash === 'string' && hash) return hash;
    }
  }
  return null;
}

// Turns a BlurHash into a settled colour band: same hue as the artwork's
// average colour, saturation boosted (raw poster averages are mud) and
// clamped, lightness fixed at 47% for every tape so the set reads as a
// boxed set. A malformed/unusable hash falls back to neutral grey (0%
// saturation) rather than emitting a wrong colour. bandTextColor is
// whichever of white/black gives more contrast against the resulting band.
function bandColorFromBlurHash(hash) {
  const avg = averageColorFromBlurHash(hash);
  let hue = 0;
  let satFraction = 0;
  if (avg) {
    const hsl = rgbToHsl(avg.r, avg.g, avg.b);
    hue = Math.round(hsl.h);
    satFraction = Math.min(0.82, Math.max(0.46, hsl.s * 1.9));
  }
  const satPct = Math.round(satFraction * 100);
  const bandColor = `hsl(${hue} ${satPct}% 47%)`;
  const rgb = hslToRgb(hue, satFraction, 0.47);
  const l = relativeLuminance(rgb.r, rgb.g, rgb.b);
  const contrastWhite = 1.05 / (l + 0.05);
  const contrastBlack = (l + 0.05) / 0.05;
  const bandTextColor = contrastWhite >= contrastBlack ? '#FFFFFF' : '#141414';
  return { bandColor, bandTextColor };
}

// Posters and logos go through the server (GET /api/jellyfin/image): the
// Jellyfin URL is an internal address the browser may not reach, and the API
// key must stay on the server.
function imageProxyUrl(id, type, maxWidth) {
  return `/api/jellyfin/image?id=${encodeURIComponent(id)}&type=${type}&maxWidth=${maxWidth}`;
}

// Shared item formatter for the resume, next-up, AND now-playing widgets,
// so the frontend never needs any Jellyfin-specific logic. An Episode is
// shown under its series name with an "SxEy · Episode Name" subtitle;
// anything else (a Film, etc.) is shown under its own name with an empty
// subtitle — never "SundefinedEundefined".
//
// `livePositionTicks` is the one now-playing-only extra: when given (a
// number), progress/leftMin are computed from it instead of from
// UserData, since a live session's position lives on PlayState, not on
// the item's UserData. Resume/next-up pass nothing and get the old
// UserData-based behaviour unchanged.
function formatJellyfinItem(it, linkBase, serverId, withProgress, livePositionTicks) {
  const isEpisode = it.Type === 'Episode';
  const title = isEpisode ? it.SeriesName || it.Name || 'Unknown' : it.Name || 'Unknown';
  let subtitle = '';
  if (isEpisode) {
    const season = it.ParentIndexNumber;
    const episode = it.IndexNumber;
    const seasonEpisode = season != null && episode != null ? `S${season}E${episode}` : '';
    const epName = it.Name || '';
    subtitle = seasonEpisode && epName ? `${seasonEpisode} · ${epName}` : seasonEpisode || epName;
  }
  const url = `${linkBase}/web/#/details?id=${encodeURIComponent(it.Id)}&serverId=${encodeURIComponent(serverId)}`;

  const runMin = typeof it.RunTimeTicks === 'number' ? Math.round(it.RunTimeTicks / TICKS_PER_MINUTE) : null;
  let progress = null;
  let leftMin = null;
  if (withProgress && typeof livePositionTicks === 'number' && typeof it.RunTimeTicks === 'number') {
    // Live session: position comes from PlayState.PositionTicks, polled
    // fresh every call — never fabricate a 0 leftMin, clamp instead.
    progress = it.RunTimeTicks > 0 ? Math.round((livePositionTicks / it.RunTimeTicks) * 100) : null;
    leftMin = Math.max(0, Math.round((it.RunTimeTicks - livePositionTicks) / TICKS_PER_MINUTE));
  } else if (withProgress && it.UserData && typeof it.UserData.PlayedPercentage === 'number') {
    progress = Math.round(it.UserData.PlayedPercentage);
    if (typeof it.RunTimeTicks === 'number' && typeof it.UserData.PlaybackPositionTicks === 'number') {
      leftMin = Math.max(0, Math.round((it.RunTimeTicks - it.UserData.PlaybackPositionTicks) / TICKS_PER_MINUTE));
    }
  }

  const posterId = isEpisode ? it.SeriesId || it.Id : it.Id;
  const posterUrl = imageProxyUrl(posterId, 'Primary', 200);
  const logoUrl = it.ParentLogoItemId
    ? imageProxyUrl(it.ParentLogoItemId, 'Logo', 260)
    : null;

  const { bandColor, bandTextColor } = bandColorFromBlurHash(pickBlurHash(it));

  return {
    id: it.Id,
    serverId,
    title,
    subtitle,
    series: title,
    season: isEpisode && it.ParentIndexNumber != null ? it.ParentIndexNumber : null,
    episode: isEpisode && it.IndexNumber != null ? it.IndexNumber : null,
    episodeName: isEpisode ? it.Name || '' : '',
    progress,
    runMin,
    leftMin,
    posterUrl,
    logoUrl,
    bandColor,
    bandTextColor,
    url,
  };
}


// --- request paths -----------------------------------------------------------

const SESSIONS_PATH = '/Sessions';

const resumePath = (userId) =>
  `/Users/${encodeURIComponent(userId)}/Items/Resume?Limit=12&MediaTypes=Video&Fields=ImageBlurHashes,ParentLogoItemId`;

// enableResumable=false is load-bearing: without it NextUp also returns
// part-watched episodes, duplicating the resume list.
const nextUpPath = (userId) =>
  `/Shows/NextUp?userId=${encodeURIComponent(userId)}&enableResumable=false&Limit=12&Fields=ImageBlurHashes,ParentLogoItemId`;

// Both item widgets share fetch/format plumbing; progress is always null for
// next-up — those episodes are unstarted, so there is genuinely nothing to
// report (not a fabricated 0, which would read as "started and abandoned").
const ITEM_KINDS = {
  resume: { path: resumePath, withProgress: true },
  nextup: { path: nextUpPath, withProgress: false },
};

function trimBase(url) {
  return (url || '').replace(/\/+$/, '');
}

// --- failures ------------------------------------------------------------------

// fetch throws a bare, generic "fetch failed" / "Failed to fetch" (or a
// timeout/abort) with no indication of what host it tried to reach. Turn
// that into something the user can act on, naming only the origin —
// never the full URL (which could carry a query string) and never the
// API key.
function isNetworkFailure(e) {
  return Boolean(e) && (e instanceof TypeError || e.name === 'TimeoutError' || e.name === 'AbortError');
}

function describeFetchFailure(e, urlBase) {
  if (!isNetworkFailure(e)) return e;
  let origin = urlBase;
  try {
    origin = new URL(urlBase).origin;
  } catch {
    /* urlBase already has no query string; use it as-is */
  }
  return new Error(`Cannot reach Jellyfin at ${origin}`);
}

// --- transport (platform-neutral) ----------------------------------------------

async function getJson(urlBase, path, apiKey) {
  const res = await fetch(`${urlBase}${path}`, {
    headers: { Authorization: `MediaBrowser Token="${apiKey}"` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function getServerId(urlBase, apiKey) {
  const info = await getJson(urlBase, '/System/Info', apiKey);
  return info.Id;
}

// --- result builders -------------------------------------------------------------

// The click-through link base: creds.linkBase (the public address the
// browser can reach) when given, else the address the server itself calls.
function linkBaseOf(creds, urlBase) {
  return trimBase(creds.linkBase) || urlBase;
}

// `creds` is { url, apiKey, userId, linkBase }. `serverIdFor(urlBase, apiKey)` lets the
// server plug in its cached lookup; the browser uses the plain one. Every
// loader never throws and returns the endpoint shape { ok, items, error }.

async function loadItems(kind, creds, serverIdFor = getServerId) {
  const urlBase = trimBase(creds.url);
  const apiKey = creds.apiKey || '';
  const userId = (creds.userId || '').trim();
  if (!urlBase || !apiKey) return { ok: false, items: [], error: 'Jellyfin is not configured.' };
  if (!userId) return { ok: false, items: [], error: 'Jellyfin user is not selected.' };
  const { path, withProgress } = ITEM_KINDS[kind];
  try {
    const serverId = await serverIdFor(urlBase, apiKey);
    const body = await getJson(urlBase, path(userId), apiKey);
    const rawItems = Array.isArray(body.Items) ? body.Items : [];
    const items = rawItems.map((it) => formatJellyfinItem(it, linkBaseOf(creds, urlBase), serverId, withProgress));
    return { ok: true, items, error: null };
  } catch (e) {
    return { ok: false, items: [], error: describeFetchFailure(e, urlBase).message };
  }
}

// One item per active session — multiple people can be watching at once.
// Nothing playing is a normal state, not an error: { ok: true, items: [] }.
// Same item shape as the resume/next-up lists (same formatter) plus
// playback-only fields: userName, isPaused, playMethod, transcodeReason,
// client, device.
function nowPlayingItems(sessions, linkBase, serverId) {
  const playing = (Array.isArray(sessions) ? sessions : []).filter((sess) => sess.NowPlayingItem);
  return playing.map((session) => {
    const it = session.NowPlayingItem;
    const playState = session.PlayState || {};
    const transcodingInfo = session.TranscodingInfo || {};
    const positionTicks = typeof playState.PositionTicks === 'number' ? playState.PositionTicks : null;
    const base = formatJellyfinItem(it, linkBase, serverId, true, positionTicks);
    const reasons = Array.isArray(transcodingInfo.TranscodeReasons) ? transcodingInfo.TranscodeReasons : [];
    return {
      ...base,
      userName: session.UserName || 'Unknown',
      isPaused: Boolean(playState.IsPaused),
      playMethod: playState.PlayMethod || null,
      transcodeReason: reasons.length ? reasons[0] : null,
      client: session.Client || null,
      device: session.DeviceName || null,
    };
  });
}

async function loadNowPlaying(creds, serverIdFor = getServerId) {
  const urlBase = trimBase(creds.url);
  const apiKey = creds.apiKey || '';
  if (!urlBase || !apiKey) return { ok: false, items: [], error: 'Jellyfin is not configured.' };
  try {
    const serverId = await serverIdFor(urlBase, apiKey);
    const sessions = await getJson(urlBase, SESSIONS_PATH, apiKey);
    return { ok: true, items: nowPlayingItems(sessions, linkBaseOf(creds, urlBase), serverId), error: null };
  } catch (e) {
    return { ok: false, items: [], error: describeFetchFailure(e, urlBase).message };
  }
}

// The small "who is watching what" summary behind /api/state.
async function loadSessions(creds) {
  const urlBase = trimBase(creds.url);
  try {
    const sessions = await getJson(urlBase, SESSIONS_PATH, creds.apiKey || '');
    const playing = sessions.filter((s) => s.NowPlayingItem);
    return {
      activeCount: playing.length,
      sessions: playing.map((s) => ({
        userName: s.UserName || 'Unknown',
        itemName: s.NowPlayingItem.Name || 'Unknown',
      })),
      fetchedAt: new Date().toISOString(),
      error: null,
    };
  } catch (e) {
    return { activeCount: 0, sessions: [], fetchedAt: null, error: describeFetchFailure(e, urlBase).message };
  }
}

module.exports = {
  trimBase,
  getJson,
  getServerId,
  describeFetchFailure,
  averageColorFromBlurHash,
  bandColorFromBlurHash,
  formatJellyfinItem,
  loadItems,
  loadNowPlaying,
  loadSessions,
};
