// TrueNAS logic shared by the server (src/truenas.js) and the browser
// (public/app.js, when "Call from browser" is on). Platform-neutral: the
// WebSocket here is the standard one that Node 22 and browsers both ship,
// so rpcSession and the call list exist exactly once. Caching, settings and
// the Node-version guard stay in src/truenas.js.
//
// Column semantics below (netdata_get_data's "cpu" and "memory" graphs) are
// taken from TrueNAS's own middleware source
// (plugins/reporting/netdata/graphs.py): the "cpu" graph's "cpu" legend
// entry is overall %CPU (0-100, matches the UI dashboard), and the
// "memory" graph's only entry is named "available" — physical memory
// AVAILABLE in bytes, not used. usedBytes is therefore physmem - available.
//
// UMD: module.exports in Node, window.PatchbayTruenas in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PatchbayTruenas = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CALL_TIMEOUT_MS = 10000;

  function emptyResult(error) {
    return {
      ok: false,
      cpu: null,
      memory: null,
      pools: null,
      uptime: null,
      alerts: null,
      host: null,
      fetchedAt: null,
      error,
    };
  }

  class AuthRejected extends Error {
    constructor() {
      super('TrueNAS rejected the API key.');
      this.name = 'AuthRejected';
    }
  }

  function wsUrlFor(rawUrl) {
    const u = new URL(rawUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${u.toString().replace(/\/+$/, '')}/api/current`;
  }

  // Opens one WebSocket, runs `run(call)` where call(method, params) sends a
  // JSON-RPC 2.0 request and resolves with its result, then ALWAYS closes the
  // socket — on success, on error, and on the 10s hard timeout. Never holds a
  // persistent connection open.
  function rpcSession(wsUrl, origin, run) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws = null;
      let nextId = 1;
      const pending = new Map();

      const hardTimeout = setTimeout(() => {
        finish(reject, new Error(`TrueNAS at ${origin} did not respond in time.`));
      }, CALL_TIMEOUT_MS);

      function failAllPending(err) {
        for (const { rej } of pending.values()) rej(err);
        pending.clear();
      }

      function finish(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimeout);
        try {
          if (ws) ws.close();
        } catch {
          /* already closing/closed */
        }
        fn(value);
      }

      function call(method, params = []) {
        return new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { res, rej });
          try {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
          } catch (e) {
            pending.delete(id);
            rej(e);
          }
        });
      }

      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        finish(reject, e);
        return;
      }

      ws.addEventListener('open', async () => {
        try {
          const result = await run(call);
          finish(resolve, result);
        } catch (e) {
          finish(reject, e);
        }
      });

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || 'TrueNAS returned an error.'));
          else res(msg.result);
        }
      });

      ws.addEventListener('error', () => {
        const err = new Error(`Cannot reach TrueNAS at ${origin}`);
        failAllPending(err);
        finish(reject, err);
      });

      ws.addEventListener('close', () => {
        if (!settled) {
          const err = new Error(`Cannot reach TrueNAS at ${origin}`);
          failAllPending(err);
          finish(reject, err);
        }
      });
    });
  }

  function numberOrNull(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  function extractChart(telemetry, name) {
    if (!Array.isArray(telemetry)) return null;
    return telemetry.find((c) => c && c.name === name) || null;
  }

  // Mean of one legend column over the queried window, straight from
  // TrueNAS's own aggregation (we do not recompute it ourselves).
  function meanOf(chart, legendKey) {
    if (!chart || !chart.aggregations || !chart.aggregations.mean) return null;
    return numberOrNull(chart.aggregations.mean[legendKey]);
  }

  const ALERT_LEVEL_RANK = { INFO: 0, NOTICE: 1, WARNING: 2, ERROR: 3, CRITICAL: 4, ALERT: 5, EMERGENCY: 6 };

  function buildSnapshot(info, pools, alerts, telemetry) {
    const cores = info ? numberOrNull(info.cores) : null;
    const load1 = info && Array.isArray(info.loadavg) ? numberOrNull(info.loadavg[0]) : null;
    const totalMemBytes = info ? numberOrNull(info.physmem) : null;

    const cpuChart = extractChart(telemetry, 'cpu');
    const cpuMean = meanOf(cpuChart, 'cpu');
    const cpuPercent = cpuMean !== null ? Math.round(cpuMean) : null;

    const memChart = extractChart(telemetry, 'memory');
    const availableBytes = meanOf(memChart, 'available');
    let usedBytes = null;
    let memPercent = null;
    if (totalMemBytes !== null && availableBytes !== null) {
      usedBytes = Math.max(0, Math.round(totalMemBytes - availableBytes));
      memPercent = totalMemBytes > 0 ? Math.round((usedBytes / totalMemBytes) * 100) : null;
    }

    const normalizedPools = Array.isArray(pools)
      ? pools.map((p) => {
          const size = numberOrNull(p && p.size);
          const allocated = numberOrNull(p && p.allocated);
          return {
            name: (p && p.name) || 'Unknown',
            status: (p && p.status) || null,
            healthy: p && typeof p.healthy === 'boolean' ? p.healthy : null,
            usedBytes: allocated,
            totalBytes: size,
            percent: size !== null && allocated !== null && size > 0 ? Math.round((allocated / size) * 100) : null,
          };
        })
      : [];

    const uptimeSeconds = info ? numberOrNull(info.uptime_seconds) : null;
    const uptime =
      uptimeSeconds !== null
        ? { seconds: Math.round(uptimeSeconds), days: Math.floor(uptimeSeconds / 86400) }
        : null;

    const alertList = Array.isArray(alerts) ? alerts : [];
    let worstLevel = null;
    for (const a of alertList) {
      if (!a || typeof a.level !== 'string') continue;
      const rank = ALERT_LEVEL_RANK[a.level] ?? -1;
      if (worstLevel === null || rank > (ALERT_LEVEL_RANK[worstLevel] ?? -1)) worstLevel = a.level;
    }
    const activeAlerts = alertList.filter((a) => a && !a.dismissed).length;

    return {
      ok: true,
      cpu: { percent: cpuPercent, cores, load1 },
      memory: { usedBytes, totalBytes: totalMemBytes, percent: memPercent },
      pools: normalizedPools,
      uptime,
      alerts: { total: alertList.length, active: activeAlerts, worstLevel },
      host: { hostname: (info && info.hostname) || null, version: (info && info.version) || null },
      fetchedAt: new Date().toISOString(),
      error: null,
    };
  }

  // The RPC calls behind one snapshot. Telemetry is best-effort: absence of
  // live telemetry does not fail the whole snapshot, it just leaves
  // cpu.percent/memory nulled in buildSnapshot.
  async function fetchSnapshot(call, apiKey) {
    let authOk;
    try {
      authOk = await call('auth.login_with_api_key', [apiKey]);
    } catch {
      throw new AuthRejected();
    }
    if (authOk !== true) throw new AuthRejected();

    const nowSec = Math.floor(Date.now() / 1000);
    const [info, pools, alerts, telemetry] = await Promise.all([
      call('system.info'),
      call('pool.query'),
      call('alert.list'),
      call('reporting.netdata_get_data', [
        [{ name: 'cpu' }, { name: 'memory' }],
        { start: nowSec - 60, aggregate: true },
      ]).catch(() => null),
    ]);
    return buildSnapshot(info, pools, alerts, telemetry);
  }

  function originOf(rawUrl) {
    try {
      return new URL(rawUrl).origin;
    } catch {
      return rawUrl; // keep as-is for the message
    }
  }

  // Whole snapshot from raw credentials, never throws: the endpoint shape
  // (ok:true data, or emptyResult). Error text never contains the key.
  async function loadSnapshot(creds) {
    const rawUrl = (creds.url || '').trim();
    const apiKey = creds.apiKey || '';
    if (!rawUrl || !apiKey) return emptyResult('TrueNAS is not configured.');
    let wsUrl;
    try {
      wsUrl = wsUrlFor(rawUrl);
    } catch {
      return emptyResult('TrueNAS URL is invalid.');
    }
    try {
      return await rpcSession(wsUrl, originOf(rawUrl), (call) => fetchSnapshot(call, apiKey));
    } catch (e) {
      return emptyResult(e instanceof AuthRejected ? e.message : e.message || 'TrueNAS request failed.');
    }
  }

  return { emptyResult, wsUrlFor, rpcSession, buildSnapshot, loadSnapshot };
});
