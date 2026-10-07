/**
 * test-counter.js
 *
 * Tests the inject.js blocked-event counter: delta behaviour and
 * scheduling.  Runs outside the extension folder in dev/.
 *
 * Run: node test-counter.js
 */

'use strict';

const { JSDOM } = require('jsdom');
const path      = require('path');
const fs        = require('fs');

/* ── Minimal chrome stub (inject.js is MAIN world — no chrome.* calls,
      but Function.prototype.__saPatched__ check needs to survive) ── */

/* ── Load inject.js source ── */
const injectSrc = fs.readFileSync(
  path.join(__dirname, '../stayactive-pro/inject.js'),
  'utf8',
);

/* ── Build a jsdom window ── */
function makeWindow() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://example.com/',
  });
  const { window } = dom;

  // Track postMessages sent by inject.js
  const messages = [];
  const origPostMessage = window.postMessage.bind(window);
  window.postMessage = function(data, origin) {
    // Deliver the message so listeners inside the window fire.
    origPostMessage(data, origin);
  };
  // Intercept window 'message' events at capture phase to record SA output.
  window.addEventListener('message', (event) => {
    if (event.data && event.data.__saType === 'BLOCKED_COUNTS') {
      messages.push(JSON.parse(JSON.stringify(event.data.counts)));
    }
  }, true);

  // Run inject.js inside the jsdom window.
  const script = window.document.createElement('script');
  script.textContent = injectSrc;
  window.document.head.appendChild(script);

  return { window, messages };
}

/* ── Helpers ── */

function dispatchOn(window, target, type) {
  const evt = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'target', { value: target, writable: false });
  target.dispatchEvent(evt);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deepEqual(a, b) {
  const sortedStr = obj => JSON.stringify(obj, Object.keys(obj).sort());
  return sortedStr(a) === sortedStr(b);
}

function assert(condition, msg) {
  if (!condition) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('PASS:', msg);
  }
}

/* ════════════════════════════════════════════════════════════════════
 * Test run
 * ════════════════════════════════════════════════════════════════════ */

async function run() {
  const { window, messages } = makeWindow();
  const doc  = window.document;
  const html = doc.documentElement;

  console.log('\n── Round 1: 3×blur, 2×visibilitychange, 1×mouseleave ──');

  // Dispatch events targeting window/document/html so blockHandler fires.
  for (let i = 0; i < 3; i++) dispatchOn(window, window, 'blur');
  for (let i = 0; i < 2; i++) dispatchOn(window, doc,    'visibilitychange');
  dispatchOn(window, html, 'mouseleave');

  // Wait 2.5 s for the 2 s throttle timer to fire.
  await wait(2500);

  assert(messages.length === 1, `Exactly 1 message posted (got ${messages.length})`);

  const expected1 = { blur: 3, visibilitychange: 2, mouseleave: 1 };
  assert(
    deepEqual(messages[0], expected1),
    `Round 1 counts = ${JSON.stringify(messages[0])} (expected ${JSON.stringify(expected1)})`,
  );

  console.log('\n── Round 2: 2×blur only ──');

  for (let i = 0; i < 2; i++) dispatchOn(window, window, 'blur');

  await wait(2500);

  assert(messages.length === 2, `Exactly 2 total messages after round 2 (got ${messages.length})`);

  const expected2 = { blur: 2 };
  assert(
    deepEqual(messages[1], expected2),
    `Round 2 counts = ${JSON.stringify(messages[1])} (expected ${JSON.stringify(expected2)})`,
  );

  console.log('\n── Round 3: no events → no message ──');

  await wait(2500);

  assert(messages.length === 2, `Still 2 total messages after quiet period (got ${messages.length})`);

  console.log('\n── Done. ──\n');
}

run().catch(err => {
  console.error('Uncaught error in test:', err);
  process.exitCode = 1;
});
