// TrueNAS telemetry. Zero dependencies.
//
// TrueNAS 25.04+ speaks JSON-RPC 2.0 over a single WebSocket endpoint
// (wss://<host>/api/current). REST v2.0 is deprecated there and removed in
// TrueNAS 26, so WebSocket is the only route worth building. The socket is
// our own TLS client (src/wsclient.js) rather than the global WebSocket so a
// self-signed TrueNAS certificate can be pinned by fingerprint.
//
// Credentials are read from src/settings.js on every call — never cached at
// module load — so a settings change takes effect on the next call.
//
// The RPC session, the call list and buildSnapshot (including the netdata
// "available, not used" memory semantics) live in src/truenas-core.js. This
// file only adds settings lookup and the cache.

const settings = require('./settings');
const core = require('./truenas-core');
const { probeFingerprint } = require('./wsclient');

const CACHE_MS = 15 * 1000;

let cache = { at: 0, data: null };

// Discards the cached snapshot. Call after a successful settings save so
// the next request re-reads under the new URL/key instead of serving a
// snapshot fetched under the old ones.
function invalidate() {
  cache = { at: 0, data: null };
}

function credsFrom(s) {
  return { url: s.truenas.url, apiKey: s.truenas.apiKey, certFingerprint: s.truenas.certFingerprint };
}

async function snapshot(force = false) {
  const s = await settings.load();
  const creds = credsFrom(s);
  if (!(creds.url || '').trim() || !creds.apiKey) {
    return core.emptyResult('TrueNAS is not configured.');
  }

  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_MS) return cache.data;

  const data = await core.loadSnapshot(creds);
  cache = { at: now, data };
  return data;
}

// For the settings page's "test connection" button. Never throws; the
// detail string never contains the API key. When the certificate is not
// trusted and no pin is set, it also returns the fingerprint the server
// presented (public, not secret) so the page can offer "Trust this
// certificate" — found by a separate probe that sends nothing, so the key
// has not left this process.
async function testConnection() {
  const s = await settings.load();
  const creds = credsFrom(s);
  if (!(creds.url || '').trim() || !creds.apiKey) return { ok: false, detail: 'TrueNAS is not configured.' };

  let result;
  try {
    result = await core.runSnapshot(creds);
    cache = { at: Date.now(), data: result };
  } catch (e) {
    const failure = { ok: false, detail: core.describeFailure(e) };
    if (e && e.code === 'CERT_UNTRUSTED' && !creds.certFingerprint) {
      const fingerprint = await probeFingerprint(creds.url.trim());
      if (fingerprint) {
        failure.certFingerprint = fingerprint;
        failure.detail = 'The TrueNAS certificate is not trusted (a self-signed certificate is normal). Compare the fingerprint, then trust it.';
      }
    }
    return failure;
  }
  const poolCount = Array.isArray(result.pools) ? result.pools.length : 0;
  if (poolCount === 0) {
    return { ok: true, detail: `TrueNAS ${result.host.version || 'unknown version'}, no pools found` };
  }
  const healthyCount = result.pools.filter((p) => p.healthy).length;
  const poolWord = poolCount === 1 ? 'pool' : 'pools';
  const healthNote = healthyCount === poolCount ? 'healthy' : `${healthyCount}/${poolCount} healthy`;
  return { ok: true, detail: `TrueNAS ${result.host.version || 'unknown version'}, ${poolCount} ${poolWord} ${healthNote}` };
}

module.exports = { snapshot, testConnection, invalidate };
