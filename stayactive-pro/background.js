/**
 * background.js — StayActive Pro Service Worker
 *
 * Responsibilities:
 *  - Manage per-hostname enabling/disabling (storage + dynamic scripts).
 *  - Manage optional host permissions.
 *  - Update toolbar icon/badge per-tab.
 *  - Handle auto-refresh alarms.
 *  - Handle keyboard command toggle.
 *  - Relay blocked-event counts to the popup.
 *  - Sync registered scripts with storage on startup.
 *
 * STATELESS DESIGN: The service worker can be killed at any time.
 * We never rely on module-level variables surviving across events.
 * All state lives in chrome.storage.local.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════
 * Constants
 * ═══════════════════════════════════════════════════════════════════ */

const STORAGE_ENABLED_HOSTS = 'enabledHosts';
const STORAGE_HOST_SETTINGS  = 'hostSettings';
const STORAGE_BLOCKED_COUNTS = 'blockedCounts'; // per-tab counts cache

/* ── Counts serial queue ────────────────────────────────────────────
 * WHY a queue?  allFrames:true means multiple frames in one tab can
 * each post BLOCKED_COUNTS simultaneously.  Without serialisation, two
 * concurrent read-modify-write cycles race: one overwrites the other's
 * write and a frame's counts are silently dropped.
 *
 * NOTE: countsQueue is ONLY a lock for in-flight work.  If the service
 * worker restarts between events, the variable resets to
 * Promise.resolve() — that is fine because all persisted state lives in
 * chrome.storage.local, not in this variable.
 * ────────────────────────────────────────────────────────────────── */
let countsQueue = Promise.resolve();
function enqueueCounts(fn) {
  countsQueue = countsQueue.then(fn, fn).catch(err => console.error('[SA] counts', err));
  return countsQueue;
}

const ICON_ON  = { 16: 'icons/icon16_on.png',  32: 'icons/icon32_on.png',  48: 'icons/icon48_on.png',  128: 'icons/icon128_on.png'  };
const ICON_OFF = { 16: 'icons/icon16_off.png', 32: 'icons/icon32_off.png', 48: 'icons/icon48_off.png', 128: 'icons/icon128_off.png' };

/** Pages where we cannot inject scripts */
const UNSUPPORTED_ORIGINS = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com',
];

/* ═══════════════════════════════════════════════════════════════════
 * Utility helpers
 * ═══════════════════════════════════════════════════════════════════ */

function isUnsupported(url) {
  if (!url) return true;
  return UNSUPPORTED_ORIGINS.some(prefix => url.startsWith(prefix));
}

function scriptId(hostname) {
  // Dynamic content-script IDs must be unique strings.
  return `sa-${hostname}`;
}

function matchPatterns(hostname, includeSubdomains) {
  const patterns = [`*://${hostname}/*`];
  if (includeSubdomains) {
    patterns.push(`*://*.${hostname}/*`);
  }
  return patterns;
}

async function getStorage(...keys) {
  try {
    return await chrome.storage.local.get(keys);
  } catch (err) {
    console.error('[SA] getStorage error', err);
    return {};
  }
}

async function setStorage(obj) {
  try {
    await chrome.storage.local.set(obj);
  } catch (err) {
    console.error('[SA] setStorage error', err);
  }
}

async function getEnabledHosts() {
  const data = await getStorage(STORAGE_ENABLED_HOSTS);
  return data[STORAGE_ENABLED_HOSTS] || [];
}

async function getHostSettings() {
  const data = await getStorage(STORAGE_HOST_SETTINGS);
  return data[STORAGE_HOST_SETTINGS] || {};
}

function defaultHostSettings() {
  return {
    spoofVisibility:     true,
    includeSubdomains:   false,
    antiIdle:            false,
    keepAliveAudio:      false,
    autoRefresh:         false,
    autoRefreshSeconds:  60,
    fakeActivity:        false,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * Icon & badge helpers
 * ═══════════════════════════════════════════════════════════════════ */

async function setTabIcon(tabId, enabled) {
  try {
    await chrome.action.setIcon({ tabId, path: enabled ? ICON_ON : ICON_OFF });
    await chrome.action.setBadgeText({ tabId, text: enabled ? 'ON' : '' });
    if (enabled) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563EB' });
    }
  } catch (_) {
    // Tab may no longer exist.
  }
}

async function refreshIconForTab(tab) {
  if (!tab || !tab.url || isUnsupported(tab.url)) {
    try {
      await chrome.action.setIcon({ tabId: tab.id, path: ICON_OFF });
      await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    } catch (_) {}
    return;
  }

  try {
    const url      = new URL(tab.url);
    const hostname = url.hostname;
    const hosts    = await getEnabledHosts();
    const enabled  = hosts.includes(hostname);
    await setTabIcon(tab.id, enabled);
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════════════════════
 * Content-script registration
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Register dynamic content scripts for a hostname.
 * We register TWO scripts:
 *   1. inject.js in MAIN world  — the actual spoofing.
 *   2. relay.js in ISOLATED world — config bridge + message relay.
 *
 * Uses getRegisteredContentScripts first to avoid duplicate-ID errors.
 */
async function registerScripts(hostname, includeSubdomains) {
  const patterns = matchPatterns(hostname, includeSubdomains);
  const mainId   = scriptId(hostname);
  const relayId  = `${scriptId(hostname)}-relay`;

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [mainId, relayId],
    });
    const existingIds = existing.map(s => s.id);

    const toRegister = [];
    const toUpdate   = [];

    const mainScript = {
      id:                    mainId,
      js:                    ['inject.js'],
      world:                 'MAIN',
      runAt:                 'document_start',
      allFrames:             true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true,
      matches:               patterns,
    };

    const relayScript = {
      id:                    relayId,
      js:                    ['relay.js'],
      world:                 'ISOLATED',
      runAt:                 'document_start',
      allFrames:             true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true,
      matches:               patterns,
    };

    // Split into register vs update to avoid duplicate ID errors.
    if (existingIds.includes(mainId)) {
      toUpdate.push(mainScript);
    } else {
      toRegister.push(mainScript);
    }

    if (existingIds.includes(relayId)) {
      toUpdate.push(relayScript);
    } else {
      toRegister.push(relayScript);
    }

    if (toRegister.length > 0) {
      await chrome.scripting.registerContentScripts(toRegister);
    }
    if (toUpdate.length > 0) {
      await chrome.scripting.updateContentScripts(toUpdate);
    }
  } catch (err) {
    console.error('[SA] registerScripts error for', hostname, err);
    throw err;
  }
}

async function unregisterScripts(hostname) {
  const mainId  = scriptId(hostname);
  const relayId = `${scriptId(hostname)}-relay`;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [mainId, relayId] });
  } catch (_) {
    // May not exist — that's fine.
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * Permission management
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Request optional host permission for a hostname.
 * chrome.permissions.request MUST be called directly inside a user-
 * gesture handler (message from popup button click).
 *
 * Returns true if granted, false if denied or error.
 */
async function requestHostPermission(hostname, includeSubdomains) {
  const origins = matchPatterns(hostname, includeSubdomains);
  try {
    const granted = await chrome.permissions.request({ origins });
    return granted;
  } catch (err) {
    console.error('[SA] requestHostPermission error', err);
    return false;
  }
}

async function removeHostPermission(hostname) {
  const origins = matchPatterns(hostname, true); // Remove both patterns.
  try {
    await chrome.permissions.remove({ origins });
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════════════════════
 * Enable / Disable site
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Enable StayActive for a hostname.
 * Called from the popup in response to a user gesture (toggle click).
 * Returns { ok: true } or { ok: false, error: string }.
 */
async function enableSite(hostname, tabId, options = {}) {
  try {
    // 1. Verify permission — the popup (or keyboard command) should have already requested it.
    const includeSubdomains = !!options.includeSubdomains;
    const origins = matchPatterns(hostname, includeSubdomains);
    
    const hasPermission = await chrome.permissions.contains({ origins });
    if (!hasPermission) {
      return { ok: false, error: 'HOST_PERMISSION_MISSING' };
    }

    // 2. Save to storage.
    const [hosts, hostSettings] = await Promise.all([
      getEnabledHosts(),
      getHostSettings(),
    ]);

    if (!hosts.includes(hostname)) hosts.push(hostname);
    hostSettings[hostname] = Object.assign(
      defaultHostSettings(),
      hostSettings[hostname] || {},
      options,
      { includeSubdomains },
    );

    await setStorage({
      [STORAGE_ENABLED_HOSTS]: hosts,
      [STORAGE_HOST_SETTINGS]: hostSettings,
    });

    // 3. Register content scripts.
    await registerScripts(hostname, includeSubdomains);

    // 4. Update icon.
    await setTabIcon(tabId, true);

    // 5. Reload tab so scripts apply from document_start.
    try { await chrome.tabs.reload(tabId); } catch (_) {}

    // 6. Start auto-refresh alarm if configured.
    if (hostSettings[hostname].autoRefresh) {
      startAutoRefreshAlarm(hostname, hostSettings[hostname].autoRefreshSeconds || 60);
    }

    return { ok: true };
  } catch (err) {
    console.error('[SA] enableSite error', err);
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Disable StayActive for a hostname.
 */
async function disableSite(hostname, tabId) {
  try {
    // 1. Unregister scripts.
    await unregisterScripts(hostname);

    // 2. Remove permission.
    await removeHostPermission(hostname);

    // 3. Update storage.
    const [hosts, hostSettings] = await Promise.all([
      getEnabledHosts(),
      getHostSettings(),
    ]);

    const newHosts = hosts.filter(h => h !== hostname);
    delete hostSettings[hostname];

    await setStorage({
      [STORAGE_ENABLED_HOSTS]: newHosts,
      [STORAGE_HOST_SETTINGS]: hostSettings,
    });

    // 4. Cancel auto-refresh alarm.
    await clearAutoRefreshAlarm(hostname);

    // 5. Update icon.
    await setTabIcon(tabId, false);

    // 6. Reload tab.
    try { await chrome.tabs.reload(tabId); } catch (_) {}

    return { ok: true };
  } catch (err) {
    console.error('[SA] disableSite error', err);
    return { ok: false, error: err.message || String(err) };
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * Host settings update (individual tools)
 * ═══════════════════════════════════════════════════════════════════ */

async function updateHostSetting(hostname, patch) {
  try {
    const hostSettings = await getHostSettings();
    hostSettings[hostname] = Object.assign(
      defaultHostSettings(),
      hostSettings[hostname] || {},
      patch,
    );
    await setStorage({ [STORAGE_HOST_SETTINGS]: hostSettings });

    // Update script registrations to reflect new match patterns if needed.
    const includeSubdomains = !!hostSettings[hostname].includeSubdomains;
    await registerScripts(hostname, includeSubdomains);

    // Manage auto-refresh alarm.
    if (patch.autoRefresh !== undefined || patch.autoRefreshSeconds !== undefined) {
      const s = hostSettings[hostname];
      if (s.autoRefresh) {
        startAutoRefreshAlarm(hostname, s.autoRefreshSeconds || 60);
      } else {
        await clearAutoRefreshAlarm(hostname);
      }
    }

    return { ok: true, settings: hostSettings[hostname] };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * Auto-refresh alarms
 * ═══════════════════════════════════════════════════════════════════ */

function alarmName(hostname) {
  return `autoRefresh:${hostname}`;
}

function startAutoRefreshAlarm(hostname, seconds) {
  const periodMinutes = Math.max(seconds, 5) / 60;
  chrome.alarms.create(alarmName(hostname), {
    delayInMinutes: periodMinutes,
    periodInMinutes: periodMinutes,
  });
}

async function clearAutoRefreshAlarm(hostname) {
  try {
    await chrome.alarms.clear(alarmName(hostname));
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════════════════════
 * Startup sync — re-register scripts stored in enabledHosts
 * ═══════════════════════════════════════════════════════════════════ */

async function syncScriptsOnStartup() {
  try {
    const [hosts, hostSettings] = await Promise.all([
      getEnabledHosts(),
      getHostSettings(),
    ]);

    for (const hostname of hosts) {
      const settings        = hostSettings[hostname] || defaultHostSettings();
      const includeSubdoms  = !!settings.includeSubdomains;
      await registerScripts(hostname, includeSubdoms);

      // Restore auto-refresh alarms.
      if (settings.autoRefresh) {
        startAutoRefreshAlarm(hostname, settings.autoRefreshSeconds || 60);
      }
    }
  } catch (err) {
    console.error('[SA] syncScriptsOnStartup error', err);
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * Event listeners
 * ═══════════════════════════════════════════════════════════════════ */

/* ── Install / Startup ── */

chrome.runtime.onInstalled.addListener(async () => {
  await syncScriptsOnStartup();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncScriptsOnStartup();
});

/* ── Tab events: keep icon in sync ── */

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    await refreshIconForTab(tab);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await refreshIconForTab(tab);
  } catch (_) {}
});

/* ── Alarm: auto-refresh ── */

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('autoRefresh:')) return;

  const hostname = alarm.name.slice('autoRefresh:'.length);

  try {
    // Find all tabs with this hostname and reload them.
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url) continue;
      try {
        const url = new URL(tab.url);
        if (url.hostname === hostname || url.hostname.endsWith(`.${hostname}`)) {
          await chrome.tabs.reload(tab.id);
        }
      } catch (_) {}
    }

    // Notify popup of next refresh time.
    chrome.runtime.sendMessage({
      type: 'AUTO_REFRESH_FIRED',
      hostname,
    }).catch(() => {});
  } catch (err) {
    console.error('[SA] auto-refresh alarm error', err);
  }
});

/* ── Keyboard command: toggle current site ── */

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-site') return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || isUnsupported(tab.url)) return;

    const url      = new URL(tab.url);
    const hostname = url.hostname;
    const hosts    = await getEnabledHosts();

    if (hosts.includes(hostname)) {
      await disableSite(hostname, tab.id);
    } else {
      // Keyboard commands are user gestures — permission request is allowed.
      // Default to false for includeSubdomains in quick toggle.
      const origins = matchPatterns(hostname, false);
      const hasPermission = await chrome.permissions.contains({ origins });
      if (!hasPermission) {
        const granted = await requestHostPermission(hostname, false);
        if (!granted) return;
      }
      await enableSite(hostname, tab.id, { includeSubdomains: false });
    }
  } catch (err) {
    console.error('[SA] toggle-site command error', err);
  }
});

/* ── Messages from popup / options / relay ── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));

  // Return true to keep the message channel open for async response.
  return true;
});

async function handleMessage(message, sender) {
  // BLOCKED_COUNTS comes from content scripts (relay.js), which have a sender.tab.
  if (message.type === 'BLOCKED_COUNTS') {
    if (!sender.tab) return { ok: false };
  } else {
    // All other messages must come from an extension page (popup/options).
    const extUrl = chrome.runtime.getURL('');
    if (!sender.url || !sender.url.startsWith(extUrl)) {
      return { ok: false, error: 'Unauthorized sender' };
    }
  }

  switch (message.type) {

    /* ── Popup: get current tab state ── */
    case 'GET_TAB_STATE': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return { ok: false, error: 'No active tab.' };

      const unsupported = isUnsupported(tab.url || '');
      if (unsupported) {
        return { ok: true, unsupported: true, url: tab.url };
      }

      const url      = new URL(tab.url);
      const hostname = url.hostname;
      const hosts    = await getEnabledHosts();
      const settings = await getHostSettings();

      // Get alarm info for countdown.
      let alarmInfo = null;
      try {
        alarmInfo = await chrome.alarms.get(alarmName(hostname));
      } catch (_) {}

      // Get blocked counts for this tab.
      const countsData = await getStorage(STORAGE_BLOCKED_COUNTS);
      const allCounts  = countsData[STORAGE_BLOCKED_COUNTS] || {};
      const counts     = allCounts[tab.id] || {};

      return {
        ok:          true,
        tabId:       tab.id,
        hostname,
        enabled:     hosts.includes(hostname),
        settings:    settings[hostname] || defaultHostSettings(),
        alarmInfo,
        counts,
        shortcut:    'Alt+Shift+A',
      };
    }

    /* ── Popup: enable site (MUST be from user gesture) ── */
    case 'ENABLE_SITE': {
      const { tabId, options } = message;
      // Derive hostname securely from the trusted tab object, not the message payload.
      const tab = await chrome.tabs.get(tabId);
      const url = new URL(tab.url);
      const hostname = url.hostname;
      return await enableSite(hostname, tabId, options);
    }

    /* ── Popup: disable site ── */
    case 'DISABLE_SITE': {
      const { tabId } = message;
      // Derive hostname securely from the trusted tab object.
      const tab = await chrome.tabs.get(tabId);
      const url = new URL(tab.url);
      const hostname = url.hostname;
      return await disableSite(hostname, tabId);
    }

    /* ── Popup/options: update a single host setting ── */
    case 'UPDATE_HOST_SETTING': {
      const { hostname, patch } = message;
      return await updateHostSetting(hostname, patch);
    }

    /* ── Options: get all enabled hosts with settings ── */
    case 'GET_ALL_HOSTS': {
      const [hosts, settings] = await Promise.all([
        getEnabledHosts(),
        getHostSettings(),
      ]);
      return { ok: true, hosts, settings };
    }

    /* ── Options: disable all ── */
    case 'DISABLE_ALL': {
      const hosts = await getEnabledHosts();
      for (const hostname of hosts) {
        await unregisterScripts(hostname);
        await removeHostPermission(hostname);
        await clearAutoRefreshAlarm(hostname);
      }
      await setStorage({
        [STORAGE_ENABLED_HOSTS]: [],
        [STORAGE_HOST_SETTINGS]: {},
      });
      return { ok: true };
    }

    /* ── Options: import settings ── */
    case 'IMPORT_SETTINGS': {
      const { enabledHosts, hostSettings } = message.data;
      await setStorage({
        [STORAGE_ENABLED_HOSTS]: enabledHosts || [],
        [STORAGE_HOST_SETTINGS]: hostSettings || {},
      });
      await syncScriptsOnStartup();
      return { ok: true };
    }

    /* ── Relay: blocked event counts from MAIN world ── */
    case 'BLOCKED_COUNTS': {
      if (!sender.tab) return { ok: false };
      const tabId  = sender.tab.id;
      const counts = message.counts || {};

      await enqueueCounts(async () => {
        const countsData = await getStorage(STORAGE_BLOCKED_COUNTS);
        const allCounts  = countsData[STORAGE_BLOCKED_COUNTS] || {};

        // Accumulate deltas per-tab.  Re-validate here too: messages are
        // now sanitized by relay.js, but defence-in-depth costs nothing.
        const prev = allCounts[tabId] || {};
        for (const [key, val] of Object.entries(counts)) {
          if (Number.isFinite(val) && val > 0) {
            prev[key] = (prev[key] || 0) + val;
          }
        }
        allCounts[tabId] = prev;

        await setStorage({ [STORAGE_BLOCKED_COUNTS]: allCounts });

        // Forward to popup if it is open.
        chrome.runtime.sendMessage({
          type:   'COUNTS_UPDATED',
          tabId,
          counts: prev,
        }).catch(() => {});
      });

      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}
