import { base64ToBuffer, bufferToBase64 } from '../shared/base64';
import { STORAGE_KEY_LAST_START, WIRE } from '../shared/constants';
import type { ToExt, ToPage } from '../shared/messages';
import { safeDisconnect, safePost } from '../shared/port';
import { onSettingsChanged } from '../shared/settings';
import type { ClipMeta, EffectId, Settings } from '../shared/types';
import { Overlay } from './overlay';

/**
 * ISOLATED world. Bridges the injected pipeline (which can reach the page but
 * not chrome.*) and the service worker (which can reach storage but not the
 * page), and hosts the in-page controls.
 */

const isTopFrame = window === window.top;

let settings: Settings | null = null;
let clips: ClipMeta[] = [];
let clipLoadToken = 0;
let recording = false;

const overlay = isTopFrame
  ? new Overlay({
      onCommand: (command) => toPage({ type: 'command', command }),
      onEffect: (effect) => void setSettings({ effect: effect as EffectId }),
      onRecord: () => toggleRecording(),
      onSelectClip: (id) => void setSettings({ activeClipId: id }),
      onOpenStudio: () => void chrome.runtime.sendMessage({ type: 'open-studio' }),
      onHide: () => void setSettings({ overlayVisible: false }),
    })
  : null;

// ------------------------------------------------------------------ plumbing

function toPage(msg: ToPage, transfer: Transferable[] = []): void {
  window.postMessage({ [WIRE]: true, dir: 'to-page', msg }, '*', transfer);
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data as { [k: string]: unknown; dir?: string; msg?: ToExt };
  if (!data || data[WIRE] !== true || data.dir !== 'to-ext' || !data.msg) return;
  void fromPage(data.msg);
});

async function fromPage(msg: ToExt): Promise<void> {
  switch (msg.type) {
    case 'ready':
      if (settings) toPage({ type: 'settings', settings });
      return;

    case 'status':
      overlay?.setStatus(msg.status);
      try {
        await chrome.runtime.sendMessage({ type: 'status-report', status: msg.status });
      } catch {
        // Service worker is asleep or the extension reloaded; harmless.
      }
      return;

    case 'start-chosen':
      await chrome.storage.local.set({ [STORAGE_KEY_LAST_START]: msg.index });
      return;

    case 'need-clip':
      if (msg.clipId) void streamClipToPage(msg.clipId);
      else toPage({ type: 'clip-cleared' });
      return;

    case 'toast':
      overlay?.toast(msg.text, msg.tone);
      return;

    case 'capture-progress':
      overlay?.setRecording(true, `Stop · ${(msg.durationMs / 1000).toFixed(1)}s · ${formatSize(msg.bytes)}`);
      return;

    case 'capture-done':
      recording = false;
      overlay?.setRecording(false);
      overlay?.toast('Saving clip…');
      await saveCapture(msg.frames, msg.width, msg.height, msg.fps);
      return;

    case 'capture-failed':
      recording = false;
      overlay?.setRecording(false);
      overlay?.toast(msg.reason, 'warn');
      return;
  }
}

// Commands and settings pushes from the service worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'command') toPage({ type: 'command', command: msg.command });
  else if (msg?.type === 'toast') overlay?.toast(msg.text, msg.tone);
  else if (msg?.type === 'foreign-status') overlay?.setStatus(msg.status);
  else if (msg?.type === 'request-status') toPage({ type: 'request-status' });
  else if (msg?.type === 'start-recording') toggleRecording();
});

// ------------------------------------------------------------------ settings

async function loadSettings(): Promise<void> {
  settings = (await chrome.runtime.sendMessage({ type: 'get-settings' })) as Settings;
  applySettings(settings);

  const stored = await chrome.storage.local.get(STORAGE_KEY_LAST_START);
  const last = stored[STORAGE_KEY_LAST_START];
  if (typeof last === 'number') toPage({ type: 'restore-last-start', index: last });
}

async function setSettings(patch: Partial<Settings>): Promise<void> {
  settings = (await chrome.runtime.sendMessage({ type: 'set-settings', patch })) as Settings;
  applySettings(settings);
}

function applySettings(next: Settings): void {
  settings = next;
  overlay?.setSettings(next);
  overlay?.setClips(clips, next.activeClipId);
  toPage({ type: 'settings', settings: next });
}

onSettingsChanged((next) => {
  const clipChanged = settings?.activeClipId !== next.activeClipId;
  applySettings(next);
  if (clipChanged) void refreshClips();
});

async function refreshClips(): Promise<void> {
  clips = ((await chrome.runtime.sendMessage({ type: 'list-clips' })) as ClipMeta[]) ?? [];
  overlay?.setClips(clips, settings?.activeClipId ?? null);
}

// ------------------------------------------------------------- clip transfer

/** Pulls a clip's frames from the worker in base64 chunks and hands them to the page. */
function streamClipToPage(clipId: string): void {
  const token = ++clipLoadToken;
  const port = chrome.runtime.connect({ name: `clip:${clipId}` });
  let meta: ClipMeta | null = null;
  let abandoned = false;
  const frames: ArrayBuffer[] = [];

  port.onMessage.addListener((msg) => {
    // A newer load superseded this one. Drop it once; further queued messages
    // must not disconnect an already-disconnected port.
    if (token !== clipLoadToken) {
      if (!abandoned) {
        abandoned = true;
        safeDisconnect(port);
      }
      return;
    }
    if (msg.type === 'meta') {
      meta = msg.meta;
    } else if (msg.type === 'chunk') {
      (msg.frames as string[]).forEach((b64, i) => { frames[msg.start + i] = base64ToBuffer(b64); });
    } else if (msg.type === 'done' && meta) {
      toPage({ type: 'clip-data', meta, frames }, frames);
    } else if (msg.type === 'missing') {
      toPage({ type: 'clip-cleared' });
    }
  });
}

// ---------------------------------------------------------------- recording

/** Click to start, click again to stop. Auto-stops only if a limit is set. */
function toggleRecording(): void {
  if (recording) {
    overlay?.setRecording(true, 'Saving…');
    toPage({ type: 'stop-capture' });
    return;
  }
  recording = true;
  overlay?.setRecording(true, 'Stop');
  toPage({ type: 'start-capture', durationMs: settings?.maxClipMs ?? 0 });
}

function formatSize(bytes: number): string {
  return bytes > 1024 * 1024 * 1024
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

async function saveCapture(frames: ArrayBuffer[], width: number, height: number, fps: number): Promise<void> {
  try {
    const thumbnail = await makeThumbnail(frames[0]);
    const port = chrome.runtime.connect({ name: 'upload' });
    safePost(port, {
      type: 'meta',
      meta: {
        name: `Clip ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        frameCount: frames.length,
        fps,
        width,
        height,
        pinned: false,
        loopStyle: settings?.loopStyle ?? 'pingpong',
        createdAt: Date.now(),
        thumbnail,
      },
    });

    const BATCH = 32;
    for (let i = 0; i < frames.length; i += BATCH) {
      const batch = frames.slice(i, i + BATCH).map(bufferToBase64);
      if (!safePost(port, { type: 'chunk', start: i, frames: batch })) {
        overlay?.toast('Lost the connection while saving that clip', 'warn');
        return;
      }
    }
    safePost(port, { type: 'done' });

    port.onMessage.addListener(async (msg) => {
      if (msg.type !== 'saved') return;
      safeDisconnect(port);
      await refreshClips();
      overlay?.toast('Clip saved and selected');
    });
  } catch (err) {
    overlay?.toast(`Could not save clip: ${String(err)}`, 'warn');
  }
}

async function makeThumbnail(buf: ArrayBuffer): Promise<string> {
  const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/webp' }));
  const w = 160;
  const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL('image/webp', 0.7);
}

// ---------------------------------------------------------------- bootstrap

function mountOverlay(): void {
  if (!overlay) return;
  if (document.body) overlay.mount();
  else document.addEventListener('DOMContentLoaded', () => overlay.mount(), { once: true });
}

mountOverlay();
void loadSettings().then(refreshClips);
