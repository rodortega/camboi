/**
 * Extension messaging (chrome.runtime.sendMessage / Port.postMessage) serializes
 * as JSON, so binary has to cross that boundary as text. window.postMessage
 * between worlds uses structured clone and does not need this.
 */

export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(out);
}

export function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
