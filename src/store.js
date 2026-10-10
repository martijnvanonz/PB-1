// Layout persistence + on-disk icon cache. Zero dependencies.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || './data';
const LAYOUT_FILE = path.join(DATA_DIR, 'layout.json');
const ICONS_DIR = path.join(DATA_DIR, 'icons');
const ICON_HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ICON_NEG_TTL_MS = 24 * 60 * 60 * 1000;

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ICONS_DIR, { recursive: true });
}

// --- stale tmp file sweep -------------------------------------------------
// Writes go through a tmp-then-rename pattern (".<name>.tmp-<pid>-<uuid>").
// If the process is killed mid-write, the tmp file is orphaned and nothing
// else ever removes it. On startup, sweep DATA_DIR for tmp files matching
// exactly that pattern that are older than an hour and delete them. The
// pattern is deliberately narrow — a dotfile starting with ".tmp-" is never
// a real data file this app writes, so this can never touch settings.json,
// layout.json, or anything under icons/.
const STALE_TMP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const TMP_FILE_RE = /^\..+\.tmp-\d+-[0-9a-f-]+$/i;

function sweepStaleTmpFiles(dir = DATA_DIR, maxAgeMs = STALE_TMP_MAX_AGE_MS) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // dir doesn't exist yet — nothing to sweep
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!TMP_FILE_RE.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(full);
        console.warn(`store: removed stale tmp file ${entry.name}`);
      }
    } catch {
      /* file vanished or is unreadable — ignore, not our problem */
    }
  }
}

const THEMES = new Set(['ko', 'riddim']);
const WIDGETS = new Set(['jellyfin-resume', 'jellyfin-nextup', 'jellyfin-nowplaying', 'truenas']);

function validationError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function defaultLayout() {
  return { version: 1, groups: [], hidden: [], favorites: [], theme: 'ko' };
}

// Validates and normalizes a single item. Throws a validationError on any
// problem — shared by the strict (write) and tolerant (read) paths so both
// agree on what "valid" means; they differ only in what happens when this
// throws.
function sanitizeItemStrict(it) {
  if (!it || typeof it !== 'object') throw validationError('Each item must be an object.');
  if (it.type === 'pangolin') {
    if (typeof it.key !== 'string' || !it.key) throw validationError('Pangolin item needs a key.');
    return { type: 'pangolin', key: it.key };
  }
  if (it.type === 'manual') {
    if (typeof it.id !== 'string' || !it.id) throw validationError('Manual item needs an id.');
    if (typeof it.name !== 'string' || !it.name) throw validationError('Manual item needs a name.');
    if (typeof it.url !== 'string' || !it.url) throw validationError('Manual item needs a url.');
    return { type: 'manual', id: it.id, name: it.name, url: it.url };
  }
  if (it.type === 'widget') {
    if (typeof it.id !== 'string' || !it.id) throw validationError('Widget item needs an id.');
    if (typeof it.widget !== 'string' || !WIDGETS.has(it.widget)) {
      throw validationError(`Unknown widget: ${it.widget}`);
    }
    return { type: 'widget', id: it.id, widget: it.widget };
  }
  throw validationError(`Unknown item type: ${it.type}`);
}

// Strict: the WRITE path. A single bad item, group, or duplicate id fails
// the whole request with a 400 — a bad payload from the client is a real
// error and must never be silently swallowed or partially applied.
function sanitizeLayout(input) {
  if (!input || typeof input !== 'object') throw validationError('Layout must be an object.');
  const groups = Array.isArray(input.groups) ? input.groups : [];
  const hidden = Array.isArray(input.hidden) ? input.hidden : [];
  const favorites = Array.isArray(input.favorites) ? input.favorites : [];
  const theme = THEMES.has(input.theme) ? input.theme : 'ko';

  const seenGroupIds = new Set();
  const cleanGroups = groups.map((g) => {
    if (!g || typeof g !== 'object') throw validationError('Each group must be an object.');
    if (typeof g.id !== 'string' || !g.id) throw validationError('Group id must be a non-empty string.');
    if (seenGroupIds.has(g.id)) throw validationError(`Duplicate group id: ${g.id}`);
    seenGroupIds.add(g.id);
    if (typeof g.name !== 'string') throw validationError('Group name must be a string.');
    const items = Array.isArray(g.items) ? g.items : [];
    const cleanItems = items.map(sanitizeItemStrict);
    return { id: g.id, name: g.name, items: cleanItems };
  });

  const cleanHidden = hidden.filter((h) => typeof h === 'string');
  const cleanFavorites = favorites.filter((f) => typeof f === 'string');
  return { version: 1, groups: cleanGroups, hidden: cleanHidden, favorites: cleanFavorites, theme };
}

// Tolerant: the READ path. layout.json on disk is not user input at the
// moment of reading it — it was already validated when it was written (or
// it's stale from an older server version, e.g. after rolling back a
// deploy while a newer widget type is still referenced in the file). A
// single unrecognised item must never wipe the rest of a user's layout:
// invalid items are dropped, valid ones and their groups (even if a group
// ends up with zero items) survive. Only a genuinely unusable group
// (missing/duplicate id, non-string name) is dropped outright. Skips are
// logged once as a count — never the layout contents, never a secret.
function sanitizeLayoutTolerant(input) {
  if (!input || typeof input !== 'object') return defaultLayout();
  const groups = Array.isArray(input.groups) ? input.groups : [];
  const hidden = Array.isArray(input.hidden) ? input.hidden : [];
  const favorites = Array.isArray(input.favorites) ? input.favorites : [];
  const theme = THEMES.has(input.theme) ? input.theme : 'ko';

  let skippedItems = 0;
  let skippedGroups = 0;
  const seenGroupIds = new Set();
  const cleanGroups = [];
  for (const g of groups) {
    const validGroupShape =
      g && typeof g === 'object' && typeof g.id === 'string' && g.id && typeof g.name === 'string';
    if (!validGroupShape || seenGroupIds.has(g.id)) {
      skippedGroups++;
      continue;
    }
    seenGroupIds.add(g.id);
    const items = Array.isArray(g.items) ? g.items : [];
    const cleanItems = [];
    for (const it of items) {
      try {
        cleanItems.push(sanitizeItemStrict(it));
      } catch {
        skippedItems++;
      }
    }
    cleanGroups.push({ id: g.id, name: g.name, items: cleanItems });
  }

  if (skippedItems > 0 || skippedGroups > 0) {
    console.warn(
      `store: layout.json had ${skippedItems} invalid item(s) and ${skippedGroups} invalid/duplicate group(s); skipped on load.`
    );
  }

  const cleanHidden = hidden.filter((h) => typeof h === 'string');
  const cleanFavorites = favorites.filter((f) => typeof f === 'string');
  return { version: 1, groups: cleanGroups, hidden: cleanHidden, favorites: cleanFavorites, theme };
}

async function loadLayout() {
  try {
    const raw = await fsp.readFile(LAYOUT_FILE, 'utf8');
    return sanitizeLayoutTolerant(JSON.parse(raw));
  } catch {
    return defaultLayout();
  }
}

async function saveLayout(layout) {
  const clean = sanitizeLayout(layout);
  ensureDirs();
  const tmp = path.join(DATA_DIR, `.layout.json.tmp-${process.pid}-${crypto.randomUUID()}`);
  await fsp.writeFile(tmp, JSON.stringify(clean, null, 2), 'utf8');
  await fsp.rename(tmp, LAYOUT_FILE);
  return clean;
}

// --- icon URL cache -----------------------------------------------------
// Keyed by the resource's own key (not a URL — the endpoint never takes a
// user-supplied URL). Caches the DISCOVERED URL STRING, not image bytes —
// the server no longer fetches icons, only finds where they are; the
// browser fetches the actual image itself. Negatives cache too, with a
// shorter TTL, so a resource with no discoverable icon doesn't get its
// HTML re-crawled on every request.

function iconCachePath(key) {
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  return path.join(ICONS_DIR, `${hash}.json`);
}

async function getCachedIconUrl(key) {
  const file = iconCachePath(key);
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    const ttl = parsed.url ? ICON_HIT_TTL_MS : ICON_NEG_TTL_MS;
    if (Date.now() - parsed.at > ttl) return null; // expired — re-discover
    return { url: parsed.url };
  } catch {
    return null;
  }
}

async function writeIconCache(key, url) {
  ensureDirs();
  const file = iconCachePath(key);
  const tmp = path.join(ICONS_DIR, `.icon.tmp-${process.pid}-${crypto.randomUUID()}`);
  await fsp.writeFile(tmp, JSON.stringify({ url, at: Date.now() }));
  await fsp.rename(tmp, file);
}

function saveIconUrlHit(key, url) {
  return writeIconCache(key, url);
}

function saveIconUrlMiss(key) {
  return writeIconCache(key, null);
}

// Run the stale-tmp sweep once, at module load — i.e. on server startup,
// since this module is required unconditionally at boot. Never let a sweep
// failure block startup.
try {
  sweepStaleTmpFiles();
} catch (e) {
  console.warn(`store: tmp file sweep failed (${e.message})`);
}

module.exports = {
  DATA_DIR,
  ensureDirs,
  defaultLayout,
  sanitizeLayout,
  loadLayout,
  saveLayout,
  getCachedIconUrl,
  saveIconUrlHit,
  saveIconUrlMiss,
  sweepStaleTmpFiles,
};
