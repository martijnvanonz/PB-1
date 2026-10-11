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
    jellyfin: { url: '', apiKey: '', userId: '' },
    truenas: { url: '', apiKey: '', certFingerprint: '' },
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

// TrueNAS 25.04+ revokes an API key the moment it is used over plain
// http/ws, so an http:// URL here would destroy the key on first use.
//
// `fromDisk` skips the https rule: an older settings.json may still hold an
// http:// URL, and a validation failure while loading would make load()
// treat the file as corrupt and overwrite it. The rule applies to every save.
function validateTruenasUrl(value, fromDisk) {
  const url = validateUrlField(value, 'truenas.url');
  if (!fromDisk && url && new URL(url).protocol === 'http:') {
    throw validationError(
      'truenas.url must use https://. TrueNAS 25.04 and newer revoke an API key that is used over plain HTTP.'
    );
  }
  return url;
}

// SHA-256 fingerprint of the TrueNAS certificate, the format Node prints
// for getPeerCertificate().fingerprint256: 32 hex pairs joined by colons.
// Stored upper-case so comparisons never depend on how it was pasted.
const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

function validateCertFingerprint(value) {
  if (typeof value !== 'string') throw validationError('truenas.certFingerprint must be a string.');
  const trimmed = value.trim().toUpperCase();
  if (trimmed === '') return '';
  if (!FINGERPRINT_RE.test(trimmed)) {
    throw validationError('truenas.certFingerprint must be a SHA-256 fingerprint: 32 hex pairs separated by colons.');
  }
  return trimmed;
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
function mergeAndValidate(current, patch, fromDisk = false) {
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

  const t = (patch && typeof patch === 'object' && patch.truenas) || {};
  next.truenas.url = validateTruenasUrl(t.url !== undefined ? t.url : current.truenas.url, fromDisk);
  next.truenas.apiKey = validateApiKey(t.apiKey, current.truenas.apiKey, 'truenas.apiKey');
  next.truenas.certFingerprint = validateCertFingerprint(
    t.certFingerprint !== undefined ? t.certFingerprint : current.truenas.certFingerprint
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
  return mergeAndValidate(defaultSettings(), parsed, true);
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
    },
    truenas: {
      url: settings.truenas.url,
      apiKeyHint: hintFor(settings.truenas.apiKey),
      certFingerprint: settings.truenas.certFingerprint,
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

module.exports = {
  DATA_DIR,
  SETTINGS_FILE,
  load,
  save,
  publicView,
  configured,
};
