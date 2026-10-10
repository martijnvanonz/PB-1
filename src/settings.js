// Runtime settings store. Zero dependencies.
//
// Settings persist to $DATA_DIR/settings.json (mode 0600). Environment
// variables are read ONLY as a one-time seed the first time this file is
// created — after that, the file always wins. This lets an existing
// env-var-based install migrate itself the first time it boots against
// the new settings store, without losing its configuration.
//
// The parsed settings are cached in memory and invalidated on every save,
// so callers always see current values — nothing is captured at module
// load time.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || './data';
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const VERSION = 1;

function validationError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function defaultSettings() {
  return {
    version: VERSION,
    pangolin: { apiUrl: '', orgId: '', apiKey: '' },
    jellyfin: { url: '', apiKey: '', userId: '', fromBrowser: false },
    truenas: { url: '', apiKey: '', fromBrowser: false },
    branding: { model: 'PB-1', subtitle: 'サーバー' },
  };
}

function seedFromEnv() {
  const settings = defaultSettings();
  settings.pangolin.apiUrl = (process.env.PANGOLIN_API_URL || '').trim();
  settings.pangolin.orgId = (process.env.PANGOLIN_ORG_ID || '').trim();
  settings.pangolin.apiKey = process.env.PANGOLIN_API_KEY || '';
  settings.jellyfin.url = (process.env.JELLYFIN_URL || '').trim();
  settings.jellyfin.apiKey = process.env.JELLYFIN_API_KEY || '';
  return settings;
}

// --- validation ----------------------------------------------------------

function validateUrlField(value, label) {
  if (typeof value !== 'string') throw validationError(`${label} must be a string.`);
  const trimmed = value.trim();
  if (trimmed === '') return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw validationError(`${label} must be a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw validationError(`${label} must use http:// or https://.`);
  }
  return trimmed;
}

const ORG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validateOrgId(value) {
  if (typeof value !== 'string') throw validationError('pangolin.orgId must be a string.');
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (!ORG_ID_RE.test(trimmed)) {
    throw validationError('pangolin.orgId may only contain letters, digits, "_" and "-" (max 64 characters).');
  }
  return trimmed;
}

function validateApiKey(value, existing, label) {
  // Absent, null or empty string means "keep the existing key" — this is
  // what lets the settings form submit without ever holding the real key.
  if (value === undefined || value === null || value === '') return existing;
  if (typeof value !== 'string') throw validationError(`${label} must be a string.`);
  return value;
}

// Strict: "false" or 0 must not silently turn on a mode that hands the API
// key to every browser. Only a real boolean passes.
function validateBoolean(value, label) {
  if (typeof value !== 'boolean') throw validationError(`${label} must be true or false.`);
  return value;
}

function validateJellyfinUserId(value) {
  if (typeof value !== 'string') throw validationError('jellyfin.userId must be a string.');
  const trimmed = value.trim();
  if (trimmed.length > 64) {
    throw validationError('jellyfin.userId must be 64 characters or fewer.');
  }
  return trimmed;
}

function validateModel(value) {
  if (typeof value !== 'string') throw validationError('branding.model must be a string.');
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 12) {
    throw validationError('branding.model must be 1 to 12 characters.');
  }
  return trimmed;
}

function validateSubtitle(value) {
  if (typeof value !== 'string') throw validationError('branding.subtitle must be a string.');
  if (value.length > 24) {
    throw validationError('branding.subtitle must be 24 characters or fewer.');
  }
  return value;
}

// Merges `patch` on top of `current`, validating every field. Unknown
// top-level keys are ignored, not an error.
function mergeAndValidate(current, patch) {
  const next = defaultSettings();
  next.version = VERSION;

  const p = (patch && typeof patch === 'object' && patch.pangolin) || {};
  next.pangolin.apiUrl = validateUrlField(
    p.apiUrl !== undefined ? p.apiUrl : current.pangolin.apiUrl,
    'pangolin.apiUrl'
  );
  next.pangolin.orgId = validateOrgId(p.orgId !== undefined ? p.orgId : current.pangolin.orgId);
  next.pangolin.apiKey = validateApiKey(p.apiKey, current.pangolin.apiKey, 'pangolin.apiKey');

  const j = (patch && typeof patch === 'object' && patch.jellyfin) || {};
  next.jellyfin.url = validateUrlField(j.url !== undefined ? j.url : current.jellyfin.url, 'jellyfin.url');
  next.jellyfin.apiKey = validateApiKey(j.apiKey, current.jellyfin.apiKey, 'jellyfin.apiKey');
  next.jellyfin.userId = validateJellyfinUserId(
    j.userId !== undefined ? j.userId : current.jellyfin.userId
  );
  next.jellyfin.fromBrowser = validateBoolean(
    j.fromBrowser !== undefined ? j.fromBrowser : current.jellyfin.fromBrowser,
    'jellyfin.fromBrowser'
  );

  const t = (patch && typeof patch === 'object' && patch.truenas) || {};
  next.truenas.url = validateUrlField(t.url !== undefined ? t.url : current.truenas.url, 'truenas.url');
  next.truenas.apiKey = validateApiKey(t.apiKey, current.truenas.apiKey, 'truenas.apiKey');
  next.truenas.fromBrowser = validateBoolean(
    t.fromBrowser !== undefined ? t.fromBrowser : current.truenas.fromBrowser,
    'truenas.fromBrowser'
  );

  const b = (patch && typeof patch === 'object' && patch.branding) || {};
  next.branding.model = validateModel(b.model !== undefined ? b.model : current.branding.model);
  next.branding.subtitle = validateSubtitle(
    b.subtitle !== undefined ? b.subtitle : current.branding.subtitle
  );

  return next;
}

// --- persistence -----------------------------------------------------------

let cache = null; // in-memory cache of the parsed settings; null = not loaded

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function readFromDisk() {
  const raw = await fsp.readFile(SETTINGS_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  // Merge onto defaults so a settings.json from an older/partial version
  // never leaves a field undefined.
  return mergeAndValidate(defaultSettings(), parsed);
}

async function writeToDisk(settings) {
  ensureDir();
  const tmp = path.join(DATA_DIR, `.settings.json.tmp-${process.pid}-${crypto.randomUUID()}`);
  await fsp.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8', { mode: 0o600 });
  await fsp.chmod(tmp, 0o600);
  await fsp.rename(tmp, SETTINGS_FILE);
  try {
    await fsp.chmod(SETTINGS_FILE, 0o600);
  } catch {
    /* best effort — rename preserves the tmp file's mode on most platforms */
  }
}

// Loads current settings, seeding from environment variables the first
// time (when settings.json does not yet exist). Cached in memory until
// the next save().
async function load() {
  if (cache) return cache;
  try {
    cache = await readFromDisk();
    return cache;
  } catch {
    // No settings.json yet (or it's unreadable/corrupt) — seed from env
    // and try to persist immediately so the file becomes the source of
    // truth from here on. If DATA_DIR is not writable (e.g. read-only
    // filesystem), don't fail every request that needs settings — log the
    // reason once and keep serving the seeded settings from memory for
    // this run. cache is set either way, so this branch (and the log) only
    // runs once; later calls return the cached value directly.
    const seeded = seedFromEnv();
    try {
      await writeToDisk(seeded);
    } catch (writeErr) {
      console.warn(
        `settings: could not write ${SETTINGS_FILE} (${writeErr.message}); serving in-memory defaults for this run.`
      );
    }
    cache = seeded;
    return cache;
  }
}

// Validates and persists `patch` merged onto the current settings.
// Returns the new settings object. Throws a validation Error (status 400)
// on bad input — never partially applies a patch.
async function save(patch) {
  const current = await load();
  const next = mergeAndValidate(current, patch);
  await writeToDisk(next);
  cache = next;
  return cache;
}

function hintFor(apiKey) {
  if (typeof apiKey === 'string' && apiKey.length >= 8) return apiKey.slice(-4);
  return null;
}

// The safe, external view of settings: never includes a raw apiKey, only
// a last-4-characters hint (or null if too short / unset).
function toPublicView(settings) {
  return {
    configured: isConfigured(settings),
    pangolin: {
      apiUrl: settings.pangolin.apiUrl,
      orgId: settings.pangolin.orgId,
      apiKeyHint: hintFor(settings.pangolin.apiKey),
    },
    jellyfin: {
      url: settings.jellyfin.url,
      apiKeyHint: hintFor(settings.jellyfin.apiKey),
      userId: settings.jellyfin.userId,
      fromBrowser: settings.jellyfin.fromBrowser,
    },
    truenas: {
      url: settings.truenas.url,
      apiKeyHint: hintFor(settings.truenas.apiKey),
      fromBrowser: settings.truenas.fromBrowser,
    },
    branding: {
      model: settings.branding.model,
      subtitle: settings.branding.subtitle,
    },
  };
}

async function publicView() {
  const settings = await load();
  return toPublicView(settings);
}

function isConfigured(settings) {
  return Boolean(settings.pangolin.apiUrl && settings.pangolin.orgId && settings.pangolin.apiKey);
}

// True when Pangolin has enough configured to attempt an API call.
async function configured() {
  const settings = await load();
  return isConfigured(settings);
}

// The ONE place a raw key may leave the server for a browser: only for
// services whose "Call from browser" flag is on. Everything else stays
// server-side. Returns {} when no service opted in.
async function browserCredentials() {
  const s = await load();
  const out = {};
  if (s.jellyfin.fromBrowser) {
    out.jellyfin = { url: s.jellyfin.url, apiKey: s.jellyfin.apiKey, userId: s.jellyfin.userId };
  }
  if (s.truenas.fromBrowser) {
    out.truenas = { url: s.truenas.url, apiKey: s.truenas.apiKey };
  }
  return out;
}

module.exports = {
  DATA_DIR,
  SETTINGS_FILE,
  load,
  save,
  publicView,
  configured,
  browserCredentials,
};
