import { base64ToBuffer, bufferToBase64 } from '../shared/base64';
import { COMMANDS } from '../shared/constants';
import { readSettings, writeSettings } from '../shared/settings';
import type { ClipMeta, PipelineStatus } from '../shared/types';
import { deleteClip, getClip, listClips, newClipId, putClip, updateClip } from './clipdb';

/** Last status each tab's pipeline reported, so the popup can render instantly. */
const tabStatus = new Map<string, PipelineStatus>();

chrome.runtime.onInstalled.addListener(async (details) => {
  await readSettings(); // materialise defaults
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const key of tabStatus.keys()) {
    if (key.startsWith(`${tabId}:`)) tabStatus.delete(key);
  }
});

/** The attached pipeline for a tab, preferring the top frame. */
function statusForTab(tabId: number): PipelineStatus | null {
  return tabStatus.get(`${tabId}:0`) ?? [...tabStatus].find(([k]) => k.startsWith(`${tabId}:`))?.[1] ?? null;
}

// ---------------------------------------------------------------- commands

chrome.commands.onCommand.addListener(async (command) => {
  if (command === COMMANDS.nextClip) {
    const next = await cycleClip();
    await broadcastToActiveTab({ type: 'toast', text: next ? `Clip: ${next}` : 'No clips saved yet' });
    return;
  }
  const map: Record<string, string> = {
    [COMMANDS.toggleLoop]: 'toggle-loop',
    [COMMANDS.goLive]: 'go-live',
    [COMMANDS.panicFreeze]: 'panic-freeze',
  };
  const mapped = map[command];
  if (mapped) await broadcastToActiveTab({ type: 'command', command: mapped });
});

async function broadcastToActiveTab(msg: unknown): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) return;
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    // No content script on this page (chrome://, the Web Store, a PDF viewer...).
  }
}

/** Advance activeClipId to the next saved clip, wrapping. Returns its name. */
async function cycleClip(): Promise<string | null> {
  const clips = await listClips();
  if (!clips.length) return null;
  const settings = await readSettings();
  const idx = clips.findIndex((c) => c.id === settings.activeClipId);
  const next = clips[(idx + 1) % clips.length];
  await writeSettings({ activeClipId: next.id });
  return next.name;
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, (err: unknown) => {
    console.error('[camboi] message failed', msg?.type, err);
    sendResponse({ error: String(err) });
  });
  return true; // async
});

async function handleMessage(msg: any, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg?.type) {
    case 'get-settings':
      return readSettings();

    case 'set-settings':
      return writeSettings(msg.patch);

    case 'list-clips':
      return listClips();

    case 'delete-clip': {
      await deleteClip(msg.id);
      const settings = await readSettings();
      if (settings.activeClipId === msg.id) await writeSettings({ activeClipId: null });
      return listClips();
    }

    case 'update-clip':
      return updateClip(msg.id, msg.patch);

    case 'cycle-clip':
      return cycleClip();

    case 'status-report': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) {
        const key = `${tabId}:${sender.frameId ?? 0}`;
        if (msg.status.attached) tabStatus.set(key, msg.status);
        else tabStatus.delete(key);
        // The overlay only lives in the top frame; if the camera is actually
        // being used by an embedded iframe, mirror its status up.
        if (sender.frameId && msg.status.attached) {
          chrome.tabs
            .sendMessage(tabId, { type: 'foreign-status', status: msg.status }, { frameId: 0 })
            .catch(() => {});
        }
      }
      return { ok: true };
    }

    case 'get-tab-status':
      return msg.tabId !== undefined ? statusForTab(msg.tabId) : null;

    case 'open-studio':
      await chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
      return { ok: true };

    case 'open-shortcuts':
      await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      return { ok: true };


    default:
      return { error: `unknown message ${msg?.type}` };
  }
}

// ------------------------------------------------------- clip byte streaming

/**
 * Content scripts cannot read the extension's IndexedDB, and runtime messaging
 * is JSON-only, so frames are base64-chunked over a long-lived port.
 */
const FRAMES_PER_CHUNK = 8;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name.startsWith('clip:')) {
    void streamClip(port, port.name.slice('clip:'.length));
  } else if (port.name === 'upload') {
    receiveClip(port);
  }
});

/** Receives a newly recorded clip, base64-chunked, from a content script. */
function receiveClip(port: chrome.runtime.Port): void {
  let meta: Omit<ClipMeta, 'id'> | null = null;
  const frames: ArrayBuffer[] = [];

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'meta') {
      meta = msg.meta;
      return;
    }
    if (msg.type === 'chunk') {
      (msg.frames as string[]).forEach((b64, i) => { frames[msg.start + i] = base64ToBuffer(b64); });
      return;
    }
    if (msg.type !== 'done' || !meta) return;

    const id = newClipId();
    await putClip({ ...meta, id, frames, frameCount: frames.length });
    await writeSettings({ activeClipId: id });
    try {
      port.postMessage({ type: 'saved', id });
    } catch {
      // Sender navigated away mid-save; the clip is still stored.
    }
  });
}

async function streamClip(port: chrome.runtime.Port, id: string): Promise<void> {
  let alive = true;
  port.onDisconnect.addListener(() => { alive = false; });

  const clip = await getClip(id);
  if (!clip) {
    if (alive) port.postMessage({ type: 'missing' });
    port.disconnect();
    return;
  }

  const { frames, ...meta } = clip;
  port.postMessage({ type: 'meta', meta });

  for (let i = 0; i < frames.length && alive; i += FRAMES_PER_CHUNK) {
    const batch = frames.slice(i, i + FRAMES_PER_CHUNK).map(bufferToBase64);
    port.postMessage({ type: 'chunk', start: i, frames: batch });
    // Yield so a long clip does not monopolise the worker.
    await new Promise((r) => setTimeout(r, 0));
  }

  if (alive) {
    port.postMessage({ type: 'done' });
    port.disconnect();
  }
}
