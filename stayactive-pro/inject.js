/**
 * inject.js — StayActive Pro
 *
 * Runs in the MAIN world at document_start so our overrides beat any
 * page-level listener registration.  MAIN world means NO chrome.* APIs.
 *
 * Config delivery (WHY postMessage, not a DOM attribute):
 *   - A DOM data-attribute would be written by relay.js only AFTER an
 *     async chrome.storage.local.get resolves, which is always AFTER
 *     this synchronous script has already run — so we'd always read
 *     empty config.  Using postMessage lets relay.js push config to us
 *     whenever it is ready, and a handshake (SA_READY / SA_CONFIG) makes
 *     the delivery reliable regardless of which script starts first.
 *   - A data-attribute also leaks the extension's presence to the page;
 *     a postMessage with a private __saType key is less conspicuous.
 *
 * Sections 1–6 (core spoofing) run immediately — no config needed,
 * because every site that has inject.js registered is already enabled.
 * Sections 7–8 (extras) run inside startExtras(cfg) called once config
 * arrives via the SA_CONFIG message.
 */

(function stayActiveProInject() {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────
   * HANDSHAKE — register the SA_CONFIG listener and post SA_READY.
   *
   * WHY register first, then post?  If relay.js is already loaded and
   * waiting, it will reply to SA_READY immediately (synchronously in the
   * microtask queue).  If relay.js loads later, it will see our SA_READY
   * in its own listener and post SA_CONFIG once storage is read.
   * Either way, startExtras runs exactly once thanks to extrasStarted.
   * ───────────────────────────────────────────────────────────────── */

  // Cache native methods at document_start before page scripts can tamper with them.
  // This protects against MAIN-world prototype pollution.
  const nativePortPostMessage = MessagePort.prototype.postMessage;
  const nativeJSONParse = JSON.parse;

  // Guard: run startExtras at most once per page load even if two
  // SA_CONFIG messages somehow arrive (shouldn't happen, but be safe).
  let extrasStarted = false;

  // Create a secure MessageChannel. We send port2 to relay.js and listen on port1.
  // This prevents the page from intercepting or spoofing SA_CONFIG / BLOCKED_COUNTS.
  const channel = new MessageChannel();

  channel.port1.onmessage = function onSaConfig(event) {
    if (!event.data || event.data.__saType !== 'SA_CONFIG') return;

    let cfg;
    try {
      cfg = nativeJSONParse(event.data.cfg);
    } catch (_) {
      return;
    }

    if (extrasStarted) return;
    extrasStarted = true;

    startExtras(cfg);
  };

  // Tell relay.js we are ready and pass the secure port.
  // relay.js uses a capture-phase listener to intercept this and stop propagation,
  // so the page never sees the message or steals the port.
  window.postMessage({ __saType: 'SA_READY' }, '*', [channel.port2]);

  /* ─────────────────────────────────────────────────────────────────
   * 2. Native-code toString spoofing helper.
   *
   *    WHY: Some fingerprinting scripts call
   *      Object.getOwnPropertyDescriptor(document,'hidden').get.toString()
   *    to detect overrides.  We patch Function.prototype.toString so
   *    our getter functions print as "[native code]".
   * ───────────────────────────────────────────────────────────────── */
  const nativeToString = Function.prototype.toString;
  const nativeCodeMap = new WeakMap();

  function registerNativeString(fn, nativeStr) {
    nativeCodeMap.set(fn, nativeStr);
  }

  // Only override toString once, even if this IIFE somehow ran twice.
  if (!Function.prototype.__saPatched__) {
    Object.defineProperty(Function.prototype, '__saPatched__', {
      value: true, writable: false, configurable: false, enumerable: false,
    });

    Function.prototype.toString = function toString() {
      if (nativeCodeMap.has(this)) {
        return nativeCodeMap.get(this);
      }
      return nativeToString.call(this);
    };

    // Make our patched toString itself look native.
    registerNativeString(
      Function.prototype.toString,
      'function toString() { [native code] }',
    );
  }

  /* ─────────────────────────────────────────────────────────────────
   * 3. Override visibility getters on Document.prototype.
   *
   *    WHY Document.prototype and not document directly?
   *    Some frameworks re-query the descriptor via
   *    Object.getPrototypeOf(document), so patching the prototype
   *    is more robust.  configurable:true lets test code reset it.
   *
   *    WHY unconditional (no cfg guard)?  Every site that has inject.js
   *    registered is already enabled — the background only registers the
   *    script when the user turns the site on.  So core spoofing is
   *    always appropriate here.
   * ───────────────────────────────────────────────────────────────── */
  const visibilityProps = {
    hidden:                { value: false,     nativeStr: 'function get hidden() { [native code] }' },
    webkitHidden:          { value: false,     nativeStr: 'function get webkitHidden() { [native code] }' },
    visibilityState:       { value: 'visible', nativeStr: 'function get visibilityState() { [native code] }' },
    webkitVisibilityState: { value: 'visible', nativeStr: 'function get webkitVisibilityState() { [native code] }' },
  };

  for (const [prop, meta] of Object.entries(visibilityProps)) {
    const getter = () => meta.value;
    registerNativeString(getter, meta.nativeStr);

    Object.defineProperty(Document.prototype, prop, {
      get: getter,
      configurable: true,  // Allow test code / other extensions to override.
      enumerable: true,
    });
  }

  /* document.hasFocus() → always true */
  const hasFocusFn = () => true;
  registerNativeString(hasFocusFn, 'function hasFocus() { [native code] }');
  Document.prototype.hasFocus = hasFocusFn;

  /* ─────────────────────────────────────────────────────────────────
   * 4. Block visibility/focus events at capture phase on window.
   *
   *    WHY capture phase?  Capture fires before bubble, so we can
   *    call stopImmediatePropagation() before any page handler sees
   *    the event.  We only block when target is window, document, or
   *    <html> — never on normal elements like <input> or <button>
   *    so that form blur behaviour is untouched.
   * ───────────────────────────────────────────────────────────────── */
  const BLOCKED_EVENTS = [
    'visibilitychange',
    'webkitvisibilitychange',
    'blur',
    'mouseleave',
    'freeze',
  ];

  // Pending delta counts for the event log feature.
  // WHY deltas (not cumulative totals)?  background.js ADDS each incoming
  // message to storage — so if we sent running totals, every event would
  // be counted twice (once in the flush and again on the next flush).
  // Sending only the NEW events since the last flush keeps the math correct.
  const pendingCounts = {};
  BLOCKED_EVENTS.forEach(e => { pendingCounts[e] = 0; });

  /* ─────────────────────────────────────────────────────────────────
   * 6. Report blocked event counts back to the relay script.
   *
   *    We cannot use chrome.runtime.sendMessage from MAIN world, so
   *    we post a structured message on window.  The isolated-world
   *    relay script (which CAN use chrome.*) listens and forwards it.
   *    Throttled to once per 2 s to avoid spam.
   * ───────────────────────────────────────────────────────────────── */
  let reportTimer = null;

  function scheduleReport() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;

      // Build a delta object containing only keys with new events.
      // WHY skip zero-count keys?  Sending zeros wastes a message and
      // could confuse the background if it receives an empty object.
      const delta = {};
      for (const key of BLOCKED_EVENTS) {
        if (pendingCounts[key] > 0) {
          delta[key] = pendingCounts[key];
          pendingCounts[key] = 0; // Reset so the next flush starts fresh.
        }
      }

      if (Object.keys(delta).length > 0) {
        nativePortPostMessage.call(channel.port1, { __saType: 'BLOCKED_COUNTS', counts: delta });
      }
    }, 2000);
  }

  function blockHandler(event) {
    const t = event.target;
    // Only intercept top-level targets — not inputs, buttons, etc.
    if (t === window || t === document || t === document.documentElement) {
      pendingCounts[event.type] = (pendingCounts[event.type] || 0) + 1;

      // WHY call scheduleReport here, inside the same handler?  blockHandler
      // is registered first in capture phase and calls
      // stopImmediatePropagation(), which prevents any listener registered
      // AFTER it on the same target from running.  A second capture listener
      // for scheduleReport would never fire.  Calling it directly here is the
      // only reliable way to trigger the throttled report.
      scheduleReport();

      event.stopImmediatePropagation();
      // Don't call preventDefault() — some events have side-effects we
      // still want.
    }
  }

  for (const evtName of BLOCKED_EVENTS) {
    window.addEventListener(evtName, blockHandler, true /* capture */);
  }

  /* ─────────────────────────────────────────────────────────────────
   * 5. Neutralise property-assignment handlers.
   *
   *    Some sites do: window.onblur = function() { pauseVideo(); }
   *    We intercept the setter and silently discard the assignment.
   * ───────────────────────────────────────────────────────────────── */
  const noop = () => {};

  function neutraliseSetter(obj, prop) {
    Object.defineProperty(obj, prop, {
      get: () => null,
      set: noop,
      configurable: true,
      enumerable: true,
    });
  }

  neutraliseSetter(window,   'onblur');
  neutraliseSetter(document, 'onvisibilitychange');
  neutraliseSetter(document, 'onwebkitvisibilitychange');

  /* ─────────────────────────────────────────────────────────────────
   * startExtras(cfg) — called once when SA_CONFIG message arrives.
   *
   * Contains sections 7 (anti-idle) and 8 (silent audio).
   * These depend on user-configured options and must NOT run until
   * config is known.  They are safe to skip entirely if both are off.
   * ───────────────────────────────────────────────────────────────── */
  function startExtras(cfg) {
    // Verification hook — remove after confirming fix works.
    console.debug('[StayActive] extras started', cfg);

    /* ───────────────────────────────────────────────────────────────
     * 7. Anti-idle / fake activity  (cfg.antiIdle || cfg.fakeActivity)
     *
     *    Dispatches synthetic mousemove + scroll on a random 20–40 s
     *    interval so the OS/browser idle timer does not tick up.
     *    Requests a Screen Wake Lock and re-acquires it when released.
     * ─────────────────────────────────────────────────────────────── */
    if (cfg.antiIdle || cfg.fakeActivity) {
      function randomBetween(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
      }

      function dispatchFakeActivity() {
        try {
          // Synthetic mousemove — will NOT re-trigger our block handler
          // because event.target is document.body, not window/document/<html>.
          const mv = new MouseEvent('mousemove', {
            bubbles: true, cancelable: true,
            clientX: randomBetween(1, 10), clientY: randomBetween(1, 10),
          });
          document.dispatchEvent(mv);

          // Tiny scroll keeps some idle APIs from firing.
          window.scrollBy(0, 0);
        } catch (_) {}

        scheduleNextFakeActivity();
      }

      function scheduleNextFakeActivity() {
        const delay = randomBetween(20000, 40000);
        setTimeout(dispatchFakeActivity, delay);
      }

      scheduleNextFakeActivity();

      /* Screen Wake Lock — re-acquire when released */
      if ('wakeLock' in navigator) {
        let wakeLockRef = null;

        async function acquireWakeLock() {
          try {
            wakeLockRef = await navigator.wakeLock.request('screen');
            wakeLockRef.addEventListener('release', acquireWakeLock);
          } catch (_) {
            // Silently fail — wake lock is optional enhancement.
          }
        }

        // Wake Lock requires a user gesture on some browsers; try immediately
        // and also on first interaction.
        acquireWakeLock();
        document.addEventListener('click', acquireWakeLock, { once: true });
      }

      /* Spoof Idle Detection API if present */
      if (typeof IdleDetector !== 'undefined') {
        try {
          const OrigIdleDetector = IdleDetector;
          class SpoofedIdleDetector extends OrigIdleDetector {
            get userState()   { return 'active'; }
            get screenState() { return 'unlocked'; }
          }
          window.IdleDetector = SpoofedIdleDetector;
        } catch (_) {}
      }
    }

    /* ───────────────────────────────────────────────────────────────
     * 8. Silent audio keep-alive  (cfg.keepAliveAudio)
     *
     *    An oscillator running at gain 0 is enough to signal "active
     *    audio" to Chrome's background throttling heuristic without
     *    producing audible sound.
     *
     *    WHY: Chrome aggressively throttles setTimeout/setInterval in
     *    hidden tabs unless audio is playing.  Gain-0 audio tricks it.
     * ─────────────────────────────────────────────────────────────── */
    if (cfg.keepAliveAudio) {
      let audioCtx = null;

      function startSilentAudio() {
        try {
          audioCtx = new AudioContext();
          const osc  = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          gain.gain.value = 0;           // Completely silent.
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start();

          // If autoplay policy suspends the context, resume on first interaction.
          if (audioCtx.state === 'suspended') {
            document.addEventListener('click', () => audioCtx.resume(), { once: true });
          }
        } catch (_) {}
      }

      // Defer slightly so the page has a chance to load its own AudioContext first.
      setTimeout(startSilentAudio, 500);
    }
  } // end startExtras

})();
