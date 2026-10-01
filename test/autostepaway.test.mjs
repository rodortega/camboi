import { browser, attach, evaluate, sleep } from './cdp.mjs';

const b = await browser();
const page = await attach(b, 'test.html', { type: 'page' });
const sid = page.sessionId;
await b.send('Runtime.enable', {}, sid);
await b.send('Page.enable', {}, sid);

const pass = (n, ok, d = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`);
const status = () => evaluate(b, sid, 'window.__status');
const cam = (msg) => evaluate(b, sid, `window.__cam(${JSON.stringify(msg)})`);

// A clip has to exist before auto step-away has anything to show.
await b.send('Page.reload', {}, sid);
await sleep(2000);
await evaluate(b, sid, 'window.__start({video:true, audio:true})');
await sleep(1200);
if (!(await status())?.clipLoaded) {
  await cam({ type: 'start-capture', durationMs: 2000 });
  await sleep(6000);
}
pass('a clip is available', (await status())?.clipLoaded === true);

// Flip the setting where it actually lives: extension storage.
const sw = await attach(b, 'sw.js', { type: 'service_worker' });
await evaluate(b, sw.sessionId, `
  chrome.storage.local.get('settings').then(({ settings }) =>
    chrome.storage.local.set({ settings: { ...settings, autoStepAway: true } }))`);
await sleep(600);

console.log('\n-- rejoining with auto step-away on --');
await b.send('Page.reload', {}, sid);
await sleep(2000);
await evaluate(b, sid, 'window.__start({video:true, audio:true})');

let state = null;
for (let i = 0; i < 20; i++) {
  await sleep(250);
  state = (await status())?.state;
  if (state === 'loop') break;
}
// 'loop' rather than 'transition-to-loop' is the point: it cut straight in,
// with no crossfade from a live picture that was never shown.
pass('the call starts on the loop, never live', state === 'loop', `state=${state}`);

const toasts = await evaluate(b, sid, 'window.__toasts');
pass('the user is told why they are not live', toasts.some((t) => /loop/i.test(t)), JSON.stringify(toasts));

// Going live must still work normally from there.
await cam({ type: 'command', command: 'go-live' });
await sleep(1500);
pass('Go live still works', (await status())?.state === 'live', (await status())?.state);

// Leave the profile as we found it.
await evaluate(b, sw.sessionId, `
  chrome.storage.local.get('settings').then(({ settings }) =>
    chrome.storage.local.set({ settings: { ...settings, autoStepAway: false } }))`);
b.close();
