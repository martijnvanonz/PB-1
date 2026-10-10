// TrueNAS telemetry. Zero dependencies — uses the platform's global
// WebSocket (Node 22+). Node < 22 has no global WebSocket, so this module
// degrades to a clean error result instead of throwing; it must never crash
// server boot or leave an unhandled rejection on an older runtime.
//
// TrueNAS 25.04+ speaks JSON-RPC 2.0 over a single WebSocket endpoint
// (wss://<host>/api/current). REST v2.0 is deprecated there and removed in
// TrueNAS 26, so WebSocket is the only route worth building.
//
// Credentials are read from src/settings.js on every call — never cached at
// module load — so a settings change takes effect on the next call.
//
// The RPC session, the call list and buildSnapshot (including the netdata
// "available, not used" memory semantics) live in
// public/shared/truenas-core.js so the browser can run the exact same code
// when "Call from browser" is on. This file only adds settings lookup, the
// Node-version guard and the cache.

const settings = require('./settings');
const core = require('../public/shared/truenas-core');

const CACHE_MS = 15 * 1000;

let cache = { at: 0, data: null };

// Discards the cached snapshot. Call after a successful settings save so
// the next request re-reads under the new URL/key instead of serving a
// snapshot fetched under the old ones.
function invalidate() {
  cache = { at: 0, data: null };
}

async function snapshot(force = false) {
  if (typeof WebSocket === 'undefined') {
    return core.emptyResult(`TrueNAS telemetry needs Node 22 or newer (this server is running ${process.version}).`);
  }

  const s = await settings.load();
  const creds = { url: s.truenas.url, apiKey: s.truenas.apiKey };
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
// detail string never contains the API key.
async function testConnection() {
  const result = await snapshot(true);
  if (!result.ok) return { ok: false, detail: result.error };
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
