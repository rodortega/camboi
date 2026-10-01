import { browser, attach, evaluate, sleep } from './cdp.mjs';

/**
 * Mimics an app that opens the camera, grabs a still and closes it again:
 * each cycle should begin at a different point in the clip, and must never
 * show a live frame.
 */
const b = await browser();
const page = await attach(b, 'test.html', { type: 'page' });
const sid = page.sessionId;
await b.send('Runtime.enable', {}, sid);
await b.send('Page.enable', {}, sid);

const pass = (n, ok, d = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`);
const status = () => evaluate(b, sid, 'window.__status');

await b.send('Page.reload', {}, sid);
await sleep(2000);
await evaluate(b, sid, 'window.__start({video:true, audio:true})');
await sleep(1200);
if (!(await status())?.clipLoaded) {
  await evaluate(b, sid, `window.__cam({type:'start-capture', durationMs: 4000})`);
  await sleep(9000);
}
pass('a clip is available', (await status())?.clipLoaded === true);

const sw = await attach(b, 'sw.js', { type: 'service_worker' });
const setSettings = (patch) =>
  evaluate(b, sw.sessionId, `
    chrome.storage.local.get('settings').then(({ settings }) =>
      chrome.storage.local.set({ settings: { ...settings, ...${JSON.stringify(patch)} } }))`);

await setSettings({ autoStepAway: true, randomStart: true });
await sleep(800);

console.log('\n-- six snapshot cycles --');
const hashes = [];
let everLive = false;
for (let i = 0; i < 6; i++) {
  await b.send('Page.reload', {}, sid);
  await sleep(1600);
  // Open the camera, let it settle just long enough to grab a still, close it.
  await evaluate(b, sid, 'window.__start({video:true, audio:true})');
  await sleep(500);
  // Ask for a fresh status; the periodic one can be up to 600ms stale.
  await evaluate(b, sid, `window.__cam({type:'request-status'})`);
  await sleep(120);
  const st = await status();
  const shot = await evaluate(b, sid, 'window.__sample()');
  // A leak means frames reached the page while we were not on the loop.
  if (st?.state !== 'loop' && shot.ct > 0) everLive = true;
  if (shot.hash) hashes.push(shot.hash);
  await evaluate(b, sid, 'window.__stream.getVideoTracks().forEach(t => t.stop())');
  await sleep(200);
}
console.log('   start hashes:', hashes.join(', '));

const distinct = new Set(hashes).size;
pass('no cycle ever delivered a live frame', !everLive);
pass('snapshots start at different points', distinct >= 4 && hashes.length >= 5,
  `${distinct} distinct of ${hashes.length}`);
pass('no two consecutive cycles matched', hashes.every((h, i) => i === 0 || h !== hashes[i - 1]));

await setSettings({ autoStepAway: false, randomStart: false });
b.close();
