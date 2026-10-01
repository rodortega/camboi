import { browser, attach, evaluate, sleep } from './cdp.mjs';

/**
 * Tears pages down mid-transfer to make sure nothing touches a dead port.
 * "Attempting to use a disconnected port object" shows up on the extension's
 * own error page, not in any tab, so this watches the service worker directly.
 */
const b = await browser(Number(process.env.CAMBOI_PORT ?? 9222));
const page = await attach(b, 'test.html', { type: 'page' });
const sid = page.sessionId;
await b.send('Page.enable', {}, sid);
await b.send('Runtime.enable', {}, sid);

const pass = (n, ok, d = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`);

// The worker may still be booting; it only shows up as sw.js once awake.
let sw = null;
for (let i = 0; i < 20 && !sw; i++) {
  sw = await attach(b, 'sw.js', { type: 'service_worker' }).catch(() => null);
  if (!sw) await sleep(500);
}
if (!sw) throw new Error('service worker never appeared');
await b.send('Runtime.enable', {}, sw.sessionId);
await b.send('Log.enable', {}, sw.sessionId);

const errors = [];
b.on((m) => {
  if (m.sessionId !== sw.sessionId) return;
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errors.push(m.params.entry.text);
  }
});

// A clip has to be active, or there is no port traffic to interrupt.
await b.send('Page.reload', {}, sid);
await sleep(2000);
await evaluate(b, sid, 'window.__start({video:true, audio:true})');
await sleep(1200);
if (!(await evaluate(b, sid, 'window.__status'))?.clipLoaded) {
  await evaluate(b, sid, `window.__cam({type:'start-capture', durationMs: 4000})`);
  await sleep(9000);
}
pass('a clip is active, so clip streaming happens on every load',
  (await evaluate(b, sid, 'window.__status'))?.clipLoaded === true);

console.log('\n-- tearing the page down mid-transfer, 10 times --');
for (let i = 0; i < 10; i++) {
  await b.send('Page.reload', {}, sid);
  // Just long enough for the clip stream to start, nowhere near long enough
  // for it to finish.
  await sleep(120 + i * 40);
}
await sleep(1500);

console.log('\n-- opening and abandoning cameras --');
for (let i = 0; i < 5; i++) {
  await b.send('Page.reload', {}, sid);
  await sleep(1200);
  await evaluate(b, sid, 'window.__start({video:true, audio:true})').catch(() => {});
  await sleep(300);
}
await sleep(2000);

const portErrors = errors.filter((e) => /disconnected port|port closed/i.test(e));
pass('no disconnected-port errors in the service worker', portErrors.length === 0,
  portErrors.slice(0, 2).join(' | '));
pass('no uncaught errors in the service worker at all', errors.length === 0,
  errors.slice(0, 2).map((e) => String(e).slice(0, 120)).join(' | '));

b.close();
