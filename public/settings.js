'use strict';

// ---------------------------------------------------------------------------
// Small self-contained helpers (this page has no build step and shares
// nothing with app.js at runtime — duplicated on purpose).
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const THEMES = ['ko', 'riddim'];

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('hc1-theme', theme);
  } catch (e) { /* localStorage unavailable */ }
}

function cycleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'ko';
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  applyTheme(next);
  $('#chip-theme').textContent = `THEME · ${next.toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Load + populate
// ---------------------------------------------------------------------------

let SETTINGS = null;

async function loadSettings() {
  const res = await fetch('/api/settings');
  if (!res.ok) throw new Error(`Failed to load settings: ${res.status}`);
  SETTINGS = await res.json();
}

function setField(name, value) {
  const el = document.querySelector(`[name="${name}"]`);
  if (el) el.value = value != null ? value : '';
}

// Key fields are never populated with the actual value — the server never
// sends one. The hint (last 4 chars, or null) is shown as a helper string
// next to the field, and as a placeholder, so the field visibly reads
// "there is a key saved" without ever putting it in the DOM.
function applyKeyHint(inputName, helpElId, hint) {
  const input = document.querySelector(`[name="${inputName}"]`);
  if (input) {
    input.placeholder = hint ? `saved, ending ${hint}` : 'no key saved';
  }
  const help = $(`#${helpElId}`);
  if (help) {
    help.textContent = hint
      ? `Saved, ending ${hint}. Leave blank to keep it.`
      : 'No key saved yet. Leave blank to skip.';
  }
}

function populateForm() {
  if (!SETTINGS) return;
  const branding = SETTINGS.branding || {};
  const pangolin = SETTINGS.pangolin || {};
  const truenas = SETTINGS.truenas || {};
  const jellyfin = SETTINGS.jellyfin || {};

  setField('branding.model', branding.model);
  setField('branding.subtitle', branding.subtitle);

  setField('pangolin.apiUrl', pangolin.apiUrl);
  setField('pangolin.orgId', pangolin.orgId);
  applyKeyHint('pangolin.apiKey', 'hint-pangolin', pangolin.apiKeyHint);

  setField('truenas.url', truenas.url);
  applyKeyHint('truenas.apiKey', 'hint-truenas', truenas.apiKeyHint);

  setField('jellyfin.url', jellyfin.url);
  applyKeyHint('jellyfin.apiKey', 'hint-jellyfin', jellyfin.apiKeyHint);
}

// ---------------------------------------------------------------------------
// Jellyfin user picker
// ---------------------------------------------------------------------------

// Degrades honestly: a missing url/key or a failed call leaves the select
// disabled with an explanatory line instead of an empty, seemingly-broken
// control. The currently saved userId (plain string, not a secret — present
// in both GET and PUT) is preserved as the selected option when it still
// exists in the fetched list.
async function loadJellyfinUsers() {
  const select = $('#jellyfin-user-select');
  const help = $('#jellyfin-user-help');
  select.disabled = true;
  select.innerHTML = '';

  try {
    const res = await fetch('/api/jellyfin/users');
    const body = await res.json();
    if (!res.ok || !body.ok || !body.users || body.users.length === 0) {
      help.textContent = (body && body.error) || 'Add a Jellyfin URL and API key, save, then reload this page to choose a user.';
      return;
    }
    select.innerHTML = body.users.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`).join('');
    const savedUserId = (SETTINGS.jellyfin && SETTINGS.jellyfin.userId) || '';
    if (savedUserId && body.users.some((u) => u.id === savedUserId)) {
      select.value = savedUserId;
    }
    select.disabled = false;
    help.textContent = 'Controls whose Continue Watching and Up Next lists appear on the Jellyfin widgets.';
  } catch (e) {
    help.textContent = 'Could not reach the server to load Jellyfin users.';
  }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

async function testTarget(target, resultElId) {
  const el = $(`#${resultElId}`);
  el.hidden = false;
  el.classList.remove('test-ok', 'test-fail');
  el.textContent = 'Testing…';
  try {
    const res = await fetch('/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    const body = await res.json();
    el.textContent = body.detail || (body.ok ? 'OK.' : 'No detail returned.');
    el.classList.add(body.ok ? 'test-ok' : 'test-fail');
  } catch (e) {
    el.textContent = 'Could not reach the server.';
    el.classList.add('test-fail');
  }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

function showError(message) {
  const el = $('#form-error');
  el.textContent = message;
  el.hidden = false;
}

function hideError() {
  $('#form-error').hidden = true;
}

function buildPayload(form) {
  const data = new FormData(form);
  const get = (name) => (data.get(name) || '').toString().trim();

  const payload = {
    branding: {
      model: get('branding.model'),
      subtitle: get('branding.subtitle'),
    },
    pangolin: {
      apiUrl: get('pangolin.apiUrl'),
      orgId: get('pangolin.orgId'),
    },
    truenas: {
      url: get('truenas.url'),
    },
    jellyfin: {
      url: get('jellyfin.url'),
      userId: get('jellyfin.userId'),
    },
  };

  // Blank key field = keep the existing key. Only send apiKey when the
  // user actually typed something into it.
  const pangolinKey = get('pangolin.apiKey');
  if (pangolinKey) payload.pangolin.apiKey = pangolinKey;
  const truenasKey = get('truenas.apiKey');
  if (truenasKey) payload.truenas.apiKey = truenasKey;
  const jellyfinKey = get('jellyfin.apiKey');
  if (jellyfinKey) payload.jellyfin.apiKey = jellyfinKey;

  return payload;
}

async function handleSubmit(e) {
  e.preventDefault();
  hideError();
  const payload = buildPayload(e.target);
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) {
      showError(body.error || 'Failed to save settings.');
      return;
    }
    window.location.href = '/index.html';
  } catch (err) {
    showError(err.message || 'Failed to save settings.');
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  $('#chip-back').addEventListener('click', () => {
    window.location.href = '/index.html';
  });
  $('#chip-theme').addEventListener('click', cycleTheme);
  $('#chip-theme').textContent = `THEME · ${(document.documentElement.getAttribute('data-theme') || 'ko').toUpperCase()}`;
  $('#test-pangolin').addEventListener('click', () => testTarget('pangolin', 'test-result-pangolin'));
  $('#settings-form').addEventListener('submit', handleSubmit);

  try {
    await loadSettings();
    populateForm();
    await loadJellyfinUsers();
  } catch (e) {
    showError(e.message || 'Failed to load settings.');
  }
}

boot();
