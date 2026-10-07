/**
 * relay.js — StayActive Pro (Isolated World)
 *
 * This script runs in the ISOLATED world (the default content-script
 * world) so it has access to chrome.* APIs.  It acts as a bridge:
 *
 *   1. Reads per-host config from chrome.storage.local.
 *   2. Posts { __saType: 'SA_CONFIG', cfg: JSON.stringify(cfgObject) }
 *      to window so inject.js (MAIN world) can start its extras.
 *   3. Listens for postMessage from MAIN world and forwards blocked-
 *      event counts to the service worker via chrome.runtime.sendMessage.
 *
 * WHY a relay?  Manifest V3 MAIN-world scripts cannot call chrome.*.
 *
 * WHY postMessage instead of a DOM data-attribute?
 *   - The storage read is async; by the time the attribute would be
 *     written, inject.js has already read it (getting nothing).
 *   - A data-attribute also leaks the extension's presence to the page.
 *
 * Handshake protocol (WHY: the two scripts can start in either order):
 *   - inject.js posts SA_READY and then listens for SA_CONFIG.
 *   - relay.js listens for SA_READY synchronously (before any await).
 *     When SA_READY arrives and config is already loaded, relay re-posts
 *     SA_CONFIG.  If config isn't loaded yet, the storage callback posts
 *     SA_CONFIG when it resolves — inject.js is already listening by then.
 *   - Result: inject.js receives SA_CONFIG exactly once no matter the order.
 */

(function relay() {
  'use strict';

  // Cache for config read from storage.  null = not yet loaded.
  let cachedCfg = null;

  /* ─────────────────────────────────────────────────────────────────
   * postConfig — post SA_CONFIG to window (and therefore to inject.js).
   * Sends cfg as a JSON STRING so it crosses the world boundary safely.
   * ───────────────────────────────────────────────────────────────── */
  function postConfig(cfg) {
    window.postMessage({
      __saType: 'SA_CONFIG',
      cfg: JSON.stringify(cfg),
    }, '*');
  }

  /* ─────────────────────────────────────────────────────────────────
   * Synchronous message listener — registered BEFORE any await so
   * messages posted by inject.js are never missed.
   *
   * Handles two message types:
   *   SA_READY      — inject.js is listening; reply with SA_CONFIG if
   *                   we already have config.
   *   BLOCKED_COUNTS — forward event-count data to the service worker.
   *
   * WHY register BLOCKED_COUNTS here (not after the storage await)?
   *   The old code registered it inside the async IIFE body, after the
   *   await.  That meant it could miss messages posted by inject.js
   *   before the await resolved.  Registering synchronously fixes that.
   * ───────────────────────────────────────────────────────────────── */
  window.addEventListener('message', function onWindowMessage(event) {
    // Validate: must be from the same window and carry our sentinel key.
    if (
      event.source !== window ||
      !event.data ||
      typeof event.data !== 'object'
    ) {
      return;
    }

    if (event.data.__saType === 'SA_READY') {
      // inject.js just announced it is ready.  If we already have config
      // (storage resolved before inject.js posted SA_READY), send it now.
      if (cachedCfg !== null) {
        postConfig(cachedCfg);
      }
      // If cachedCfg is still null, the storage callback will post SA_CONFIG
      // once it finishes — inject.js is already listening by then.
      return;
    }

    if (event.data.__saType === 'BLOCKED_COUNTS') {
      // Sanitize before forwarding — a page script could post a fake
      // BLOCKED_COUNTS message (Bug D).  Only pass known keys with
      // finite positive values, clamped to 1000 to bound storage growth.
      const ALLOWED_KEYS = new Set([
        'visibilitychange', 'webkitvisibilitychange',
        'blur', 'mouseleave', 'pagehide', 'freeze',
      ]);
      const raw   = (typeof event.data.counts === 'object' && event.data.counts) ? event.data.counts : {};
      const clean = {};
      for (const key of ALLOWED_KEYS) {
        const v = raw[key];
        if (Number.isFinite(v) && v > 0) {
          clean[key] = Math.min(v, 1000);
        }
      }
      // Only forward if there is something meaningful to report.
      if (Object.keys(clean).length === 0) return;

      chrome.runtime.sendMessage({
        type:   'BLOCKED_COUNTS',
        counts: clean,
      }).catch(() => {});
      return;
    }
  });

  /* ─────────────────────────────────────────────────────────────────
   * Async storage read — runs concurrently with the listener above.
   * When done, caches the config and posts SA_CONFIG to inject.js.
   * ───────────────────────────────────────────────────────────────── */
  (async function loadConfig() {
    // Default: all extras off.  Core spoofing needs no config.
    let cfg = { antiIdle: false, keepAliveAudio: false, fakeActivity: false };

    try {
      const hostname     = location.hostname;
      const result       = await chrome.storage.local.get(['hostSettings']);
      const hostSettings = result.hostSettings || {};
      const s            = hostSettings[hostname] || {};

      cfg = {
        antiIdle:       !!s.antiIdle,
        keepAliveAudio: !!s.keepAliveAudio,
        fakeActivity:   !!s.fakeActivity,
      };
    } catch (err) {
      // If storage throws, still post SA_CONFIG with all-false so inject.js
      // doesn't hang waiting for a message that will never arrive.
      console.warn('[StayActive Pro] relay: storage read failed', err);
    }

    // Cache so the SA_READY handler can replay it if inject.js arrives late.
    cachedCfg = cfg;

    // Post to inject.js.  If inject.js already sent SA_READY and is waiting,
    // this delivers config immediately.  If inject.js hasn't started yet, it
    // will send SA_READY and we'll reply from the listener above.
    postConfig(cfg);
  })();

})();
