/**
 * A chrome.runtime.Port can die at any moment — the tab navigates, the frame is
 * torn down, or the service worker is evicted mid-transfer. Touching one after
 * that throws "Attempting to use a disconnected port object", which surfaces as
 * an unhandled rejection on the extension's error page. None of these failures
 * are actionable: the transfer is simply over.
 */

export function safePost(port: chrome.runtime.Port, message: unknown): boolean {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

export function safeDisconnect(port: chrome.runtime.Port): void {
  try {
    port.disconnect();
  } catch {
    // Already gone.
  }
}
