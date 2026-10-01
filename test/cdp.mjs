// Minimal CDP client over the DevTools websocket. No deps; Node 22 has WebSocket.
export class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.listeners = []; }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws ' + url)); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.waiters.has(m.id)) {
        const { res, rej } = c.waiters.get(m.id);
        c.waiters.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        for (const fn of c.listeners) fn(m);
      }
    };
    return c;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiters.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.waiters.delete(id)) rej(new Error(`timeout: ${method}`));
      }, 30000);
    });
  }

  on(fn) { this.listeners.push(fn); }
  close() { this.ws.close(); }
}

export async function browser(port = 9222) {
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return CDP.connect(info.webSocketDebuggerUrl);
}

export async function targets(port = 9222) {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

/** Attach to the first target whose url contains `match`. */
export async function attach(cdp, match, { type } = {}) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const t = targetInfos.find((t) => t.url.includes(match) && (!type || t.type === type));
  if (!t) throw new Error(`no target matching ${match}\n` + targetInfos.map((x) => `${x.type} ${x.url}`).join('\n'));
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  return { sessionId, target: t };
}

export async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
