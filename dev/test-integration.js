/**
 * test-integration.js — runs inject.js + relay.js together in jsdom with a fake chrome API.
 *
 * Put this file in  dev/  (next to package.json, where jsdom is installed) and run:
 *     node test-integration.js
 *
 * It prints PASS / FAIL per scenario and exits with code 1 if anything fails.
 * Scenarios are tagged with the task that should make them pass.
 *
 * Limits: jsdom is not Chrome. It emulates MessageChannel + postMessage(transfer) and
 * collapses the MAIN / ISOLATED worlds into one window. Always confirm in real Chrome too.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

const base = path.join(__dirname, '..', 'stayactive-pro');
const injectSrc = fs.readFileSync(path.join(base, 'inject.js'), 'utf8');
const relaySrc = fs.readFileSync(path.join(base, 'relay.js'), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label, tag = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${tag ? '[' + tag + '] ' : ''}${label}`);
    if (!ok) failed++;
};

function makeEnv(initial, url = 'https://example.com/', storeOverride) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url });
    const w = dom.window;
    w.MessageChannel = MessageChannel;
    w.MessagePort = MessagePort;
    // jsdom ignores the "transfer" argument of postMessage; emulate Chrome.
    w.postMessage = (data, origin, transfer) => setTimeout(() => {
        const ev = new w.Event('message');
        Object.defineProperties(ev, { data: { value: data }, source: { value: w }, ports: { value: transfer || [] } });
        w.dispatchEvent(ev);
    }, 0);

    const listeners = [], sent = [], delays = [], audio = [];
    const realST = w.setTimeout.bind(w);
    w.setTimeout = (fn, ms, ...a) => { delays.push(ms); return realST(fn, ms, ...a); };
    w.AudioContext = function () {
        audio.push('created');
        return {
            createGain: () => ({ gain: {}, connect() { } }),
            createOscillator: () => ({ frequency: {}, connect() { }, start() { }, stop() { } }),
            destination: {}, close: () => Promise.resolve(), resume() { },
        };
    };

    const host = new URL(url).hostname;
    let store = storeOverride || { hostSettings: { [host]: initial } };
    w.chrome = {
        storage: {
            local: { get: async () => JSON.parse(JSON.stringify(store)) },
            onChanged: { addListener: (f) => listeners.push(f) },
        },
        runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve(); } },
    };
    const change = (hostSettings) => {
        store = { hostSettings };
        listeners.forEach((f) => f({ hostSettings: { newValue: hostSettings } }, 'local'));
    };
    return { w, sent, delays, audio, change, host, run: (s) => w.eval(s) };
}
// The fake-activity timer uses a random 20–40 s delay.
const fakeTimers = (e) => e.delays.filter((ms) => ms >= 20000 && ms <= 40000).length;

(async () => {
    // T1 — handshake, config delivery, counter (should already pass)
    {
        const e = makeEnv({ antiIdle: true });
        e.run(injectSrc); e.run(relaySrc); await wait(150);
        for (let i = 0; i < 3; i++) e.w.dispatchEvent(new e.w.Event('blur'));
        await wait(2300);
        check(fakeTimers(e) === 1, 'extras start when config says antiIdle:true', 'Task 1');
        check(JSON.stringify(e.sent.map((m) => m.counts)) === '[{"blur":3}]', 'blocked counter forwards exactly {blur:3}', 'Task 2');
        check(e.w.document.hidden === false && e.w.document.visibilityState === 'visible', 'document.hidden=false, visibilityState=visible', 'core');
    }
    // T2 — live toggle anti-idle OFF -> ON must start the timer
    {
        const e = makeEnv({ antiIdle: false });
        e.run(injectSrc); e.run(relaySrc); await wait(150);
        e.change({ [e.host]: { antiIdle: true } }); await wait(150);
        check(fakeTimers(e) === 1, 'live toggle anti-idle ON starts fake activity (no reload)', 'live-config');
    }
    // T3 — live toggle audio OFF -> ON must create the AudioContext without needing a click
    {
        const e = makeEnv({ keepAliveAudio: false });
        e.run(injectSrc); e.run(relaySrc); await wait(800);
        e.change({ [e.host]: { keepAliveAudio: true } }); await wait(300);
        check(e.audio.length === 1, 'live toggle audio ON creates AudioContext immediately', 'live-config');
    }
    // T4 — IdleDetector must stay untouched when every extra is off
    {
        const e = makeEnv({});
        e.w.IdleDetector = class IdleDetector { };
        const original = e.w.IdleDetector;
        e.run(injectSrc); e.run(relaySrc); await wait(150);
        check(e.w.IdleDetector === original, 'IdleDetector not replaced when all extras are off', 'live-config');
    }
    // T5 — wake lock must be re-requested when a (blocked) visibilitychange fires
    {
        const e = makeEnv({ antiIdle: true });
        let acquired = 0;
        Object.defineProperty(e.w.navigator, 'wakeLock', {
            value: { request: async () => { acquired++; return { released: true, addEventListener() { }, release: async () => { } }; } },
        });
        e.run(injectSrc); e.run(relaySrc); await wait(200);
        const before = acquired;
        e.w.document.dispatchEvent(new e.w.Event('visibilitychange', { bubbles: true }));
        await wait(100);
        check(acquired > before, 'wake lock re-requested on visibilitychange', 'live-config');
    }
    // T6 — subdomain: settings stored under example.com, page is www.example.com
    {
        const e = makeEnv(null, 'https://www.example.com/', { hostSettings: { 'example.com': { antiIdle: true, includeSubdomains: true } } });
        e.run(injectSrc); e.run(relaySrc); await wait(150);
        check(fakeTimers(e) === 1, 'www.example.com picks up settings of example.com (includeSubdomains)', 'relay-fix');
    }
    // T7 — relay script runs after inject's handshake message was already dispatched
    {
        const e = makeEnv({ antiIdle: true });
        e.run(injectSrc); await wait(50); e.run(relaySrc); await wait(300);
        check(fakeTimers(e) === 1, 'extras still start when relay loads late (handshake retry)', 'relay-fix');
    }
    console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
    process.exit(failed ? 1 : 0);
})();