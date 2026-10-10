// Patchbay server. node:http only, zero npm dependencies.

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const pangolin = require('./pangolin');
const store = require('./store');
const jellyfin = require('./jellyfin');
const truenas = require('./truenas');
const icons = require('./icons');
const settings = require('./settings');

const PORT = Number(process.env.PORT || 8288);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

// Extensions worth gzipping when the client sends Accept-Encoding: gzip.
// Never the woff2 font — it's already compressed, and re-compressing it
// only burns CPU for zero (or negative) size benefit.
const COMPRESSIBLE_EXT = new Set(['.js', '.css', '.html', '.json', '.svg']);

// The one accent colour that's constant across both colourways (--sub /
// --alert / --signal in ko; --sub / --alert in riddim) — read from
// public/styles.css by hand, not guessed. Used only for the inline
// favicon below; see handleFavicon.
const ACCENT = '#F04E23';

// --- helpers -----------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error(`Request body exceeds ${maxBytes} bytes.`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Request body is not valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Trim + drop a trailing slash so re-saving the settings form without
// touching a URL field never looks like a change. Anything falsy passes
// through unchanged (undefined stays undefined => "not part of the patch").
function normalizeUrlForCompare(value) {
  if (typeof value !== 'string') return value;
  return value.trim().replace(/\/+$/, '');
}

// An omitted, null, or empty-string credential means "keep the existing
// one" (see settings.js validateApiKey) — this mirrors that definition.
function isCredentialOmitted(value) {
  return value === undefined || value === null || value === '';
}

// Every service that pairs a destination URL with a bearer credential.
// If a patch changes the URL while leaning on the "omitted = keep the old
// key" behaviour, the (still-live) old key would get sent to whatever
// host now sits behind that URL. Reject that combination; require the
// caller to re-supply the credential in the same request instead.
const CREDENTIAL_PAIRS = [
  { service: 'pangolin', urlField: 'apiUrl', keyField: 'apiKey', label: 'pangolin API URL' },
  { service: 'jellyfin', urlField: 'url', keyField: 'apiKey', label: 'Jellyfin URL' },
  { service: 'truenas', urlField: 'url', keyField: 'apiKey', label: 'TrueNAS URL' },
];

// The rule looks only at the URL and the key, never at fromBrowser: pointing
// a service at a new host while keeping the old key is rejected whether or
// not the same request also flips "Call from browser" — flipping it would
// otherwise hand the old key to the browser for the new host.
//
// Returns an error message string if `patch` would leak a credential,
// otherwise null. `current` is the currently-saved settings object.
function findCredentialExfilRisk(current, patch) {
  if (!patch || typeof patch !== 'object') return null;
  for (const pair of CREDENTIAL_PAIRS) {
    const currentService = current[pair.service] || {};
    const patchService = patch[pair.service];
    if (!patchService || typeof patchService !== 'object') continue;

    const newUrl = patchService[pair.urlField];
    if (newUrl === undefined) continue; // URL not part of this patch at all

    const urlChanged =
      normalizeUrlForCompare(newUrl) !== normalizeUrlForCompare(currentService[pair.urlField]);
    if (!urlChanged) continue;

    const newKey = patchService[pair.keyField];
    const keyOmitted = isCredentialOmitted(newKey);
    const hasExistingKey = Boolean(currentService[pair.keyField]);
    if (keyOmitted && hasExistingKey) {
      return `Re-enter the API key when you change the ${pair.label}.`;
    }
  }
  return null;
}

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
  const resolved = path.resolve(path.join(PUBLIC_DIR, rel));
  const withinPublic = resolved === PUBLIC_DIR || resolved.startsWith(PUBLIC_DIR + path.sep);
  if (!withinPublic) return sendJson(res, 403, { error: 'Forbidden.' });

  let stat;
  try {
    stat = await fsp.stat(resolved);
    if (stat.isDirectory()) throw new Error('is a directory');
  } catch {
    return sendJson(res, 404, { error: 'Not found.' });
  }

  const ext = path.extname(resolved);
  const relFromPublic = path.relative(PUBLIC_DIR, resolved);
  const isVendor = relFromPublic.split(path.sep)[0] === 'vendor';
  const isHtml = ext === '.html';
  // app.js / styles.css (and anything else non-vendor, non-html) get the
  // revalidate-every-time treatment: no long cache, but a cheap 304 when
  // nothing changed.
  const revalidatable = !isVendor && !isHtml;

  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  let etag = null;
  if (revalidatable) {
    etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    headers.ETag = etag;
    headers['Cache-Control'] = 'no-cache';
  } else if (isHtml) {
    headers['Cache-Control'] = 'no-cache';
  } else if (isVendor) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  }
  headers['Last-Modified'] = stat.mtime.toUTCString();

  const inm = req.headers['if-none-match'];
  const ims = req.headers['if-modified-since'];
  let notModified = false;
  if (etag && inm) {
    notModified = inm === etag;
  } else if (ims) {
    const imsDate = new Date(ims);
    if (!Number.isNaN(imsDate.getTime())) {
      // HTTP-date has 1-second resolution; truncate mtime the same way.
      notModified = Math.floor(stat.mtimeMs / 1000) <= Math.floor(imsDate.getTime() / 1000);
    }
  }
  if (notModified) {
    res.writeHead(304, headers);
    return res.end();
  }

  let data;
  try {
    data = await fsp.readFile(resolved);
  } catch {
    return sendJson(res, 404, { error: 'Not found.' });
  }

  const compressible = COMPRESSIBLE_EXT.has(ext);
  if (compressible) headers.Vary = 'Accept-Encoding';
  const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  if (compressible && acceptsGzip && data.length > 0) {
    data = zlib.gzipSync(data);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = data.length;

  res.writeHead(200, headers);
  res.end(data);
}

// Small inline mark, monochrome-in-spirit (dark plate + the app's one
// constant accent), legible at 16px. Never a file under public/ — this
// route is the only place that may live in src/server.js.
function handleFavicon(req, res) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<rect width="32" height="32" rx="7" fill="#1C1C1C"/>' +
    `<circle cx="16" cy="16" r="7" fill="${ACCENT}"/>` +
    '</svg>';
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'public, max-age=604800',
    'Content-Length': Buffer.byteLength(svg),
  });
  res.end(svg);
}

// --- route handlers --------------------------------------------------------

async function handleState(req, res, query) {
  const force = query.get('refresh') === '1';
  const [pg, jf, layout, settingsView] = await Promise.all([
    pangolin.snapshot(force),
    jellyfin.getSessions(),
    store.loadLayout(),
    settings.publicView(),
  ]);
  sendJson(res, 200, { pangolin: pg, jellyfin: jf, layout, settings: settingsView });
}

// Raw keys for the services that opted into "Call from browser", so the page
// can call them itself. no-store: a key must never sit in a shared cache.
async function handleBrowserCredentials(req, res) {
  const payload = JSON.stringify(await settings.browserCredentials());
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

async function handleSaveLayout(req, res) {
  const body = await readJsonBody(req, 200 * 1024);
  const saved = await store.saveLayout(body);
  sendJson(res, 200, saved);
}

async function handleGetSettings(req, res) {
  sendJson(res, 200, await settings.publicView());
}

async function handlePutSettings(req, res) {
  const body = await readJsonBody(req, 32 * 1024);
  const current = await settings.load();
  const exfilRisk = findCredentialExfilRisk(current, body);
  if (exfilRisk) return sendJson(res, 400, { error: exfilRisk });
  await settings.save(body);
  pangolin.invalidate();
  jellyfin.invalidate();
  truenas.invalidate();
  sendJson(res, 200, await settings.publicView());
}

async function handleTestSettings(req, res) {
  const body = await readJsonBody(req, 32 * 1024);
  const target = body && body.target;
  if (target === 'pangolin') {
    return sendJson(res, 200, await pangolin.testConnection());
  }
  if (target === 'truenas') {
    return sendJson(res, 200, await truenas.testConnection());
  }
  sendJson(res, 200, { ok: false, detail: 'Unknown test target.' });
}

// Icon DISCOVERY, keyed strictly by resource key — never a user-supplied
// URL. The key must exist in the current Pangolin snapshot; the server
// derives the fetch target itself, so no request-controlled URL ever
// reaches fetch(). The server only finds where the icon is — it never
// fetches or stores image bytes; the browser fetches the actual image
// (often via Pangolin's own magic DNS), which also gets it real HTTP
// caching for free. Returns { url } — a real URL on success, null when
// nothing was discoverable. Failures are quiet: a 404/null url here just
// means the frontend falls back to the monogram, not an error state.
//
// ?debug=1 bypasses the cache and returns full diagnostic detail instead —
// the candidate base URLs tried, whether each page fetch succeeded, which
// <link> tags were parsed, and which was chosen — so an operator can tell
// "unreachable" apart from "genuinely no icon", which otherwise both look
// like the same quiet 404. Never logged to the console either way.
async function handleIcon(req, res, query) {
  const key = query.get('key');
  if (!key) return sendJson(res, 400, { error: 'key is required.' });

  const snap = await pangolin.snapshot(false);
  const resource = snap.resources.find((r) => r.key === key);
  if (!resource) return sendJson(res, 404, { error: 'Unknown resource.' });

  const debug = query.get('debug') === '1';

  if (debug) {
    const candidates = icons.candidateBaseUrls(resource);
    const attempts = [];
    let url = null;
    for (const baseUrl of candidates) {
      const detail = await icons.discoverIconDetailed(baseUrl);
      attempts.push(detail);
      if (detail.ok && detail.iconUrl && !url) url = icons.rebaseOntoPublic(detail.iconUrl, resource);
    }
    return sendJson(res, url ? 200 : 404, { key, candidates, attempts, url });
  }

  const cached = await store.getCachedIconUrl(key);
  if (cached) return sendJson(res, cached.url ? 200 : 404, { url: cached.url });

  for (const baseUrl of icons.candidateBaseUrls(resource)) {
    const iconUrl = await icons.discoverIconUrl(baseUrl);
    if (!iconUrl) continue;
    const publicUrl = icons.rebaseOntoPublic(iconUrl, resource);
    await store.saveIconUrlHit(key, publicUrl);
    return sendJson(res, 200, { url: publicUrl });
  }

  await store.saveIconUrlMiss(key);
  sendJson(res, 404, { url: null });
}

async function handleJellyfinResume(req, res) {
  const result = await jellyfin.resumeList();
  sendJson(res, 200, result);
}

async function handleJellyfinNextUp(req, res) {
  const result = await jellyfin.nextUpList();
  sendJson(res, 200, result);
}

async function handleJellyfinNowPlaying(req, res) {
  const result = await jellyfin.nowPlaying();
  sendJson(res, 200, result);
}

async function handleJellyfinUsers(req, res) {
  const result = await jellyfin.listUsers();
  sendJson(res, 200, result);
}

async function handleTruenas(req, res) {
  const result = await truenas.snapshot();
  sendJson(res, 200, result);
}

// --- dispatch ----------------------------------------------------------

async function dispatch(req, res, url) {
  const { pathname, searchParams } = url;
  if (req.method === 'GET' && pathname === '/api/state') return handleState(req, res, searchParams);
  if (req.method === 'POST' && pathname === '/api/layout') return handleSaveLayout(req, res);
  if (req.method === 'GET' && pathname === '/api/settings') return handleGetSettings(req, res);
  if (req.method === 'PUT' && pathname === '/api/settings') return handlePutSettings(req, res);
  if (req.method === 'POST' && pathname === '/api/settings/test') return handleTestSettings(req, res);
  if (req.method === 'GET' && pathname === '/api/browser-credentials') return handleBrowserCredentials(req, res);
  if (req.method === 'GET' && pathname === '/api/icon') return handleIcon(req, res, searchParams);
  if (req.method === 'GET' && pathname === '/api/jellyfin/resume') return handleJellyfinResume(req, res);
  if (req.method === 'GET' && pathname === '/api/jellyfin/nextup') return handleJellyfinNextUp(req, res);
  if (req.method === 'GET' && pathname === '/api/jellyfin/nowplaying') return handleJellyfinNowPlaying(req, res);
  if (req.method === 'GET' && pathname === '/api/jellyfin/users') return handleJellyfinUsers(req, res);
  if (req.method === 'GET' && pathname === '/api/truenas') return handleTruenas(req, res);
  if (req.method === 'GET' && pathname === '/favicon.ico') return handleFavicon(req, res);
  if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  return sendJson(res, 404, { error: 'Not found.' });
}

const server = http.createServer((req, res) => {
  const start = Date.now();
  const url = new URL(req.url, 'http://localhost');
  res.on('finish', () => {
    // Quiet for successful static hits — noisy only for API calls and
    // anything that didn't come back 2xx.
    const isApi = url.pathname.startsWith('/api/');
    const isOk = res.statusCode >= 200 && res.statusCode < 300;
    if (isApi || !isOk) {
      console.log(`${req.method} ${url.pathname} -> ${res.statusCode} (${Date.now() - start}ms)`);
    }
  });
  dispatch(req, res, url).catch((e) => {
    console.error('request handler error:', e);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // Only errors that deliberately set `.status` (validation failures,
    // oversized/malformed bodies) are safe to echo back — their message
    // is written for the settings form to display. Anything else (e.g. a
    // raw filesystem error with an absolute path in it) gets a generic
    // message; the real detail still goes to the server log.
    const status = e.status || 500;
    const message = e.status ? e.message : 'Internal server error.';
    sendJson(res, status, { error: message });
  });
});

// --- startup / shutdown -------------------------------------------------

function ensureDataDirOrExit() {
  try {
    store.ensureDirs();
  } catch (e) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
    console.error(
      [
        '',
        'Patchbay could not create or access its data directory.',
        `  Directory : ${store.DATA_DIR}`,
        `  Running as: uid ${uid}`,
        `  Error     : ${e.code || e.message}`,
        '',
        'Fix: on the Docker host, make that directory writable by this uid, e.g.:',
        '  chown -R 1000:1000 <the-host-directory-mounted-there>',
        '',
      ].join('\n')
    );
    process.exit(1);
  }
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  const forceTimer = setTimeout(() => {
    console.error('Shutdown did not finish in time; forcing exit.');
    process.exit(1);
  }, 5000);
  forceTimer.unref();
  server.close((err) => {
    clearTimeout(forceTimer);
    if (err) {
      console.error('Error while closing server:', err);
      process.exit(1);
    }
    console.log('Shut down cleanly.');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

ensureDataDirOrExit();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Patchbay listening on 0.0.0.0:${PORT} (DATA_DIR=${store.DATA_DIR})`);
});

// No background poll and no startup warm-up: this is a start page, not a
// dashboard left open. handleState calls pangolin.snapshot() on demand
// when someone actually loads /api/state, and pangolin.js's own TTL cache
// keeps back-to-back loads cheap. With nobody looking at the page, this
// server makes zero outbound requests to Pangolin.
