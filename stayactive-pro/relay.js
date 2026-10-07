/**
 * relay.js — StayActive Pro (Isolated World)
 *
 * This script runs in the ISOLATED world (the default content-script
 * world) so it has access to chrome.* APIs.  It acts as a bridge:
 *
 *   1. Reads per-host config from chrome.storage.local.
 *   2. Stamps it onto document.documentElement.dataset.saConfig so
 *      inject.js (MAIN world) can read it at document_start.
 *   3. Listens for postMessage from MAIN world and forwards blocked-
 *      event counts to the service worker via chrome.runtime.sendMessage.
 *
 * WHY a relay?  Manifest V3 MAIN-world scripts cannot call chrome.*.
 * The data-attribute bridge is synchronous at document_start, so
 * inject.js always gets config before any page script runs.
 */

(async function relay() {
  'use strict';

  try {
    // 1. Read config for this hostname.
    const hostname = location.hostname;
    const result   = await chrome.storage.local.get(['hostSettings']);
    const hostSettings = result.hostSettings || {};
    const cfg      = hostSettings[hostname] || {};

    // 2. Stamp config onto the root element for inject.js to consume.
    //    document.documentElement is guaranteed to exist at document_start.
    document.documentElement.dataset.saConfig = JSON.stringify({
      spoofVisibility: cfg.spoofVisibility !== false, // default on
      antiIdle:        !!cfg.antiIdle,
      keepAliveAudio:  !!cfg.keepAliveAudio,
      fakeActivity:    !!cfg.fakeActivity,
    });
  } catch (err) {
    // Storage unavailable — inject.js will use safe defaults.
    console.warn('[StayActive Pro] relay: failed to read config', err);
  }

  // 3. Forward blocked-event counts to the service worker.
  //    inject.js (MAIN world) posts window messages throttled to 2 s.
  window.addEventListener('message', (event) => {
    if (
      event.source === window &&
      event.data &&
      event.data.__saType === 'BLOCKED_COUNTS'
    ) {
      chrome.runtime.sendMessage({
        type: 'BLOCKED_COUNTS',
        counts: event.data.counts,
      }).catch(() => {
        // Service worker may be sleeping — silently ignore.
      });
    }
  });
})();
