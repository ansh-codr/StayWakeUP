/**
 * popup.js — StayActive Pro
 *
 * All UI strings live in the `messages` object at the top so they
 * are easy to replace with i18n later.
 *
 * Design: The popup is intentionally stateless — every open re-fetches
 * state from the background.  This avoids stale UI after tab switches.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════
 * i18n-ready message strings
 * ═══════════════════════════════════════════════════════════════════ */
const messages = {
  appName:             'StayActive Pro',
  loading:             'Loading…',
  unsupportedPage:     'StayActive Pro cannot run on this page.',
  permDenied:          'Permission denied. Please try again.',
  errorPrefix:         'Error: ',
  masterToggleOn:      'Always active on this site',
  masterToggleSub:     'Spoofs visibility & focus APIs',
  includeSubdomains:   'Include subdomains',
  extraTools:          '⚙️ Extra tools',
  antiIdle:            'Anti-idle & Wake Lock',
  antiIdleDesc:        'Fake mouse activity every 20–40 s',
  keepAudio:           'Silent audio keep-alive',
  keepAudioDesc:       'Prevents timer throttling',
  autoRefresh:         'Auto-refresh',
  autoRefreshDesc:     'Reload tab every N seconds',
  eventLog:            'Blocked events',
  eventLogDesc:        'Events intercepted this session',
  manageLink:          'Manage sites',
  shortcutHint:        'Alt+Shift+A to toggle',
  nextRefresh:         'Next: ',
  countdown:           (s) => `${s}s`,
};

/* ═══════════════════════════════════════════════════════════════════
 * DOM references
 * ═══════════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const UI = {
  headerIcon:        $('header-icon'),
  hostnameDisplay:   $('hostname-display'),
  statusDot:         $('status-dot'),
  unsupportedNotice: $('unsupported-notice'),
  unsupportedText:   $('unsupported-text'),
  errorBanner:       $('error-banner'),
  errorText:         $('error-text'),
  mainContent:       $('main-content'),
  masterToggle:      $('master-toggle'),
  subdomainRow:      $('subdomain-row'),
  includeSubdomains: $('include-subdomains'),
  extraToolsToggle:  $('extra-tools-toggle'),
  extraChevron:      $('extra-chevron'),
  extraToolsBody:    $('extra-tools-body'),
  antiIdle:          $('toggle-anti-idle'),
  keepAudio:         $('toggle-keep-audio'),
  autoRefresh:       $('toggle-auto-refresh'),
  refreshConfig:     $('refresh-config'),
  refreshSeconds:    $('refresh-seconds'),
  refreshCountdown:  $('refresh-countdown'),
  manageSitesLink:   $('manage-sites-link'),
  shortcutHint:      $('shortcut-hint'),
  // Count cells
  cntVisibility:     $('cnt-visibilitychange'),
  cntBlur:           $('cnt-blur'),
  cntMouseleave:     $('cnt-mouseleave'),
};

/* ═══════════════════════════════════════════════════════════════════
 * State
 * ═══════════════════════════════════════════════════════════════════ */
let state = {
  tabId:    null,
  hostname: null,
  enabled:  false,
  settings: {},
  alarmInfo: null,
};

let countdownInterval = null;

/* ═══════════════════════════════════════════════════════════════════
 * Apply i18n strings to static elements
 * ═══════════════════════════════════════════════════════════════════ */
function applyMessages() {
  $('lbl-master-toggle').textContent      = messages.masterToggleOn;
  $('lbl-master-sub').textContent         = messages.masterToggleSub;
  $('lbl-include-subdomains').textContent = messages.includeSubdomains;
  $('lbl-extra-tools').textContent        = messages.extraTools;
  $('lbl-anti-idle').textContent          = messages.antiIdle;
  $('lbl-anti-idle-desc').textContent     = messages.antiIdleDesc;
  $('lbl-keep-audio').textContent         = messages.keepAudio;
  $('lbl-keep-audio-desc').textContent    = messages.keepAudioDesc;
  $('lbl-auto-refresh').textContent       = messages.autoRefresh;
  $('lbl-auto-refresh-desc').textContent  = messages.autoRefreshDesc;
  $('lbl-event-log').textContent          = messages.eventLog;
  $('lbl-event-log-desc').textContent     = messages.eventLogDesc;
  $('lbl-seconds').textContent            = messages.countdown(UI.refreshSeconds.value);
  UI.shortcutHint.textContent             = messages.shortcutHint;
}

/* ═══════════════════════════════════════════════════════════════════
 * Show / hide helpers
 * ═══════════════════════════════════════════════════════════════════ */
function showError(msg) {
  UI.errorText.textContent = messages.errorPrefix + msg;
  UI.errorBanner.classList.remove('hidden');
}

function hideError() {
  UI.errorBanner.classList.add('hidden');
}

function showUnsupported(url) {
  UI.unsupportedText.textContent = messages.unsupportedPage + ' (' + (url || '') + ')';
  UI.unsupportedNotice.classList.remove('hidden');
  UI.mainContent.classList.add('hidden');
}

function showMain() {
  UI.unsupportedNotice.classList.add('hidden');
  UI.mainContent.classList.remove('hidden');
}

/* ═══════════════════════════════════════════════════════════════════
 * Render from state
 * ═══════════════════════════════════════════════════════════════════ */
function render() {
  const { hostname, enabled, settings, alarmInfo } = state;

  // Hostname in header.
  UI.hostnameDisplay.textContent = hostname || messages.loading;

  // Status dot.
  UI.statusDot.classList.toggle('active', enabled);

  // Header icon.
  UI.headerIcon.src = enabled
    ? '../icons/icon32_on.png'
    : '../icons/icon32_off.png';

  // Master toggle.
  UI.masterToggle.checked = enabled;

  // Subdomain checkbox — only visible when enabled.
  UI.subdomainRow.classList.toggle('hidden', !enabled);
  UI.includeSubdomains.checked = !!(settings && settings.includeSubdomains);

  // Extra tools — only meaningful when enabled.
  UI.antiIdle.checked  = !!(settings && settings.antiIdle);
  UI.keepAudio.checked = !!(settings && settings.keepAliveAudio);
  UI.autoRefresh.checked = !!(settings && settings.autoRefresh);

  // Refresh interval.
  if (settings && settings.autoRefreshSeconds) {
    UI.refreshSeconds.value = settings.autoRefreshSeconds;
  }

  // Show/hide refresh config.
  UI.refreshConfig.classList.toggle('hidden', !(settings && settings.autoRefresh));

  // Countdown.
  renderCountdown(alarmInfo);
}

function renderCountdown(alarmInfo) {
  clearInterval(countdownInterval);
  UI.refreshCountdown.textContent = '';

  if (!alarmInfo || !alarmInfo.scheduledTime) return;

  function tick() {
    const secs = Math.max(0, Math.round((alarmInfo.scheduledTime - Date.now()) / 1000));
    UI.refreshCountdown.textContent = messages.nextRefresh + messages.countdown(secs);
    if (secs <= 0) clearInterval(countdownInterval);
  }

  tick();
  countdownInterval = setInterval(tick, 1000);
}

function renderCounts(counts) {
  if (!counts) return;
  UI.cntVisibility.textContent = (counts.visibilitychange || 0) + (counts.webkitvisibilitychange || 0);
  UI.cntBlur.textContent       = counts.blur       || 0;
  UI.cntMouseleave.textContent = counts.mouseleave || 0;
}

/* ═══════════════════════════════════════════════════════════════════
 * Load state from background
 * ═══════════════════════════════════════════════════════════════════ */
async function loadState() {
  hideError();
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_TAB_STATE' });

    if (!resp || !resp.ok) {
      showError(resp?.error || 'Unknown error');
      return;
    }

    if (resp.unsupported) {
      showUnsupported(resp.url);
      return;
    }

    state.tabId    = resp.tabId;
    state.hostname = resp.hostname;
    state.enabled  = resp.enabled;
    state.settings = resp.settings || {};
    state.alarmInfo = resp.alarmInfo;

    showMain();
    render();
    renderCounts(resp.counts);

    // Show shortcut from background.
    if (resp.shortcut) {
      UI.shortcutHint.textContent = resp.shortcut + ' to toggle';
    }
  } catch (err) {
    showError(err.message || String(err));
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * Event handlers
 * ═══════════════════════════════════════════════════════════════════ */

/* Master toggle — enable/disable site */
UI.masterToggle.addEventListener('change', async () => {
  hideError();
  const enabled = UI.masterToggle.checked;
  UI.masterToggle.disabled = true;

  try {
    if (enabled) {
      const includeSubdomains = UI.includeSubdomains.checked;
      const patterns = [`*://${state.hostname}/*`];
      if (includeSubdomains) {
        patterns.push(`*://*.${state.hostname}/*`);
      }

      const hasPermission = await chrome.permissions.contains({ origins: patterns });
      if (!hasPermission) {
        // Host permission requests must originate from a user gesture,
        // so the request is intentionally performed in the popup click flow.
        let granted = false;
        try {
          granted = await chrome.permissions.request({ origins: patterns });
        } catch (error) {
          console.error("[StayActive] permission request failed", error);
        }
        
        if (!granted) {
          UI.masterToggle.checked = false; // Revert.
          showError("Permission was not granted. This site was not enabled.");
          return;
        }
      }

      const resp = await chrome.runtime.sendMessage({
        type:     'ENABLE_SITE',
        hostname: state.hostname,
        tabId:    state.tabId,
        options:  {
          includeSubdomains: includeSubdomains,
          spoofVisibility:   true,
        },
      });

      if (!resp || !resp.ok) {
        UI.masterToggle.checked = false; // Revert.
        showError(resp?.error === 'HOST_PERMISSION_MISSING' ? "This site's permission is missing. Please try enabling it again." : "Could not enable this site.");
        return;
      }

      state.enabled = true;
      state.settings = resp.settings || state.settings;
      render();
    } else {
      const resp = await chrome.runtime.sendMessage({
        type:     'DISABLE_SITE',
        hostname: state.hostname,
        tabId:    state.tabId,
      });

      if (!resp || !resp.ok) {
        UI.masterToggle.checked = true; // Revert.
        showError("Could not disable this site.");
        return;
      }

      state.enabled = false;
      render();
    }
  } catch (err) {
    UI.masterToggle.checked = !enabled;
    showError(err.message || String(err));
  } finally {
    UI.masterToggle.disabled = false;
  }
});

/* Include subdomains checkbox */
UI.includeSubdomains.addEventListener('change', async () => {
  if (!state.enabled) return;
  await updateSetting({ includeSubdomains: UI.includeSubdomains.checked });
});

/* Extra tools collapsible toggle */
UI.extraToolsToggle.addEventListener('click', () => {
  const isOpen = !UI.extraToolsBody.classList.contains('hidden');
  UI.extraToolsBody.classList.toggle('hidden', isOpen);
  UI.extraChevron.classList.toggle('open', !isOpen);
  UI.extraToolsToggle.setAttribute('aria-expanded', String(!isOpen));
});

/* Tool toggles */
UI.antiIdle.addEventListener('change', () =>
  updateSetting({ antiIdle: UI.antiIdle.checked }));

UI.keepAudio.addEventListener('change', () =>
  updateSetting({ keepAliveAudio: UI.keepAudio.checked }));

UI.autoRefresh.addEventListener('change', async () => {
  const on = UI.autoRefresh.checked;
  UI.refreshConfig.classList.toggle('hidden', !on);
  await updateSetting({ autoRefresh: on });
});

UI.refreshSeconds.addEventListener('change', () => {
  const secs = Math.max(5, parseInt(UI.refreshSeconds.value, 10) || 60);
  UI.refreshSeconds.value = secs;
  updateSetting({ autoRefreshSeconds: secs });
});

/* Manage sites link */
UI.manageSitesLink.addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    await chrome.runtime.openOptionsPage();
    window.close();
  } catch (_) {}
});

/* ═══════════════════════════════════════════════════════════════════
 * Setting update helper
 * ═══════════════════════════════════════════════════════════════════ */
async function updateSetting(patch) {
  if (!state.hostname) return;
  hideError();
  try {
    const resp = await chrome.runtime.sendMessage({
      type:     'UPDATE_HOST_SETTING',
      hostname: state.hostname,
      patch,
    });

    if (!resp || !resp.ok) {
      showError(resp?.error || 'Failed to update setting.');
      return;
    }

    if (resp.settings) {
      state.settings = resp.settings;
    }

    // Reload alarm info.
    await loadState();
  } catch (err) {
    showError(err.message || String(err));
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * Listen for real-time count updates from background
 * ═══════════════════════════════════════════════════════════════════ */
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'COUNTS_UPDATED' && message.tabId === state.tabId) {
    renderCounts(message.counts);
  }
  if (message.type === 'AUTO_REFRESH_FIRED' && message.hostname === state.hostname) {
    loadState(); // Refresh alarm info for countdown reset.
  }
});

/* ═══════════════════════════════════════════════════════════════════
 * Init
 * ═══════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  applyMessages();
  loadState();
});
