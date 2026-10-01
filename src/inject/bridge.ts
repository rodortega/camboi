import { WIRE } from '../shared/constants';
import type { ToExt, ToPage } from '../shared/messages';

/**
 * MAIN world <-> ISOLATED world. window.postMessage uses structured clone, so
 * ArrayBuffers cross this hop intact (unlike chrome.runtime messaging).
 */

export function sendToExt(msg: ToExt, transfer: Transferable[] = []): void {
  window.postMessage({ [WIRE]: true, dir: 'to-ext', msg }, '*', transfer);
}

export function onFromExt(fn: (msg: ToPage) => void): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data as { [k: string]: unknown; dir?: string; msg?: ToPage };
    if (!data || data[WIRE] !== true || data.dir !== 'to-page' || !data.msg) return;
    fn(data.msg);
  });
}
