import { browser, attach, evaluate, sleep } from './cdp.mjs';

const b = await browser();
const { sessionId } = await attach(b, 'test.html', { type: 'page' });
await b.send('Runtime.enable', {}, sessionId);
b.on((m) => {
  if (m.method === 'Runtime.consoleAPICalled') {
    const t = m.params.args.map((a) => a.value ?? a.description).join(' ');
    if (t.includes('camboi')) console.log('   ', t.slice(0, 200));
  }
});
await b.send('Page.enable', {}, sessionId);
await b.send('Page.reload', {}, sessionId);
await sleep(2000);

const pass = (n, ok, d = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`);
const status = () => evaluate(b, sessionId, 'window.__status');
const sample = () => evaluate(b, sessionId, 'window.__sample()');
const cam = (msg) => evaluate(b, sessionId, `window.__cam(${JSON.stringify(msg)})`);

await evaluate(b, sessionId, 'window.__start({video:{width:1280,height:720}, audio:true})');
await sleep(1500);

let s = await status();
pass('pipeline reports attached and live', s?.attached === true && s.state === 'live', JSON.stringify(s));

console.log('\n-- recording a clip from the page --');
await cam({ type: 'start-capture', durationMs: 2500 });
await sleep(7000);
const toasts = await evaluate(b, sessionId, 'window.__toasts');
console.log('   toasts:', JSON.stringify(toasts));
s = await status();
pass('a clip was saved and loaded', s?.clipLoaded === true || toasts.some((t) => /saved/i.test(t)),
  `clipLoaded=${s?.clipLoaded}`);

console.log('\n-- stepping away --');
const live = await sample();
await cam({ type: 'command', command: 'toggle-loop' });
await sleep(1200);
s = await status();
pass('state is looping', s?.state === 'loop', s?.state);

const l1 = await sample();
await sleep(700);
const l2 = await sample();
pass('loop is animating (frames change)', l1.hash !== l2.hash, `${l1.hash} vs ${l2.hash}`);
pass('loop output is not black', l1.mean > 5, `mean ${l1.mean}`);
pass('loop differs from the live frame', l1.hash !== live.hash);

console.log('\n-- panic freeze --');
await cam({ type: 'command', command: 'panic-freeze' });
await sleep(400);
const f1 = await sample();
await sleep(900);
const f2 = await sample();
s = await status();
pass('state is frozen', s?.state === 'frozen', s?.state);
pass('picture is held still', f1.hash === f2.hash, `${f1.hash} vs ${f2.hash}`);

await cam({ type: 'command', command: 'panic-freeze' });
await sleep(300);

console.log('\n-- going live --');
await cam({ type: 'command', command: 'go-live' });
await sleep(1200);
s = await status();
pass('back to live', s?.state === 'live', s?.state);
const back = await sample();
pass('live picture is flowing again', back.mean > 5, `mean ${back.mean}`);

b.close();
