import { browser, attach, evaluate, sleep } from './cdp.mjs';

const b = await browser();
const { sessionId } = await attach(b, 'test.html', { type: 'page' });
await b.send('Runtime.enable', {}, sessionId);
await b.send('Log.enable', {}, sessionId);
b.on((m) => {
  if (m.method === 'Runtime.consoleAPICalled' && m.params.args?.[0]?.value?.includes?.('camboi')) {
    console.log('  [page console]', m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    console.log('  [page error]', m.params.entry.text.slice(0, 200));
  }
});

await b.send('Page.enable', {}, sessionId);
await b.send('Page.reload', {}, sessionId);
await sleep(2500);

const check = (name, ok, detail = '') =>
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);

const installed = await evaluate(b, sessionId, 'window.__camboiInstalled === true');
check('MAIN-world script installed', installed);

const str = await evaluate(b, sessionId, 'navigator.mediaDevices.getUserMedia.toString()');
check('getUserMedia masked as native', str.includes('[native code]'), str);

const overlay = await evaluate(b, sessionId, '!!document.getElementById("camboi-overlay-root")');
check('overlay mounted', overlay);

console.log('\n-- starting a camera stream --');
const info = await evaluate(b, sessionId, 'window.__start({video:{width:1280,height:720}, audio:true})');
console.log('  stream:', JSON.stringify(info));
check('one video track returned', info.videoTracks === 1);
check('audio track passed through', info.audioTracks === 1);
check('track settings report camera size', info.settings.width === 1280 && info.settings.height === 720,
  `${info.settings.width}x${info.settings.height}`);
check('track label is the real camera', /fake|camera/i.test(info.label), info.label);

await sleep(1200);
const a = await evaluate(b, sessionId, 'window.__sample()');
await sleep(600);
const c = await evaluate(b, sessionId, 'window.__sample()');
console.log('  samples:', JSON.stringify(a), JSON.stringify(c));
check('video dimensions survive the canvas round-trip', a.w === 1280 && a.h === 720, `${a.w}x${a.h}`);
check('frames are flowing (content changes)', a.hash !== c.hash);
check('picture is not black', a.mean > 5, `mean luma ${a.mean}`);

b.close();
