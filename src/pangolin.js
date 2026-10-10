// Pangolin Integration API client (read-only).
// Zero dependencies; Node 20+ global fetch.
//
// Credentials are read from src/settings.js on every call — never cached
// at module load — so a settings change takes effect on the very next
// request. Call invalidate() after a successful settings save to also
// discard the cached snapshot, so the next request refetches with the
// new credentials instead of serving stale data fetched under the old
// ones.

const settings = require('./settings');

async function configured() {
  return settings.configured();
}

// The user should never have to know the API is versioned under /v1.
// Accepts either https://host or https://host/v1 (with or without a
// trailing slash) and always builds requests against .../v1/<path>. This
// only affects the URL used at request time — the settings form still
// shows exactly what the user typed, unmodified.
function normalizeBaseUrl(rawUrl) {
  let base = (rawUrl || '').trim().replace(/\/+$/, '');
  if (/\/v1$/i.test(base)) base = base.slice(0, -3).replace(/\/+$/, '');
  return base;
}

async function api(path) {
  const s = await settings.load();
  const base = normalizeBaseUrl(s.pangolin.apiUrl);
  const key = s.pangolin.apiKey || '';
  const res = await fetch(`${base}/v1${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok || (json && json.success === false)) {
    const msg = (json && json.message) || `${res.status} ${res.statusText}`;
    const err = new Error(`Pangolin API GET ${path}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json ? json.data : null;
}

// The list endpoints wrap rows differently per version; unwrap defensively.
function unwrapList(data, ...keys) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const k of keys) if (Array.isArray(data[k])) return data[k];
  for (const v of Object.values(data)) if (Array.isArray(v)) return v;
  return [];
}

async function listAll(path, ...keys) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const data = await api(`${path}?pageSize=200&page=${page}`);
    const batch = unwrapList(data, ...keys);
    rows.push(...batch);
    if (batch.length < 200) break;
  }
  return rows;
}

function normalizeResource(r, kind) {
  const id = r.niceId || r.resourceId || r.id || r.name;
  const domain = r.fullDomain || r.alias || r.destination || null;
  const isHttp = (r.mode ? r.mode === 'http' : r.http !== false);

  // Internal (LAN-side) address for icon discovery. Private resources carry
  // it as flat destination/destinationPort fields; public resources nest it
  // under targets[0] instead. Both are site-relative — only reachable when
  // this server runs on the same LAN as the site's connector.
  const target = Array.isArray(r.targets) && r.targets.length ? r.targets[0] : null;
  const destination = r.destination ?? (target ? target.ip : null) ?? null;
  const destinationPort = r.destinationPort ?? (target ? target.port : null) ?? null;
  const scheme = r.scheme || (r.mode === 'http' ? 'http' : 'https');

  return {
    key: `${kind}:${id}`,
    kind, // 'public' | 'private'
    id,
    resourceId: r.resourceId ?? null,
    name: r.name || String(id),
    domain,
    url: isHttp && r.fullDomain ? `https://${r.fullDomain}` : null,
    mode: r.mode || (isHttp ? 'http' : r.protocol || 'tcp'),
    scheme,
    destination,
    destinationPort,
    sso: r.sso === true,
    enabled: r.enabled !== false,
    siteId: r.siteId ?? null,
    siteName: r.siteName || null,
    healthStatus: r.healthStatus || null,
    labels: Array.isArray(r.labels) ? r.labels.map((l) => ({ id: l.labelId, name: l.name, color: l.color })) : [],
  };
}

function normalizeSite(s) {
  return {
    siteId: s.siteId ?? s.id,
    niceId: s.niceId || null,
    name: s.name || s.niceId || String(s.siteId ?? s.id),
    online: Boolean(s.online),
    mbIn: Number(s.megabytesIn ?? 0),
    mbOut: Number(s.megabytesOut ?? 0),
    type: s.type || null,
  };
}

// --- snapshot cache -------------------------------------------------------

// This dashboard is a start page, not a live monitor — nobody needs a
// resource list fresher than a few minutes. The resource/site list itself
// changes only a few times a year, so a page load may safely show data up
// to five minutes old rather than hitting the Pangolin API on every visit.
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

let cache = { at: 0, data: null, error: null };

// Discards the cached snapshot. Call after a successful settings save so
// the next request refetches under the new credentials instead of
// serving a snapshot fetched under the old ones.
function invalidate() {
  cache = { at: 0, data: null, error: null };
}

async function snapshot(force = false) {
  const s = await settings.load();
  const isConfigured = await configured();
  if (!isConfigured) {
    return {
      resources: [],
      sites: [],
      fetchedAt: null,
      error: 'Pangolin is not configured yet. Open the settings page to add your API URL, org ID and API key.',
    };
  }
  const now = Date.now();
  if (!force && cache.data && now - cache.at < SNAPSHOT_TTL_MS) return cache.data;
  try {
    const org = s.pangolin.orgId;
    const [pub, priv, sites] = await Promise.all([
      listAll(`/org/${org}/resources`, 'resources'),
      listAll(`/org/${org}/private-resources`, 'privateResources', 'resources').catch(() => []),
      listAll(`/org/${org}/sites`, 'sites'),
    ]);
    const data = {
      resources: [
        ...pub.map((r) => normalizeResource(r, 'public')),
        ...priv.map((r) => normalizeResource(r, 'private')),
      ],
      sites: sites.map(normalizeSite),
      fetchedAt: new Date().toISOString(),
      error: null,
    };
    cache = { at: now, data, error: null };
    return data;
  } catch (e) {
    if (cache.data) return { ...cache.data, error: `Refresh failed: ${e.message}` };
    return { resources: [], sites: [], fetchedAt: null, error: e.message };
  }
}

// Performs one live, read-only call using the currently saved credentials,
// for the settings page's "test connection" button. Never throws; the
// detail string never contains the API key.
async function testConnection() {
  const isConfigured = await configured();
  if (!isConfigured) {
    return { ok: false, detail: 'Pangolin is not configured yet.' };
  }
  try {
    const s = await settings.load();
    const org = s.pangolin.orgId;
    let privateFailed = false;
    const [resources, priv, sites] = await Promise.all([
      listAll(`/org/${org}/resources`, 'resources'),
      listAll(`/org/${org}/private-resources`, 'privateResources', 'resources').catch(() => {
        privateFailed = true;
        return [];
      }),
      listAll(`/org/${org}/sites`, 'sites'),
    ]);
    const total = resources.length + priv.length;
    const resourceWord = total === 1 ? 'resource' : 'resources';
    const siteWord = sites.length === 1 ? 'site' : 'sites';
    let detail = `${total} ${resourceWord} across ${sites.length} ${siteWord}`;
    if (privateFailed) detail += ' (private resources unavailable — total may be undercounted)';
    return { ok: true, detail };
  } catch (e) {
    return { ok: false, detail: e.message.replace(/Bearer\s+\S+/gi, 'Bearer ***') };
  }
}

module.exports = { configured, snapshot, invalidate, testConnection };
