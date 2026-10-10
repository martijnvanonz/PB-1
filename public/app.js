'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let STATE = null;
let editMode = false;
let dragSource = null; // { ref: {type,...}, fromGroupId: string|null }

const THEMES = ['ko', 'riddim'];

// Widget registry — a widget is a placeable layout item like any other, but
// its content is rendered by widget-specific code instead of resolved from
// a Pangolin resource or a manual link.
//   span     — how many of the 4 (2 on narrow screens) grid columns it occupies.
//   rowSpan  — how many key-height grid rows it occupies. The declared
//              footprint (span x rowSpan) MUST match what the card actually
//              draws — see .pad's grid-auto-rows and .widget-card's height:
//              100% in styles.css — or the grid reserves the wrong amount of
//              space and tiles below overlap or leave a hole.
//   maxItems — rows of content shown, capped to what that footprint fits.
//   endpoint — GET url returning { ok, items, error }.
//   browserLoad — same result from the browser, used instead of `endpoint`
//              when that service has "Call from browser" on (see
//              loadFromBrowser). Optional; Jellyfin widgets only.
//   showProgress — whether rows render a progress bar/figure at all.
//   paint    — (bodyEl, data, def) => void, patches one instance in place.
// Adding a second widget type is one entry here (reusing paintJellyfinSlider
// when it's another Jellyfin-shaped list of cassettes) plus registering it
// with fetchAllWidgetData — nothing about placement, drag/move, footprint,
// or removal changes.
// `bare: true` means the widget draws its own objects (the VHS cassettes)
// rather than filling the card with content the same way a plain key does
// — the card must not paint the usual dark --key-bg behind it, or a shell
// coloured close to that same dark tone (the cassette's --shell tokens are)
// disappears into it. See .widget-card--bare in styles.css.
const WIDGET_TYPES = {
  'jellyfin-resume': {
    title: 'JELLYFIN · CONTINUE WATCHING',
    span: 2,
    rowSpan: 4,
    maxItems: 10,
    endpoint: '/api/jellyfin/resume',
    browserLoad: (creds) => PatchbayJellyfin.loadItems('resume', creds),
    showProgress: true,
    emptyText: 'Nothing to resume.',
    paint: paintJellyfinSlider,
    bare: true,
  },
  'jellyfin-nextup': {
    title: 'JELLYFIN · UP NEXT',
    span: 2,
    rowSpan: 4,
    maxItems: 10,
    endpoint: '/api/jellyfin/nextup',
    browserLoad: (creds) => PatchbayJellyfin.loadItems('nextup', creds),
    showProgress: false,
    emptyText: 'Nothing up next.',
    paint: paintJellyfinSlider,
    bare: true,
  },
  // Same item shape as jellyfin-resume plus userName/isPaused/playMethod/
  // transcodeReason/client/device — the cassette component renders it
  // unchanged; tapeInnerHtml/spool key off `userName != null` to switch on
  // the handwritten name on the label and the spinning reels. The moulded
  // strip itself never changes — same "insert this side..." text as every
  // other tape. Empty is this widget's normal state most of the day, not
  // an error.
  'jellyfin-nowplaying': {
    title: 'JELLYFIN · NOW PLAYING',
    span: 2,
    rowSpan: 4,
    maxItems: 10,
    endpoint: '/api/jellyfin/nowplaying',
    browserLoad: (creds) => PatchbayJellyfin.loadNowPlaying(creds),
    showProgress: true,
    emptyText: 'Nothing playing.',
    paint: paintJellyfinSlider,
    bare: true,
    // Idle is this widget's normal state for most of the day, and an empty
    // four-row card is a lot of dead panel to spend on two words. It
    // collapses out of the grid when nothing is playing — but ONLY outside
    // EDIT mode, or it would become impossible to move or delete.
    hideWhenEmpty: true,
  },
  // No `endpoint` — deliberately. Every other widget type's endpoint
  // returns { ok, items }, which fetchWidgetData/fetchAllWidgetData knows
  // how to poll generically; TrueNAS's payload is one telemetry object
  // (cpu/memory/pools/alerts/host), not a list, so it doesn't fit that
  // shape. It rides the SAME 20s cycle instead via fetchTruenasData() (see
  // boot()), which already exists for the old #scr-sys bar and now patches
  // this widget's instances in place through updateWidgetInstances —
  // one fetch, one timer, same as before. paintTruenasWidget reads the
  // shared TRUENAS_DATA global directly rather than WIDGET_DATA[type].
  truenas: {
    title: 'TRUENAS',
    span: 2,
    rowSpan: 2,
    paint: paintTruenasWidget,
  },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// Fetch / persist
// ---------------------------------------------------------------------------

async function fetchState(force) {
  const url = force ? '/api/state?refresh=1' : '/api/state';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load state: ${res.status}`);
  STATE = await res.json();
}

// "Call from browser": a service whose settings say fromBrowser is called
// by this page itself instead of through the server, because the server (in
// a container without the Pangolin client) cannot reach it but this browser
// can. The raw credentials are fetched once per page load and kept only in
// memory; null means "use the server endpoint" (flag off, or no credentials).
let BROWSER_CREDENTIALS = null;

async function browserCredentialsFor(service) {
  const flagged = STATE && STATE.settings && STATE.settings[service] && STATE.settings[service].fromBrowser;
  if (!flagged) return null;
  if (!BROWSER_CREDENTIALS) {
    BROWSER_CREDENTIALS = fetch('/api/browser-credentials', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}));
  }
  return (await BROWSER_CREDENTIALS)[service] || null;
}

async function saveLayout() {
  const res = await fetch('/api/layout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(STATE.layout),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Failed to save layout.');
  STATE.layout = body;
}

async function persist() {
  try {
    await saveLayout();
  } catch (e) {
    console.error(e);
  }
  render();
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('hc1-theme', theme);
  } catch (e) { /* localStorage unavailable */ }
}

function cycleTheme() {
  const current = STATE.layout.theme || 'ko';
  const idx = THEMES.indexOf(current);
  const next = THEMES[(idx + 1) % THEMES.length];
  STATE.layout.theme = next;
  applyTheme(next);
  persist();
}

// ---------------------------------------------------------------------------
// Derived data helpers
// ---------------------------------------------------------------------------

function hiddenSet() {
  return new Set(STATE.layout.hidden);
}

function favoritesSet() {
  return new Set(STATE.layout.favorites || []);
}

function findResource(key) {
  return STATE.pangolin.resources.find((r) => r.key === key) || null;
}

function findSite(siteId) {
  return STATE.pangolin.sites.find((s) => s.siteId === siteId) || null;
}

function resolveItem(ref) {
  if (ref.type === 'pangolin') {
    const resource = findResource(ref.key);
    if (!resource) return null;
    return {
      hideKey: ref.key,
      kind: 'pangolin',
      name: resource.name,
      domain: resource.domain,
      url: resource.url,
      resource,
    };
  }
  if (ref.type === 'widget') {
    const def = WIDGET_TYPES[ref.widget];
    return {
      hideKey: ref.id,
      kind: 'widget',
      widget: ref.widget,
      widgetId: ref.id,
      name: def ? def.title : ref.widget,
    };
  }
  return {
    hideKey: ref.id,
    kind: 'manual',
    name: ref.name,
    domain: safeHost(ref.url),
    url: ref.url,
    manualId: ref.id,
  };
}

// Uptime is checked entirely client-side (see "Client-side uptime checking"
// below) — the server never proxies reachability, so it never blindly
// reports a private resource as down just because the SERVER can't reach it.
function computeStatus(entry) {
  if (entry.kind === 'pangolin' && entry.resource.enabled === false) {
    return { cls: 'off', ms: null };
  }
  const url = targetUrlFor(entry);
  if (!url) {
    return { cls: 'checking', ms: null, reason: 'No reachable URL to check.' };
  }
  if (isMixedContent(url)) {
    return { cls: 'checking', ms: null, reason: 'Cannot be checked from an HTTPS page (mixed content).' };
  }
  const h = CLIENT_HEALTH[url];
  if (!h) return { cls: 'checking', ms: null };
  return { cls: h.up ? 'up' : 'down', ms: h.ms };
}

function computeTray() {
  const placed = new Set();
  for (const g of STATE.layout.groups) {
    for (const it of g.items) if (it.type === 'pangolin') placed.add(it.key);
  }
  const hidden = hiddenSet();
  return STATE.pangolin.resources.filter((r) => !placed.has(r.key) && !hidden.has(r.key));
}

function allVisibleEntries() {
  const hidden = hiddenSet();
  const seen = new Set();
  const out = [];
  for (const g of STATE.layout.groups) {
    for (const ref of g.items) {
      if (ref.type === 'widget') continue; // widgets aren't checkable services
      const entry = resolveItem(ref);
      if (!entry) continue;
      if (hidden.has(entry.hideKey)) continue;
      if (seen.has(entry.hideKey)) continue;
      seen.add(entry.hideKey);
      out.push(entry);
    }
  }
  return out;
}

function suggestionFor(resource) {
  const labels = resource.labels || [];
  if (labels.length === 0) return null;
  const label = labels[0];
  const existing = STATE.layout.groups.find((g) => g.name.toLowerCase() === label.name.toLowerCase());
  return { name: label.name, color: label.color, exists: Boolean(existing) };
}

// ---------------------------------------------------------------------------
// Client-side uptime checking. The server sits outside the Pangolin tunnel
// and cannot reach private resources; the browser can. Checks run on page
// load and on an explicit CHECK click only — never on an interval, since a
// background timer silently re-declaring services up/down without the user
// asking would be exactly the kind of unannounced write we don't do to
// layout, applied to status instead.
// ---------------------------------------------------------------------------

const CLIENT_HEALTH = {}; // url -> { up, ms }
const CHECKING_NOW = new Set(); // urls with a ping actually in flight right now
const CHECK_CONCURRENCY = 6;
let uptimeChecking = false;

// url -> [{ slotEl, entry }] — repopulated by every structural render (see
// render()), consulted by targeted per-URL status updates in between so a
// status change never has to tear down and rebuild the whole panel (that
// was destroying/re-requesting every icon and restarting the checking
// animation from frame zero on every single ping — see updateStatusForUrl).
const URL_TO_SLOTS = new Map();

function targetUrlFor(entry) {
  return entry.url || null;
}

function isMixedContent(url) {
  try {
    const target = new URL(url);
    return window.location.protocol === 'https:' && target.protocol === 'http:';
  } catch {
    return false;
  }
}

async function pingOnce(url) {
  const start = performance.now();
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    return { up: true, ms: performance.now() - start };
  } catch {
    return { up: false, ms: null };
  }
}

// Two attempts, run one after another (never in parallel — a raced pair
// would make "the average" meaningless). Up if either answered; ms is the
// average of whichever attempt(s) actually succeeded.
async function pingTwiceAveraged(url) {
  const first = await pingOnce(url);
  const second = await pingOnce(url);
  const successes = [first, second].filter((r) => r.up);
  if (successes.length === 0) return { up: false, ms: null };
  const avg = successes.reduce((sum, r) => sum + r.ms, 0) / successes.length;
  return { up: true, ms: Math.round(avg) };
}

async function runWithConcurrency(items, limit, worker) {
  const queue = items.slice();
  const runnerCount = Math.min(limit, queue.length);
  const runners = new Array(runnerCount).fill(null).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function updateCheckChip() {
  const chip = $('#chip-check');
  if (!chip) return;
  chip.textContent = uptimeChecking ? 'CHECKING…' : 'CHECK';
  chip.classList.toggle('dk', uptimeChecking);
}

async function checkAllUptime() {
  if (uptimeChecking || !STATE) return;
  uptimeChecking = true;
  updateCheckChip();

  const entries = buildSearchIndex(); // placed + tray, deduped
  const targets = [];
  const seen = new Set();
  for (const entry of entries) {
    const url = targetUrlFor(entry);
    if (!url || isMixedContent(url) || seen.has(url)) continue;
    seen.add(url);
    targets.push(url);
  }

  await runWithConcurrency(targets, CHECK_CONCURRENCY, async (url) => {
    CHECKING_NOW.add(url);
    updateStatusForUrl(url); // bars start their sweep — targeted, no rebuild
    renderScreen(); // small fixed region, cheap to keep the count/P95 live
    renderChips(); // ditto for the N DOWN count
    CLIENT_HEALTH[url] = await pingTwiceAveraged(url);
    CHECKING_NOW.delete(url);
    updateStatusForUrl(url); // ...and settle back to flat when the result lands
    renderScreen();
    renderChips();
  });

  uptimeChecking = false;
  updateCheckChip();
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatTime(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function statusLabel(status) {
  if (status.cls === 'down') return 'NO ROUTE';
  if (status.cls === 'off') return 'OFF';
  if (status.cls === 'checking') return '…';
  return status.ms != null ? `${status.ms}MS` : '—';
}

// Patches ONE key's status-dependent bits in place — the tray's micro-label
// dot/text, the bars' is-checking class, and the footer's DOWN-chip-vs-
// latency slot. Touches nothing else: the icon <img>, the name, the drag
// handlers, edit-mode buttons are all left completely alone, so an icon
// mid-decode never gets torn down and re-requested by a status update.
function updateKeyStatusEls(slotEl, entry) {
  const status = computeStatus(entry);
  const url = targetUrlFor(entry);
  const isChecking = Boolean(url && CHECKING_NOW.has(url));
  const keyEl = slotEl.querySelector('.key');
  if (!keyEl) return;

  const lab = slotEl.querySelector('.slot-lab');
  if (lab) {
    lab.classList.toggle('bad', status.cls === 'down');
    if (lab.lastChild) lab.lastChild.textContent = lab.dataset.groupLabel || '';
  }

  const bars = keyEl.querySelector('.bars');
  if (bars) {
    bars.classList.toggle('is-checking', isChecking);
    const barsLabel = isChecking ? 'Checking…' : 'No history yet';
    bars.title = barsLabel;
    bars.setAttribute('aria-label', barsLabel);
  }

  const footer = keyEl.querySelector('.key-ft');
  if (footer) {
    let tail = footer.querySelector('.st, .key-lat');
    if (status.cls === 'down') {
      if (!tail || !tail.classList.contains('st')) {
        if (tail) tail.remove();
        tail = document.createElement('span');
        tail.className = 'st down';
        footer.appendChild(tail);
      }
      tail.textContent = 'DOWN';
    } else {
      if (!tail || !tail.classList.contains('key-lat')) {
        if (tail) tail.remove();
        tail = document.createElement('span');
        tail.className = 'key-lat';
        tail.appendChild(document.createElement('i'));
        footer.appendChild(tail);
      }
      while (tail.childNodes.length > 1) tail.removeChild(tail.lastChild);
      tail.appendChild(document.createTextNode(statusLabel(status)));
    }
  }
}

function updateStatusForUrl(url) {
  const slots = URL_TO_SLOTS.get(url);
  if (!slots) return;
  for (const { slotEl, entry } of slots) {
    if (!slotEl.isConnected) continue; // stale reference from a since-replaced structural render
    updateKeyStatusEls(slotEl, entry);
  }
}

// Called by every structural render right before it (re)builds slots, so
// stale references from the previous build never linger. One URL can map to
// more than one slot (same service placed in the tray AND a group, or
// duplicated across groups), so this appends rather than overwrites.
function registerUrlSlot(entry, slotEl) {
  const url = targetUrlFor(entry);
  if (!url) return;
  let list = URL_TO_SLOTS.get(url);
  if (!list) {
    list = [];
    URL_TO_SLOTS.set(url, list);
  }
  list.push({ slotEl, entry });
}

// ---------------------------------------------------------------------------
// Render: chip row + notice
// ---------------------------------------------------------------------------

function renderChips() {
  const entries = allVisibleEntries();
  const downCount = entries.filter((e) => computeStatus(e).cls === 'down').length;
  const downChip = $('#chip-down');
  downChip.hidden = downCount === 0;
  downChip.textContent = `${downCount} DOWN`;

  const editChip = $('#chip-edit');
  editChip.classList.toggle('dk', editMode);
  editChip.textContent = editMode ? 'DONE' : 'EDIT';

  $('#chip-theme').textContent = `THEME · ${(STATE.layout.theme || 'ko').toUpperCase()}`;

  const notice = $('#notice');
  if (STATE.settings && STATE.settings.configured === false) {
    notice.hidden = false;
    notice.innerHTML = 'Not connected to Pangolin yet. <a href="/settings.html">Open settings</a> to add your API key.';
  } else if (STATE.pangolin.error) {
    notice.hidden = false;
    notice.textContent = STATE.pangolin.error;
  } else {
    notice.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Render: name plate + screen
// ---------------------------------------------------------------------------

// A hyphen between two word characters becomes a non-breaking hyphen so a
// model number like "PB-1" never wraps mid-way. Only word-word hyphens are
// touched, so arbitrary text with hyphens elsewhere is left alone.
function formatModelText(raw) {
  return escapeHtml(String(raw || '')).replace(/(\w)-(\w)/g, '$1‑$2');
}

function renderPlate() {
  const count = allVisibleEntries().length;
  $('#plate-desc').textContent = `${String(count).padStart(2, '0')} SERVICE PANEL`;

  // Fallback to the device's original values when settings haven't loaded
  // yet or nothing has been configured — the plate must never look broken
  // mid-load.
  const branding = (STATE.settings && STATE.settings.branding) || {};
  const model = branding.model || 'PB-1';
  const subtitle = branding.subtitle || 'サーバー';
  $('#plate-model').innerHTML = formatModelText(model);
  $('#plate-sub').innerHTML = escapeHtml(subtitle);
  document.title = String(model);
}

function renderScreen() {
  const entries = allVisibleEntries();
  const statuses = entries.map((e) => computeStatus(e).cls);
  const upCount = statuses.filter((cls) => cls === 'up').length;
  const hasKnown = statuses.some((cls) => cls !== 'checking');
  const bigNum = hasKnown ? String(upCount).padStart(2, '0') : '--';
  $('#scr-big').innerHTML = `${bigNum}<small>/ ${String(entries.length).padStart(2, '0')} UP</small>`;

  const glyphs = $('#scr-glyphs');
  glyphs.innerHTML = '';
  for (const entry of entries) {
    const status = computeStatus(entry);
    const gl = document.createElement('span');
    gl.className = `gl gl-${status.cls}`;
    gl.title = `${entry.name} — ${status.cls.toUpperCase()}`;
    glyphs.appendChild(gl);
  }

  const synced = formatTime(STATE.pangolin.fetchedAt);
  $('#scr-meta').innerHTML = `<span>SYNC <em>${escapeHtml(synced)}</em></span>`;
}

// ---------------------------------------------------------------------------
// TrueNAS data — shared by the `truenas` widget (see the WIDGET: TRUENAS
// section further down). #scr-sys, the green screen bar's old home for this
// data, is now permanently empty/hidden markup (see index.html) — this data
// lives only in the widget a user places for themselves, per house rule
// ("a widget you add yourself; it does not live in the green bar").
// ---------------------------------------------------------------------------

// Raw last-fetched payload from /api/truenas, or null before the first
// fetch resolves. Fetched independently of STATE (see fetchTruenasData),
// never through the structural-render signature — a data refresh only ever
// patches mounted `truenas` widget instances in place, never rebuilds them.
let TRUENAS_DATA = null;

// "Not configured" is a client-known fact (no url/key saved), decided here
// rather than by matching the fetch's error text — the endpoint's own
// ok:false covers a DIFFERENT case (configured but currently failing,
// e.g. an old Node runtime) and stays visible with quiet dashes instead of
// hiding the region.
function truenasConfigured() {
  const t = (STATE && STATE.settings && STATE.settings.truenas) || {};
  return Boolean(t.url) && Boolean(t.apiKeyHint);
}

function fmtPercent(n) {
  return n == null ? '--' : `${Math.round(n)}%`;
}

// A pool is "bad" — the only condition allowed to draw `--alert` anywhere
// in this widget (rule: healthy is quiet) — when it's reported unhealthy or
// its status isn't ONLINE. INFO-level alerts and high-but-normal ZFS memory
// use never qualify.
function truenasPoolIsBad(pool) {
  return Boolean(pool) && (pool.healthy === false || (pool.status && pool.status !== 'ONLINE'));
}

// Same body shape either way: from the server's /api/truenas, or — when
// TrueNAS has "Call from browser" on — straight from this browser.
async function fetchTruenasBody() {
  const creds = await browserCredentialsFor('truenas');
  if (creds) return PatchbayTruenas.loadSnapshot(creds);
  const res = await fetch('/api/truenas');
  return res.json();
}

// Fetched on the app's existing 20s refresh cycle (see boot() below) — no
// second timer. Patches every mounted `truenas` widget instance in place
// via updateWidgetInstances, the same mechanism every other widget type
// uses; never rebuilds one.
async function fetchTruenasData() {
  try {
    const body = await fetchTruenasBody();
    TRUENAS_DATA = { loaded: true, ...body };
  } catch (e) {
    TRUENAS_DATA = { loaded: true, ok: false, error: 'Could not reach the server.' };
  }
  updateWidgetInstances('truenas');
}

// ---------------------------------------------------------------------------
// WIDGET: TRUENAS — the placeable widget version of the old #scr-sys bar.
// Unlike that four-value bar this has room, so it shows every pool (not
// just the worst one), surfaces active alerts and unhealthy pools, and
// tucks host/version in quietly at the bottom. Built and patched the same
// way the VHS slider widgets are (see ensureSliderHost/reconcileSlider
// above): a fixed set of DOM nodes is created once per widget instance
// (ensureTruenasBody) and every refresh only ever patches text/classes on
// those same nodes (paintTruenasWidget/reconcileTruenasPools) — never torn
// down and rebuilt — so there is nothing to flicker.
// ---------------------------------------------------------------------------

// Builds the widget's DOM once per instance and caches it on the bodyEl
// itself (bodyEl.__tn) — the same "build once, patch forever" contract as
// ensureSliderHost. Structure: an optional single notice line (not
// configured / loading / ok:false — see paintTruenasWidget), then the
// CPU/MEM/UP figures, the full pool list, an alerts line, and a quiet
// host/version line.
function ensureTruenasBody(bodyEl) {
  if (bodyEl.__tn && bodyEl.dataset.mode === 'truenas') return bodyEl.__tn;
  bodyEl.innerHTML = '';
  bodyEl.dataset.mode = 'truenas';

  const notice = document.createElement('div');
  notice.className = 'widget-line tn-notice';
  notice.hidden = true;

  const stats = document.createElement('div');
  stats.className = 'tn-stats';
  const mkStat = (labelText) => {
    const item = document.createElement('div');
    item.className = 'tn-stat';
    const lab = document.createElement('span');
    lab.className = 'tn-stat-lab';
    lab.textContent = labelText;
    const val = document.createElement('span');
    val.className = 'tn-stat-val';
    val.textContent = '--';
    item.appendChild(lab);
    item.appendChild(val);
    stats.appendChild(item);
    return val;
  };
  const cpuVal = mkStat('CPU');
  const memVal = mkStat('MEM');
  const upVal = mkStat('UP');

  const pools = document.createElement('div');
  pools.className = 'tn-pools';

  const alerts = document.createElement('div');
  alerts.className = 'tn-line tn-alerts';

  const host = document.createElement('div');
  host.className = 'tn-line tn-host';

  bodyEl.appendChild(notice);
  bodyEl.appendChild(stats);
  bodyEl.appendChild(pools);
  bodyEl.appendChild(alerts);
  bodyEl.appendChild(host);

  const refs = { notice, stats, cpuVal, memVal, upVal, pools, alerts, host };
  bodyEl.__tn = refs;
  return refs;
}

// Reconciles the pool list against `pools` by name, same discipline as
// reconcileSlider: a pool that's still present keeps its exact row node,
// only added/removed/reordered pools touch the DOM.
function reconcileTruenasPools(poolsEl, pools) {
  const existing = new Map();
  Array.from(poolsEl.children).forEach((el) => {
    if (el.dataset.poolName != null) existing.set(el.dataset.poolName, el);
  });
  let prev = null;
  for (const pool of pools) {
    const key = pool && pool.name != null ? String(pool.name) : '';
    let row = existing.get(key);
    if (row) {
      existing.delete(key);
    } else {
      row = document.createElement('div');
      row.className = 'tn-pool';
      row.dataset.poolName = key;
      row.appendChild(document.createElement('span')).className = 'tn-pool-name';
      row.appendChild(document.createElement('span')).className = 'tn-pool-pct';
      row.appendChild(document.createElement('span')).className = 'tn-pool-status';
    }
    const bad = truenasPoolIsBad(pool);
    row.classList.toggle('tn-bad', bad);
    row.children[0].textContent = key ? key.toUpperCase() : '--';
    row.children[1].textContent = fmtPercent(pool.percent);
    // The status word only ever appears for a bad pool — a healthy ONLINE
    // pool has nothing worth saying twice (its row already reads calm).
    row.children[2].textContent = bad ? (pool.status || 'UNHEALTHY') : '';
    const afterEl = prev ? prev.nextSibling : poolsEl.firstChild;
    if (afterEl !== row) poolsEl.insertBefore(row, afterEl);
    prev = row;
  }
  for (const stale of existing.values()) stale.remove();
}

function paintTruenasWidget(bodyEl) {
  const refs = ensureTruenasBody(bodyEl);
  const configured = truenasConfigured();
  const data = TRUENAS_DATA;
  const loaded = Boolean(data && data.loaded);
  const ok = configured && loaded && data.ok;

  // Exactly one of these three is true at a time. Not-configured and
  // loading both keep this calm — no figures worth showing yet, so the
  // single notice line IS the whole widget. ok:false is different: the
  // figures still render (as "--", never a fabricated 0), and the error
  // joins them as one quiet line rather than replacing them.
  let noticeText = null;
  if (!configured) noticeText = 'Not configured.';
  else if (!loaded) noticeText = null; // let figures show "--" with no extra line
  else if (!data.ok) noticeText = data.error || 'TrueNAS is unreachable.';

  refs.notice.hidden = noticeText == null;
  if (noticeText != null) refs.notice.textContent = noticeText;

  const hideFigures = !configured; // loading and ok:false both still show "--"
  refs.stats.hidden = hideFigures;
  refs.pools.hidden = hideFigures;
  refs.alerts.hidden = hideFigures;
  refs.host.hidden = hideFigures;
  if (hideFigures) return;

  const cpu = ok ? data.cpu || {} : {};
  const memory = ok ? data.memory || {} : {};
  const uptime = ok ? data.uptime || {} : {};
  const poolsData = ok ? data.pools || [] : [];
  const hostInfo = ok ? data.host || {} : {};
  const alertsInfo = ok ? data.alerts || {} : {};

  refs.cpuVal.textContent = fmtPercent(cpu.percent);
  // Never thresholded — see the report sent alongside this widget. This is
  // a ZFS box; much of "used" is reclaimable ARC cache, so a high figure
  // is normal, and how much of it is cache has not been measured here, so
  // no colour judgement is made about it at all.
  refs.memVal.textContent = fmtPercent(memory.percent);
  refs.upVal.textContent = uptime.days != null ? `${uptime.days}D` : '--';

  reconcileTruenasPools(refs.pools, poolsData);
  refs.pools.hidden = poolsData.length === 0;

  // Alerts stay visible whenever there's real data, quiet text and all —
  // a fixed line rather than one that appears/disappears keeps the
  // widget's height steady across refreshes. Colour is reserved for a
  // WARNING/CRITICAL level; his single real alert today is INFO ("an
  // update is available") and must never look like a problem.
  if (ok) {
    const count = alertsInfo.active != null ? alertsInfo.active : alertsInfo.total;
    const level = alertsInfo.worstLevel || '';
    const bad = count > 0 && (level === 'WARNING' || level === 'CRITICAL');
    refs.alerts.textContent = count > 0
      ? `${count} ACTIVE ALERT${count === 1 ? '' : 'S'}${level ? ` · ${level}` : ''}`
      : 'NO ACTIVE ALERTS';
    refs.alerts.classList.toggle('tn-bad', bad);
    refs.alerts.hidden = false;
  } else {
    refs.alerts.hidden = true;
    refs.alerts.classList.remove('tn-bad');
  }

  refs.host.hidden = !ok || !hostInfo.hostname;
  refs.host.textContent = hostInfo.hostname
    ? (hostInfo.version ? `${hostInfo.hostname} · ${hostInfo.version}` : hostInfo.hostname)
    : '';
}

// ---------------------------------------------------------------------------
// Render: keys
// ---------------------------------------------------------------------------

function buildMonogram(entry) {
  const mono = document.createElement('span');
  mono.className = 'key-ic-mono';
  mono.setAttribute('aria-hidden', 'true'); // the adjacent service name is the accessible label
  mono.textContent = (entry.name || '?').charAt(0);
  return mono;
}

// Plain img — greyscale happens in CSS (.key-ic { filter: grayscale(1) }),
// not by touching pixels. These icons are cross-origin, so any pixel-reading
// API (getImageData/toDataURL/toBlob) would throw SecurityError; a CSS
// filter on the rendered element has no such restriction.
function buildIconImg(src, entry) {
  const img = document.createElement('img');
  img.className = 'key-ic';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';
  img.src = src;
  img.addEventListener('error', () => img.replaceWith(buildMonogram(entry)));
  img.addEventListener('load', () => {
    if (img.naturalWidth === 0) img.replaceWith(buildMonogram(entry));
  });
  return img;
}

function keyIcon(entry) {
  // Manual links: no Pangolin entry for the server to safely resolve a
  // target from, so this stays a plain client-side guess — the browser
  // fetching its own image isn't a server-side SSRF concern the way an
  // arbitrary user-supplied URL reaching server-side fetch() would be.
  if (entry.kind !== 'pangolin') {
    if (!entry.url) return buildMonogram(entry);
    try {
      return buildIconImg(`${new URL(entry.url).origin}/favicon.ico`, entry);
    } catch {
      return buildMonogram(entry);
    }
  }

  // Pangolin resources: the server DISCOVERS the icon's URL by reading the
  // service's own HTML (it can reach private hosts the browser's CORS
  // restrictions would block from reading cross-origin) — but the BROWSER
  // fetches the actual image, often via Pangolin's own magic DNS, getting
  // real HTTP caching for free. Two steps: a monogram placeholder now,
  // swapped for the real icon once the lookup resolves.
  const placeholder = buildMonogram(entry);
  fetch(`/api/icon?key=${encodeURIComponent(entry.hideKey)}`)
    .then((r) => r.json())
    .then((data) => {
      if (!data.url || !placeholder.isConnected) return;
      placeholder.replaceWith(buildIconImg(data.url, entry));
    })
    .catch(() => { /* stays a monogram */ });
  return placeholder;
}

function armThenConfirm(btn, confirmLabel, action) {
  if (btn.dataset.armed === '1') {
    action();
    return;
  }
  const original = btn.textContent;
  btn.textContent = confirmLabel;
  btn.dataset.armed = '1';
  btn.classList.add('armed');
  setTimeout(() => {
    btn.textContent = original;
    btn.dataset.armed = '0';
    btn.classList.remove('armed');
  }, 4000);
}

function buildKeySlot(entry, opts) {
  const status = computeStatus(entry);
  const favorites = favoritesSet();
  const isFav = favorites.has(entry.hideKey);
  const hidden = opts.isHidden;

  const slot = document.createElement('div');
  slot.className = 'slot';
  slot.dataset.entryKey = entry.hideKey; // stable identifier for targeted status updates

  // Inside a group, the section header above already names the group, and
  // latency now lives in the footer — this row would just be an empty
  // leftover. It only still earns its keep in the tray, where there's no
  // section header and it carries the "NEW" label plus the suggestion chip.
  if (opts.groupLabel) {
    const lab = document.createElement('div');
    lab.className = `slot-lab${status.cls === 'down' ? ' bad' : ''}`;
    lab.dataset.groupLabel = opts.groupLabel; // so a targeted update can rebuild the text later
    const labDot = document.createElement('i');
    lab.appendChild(labDot);
    lab.appendChild(document.createTextNode(opts.groupLabel));
    slot.appendChild(lab);
  }

  const keyEl = document.createElement(entry.url && !editMode ? 'a' : 'div');
  keyEl.className = `key${isFav ? ' alt' : ''}${hidden ? ' is-hidden' : ''}`;
  if (entry.url && !editMode) {
    keyEl.href = entry.url;
    keyEl.target = '_blank';
    keyEl.rel = 'noopener';
  }
  if (status.reason) {
    keyEl.title = status.reason;
    keyEl.setAttribute('aria-label', `${entry.name} — ${status.reason}`);
  }

  const top = document.createElement('div');
  top.className = 'key-top';
  const name = document.createElement('div');
  name.className = 'key-nm';
  name.textContent = entry.name;
  top.appendChild(name);
  top.appendChild(keyIcon(entry)); // name leads, icon sits opposite it — right-aligned via key-nm's flex:1
  keyEl.appendChild(top);

  const targetUrl = targetUrlFor(entry);
  const isChecking = Boolean(targetUrl && CHECKING_NOW.has(targetUrl));

  const bars = document.createElement('div');
  bars.className = `bars${isChecking ? ' is-checking' : ''}`;
  bars.title = isChecking ? 'Checking…' : 'No history yet';
  bars.setAttribute('aria-label', isChecking ? 'Checking…' : 'No history yet');
  // Always set, not just while currently checking — a later targeted update
  // (updateKeyStatusEls) only toggles the is-checking class, so this needs
  // to already be in place whenever that class gets added.
  bars.style.setProperty('--key-delay', `${(Math.max(1, opts.slotNumber || 1) - 1) * 0.15}s`);
  for (let i = 0; i < 10; i++) bars.appendChild(document.createElement('i'));
  keyEl.appendChild(bars);

  const footer = document.createElement('div');
  footer.className = 'key-ft';
  const num = document.createElement('span');
  num.textContent = String(opts.slotNumber).padStart(2, '0');
  footer.appendChild(num);
  if (status.cls === 'down') {
    const st = document.createElement('span');
    st.className = 'st down';
    st.textContent = 'DOWN';
    footer.appendChild(st);
  } else {
    // Latency (and its status dot) lives here now, right-aligned opposite
    // the slot number — down and latency never both apply, so they share
    // this slot in the footer.
    const lat = document.createElement('span');
    lat.className = 'key-lat';
    const latDot = document.createElement('i');
    lat.appendChild(latDot);
    lat.appendChild(document.createTextNode(statusLabel(status)));
    footer.appendChild(lat);
  }
  keyEl.appendChild(footer);

  if (editMode) {
    const row = document.createElement('div');
    row.className = 'key-edit-row';

    if (opts.suggestion) {
      const suggBtn = document.createElement('button');
      suggBtn.className = 'key-mini-btn suggestion-btn';
      suggBtn.type = 'button';
      const dot = document.createElement('i');
      dot.className = 'sugg-dot';
      dot.style.background = opts.suggestion.color || 'transparent';
      suggBtn.appendChild(dot);
      suggBtn.appendChild(document.createTextNode(`${opts.suggestion.exists ? '→' : '+'} ${opts.suggestion.name.toUpperCase()}`));
      suggBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        applySuggestion(opts.suggestion.resource);
      });
      row.appendChild(suggBtn);
    }

    const favBtn = document.createElement('button');
    favBtn.className = `key-mini-btn${isFav ? ' on-state' : ''}`;
    favBtn.type = 'button';
    favBtn.textContent = isFav ? 'UNFAV' : 'FAV';
    favBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(entry.hideKey);
    });
    row.appendChild(favBtn);

    const hideBtn = document.createElement('button');
    hideBtn.className = 'key-mini-btn';
    hideBtn.type = 'button';
    hideBtn.textContent = hidden ? 'UNHIDE' : 'HIDE';
    hideBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleHidden(entry.hideKey);
    });
    row.appendChild(hideBtn);

    if (entry.kind === 'manual' && opts.groupId) {
      const delBtn = document.createElement('button');
      delBtn.className = 'key-mini-btn';
      delBtn.type = 'button';
      delBtn.textContent = 'DELETE';
      delBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        armThenConfirm(delBtn, 'CONFIRM?', () => deleteManualItem(opts.groupId, entry.manualId));
      });
      row.appendChild(delBtn);
    }

    keyEl.appendChild(row);

    keyEl.draggable = true;
    keyEl.addEventListener('dragstart', (e) => {
      dragSource = { ref: opts.ref, fromGroupId: opts.groupId || null };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', entry.hideKey);
    });
    keyEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      keyEl.classList.add('drag-over');
    });
    keyEl.addEventListener('dragleave', () => keyEl.classList.remove('drag-over'));
    keyEl.addEventListener('drop', (e) => {
      e.preventDefault();
      keyEl.classList.remove('drag-over');
      if (!dragSource) return;
      dropOntoGroup(opts.groupId || null, opts.index);
    });
  }

  slot.appendChild(keyEl);

  if (targetUrl) {
    if (!URL_TO_SLOTS.has(targetUrl)) URL_TO_SLOTS.set(targetUrl, []);
    URL_TO_SLOTS.get(targetUrl).push({ slotEl: slot, entry });
  }

  return slot;
}

function buildEmptySlot(includeLabel) {
  const slot = document.createElement('div');
  slot.className = 'slot slot-empty';
  if (includeLabel) {
    const lab = document.createElement('div');
    lab.className = 'slot-lab';
    lab.innerHTML = '&nbsp;';
    slot.appendChild(lab);
  }
  const key = document.createElement('div');
  key.className = 'key empty';
  slot.appendChild(key);
  return slot;
}

function padEmptyKeys(gridEl, count, includeLabel) {
  const remainder = count % 4;
  const padCount = remainder === 0 ? 0 : 4 - remainder;
  for (let i = 0; i < padCount; i++) gridEl.appendChild(buildEmptySlot(includeLabel));
}

function itemColumnSpan(entry) {
  if (entry.kind === 'widget') {
    const def = WIDGET_TYPES[entry.widget];
    return (def && def.span) || 2;
  }
  return 1;
}

function itemRowSpan(entry) {
  if (entry.kind === 'widget') {
    const def = WIDGET_TYPES[entry.widget];
    return (def && def.rowSpan) || 1;
  }
  return 1;
}

// How many 1x1 grid cells an item actually reserves — used to keep the
// trailing empty-slot padding (padEmptyKeys) counting real occupied cells
// instead of just item count once multi-row items are in the mix.
function itemCellCount(entry) {
  return itemColumnSpan(entry) * itemRowSpan(entry);
}

// ---------------------------------------------------------------------------
// Render: widgets
// ---------------------------------------------------------------------------

// widgetType -> { loaded, ok, items, error } — fetched independently of
// STATE (see fetchWidgetData/fetchAllWidgetData), never through the
// structural-render signature, so a data refresh never triggers a full
// rebuild of the panel.
const WIDGET_DATA = {};

// widgetType -> [{ widgetId, bodyEl }] — every currently-mounted widget
// instance's content container, repopulated by every structural render
// (see render()) so a data-only refresh can find and patch them in place
// (updateWidgetInstances) instead of tearing down the groups region, the
// same discipline URL_TO_SLOTS applies to service keys.
const WIDGET_SLOTS = new Map();

function registerWidgetSlot(widgetType, widgetId, bodyEl) {
  let list = WIDGET_SLOTS.get(widgetType);
  if (!list) {
    list = [];
    WIDGET_SLOTS.set(widgetType, list);
  }
  list.push({ widgetId, bodyEl });
}

// Shared painter for any Jellyfin-shaped list widget (resume, up-next, …).
// `def.showProgress` decides whether a progress column is drawn at all —
// up-next episodes are unstarted, so their progress is always null, and
// rendering "--" there would still misleadingly imply a bar belongs; the
// whole progress cell is omitted instead. `def.maxItems` caps rows to what
// the widget's declared footprint (def.span x def.rowSpan) actually fits —
// a fixed module that always looks the same, not a growing/scrolling one.
// Shows exactly one line of body-level state (loading/error/empty). Reuses
// the existing line element in place when the mode hasn't changed — a
// state that never toggles data-to-data (e.g. staying loaded+ok+empty
// across ticks) never touches the DOM at all.
function setWidgetSingleLine(bodyEl, mode, cls, text) {
  if (bodyEl.dataset.mode === mode && bodyEl.children.length === 1) {
    bodyEl.firstElementChild.textContent = text;
    return;
  }
  bodyEl.innerHTML = '';
  bodyEl.dataset.mode = mode;
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = text;
  bodyEl.appendChild(line);
}

// ── the cassette (.vhs) — ported verbatim from the approved mockup
// (vhs-template.html). A spool seen through its aperture: a full reel is a
// dark glossy mass of tape, an empty one is pale plastic mechanism, so the
// two are drawn at different radii rather than the same circle rescaled.
//
// `anim`, when present ({durationSec, phaseSec, playing}), wraps the hub +
// teeth in an animated <g> — see reelAnimParams. Only the hub/teeth spin,
// never the outer wound-tape mass: that's a plain filled circle, and
// rotating a plain circle is visually indistinguishable from not rotating
// it at all. The teeth are sized and placed to actually read as motion at
// the widget's real ~165px tape height (see the comment on reelAnimParams
// for the legibility check) — bigger and further from centre than the
// original static decoration needed to be.
function spool(fill, anim) {
  const S = 100, R = S / 2, hub = R * 0.22, flange = R * 0.96;
  const f = Math.max(0, Math.min(1, fill));
  const outer = hub + (flange - hub) * f;
  const teethDist = hub * 0.65, teethR = hub * 0.30;
  const teeth = Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2;
    return `<circle cx="${(R + Math.cos(a) * teethDist).toFixed(1)}" cy="${(R + Math.sin(a) * teethDist).toFixed(1)}" r="${teethR.toFixed(1)}" fill="var(--window)" fill-opacity=".75"/>`;
  }).join('');
  const hubAttrs = anim
    ? ` class="reel-hub reel-hub--live" style="animation-duration:${anim.durationSec.toFixed(2)}s;animation-delay:-${anim.phaseSec.toFixed(2)}s;animation-play-state:${anim.playing ? 'running' : 'paused'}"`
    : ' class="reel-hub"';
  return `<svg viewBox="0 0 ${S} ${S}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <circle cx="${R}" cy="${R}" r="${flange}" fill="var(--hub-lo)" fill-opacity=".22"/>
    <circle cx="${R}" cy="${R}" r="${flange}" fill="none" stroke="var(--hub)" stroke-opacity=".28" stroke-width="1"/>
    <circle cx="${R}" cy="${R}" r="${(flange * 0.72).toFixed(1)}" fill="none" stroke="var(--hub)" stroke-opacity=".14" stroke-width="1"/>
    ${f > 0.03 ? `<circle cx="${R}" cy="${R}" r="${outer.toFixed(1)}" fill="var(--tape)"/>
    <circle cx="${R}" cy="${R}" r="${outer.toFixed(1)}" fill="none" stroke="var(--hub)" stroke-opacity=".5" stroke-width="1"/>` : ''}
    <g${hubAttrs}>
      <circle cx="${R}" cy="${R}" r="${hub}" fill="var(--hub)"/>
      ${teeth}
    </g>
  </svg>`;
}

// Duration + phase for one reel's rotation. Fuller reel = slower (up to
// 6s/rev), emptier = faster (down to 3s/rev) — linear between them, so it
// stays true as playback (and therefore fill) advances.
//
// The phase is anchored to wall-clock time (Date.now()), not to when this
// element happens to be created — tapeInnerHtml's innerHTML is regenerated
// on every 20s refresh (see updateTapeEl), which would otherwise mean a
// fresh <g> with animation-delay:0 restarting the spin from vertical every
// time. A negative animation-delay equal to "how far into the current
// cycle we'd be if this had been spinning continuously since epoch" makes
// a brand-new element pick up mid-rotation at the mathematically correct
// angle instead — so the rotation reads as continuous across a refresh
// even though the DOM node underneath it is not the same one.
function reelAnimParams(fillFraction, isPaused) {
  const f = Math.max(0, Math.min(1, fillFraction));
  const durationSec = 3 + 3 * f;
  const phaseSec = (Date.now() / 1000) % durationSec;
  return { durationSec, phaseSec, playing: !isPaused };
}

function tapeAriaLabel(d) {
  const band = d.season != null && d.episode != null ? `S${d.season}E${String(d.episode).padStart(2, '0')}` : '';
  const isLive = d.userName != null;
  const left = d.leftMin != null ? `, ${d.leftMin} minutes left` : '';
  if (isLive) {
    const state = d.isPaused ? 'Paused' : 'Now playing';
    return `${state}: ${d.series || ''}${band ? ' ' + band : ''}${d.episodeName ? ', ' + d.episodeName : ''} — ${d.userName || ''}${left}`;
  }
  if (d.progress == null) {
    return `Up next: ${d.series || ''}${band ? ' ' + band : ''}${d.episodeName ? ', ' + d.episodeName : ''}`;
  }
  return `Resume ${d.series || ''}${band ? ' ' + band : ''}${d.episodeName ? ', ' + d.episodeName : ''}${left}`;
}

// The cassette's inner markup for one item. `d` is one API item:
// { id, series, season, episode, episodeName, progress, runMin, leftMin,
//   posterUrl, logoUrl, bandColor, bandTextColor, url }. --hue/--hue-fg are
// set by the caller (updateTapeEl), not embedded here, since they belong on
// the <a class="vhs"> element itself.
// Restored to match the approved reference (vhs-template.html): episode
// name (.sub), the band's SxEy text, and the STARTED/FINISHED state row
// are all back — a label with nothing written on it stopped reading as a
// label. rowSpan is back to 4 and the tape back to flex:0 0 70% to fit it
// (see WIDGET_TYPES/styles.css). .left-l stays at the size it was bumped
// to (it measured 4.5px before, genuinely too small) and .lab-band/.sub/
// .state are bumped just enough to clear the same 9px floor — the
// reference's original sizes for those (6.66px/8.76px/5.95px at 70%
// width) were fine as *decoration* but not as *information*, and now
// that they're back they need to actually be read.
function tapeInnerHtml(d) {
  const isNextUp = d.progress == null;
  const isLive = d.userName != null; // now-playing items carry userName/isPaused
  const p = isNextUp ? 0 : Math.max(0, Math.min(100, d.progress)) / 100;
  const coverHtml = d.posterUrl
    ? `<span class="cover"><img src="${escapeHtml(d.posterUrl)}" alt="" loading="lazy" decoding="async"></span>`
    : '';
  const bandHtml = d.season != null && d.episode != null ? `S${d.season}E${String(d.episode).padStart(2, '0')}` : '';
  const titleHtml = d.logoUrl
    ? `<img class="mark" src="${escapeHtml(d.logoUrl)}" alt="${escapeHtml(d.series)}" loading="lazy" decoding="async">`
    : `<span class="title">${escapeHtml(d.series)}</span>`;

  // STARTED/FINISHED reflects reality per variant. A now-playing tape is
  // definitionally started and not finished — someone paused three
  // seconds from the credits is still watching it, not done with it — so
  // this ignores `p` entirely for live items rather than copying resume's
  // "finished once p>=0.98" logic blindly. Next-up has no progress at
  // all, so it stays a single unticked row.
  const stateHtml = isLive
    ? `<span class="chk"><span class="box on"></span>started</span><span class="chk"><span class="box"></span>finished</span>`
    : isNextUp
      ? `<span class="chk"><span class="box"></span>started</span><span class="chk"><span class="box"></span>finished</span>`
      : `<span class="chk"><span class="box on"></span>started</span><span class="chk"><span class="box${p >= 0.98 ? ' on' : ''}"></span>finished</span>`;

  const counterN = isNextUp
    ? (d.runMin != null ? d.runMin : '--')
    : (d.leftMin != null ? d.leftMin : '--');
  const counterL = isNextUp ? 'MIN' : 'MIN<br>LEFT';

  // The watcher's name, written on the paper label itself — like someone
  // actually grabbed a marker — not the moulded plastic strip, which is
  // back to reading the same fixed instruction on every tape regardless
  // of what's playing.
  const handName = isLive ? `<span class="hand-name">${escapeHtml(d.userName || '')}</span>` : '';

  const animL = isLive ? reelAnimParams(p, Boolean(d.isPaused)) : null;
  const animR = isLive ? reelAnimParams(1 - p, Boolean(d.isPaused)) : null;

  return `
    <span class="moulded"><span>insert this side into recorder</span><span class="vhsmark">VHS</span></span>
    <span class="win win--l">${spool(p, animL)}</span>
    <span class="lab">
      <span class="lab-band">${bandHtml}</span>
      <span class="lab-in">
        ${coverHtml}
        <span class="lab-txt">
          ${titleHtml}
          <span class="sub">${escapeHtml(d.episodeName)}</span>
        </span>
        <span class="left"><span class="left-n">${escapeHtml(counterN)}</span><span class="left-l">${counterL}</span></span>
      </span>
      <span class="state">${stateHtml}${handName}</span>
    </span>
    <span class="win win--r">${spool(1 - p, animR)}</span>
  `;
}

// Patches one cassette in place: attributes on the <a> itself (href, the
// per-item --hue/--hue-fg the server already computed, aria-label) plus a
// fresh innerHTML for everything inside it. The <a> node's identity never
// changes across a refresh — see reconcileSlider — so this never disturbs
// the slider's scroll position or mid-drag state.
function updateTapeEl(el, d) {
  if (d.url) {
    el.href = d.url;
    el.target = '_blank';
    el.rel = 'noopener';
  } else {
    el.removeAttribute('href');
  }
  el.style.setProperty('--hue', d.bandColor || '#8A8A8A');
  el.style.setProperty('--hue-fg', d.bandTextColor || '#fff');
  el.setAttribute('aria-label', tapeAriaLabel(d));
  el.innerHTML = tapeInnerHtml(d);
}

function buildTapeEl(item) {
  const a = document.createElement('a');
  a.className = 'vhs';
  a.dataset.itemId = String(item.id);
  updateTapeEl(a, item);
  return a;
}

// ── the slider, on Embla Carousel (public/vendor/embla-carousel.umd.js,
// vendored — no npm, no build step). Embla owns all pointer/touch/mouse
// drag handling and momentum; we only build/patch the DOM it drags.
//
// Click-vs-drag is Embla's own job, not ours: it attaches a capture-phase
// "click" listener to its container that swallows the click whenever the
// preceding pointer sequence moved enough to count as a drag. A plain tap
// on a tape's <a> is untouched and follows its href normally. There is no
// hand-rolled distance/velocity guard here — that was the previous,
// hand-rolled slider, and it's what Embla replaces.
//
// bodyEl -> { emblaApi, viewport, containerEl, dotsEl, lastIds } — built
// once per widget instance and reused across every data refresh (see
// reconcileSlider), never torn down, so a refresh never disrupts an
// in-flight drag or the current slide.
const SLIDER_STATE = new WeakMap();

function updateDotsCurrent(dotsEl, emblaApi) {
  const idx = emblaApi.selectedScrollSnap();
  Array.from(dotsEl.children).forEach((dot, i) => dot.setAttribute('aria-current', String(i === idx)));
}

function ensureSliderHost(bodyEl) {
  let state = SLIDER_STATE.get(bodyEl);
  if (state && bodyEl.dataset.mode === 'slider') return state;
  bodyEl.innerHTML = '';
  bodyEl.dataset.mode = 'slider';

  const wrap = document.createElement('div');
  wrap.className = 'vhs-slider-wrap';
  const viewport = document.createElement('div');
  viewport.className = 'embla';
  viewport.setAttribute('role', 'group');
  viewport.setAttribute('aria-label', 'Tape slider');
  const containerEl = document.createElement('div');
  containerEl.className = 'embla__container';
  viewport.appendChild(containerEl);
  const dotsEl = document.createElement('div');
  dotsEl.className = 'dots';
  wrap.appendChild(viewport);
  wrap.appendChild(dotsEl);
  bodyEl.appendChild(wrap);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const options = {
    align: 'center',
    containScroll: 'trimSnaps',
    dragFree: false,
    // We drive re-measurement ourselves (see reconcileSlider) so a patch
    // that only changes an existing tape's innerHTML — no add/remove/
    // reorder — never triggers Embla's own mutation-observer-based
    // reInit, which would otherwise fire on every single 20s refresh.
    watchSlides: false,
  };
  if (reduceMotion) options.duration = 0;
  const emblaApi = EmblaCarousel(viewport, options);
  emblaApi.on('select', () => updateDotsCurrent(dotsEl, emblaApi));

  state = { emblaApi, viewport, containerEl, dotsEl, lastIds: null };
  SLIDER_STATE.set(bodyEl, state);
  return state;
}

// Reconciles the slider's slides AND its nav dots against `items` by
// item.id — the same discipline as the rest of this app's targeted
// patching (see updateStatusForUrl, updateWidgetInstances): a tape that's
// still present keeps its exact DOM node (wrapped in an .embla__slide),
// only genuinely added/removed/reordered items touch the DOM. Embla is
// told about it — via reInit() — only when the id list actually changed;
// an in-place content patch (e.g. a progress figure ticking over) never
// touches Embla at all. The currently-selected index is read before
// reconciling and restored with scrollTo(index, true) afterward — jump,
// not animate — so a refresh is never visible as a slide.
function reconcileSlider(bodyEl, items, def) {
  const state = ensureSliderHost(bodyEl);
  const { emblaApi, containerEl, dotsEl } = state;

  const newIds = items.map((it) => String(it.id));
  const idsChanged =
    state.lastIds == null ||
    newIds.length !== state.lastIds.length ||
    newIds.some((id, i) => id !== state.lastIds[i]);
  const selectedIndex = emblaApi.selectedScrollSnap();

  const existingSlides = new Map();
  Array.from(containerEl.children).forEach((el) => {
    if (el.dataset.itemId) existingSlides.set(el.dataset.itemId, el);
  });
  let prevSlide = null;
  for (const item of items) {
    const id = String(item.id);
    let slide = existingSlides.get(id);
    if (slide) {
      existingSlides.delete(id);
      updateTapeEl(slide.querySelector('.vhs'), item);
    } else {
      slide = document.createElement('div');
      slide.className = 'embla__slide';
      slide.dataset.itemId = id;
      slide.appendChild(buildTapeEl(item));
    }
    const afterEl = prevSlide ? prevSlide.nextSibling : containerEl.firstChild;
    if (afterEl !== slide) containerEl.insertBefore(slide, afterEl);
    prevSlide = slide;
  }
  for (const stale of existingSlides.values()) stale.remove();

  const existingDots = new Map();
  Array.from(dotsEl.children).forEach((el) => {
    if (el.dataset.itemId) existingDots.set(el.dataset.itemId, el);
  });
  let prevDot = null;
  items.forEach((item) => {
    const id = String(item.id);
    let dot = existingDots.get(id);
    if (dot) {
      existingDots.delete(id);
    } else {
      dot = document.createElement('button');
      dot.className = 'dot';
      dot.type = 'button';
      dot.dataset.itemId = id;
      // Looked up at click-time, not captured at creation-time — dots stay
      // in item order (same insertBefore discipline as the slides above),
      // so the live index is always correct even after items reorder.
      dot.addEventListener('click', () => emblaApi.scrollTo(Array.from(dotsEl.children).indexOf(dot)));
    }
    dot.setAttribute('aria-label', `Show ${item.series || ''}`);
    const afterEl = prevDot ? prevDot.nextSibling : dotsEl.firstChild;
    if (afterEl !== dot) dotsEl.insertBefore(dot, afterEl);
    prevDot = dot;
  });
  for (const stale of existingDots.values()) stale.remove();

  if (idsChanged) {
    emblaApi.reInit();
    emblaApi.scrollTo(Math.min(selectedIndex, Math.max(0, items.length - 1)), true);
  }
  state.lastIds = newIds;
  // Embla's own 'select' event does not fire for "still at the same
  // index" — including the very first paint, which is always still at
  // index 0 — so the initial mount would otherwise leave every dot
  // without aria-current until the user actually changes slides. Calling
  // this directly, every reconcile, is what actually keeps the indicator
  // honest; the 'select' listener above is only the fast path for a live
  // drag/click, not the sole source of truth.
  updateDotsCurrent(dotsEl, emblaApi);
}

function paintJellyfinSlider(bodyEl, data, def) {
  if (!data || !data.loaded) {
    setWidgetSingleLine(bodyEl, 'loading', 'widget-line', 'LOADING…');
    return;
  }
  if (!data.ok) {
    setWidgetSingleLine(bodyEl, 'notice', 'widget-notice', data.error || 'Jellyfin is not configured.');
    return;
  }
  const items = (data.items || []).slice(0, def.maxItems || (data.items || []).length);
  if (items.length === 0) {
    setWidgetSingleLine(bodyEl, 'empty', 'widget-line', def.emptyText || 'Nothing here.');
    return;
    // (widgets flagged hideWhenEmpty collapse their whole slot instead —
    //  applied in applyWidgetEmptyVisibility, called after every paint)
  }
  reconcileSlider(bodyEl, items, def);
}

function renderWidgetBody(widgetType, bodyEl) {
  const def = WIDGET_TYPES[widgetType];
  if (!def || !def.paint) return;
  def.paint(bodyEl, WIDGET_DATA[widgetType], def);
  applyWidgetEmptyVisibility(widgetType, def, bodyEl);
}

// A widget flagged `hideWhenEmpty` collapses its whole grid slot when it has
// nothing to show, rather than sitting there as a large empty card. Now
// Playing is idle most of the day, so the empty case is its NORMAL case.
//
// Two conditions on hiding it, both load-bearing:
//   - never in EDIT mode: a hidden slot cannot be dragged or deleted, so the
//     widget would become impossible to remove once placed.
//   - only on a genuinely empty result. A loading or errored widget stays
//     visible, because "I could not reach Jellyfin" is information and
//     silently vanishing would hide a fault.
function applyWidgetEmptyVisibility(widgetType, def, bodyEl) {
  if (!def.hideWhenEmpty) return;
  const slot = bodyEl.closest('.widget-slot');
  if (!slot) return;
  const data = WIDGET_DATA[widgetType];
  const isEmpty = Boolean(data && data.loaded && data.ok && (data.items || []).length === 0);
  slot.hidden = isEmpty && !editMode;
}

// Patches every mounted instance of one widget type in place — called after
// a fresh fetch lands. Never touches anything structural.
function updateWidgetInstances(widgetType) {
  const list = WIDGET_SLOTS.get(widgetType);
  if (!list) return;
  for (const { bodyEl } of list) {
    if (!bodyEl.isConnected) continue; // stale reference from a since-replaced structural render
    renderWidgetBody(widgetType, bodyEl);
  }
}

async function fetchWidgetBody(def) {
  const creds = def.browserLoad ? await browserCredentialsFor('jellyfin') : null;
  if (creds) return def.browserLoad(creds);
  const res = await fetch(def.endpoint);
  return res.json();
}

async function fetchWidgetData(widgetType) {
  const def = WIDGET_TYPES[widgetType];
  if (!def || !def.endpoint) return;
  try {
    const body = await fetchWidgetBody(def);
    WIDGET_DATA[widgetType] = { loaded: true, ok: Boolean(body.ok), items: body.items || [], error: body.error || null };
  } catch (e) {
    WIDGET_DATA[widgetType] = { loaded: true, ok: false, items: [], error: 'Could not reach the server.' };
  }
  updateWidgetInstances(widgetType);
}

// Every registered widget type with an endpoint fetches independently and
// in parallel — one more widget type here needs no new call site, boot()
// and the refresh interval just iterate the registry.
function fetchAllWidgetData() {
  return Promise.all(Object.keys(WIDGET_TYPES).map(fetchWidgetData));
}

function deleteWidgetItem(groupId, widgetId) {
  const group = STATE.layout.groups.find((g) => g.id === groupId);
  if (!group) return;
  group.items = group.items.filter((it) => !(it.type === 'widget' && it.id === widgetId));
  persist();
}

function buildWidgetSlot(entry, opts) {
  const def = WIDGET_TYPES[entry.widget] || { title: entry.widget, span: 2, rowSpan: 1 };

  const slot = document.createElement('div');
  slot.className = 'slot widget-slot';
  slot.dataset.entryKey = entry.hideKey;
  // The declared footprint lives entirely in the registry, set here as the
  // single source of truth — not duplicated as a fixed value in CSS — so a
  // future widget type can be a different shape without touching styles.css.
  slot.style.gridColumn = `span ${def.span || 2}`;
  slot.style.gridRow = `span ${def.rowSpan || 1}`;

  const card = document.createElement('div');
  card.className = def.bare ? 'widget-card widget-card--bare' : 'widget-card';

  const head = document.createElement('div');
  head.className = 'widget-head';
  const lab = document.createElement('span');
  lab.className = 'widget-lab';
  lab.textContent = def.title;
  head.appendChild(lab);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'widget-body';
  card.appendChild(body);
  registerWidgetSlot(entry.widget, entry.widgetId, body);
  renderWidgetBody(entry.widget, body);

  if (editMode) {
    const row = document.createElement('div');
    row.className = 'key-edit-row';
    const delBtn = document.createElement('button');
    delBtn.className = 'key-mini-btn';
    delBtn.type = 'button';
    delBtn.textContent = 'DELETE';
    delBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      armThenConfirm(delBtn, 'CONFIRM?', () => deleteWidgetItem(opts.groupId, entry.widgetId));
    });
    row.appendChild(delBtn);
    card.appendChild(row);

    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      dragSource = { ref: opts.ref, fromGroupId: opts.groupId || null };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', entry.hideKey);
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      if (!dragSource) return;
      dropOntoGroup(opts.groupId || null, opts.index);
    });
  }

  slot.appendChild(card);
  return slot;
}

// ---------------------------------------------------------------------------
// Render: tray
// ---------------------------------------------------------------------------

function renderTray() {
  const trayEl = $('#tray');
  const itemsEl = $('#tray-items');
  const tray = computeTray();

  if (!editMode || tray.length === 0) {
    trayEl.hidden = true;
    itemsEl.innerHTML = '';
    return;
  }

  trayEl.hidden = false;
  itemsEl.innerHTML = '';
  let suggestedCount = 0;
  tray.forEach((resource, index) => {
    const entry = { hideKey: resource.key, kind: 'pangolin', name: resource.name, domain: resource.domain, url: resource.url, resource };
    const ref = { type: 'pangolin', key: resource.key };
    const suggestion = suggestionFor(resource);
    if (suggestion) {
      suggestedCount++;
      suggestion.resource = resource;
    }
    const slot = buildKeySlot(entry, { isHidden: false, ref, groupId: null, slotNumber: index + 1, groupLabel: 'NEW', suggestion });
    itemsEl.appendChild(slot);
  });
  padEmptyKeys(itemsEl, tray.length, true);

  const bulkBtn = $('#tray-place-all');
  bulkBtn.hidden = suggestedCount === 0;
  bulkBtn.textContent = `PLACE ALL SUGGESTED (${suggestedCount})`;

  itemsEl.addEventListener('dragover', (e) => e.preventDefault());
  itemsEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragSource) return;
    removeFromGroups(dragSource.ref);
    dragSource = null;
    persist();
  });
}

// ---------------------------------------------------------------------------
// Render: groups
// ---------------------------------------------------------------------------

function renderGroups() {
  const el = $('#groups');
  el.innerHTML = '';
  const hidden = hiddenSet();

  if (STATE.layout.groups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = editMode ? 'Press + Add group to make your first group.' : 'Press Edit and make your first group.';
    el.appendChild(empty);
    return;
  }

  STATE.layout.groups.forEach((group, groupIndex) => {
    const block = document.createElement('div');
    block.className = 'group-block';

    const head = document.createElement('div');
    head.className = 'section-head';

    const name = document.createElement('span');
    name.className = 'lbl';
    name.textContent = group.name;
    if (editMode) {
      name.contentEditable = 'true';
      name.spellcheck = false;
      name.addEventListener('blur', () => {
        const val = name.textContent.trim() || 'UNNAMED';
        group.name = val;
        persist();
      });
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          name.blur();
        }
      });
    }
    head.appendChild(name);

    if (editMode) {
      // Reordering the groups themselves. The ends stay visible but disabled
      // so the header keeps the same shape in every group.
      head.appendChild(buildMoveGroupBtn(groupIndex, -1));
      head.appendChild(buildMoveGroupBtn(groupIndex, 1));

      const delBtn = document.createElement('button');
      delBtn.className = 'section-btn';
      delBtn.type = 'button';
      delBtn.textContent = 'DELETE';
      delBtn.addEventListener('click', () => {
        armThenConfirm(delBtn, 'CONFIRM?', () => {
          STATE.layout.groups = STATE.layout.groups.filter((g) => g.id !== group.id);
          persist();
        });
      });
      head.appendChild(delBtn);
    }

    block.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'pad';

    const visibleItems = editMode ? group.items : group.items.filter((it) => {
      const key = it.type === 'pangolin' ? it.key : it.id;
      return !hidden.has(key);
    });

    if (visibleItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Drag services here.';
      grid.appendChild(empty);
    } else {
      let totalSpan = 0;
      visibleItems.forEach((ref, index) => {
        const entry = resolveItem(ref);
        if (!entry) return;
        totalSpan += itemCellCount(entry);
        if (entry.kind === 'widget') {
          const slot = buildWidgetSlot(entry, { ref, groupId: group.id, index });
          grid.appendChild(slot);
          return;
        }
        const isItemHidden = hidden.has(entry.hideKey);
        const slot = buildKeySlot(entry, {
          isHidden: isItemHidden,
          ref,
          groupId: group.id,
          index,
          slotNumber: index + 1,
        });
        grid.appendChild(slot);
      });
      padEmptyKeys(grid, totalSpan, false);
    }

    if (editMode) {
      grid.addEventListener('dragover', (e) => e.preventDefault());
      grid.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragSource) return;
        dropOntoGroup(group.id, group.items.length);
      });
    }

    block.appendChild(grid);
    el.appendChild(block);
  });
}

function buildMoveGroupBtn(index, delta) {
  const up = delta < 0;
  const btn = document.createElement('button');
  btn.className = 'section-btn section-arrow';
  btn.type = 'button';
  btn.textContent = up ? '▲' : '▼';
  btn.title = up ? 'Move group up' : 'Move group down';
  btn.setAttribute('aria-label', btn.title);
  const target = index + delta;
  if (target < 0 || target >= STATE.layout.groups.length) {
    btn.disabled = true;
  } else {
    btn.addEventListener('click', () => moveGroup(index, target));
  }
  return btn;
}

function moveGroup(from, to) {
  const groups = STATE.layout.groups;
  if (to < 0 || to >= groups.length) return;
  const [moved] = groups.splice(from, 1);
  groups.splice(to, 0, moved);
  persist();
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function toggleHidden(key) {
  const idx = STATE.layout.hidden.indexOf(key);
  if (idx === -1) STATE.layout.hidden.push(key);
  else STATE.layout.hidden.splice(idx, 1);
  persist();
}

function toggleFavorite(key) {
  if (!STATE.layout.favorites) STATE.layout.favorites = [];
  const idx = STATE.layout.favorites.indexOf(key);
  if (idx === -1) STATE.layout.favorites.push(key);
  else STATE.layout.favorites.splice(idx, 1);
  persist();
}

function refEquals(a, b) {
  if (a.type !== b.type) return false;
  return a.type === 'pangolin' ? a.key === b.key : a.id === b.id;
}

function removeFromGroups(ref) {
  for (const g of STATE.layout.groups) {
    g.items = g.items.filter((it) => !refEquals(it, ref));
  }
}

function dropOntoGroup(targetGroupId, targetIndex) {
  if (!dragSource) return;
  const { ref } = dragSource;
  dragSource = null;
  removeFromGroups(ref);
  if (targetGroupId == null) {
    persist();
    return;
  }
  const group = STATE.layout.groups.find((g) => g.id === targetGroupId);
  if (!group) return;
  const idx = Math.min(targetIndex ?? group.items.length, group.items.length);
  group.items.splice(idx, 0, ref);
  persist();
}

function deleteManualItem(groupId, manualId) {
  const group = STATE.layout.groups.find((g) => g.id === groupId);
  if (!group) return;
  group.items = group.items.filter((it) => !(it.type === 'manual' && it.id === manualId));
  persist();
}

function addGroup() {
  const id = crypto.randomUUID();
  STATE.layout.groups.push({ id, name: 'NEW GROUP', items: [] });
  persist();
}

// Labels only ever suggest a placement — nothing moves without a click.
function applySuggestion(resource) {
  const labels = resource.labels || [];
  if (labels.length === 0) return;
  const labelName = labels[0].name;
  let group = STATE.layout.groups.find((g) => g.name.toLowerCase() === labelName.toLowerCase());
  if (!group) {
    group = { id: crypto.randomUUID(), name: labelName, items: [] };
    STATE.layout.groups.push(group);
  }
  group.items.push({ type: 'pangolin', key: resource.key });
  persist();
}

function placeAllSuggested() {
  const tray = computeTray();
  const byName = new Map();
  for (const g of STATE.layout.groups) byName.set(g.name.toLowerCase(), g);

  let moved = 0;
  for (const resource of tray) {
    const labels = resource.labels || [];
    if (labels.length === 0) continue;
    const labelName = labels[0].name;
    const key = labelName.toLowerCase();
    let group = byName.get(key);
    if (!group) {
      group = { id: crypto.randomUUID(), name: labelName, items: [] };
      STATE.layout.groups.push(group);
      byName.set(key, group);
    }
    group.items.push({ type: 'pangolin', key: resource.key });
    moved++;
  }
  if (moved > 0) persist();
}

// ---------------------------------------------------------------------------
// Search overlay
// ---------------------------------------------------------------------------

function buildSearchIndex() {
  const hidden = hiddenSet();
  const seen = new Set();
  const index = [];

  for (const g of STATE.layout.groups) {
    for (const ref of g.items) {
      if (ref.type === 'widget') continue; // widgets have no single URL to jump to
      const entry = resolveItem(ref);
      if (!entry) continue;
      if (hidden.has(entry.hideKey)) continue;
      if (seen.has(entry.hideKey)) continue;
      seen.add(entry.hideKey);
      index.push(entry);
    }
  }
  for (const resource of computeTray()) {
    const entry = resolveItem({ type: 'pangolin', key: resource.key });
    if (!entry || seen.has(entry.hideKey)) continue;
    seen.add(entry.hideKey);
    index.push(entry);
  }
  return index;
}

let searchIndex = [];
let searchResults = [];
let searchSelected = 0;

function openSearch() {
  searchIndex = buildSearchIndex();
  searchResults = searchIndex;
  searchSelected = 0;
  $('#search-overlay').hidden = false;
  const input = $('#search-input');
  input.value = '';
  input.focus();
  renderSearchResults();
}

function closeSearch() {
  $('#search-overlay').hidden = true;
}

function renderSearchResults() {
  const el = $('#search-results');
  el.innerHTML = '';
  if (searchResults.length === 0) {
    el.innerHTML = '<div class="search-empty">No matches.</div>';
    return;
  }
  searchResults.forEach((entry, i) => {
    const status = computeStatus(entry);
    const row = document.createElement('div');
    row.className = `search-row${i === searchSelected ? ' selected' : ''}`;
    row.innerHTML = `
      <span class="gl gl-${status.cls}"></span>
      <span class="name">${escapeHtml(entry.name)}</span>
      <span class="st-lab">${escapeHtml(status.cls.toUpperCase())}</span>
      <span class="domain">${escapeHtml(entry.domain || '')}</span>
    `;
    row.addEventListener('click', () => openSearchResult(i));
    el.appendChild(row);
  });
}

function openSearchResult(i) {
  const entry = searchResults[i];
  if (entry && entry.url) window.open(entry.url, '_blank', 'noopener');
  closeSearch();
}

function initSearch() {
  document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);

    // Cmd+K (macOS) / Ctrl+K (elsewhere) — a global shortcut, unlike `/`,
    // so it's deliberately NOT gated on !isTyping: it must work even while
    // focus is already inside an input. Always preventDefault so it never
    // falls through to the browser's own address-bar/find shortcut.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!$('#search-overlay').hidden) closeSearch();
      else if ($('#modal-scrim').hidden) openSearch();
      return;
    }
    if (e.key === '/' && !isTyping && $('#search-overlay').hidden && $('#modal-scrim').hidden) {
      e.preventDefault();
      openSearch();
      return;
    }
    if (e.key === 'Escape') {
      if (!$('#search-overlay').hidden) closeSearch();
      if (!$('#modal-scrim').hidden) closeModal();
      return;
    }
    if ($('#search-overlay').hidden) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      searchSelected = Math.min(searchSelected + 1, searchResults.length - 1);
      renderSearchResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      searchSelected = Math.max(searchSelected - 1, 0);
      renderSearchResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (searchResults.length) openSearchResult(searchSelected);
    }
  });

  $('#search-input').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    searchResults = !q
      ? searchIndex
      : searchIndex.filter((entry) => (entry.name + ' ' + (entry.domain || '')).toLowerCase().includes(q));
    searchSelected = 0;
    renderSearchResults();
  });

  $('#search-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'search-overlay') closeSearch();
  });

  $('#chip-search').addEventListener('click', openSearch);
}

// ---------------------------------------------------------------------------
// Add service modal
// ---------------------------------------------------------------------------

function fillSelect(select, options, labelKey, valueKey) {
  select.innerHTML = options.map((o) => `<option value="${escapeHtml(o[valueKey])}">${escapeHtml(o[labelKey])}</option>`).join('');
}

async function populateModalSelects() {
  const groupSelect = $('#form-manual select[name="groupId"]');
  if (STATE.layout.groups.length === 0) {
    groupSelect.innerHTML = '<option value="">No groups yet — create one first</option>';
  } else {
    fillSelect(groupSelect, STATE.layout.groups, 'name', 'id');
  }
}

async function openModal() {
  $('#modal-scrim').hidden = false;
  $('#form-manual').reset();
  $('#modal-error').hidden = true;
  try {
    await populateModalSelects();
  } catch (e) {
    showModalError(e.message);
  }
}

function closeModal() {
  $('#modal-scrim').hidden = true;
}

function showModalError(message) {
  const el = $('#modal-error');
  el.textContent = message;
  el.hidden = false;
}

async function submitManualForm(form) {
  const data = new FormData(form);
  const groupId = data.get('groupId');
  if (!groupId) throw new Error('Create a group before adding manual links.');
  const group = STATE.layout.groups.find((g) => g.id === groupId);
  if (!group) throw new Error('Selected group no longer exists.');
  const item = { type: 'manual', id: crypto.randomUUID(), name: data.get('name'), url: data.get('url') };
  group.items.push(item);
  await saveLayout();
  closeModal();
  render();
}

function initModal() {
  $('#add-link-btn').addEventListener('click', () => openModal());
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-scrim').addEventListener('click', (e) => {
    if (e.target.id === 'modal-scrim') closeModal();
  });

  $('#form-manual').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await submitManualForm(e.target);
    } catch (err) {
      showModalError(err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Add widget modal
// ---------------------------------------------------------------------------

function populateWidgetTypeSelect() {
  const select = $('#widget-type-select');
  select.innerHTML = Object.entries(WIDGET_TYPES)
    .map(([key, def]) => `<option value="${escapeHtml(key)}">${escapeHtml(def.title)}</option>`)
    .join('');
}

async function populateWidgetModalSelects() {
  const groupSelect = $('#form-widget select[name="groupId"]');
  if (STATE.layout.groups.length === 0) {
    groupSelect.innerHTML = '<option value="">No groups yet — create one first</option>';
  } else {
    fillSelect(groupSelect, STATE.layout.groups, 'name', 'id');
  }
  populateWidgetTypeSelect();
}

async function openWidgetModal() {
  $('#widget-modal-scrim').hidden = false;
  $('#form-widget').reset();
  $('#widget-modal-error').hidden = true;
  try {
    await populateWidgetModalSelects();
  } catch (e) {
    showWidgetModalError(e.message);
  }
}

function closeWidgetModal() {
  $('#widget-modal-scrim').hidden = true;
}

function showWidgetModalError(message) {
  const el = $('#widget-modal-error');
  el.textContent = message;
  el.hidden = false;
}

async function submitWidgetForm(form) {
  const data = new FormData(form);
  const groupId = data.get('groupId');
  const widgetKey = data.get('widget');
  if (!groupId) throw new Error('Create a group before adding a widget.');
  if (!widgetKey || !WIDGET_TYPES[widgetKey]) throw new Error('Choose a widget.');
  const group = STATE.layout.groups.find((g) => g.id === groupId);
  if (!group) throw new Error('Selected group no longer exists.');
  const item = { type: 'widget', id: crypto.randomUUID(), widget: widgetKey };
  group.items.push(item);
  await saveLayout();
  closeWidgetModal();
  render();
}

function initWidgetModal() {
  $('#add-widget-btn').addEventListener('click', () => openWidgetModal());
  $('#widget-modal-close').addEventListener('click', closeWidgetModal);
  $('#widget-modal-scrim').addEventListener('click', (e) => {
    if (e.target.id === 'widget-modal-scrim') closeWidgetModal();
  });

  $('#form-widget').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await submitWidgetForm(e.target);
    } catch (err) {
      showWidgetModalError(err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Edit mode toggle
// ---------------------------------------------------------------------------

function initEditToggle() {
  $('#chip-edit').addEventListener('click', () => {
    editMode = !editMode;
    $('#edit-actions').hidden = !editMode;
    render();
  });
  $('#add-group-btn').addEventListener('click', addGroup);
  $('#chip-theme').addEventListener('click', cycleTheme);
  $('#tray-place-all').addEventListener('click', placeAllSuggested);
  $('#chip-check').addEventListener('click', () => checkAllUptime());
  $('#chip-settings').addEventListener('click', () => {
    window.location.href = '/settings.html';
  });
}

// ---------------------------------------------------------------------------
// Main render + boot
// ---------------------------------------------------------------------------

// Structural rebuild — groups/tray membership, ordering, edit mode, theme.
// NOT for a status update alone; use updateStatusForUrl for that (see the
// check loop in checkAllUptime), or this tears down and rebuilds every
// icon, restarts the checking animation, and drops scroll/focus state.
let lastStateSignature = null;

function computeStateSignature(state) {
  return JSON.stringify({
    resources: state.pangolin.resources,
    sites: state.pangolin.sites,
    error: state.pangolin.error,
    jellyfin: state.jellyfin,
    layout: state.layout,
  });
}

function render() {
  if (!STATE) return;
  applyTheme(STATE.layout.theme || 'ko');
  URL_TO_SLOTS.clear();
  WIDGET_SLOTS.clear();
  renderChips();
  renderPlate();
  renderScreen();
  renderTray();
  renderGroups();
  sweepWidgetEmptyVisibility();
  lastStateSignature = computeStateSignature(STATE);
}

// renderWidgetBody applies this per widget, but during a structural render the
// body is painted before it is inside its slot, so `closest('.widget-slot')`
// finds nothing and the slot keeps whatever visibility it had. Leaving EDIT
// mode is exactly that path — the widget reappeared for editing and then
// stayed. Sweeping once after the tree is built catches every instance
// regardless of the order it was assembled in.
function sweepWidgetEmptyVisibility() {
  for (const [widgetType, list] of WIDGET_SLOTS) {
    const def = WIDGET_TYPES[widgetType];
    if (!def || !def.hideWhenEmpty) continue;
    for (const { bodyEl } of list) {
      if (bodyEl.isConnected) applyWidgetEmptyVisibility(widgetType, def, bodyEl);
    }
  }
}

async function refresh(force) {
  try {
    await fetchState(force);
    if (computeStateSignature(STATE) === lastStateSignature) return; // nothing changed — skip the rebuild
    render();
  } catch (e) {
    console.error(e);
  }
}

async function boot() {
  initEditToggle();
  initModal();
  initWidgetModal();
  initSearch();
  await refresh(false);
  checkAllUptime(); // on load only — never on the interval below
  fetchAllWidgetData(); // on load, then piggybacks on the refresh interval below — no second timer
  fetchTruenasData(); // ditto
  setInterval(() => {
    refresh(false);
    fetchAllWidgetData();
    fetchTruenasData();
  }, 20000);
}

boot();
