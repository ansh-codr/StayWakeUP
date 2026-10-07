/**
 * inject.js — StayActive Pro
 *
 * Runs in the MAIN world at document_start so our overrides beat any
 * page-level listener registration.  MAIN world means NO chrome.* APIs.
 *
 * Config is delivered via a data attribute written by the companion
 * isolated-world relay script (relay.js) before this script executes.
 * The relay reads chrome.storage.local and stamps:
 *   document.documentElement.dataset.saConfig = JSON.stringify(config)
 * Because inject.js runs at document_start, document.documentElement
 * already exists (the parser creates it before any script runs).
 */

(function stayActiveProInject() {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────
   * 1. Read config injected by the isolated-world relay script.
   *    Falls back to a safe default (everything enabled) if missing.
   * ───────────────────────────────────────────────────────────────── */
  let cfg = {
    spoofVisibility: true,
    antiIdle: false,
    keepAliveAudio: false,
    fakeActivity: false,
  };

  try {
    const raw = document.documentElement.dataset.saConfig;
    if (raw) {
      cfg = Object.assign(cfg, JSON.parse(raw));
    }
  } catch (_) {
    // Malformed JSON or missing — proceed with defaults.
  }

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
   * ───────────────────────────────────────────────────────────────── */
  if (cfg.spoofVisibility) {
    const visibilityProps = {
      hidden:                 { value: false,     nativeStr: 'function get hidden() { [native code] }' },
      webkitHidden:           { value: false,     nativeStr: 'function get webkitHidden() { [native code] }' },
      visibilityState:        { value: 'visible', nativeStr: 'function get visibilityState() { [native code] }' },
      webkitVisibilityState:  { value: 'visible', nativeStr: 'function get webkitVisibilityState() { [native code] }' },
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

    /* ───────────────────────────────────────────────────────────────
     * 4. Block visibility/focus events at capture phase on window.
     *
     *    WHY capture phase?  Capture fires before bubble, so we can
     *    call stopImmediatePropagation() before any page handler sees
     *    the event.  We only block when target is window, document, or
     *    <html> — never on normal elements like <input> or <button>
     *    so that form blur behaviour is untouched.
     * ─────────────────────────────────────────────────────────────── */
    const BLOCKED_EVENTS = [
      'visibilitychange',
      'webkitvisibilitychange',
      'blur',
      'mouseleave',
      'pagehide',
      'freeze',
    ];

    // Counts for the event log feature (sent via postMessage to relay).
    const blockedCounts = {};
    BLOCKED_EVENTS.forEach(e => { blockedCounts[e] = 0; });

    function blockHandler(event) {
      const t = event.target;
      // Only intercept top-level targets — not inputs, buttons, etc.
      if (t === window || t === document || t === document.documentElement) {
        blockedCounts[event.type] = (blockedCounts[event.type] || 0) + 1;
        event.stopImmediatePropagation();
        // Don't call preventDefault() — some events have side-effects we
        // still want (e.g., pagehide for bfcache).
      }
    }

    for (const evtName of BLOCKED_EVENTS) {
      window.addEventListener(evtName, blockHandler, true /* capture */);
    }

    /* ───────────────────────────────────────────────────────────────
     * 5. Neutralise property-assignment handlers.
     *
     *    Some sites do: window.onblur = function() { pauseVideo(); }
     *    We intercept the setter and silently discard the assignment.
     * ─────────────────────────────────────────────────────────────── */
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
    neutraliseSetter(window,   'onpagehide');
    neutraliseSetter(document, 'onvisibilitychange');
    neutraliseSetter(document, 'onwebkitvisibilitychange');

    /* ───────────────────────────────────────────────────────────────
     * 6. Report blocked event counts back to the relay script.
     *
     *    We cannot use chrome.runtime.sendMessage from MAIN world, so
     *    we post a structured message on window.  The isolated-world
     *    relay script (which CAN use chrome.*) listens and forwards it.
     *    Throttled to once per 2 s to avoid spam.
     * ─────────────────────────────────────────────────────────────── */
    let reportTimer = null;

    function scheduleReport() {
      if (reportTimer) return;
      reportTimer = setTimeout(() => {
        reportTimer = null;
        window.postMessage({
          __saType: 'BLOCKED_COUNTS',
          counts: Object.assign({}, blockedCounts),
        }, '*');
      }, 2000);
    }

    // Patch the block handler to also trigger a report.
    const origBlockHandler = blockHandler;
    BLOCKED_EVENTS.forEach(evtName => {
      // (already registered above — scheduleReport called inside handler closure)
    });

    // We need a slightly different setup: attach the scheduler inside
    // a second capture listener so we don't disturb the stop-propagation.
    window.addEventListener('visibilitychange', scheduleReport, true);
    window.addEventListener('blur',             scheduleReport, true);
    window.addEventListener('mouseleave',       scheduleReport, true);
    window.addEventListener('pagehide',         scheduleReport, true);
  } // end if (cfg.spoofVisibility)

  /* ─────────────────────────────────────────────────────────────────
   * 7. Anti-idle / fake activity  (cfg.antiIdle)
   *
   *    Dispatches synthetic mousemove + scroll on a random 20–40 s
   *    interval so the OS/browser idle timer does not tick up.
   *    Requests a Screen Wake Lock and re-acquires it when released.
   * ───────────────────────────────────────────────────────────────── */
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

  /* ─────────────────────────────────────────────────────────────────
   * 8. Silent audio keep-alive  (cfg.keepAliveAudio)
   *
   *    An oscillator running at gain 0 is enough to signal "active
   *    audio" to Chrome's background throttling heuristic without
   *    producing audible sound.
   *
   *    WHY: Chrome aggressively throttles setTimeout/setInterval in
   *    hidden tabs unless audio is playing.  Gain-0 audio tricks it.
   * ───────────────────────────────────────────────────────────────── */
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

})();
