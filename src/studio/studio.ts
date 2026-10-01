import { deleteClip, getClip, listClips, newClipId, putClip, updateClip } from '../background/clipdb';
import { bufferToBase64, base64ToBuffer } from '../shared/base64';
import { MAX_CLIP_EDGE, TARGET_FPS } from '../shared/constants';
import { readSettings, writeSettings } from '../shared/settings';
import type { ClipMeta, ClipRecord, LoopStyle, Settings } from '../shared/types';
import { CleanFrameDetector } from '../inject/cleanframe';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const video = $<HTMLVideoElement>('preview');
const ghost = $<HTMLCanvasElement>('ghost');
const badge = $<HTMLSpanElement>('badge');
const statusBox = $<HTMLDivElement>('status');
const clipsBox = $<HTMLDivElement>('clips');
const recordBtn = $<HTMLButtonElement>('record');
const stopBtn = $<HTMLButtonElement>('stop');
const durationInput = $<HTMLInputElement>('duration');
const autoStopBox = $<HTMLInputElement>('autoStop');
const ghostAlpha = $<HTMLInputElement>('ghostAlpha');
const mirrorBox = $<HTMLInputElement>('mirror');
const cameraSel = $<HTMLSelectElement>('camera');
const loopStyleSel = $<HTMLSelectElement>('loopStyle');
const trimRow = $<HTMLDivElement>('trimRow');
const trimStart = $<HTMLInputElement>('trimStart');
const trimEnd = $<HTMLInputElement>('trimEnd');

let settings: Settings;
let clips: ClipMeta[] = [];
let stream: MediaStream | null = null;
let detector = new CleanFrameDetector();
let ghostBitmap: ImageBitmap | null = null;

type Recorder = {
  frames: (ArrayBuffer | null)[];
  pending: number;
  startedAt: number;
  /** Infinity when recording until Stop. */
  endsAt: number;
  bytes: number;
  width: number;
  height: number;
  stopped: boolean;
};
let recorder: Recorder | null = null;
const worker = new Worker('encoder.worker.js');

// ---------------------------------------------------------------------- ui

function setStatus(text: string, tone: 'info' | 'warn' | 'bad' = 'info'): void {
  statusBox.textContent = text;
  statusBox.className = `status show ${tone}`;
  if (tone === 'info') setTimeout(() => statusBox.classList.remove('show'), 4000);
}

function applyMirror(): void {
  const t = mirrorBox.checked ? 'scaleX(-1)' : 'none';
  video.style.transform = t;
  ghost.style.transform = t;
}

autoStopBox.addEventListener('change', async () => {
  durationInput.disabled = !autoStopBox.checked;
  await writeSettings({ maxClipMs: autoStopBox.checked ? Number(durationInput.value) * 1000 : 0 });
});
durationInput.addEventListener('change', async () => {
  if (autoStopBox.checked) await writeSettings({ maxClipMs: Number(durationInput.value) * 1000 });
});
ghostAlpha.addEventListener('input', () => { $('ghostLabel').textContent = `${ghostAlpha.value}%`; drawGhost(); });
mirrorBox.addEventListener('change', applyMirror);
$('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

loopStyleSel.addEventListener('change', async () => {
  settings = await writeSettings({ loopStyle: loopStyleSel.value as LoopStyle });
  if (settings.activeClipId) await updateClip(settings.activeClipId, { loopStyle: settings.loopStyle });
  await refreshClips();
});

// ------------------------------------------------------------------ camera

async function startCamera(deviceId?: string): Promise<void> {
  stream?.getTracks().forEach((t) => t.stop());
  detector = new CleanFrameDetector();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    setStatus(`Camera unavailable: ${String(err)}`, 'bad');
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  await listCameras();
  startClock();
}

async function listCameras(): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const current = stream?.getVideoTracks()[0]?.getSettings().deviceId;
  cameraSel.innerHTML = '';
  for (const device of devices.filter((d) => d.kind === 'videoinput')) {
    cameraSel.append(new Option(device.label || 'Camera', device.deviceId, false, device.deviceId === current));
  }
}

cameraSel.addEventListener('change', () => void startCamera(cameraSel.value));

// ------------------------------------------------------------------- clock

function startClock(): void {
  const rvfc = (video as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
  }).requestVideoFrameCallback;
  if (!rvfc) {
    setInterval(onFrame, 1000 / TARGET_FPS);
    return;
  }
  const step = () => { onFrame(); rvfc.call(video, step); };
  rvfc.call(video, step);
}

let sampleCount = 0;

function onFrame(): void {
  if (video.readyState < 2 || !video.videoWidth) return;
  if (++sampleCount % 3 === 0) detector.sample(video);

  if (recorder && !recorder.stopped) {
    const now = performance.now();
    if (now >= recorder.endsAt) stopRecording();
    else captureFrame(recorder);
    badge.textContent =
      `REC ${((now - recorder.startedAt) / 1000).toFixed(1)}s · ${recorder.frames.length}f · ${formatSize(recorder.bytes)}`;
  } else if (!recorder) {
    badge.textContent = detector.isClean ? 'Ready' : 'Settling…';
    badge.className = 'badge';
  }
}

// ---------------------------------------------------------------- recording

const MAX_PENDING = 6;
/** Past this, say something — the frames are in memory until recording stops. */
const SIZE_WARN_BYTES = 750 * 1024 * 1024;
let warnedAboutSize = false;

function formatSize(bytes: number): string {
  return bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function captureFrame(job: Recorder): void {
  if (job.pending >= MAX_PENDING) return; // backpressure: skip rather than queue
  const index = job.frames.length;
  job.frames.push(null);
  job.pending++;
  createImageBitmap(video)
    .then((bitmap) => {
      worker.postMessage({ index, bitmap, width: job.width, height: job.height }, [bitmap]);
    })
    .catch(() => { job.pending--; });
}

worker.onmessage = (event: MessageEvent<{ index: number; buffer?: ArrayBuffer; error?: string }>) => {
  const job = recorder;
  if (!job) return;
  job.pending--;
  if (event.data.buffer) {
    job.frames[event.data.index] = event.data.buffer;
    job.bytes += event.data.buffer.byteLength;
    // Long recordings are allowed, but the frames live in memory until you stop.
    if (job.bytes > SIZE_WARN_BYTES && !warnedAboutSize) {
      warnedAboutSize = true;
      setStatus(`This clip is past ${formatSize(SIZE_WARN_BYTES)} and is held in memory until you stop.`, 'warn');
    }
  }
  if (job.stopped && job.pending === 0) void finishRecording();
};

recordBtn.addEventListener('click', () => {
  if (recorder) return;
  if (!video.videoWidth) return setStatus('Camera is not ready yet.', 'warn');
  if (settings.cleanFrameGuard && !detector.isClean) {
    return setStatus('Waiting for a clean picture — give the camera a second to settle.', 'warn');
  }

  const scale = Math.min(1, MAX_CLIP_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const now = performance.now();
  warnedAboutSize = false;
  recorder = {
    frames: [],
    pending: 0,
    startedAt: now,
    endsAt: autoStopBox.checked ? now + Number(durationInput.value) * 1000 : Infinity,
    bytes: 0,
    width: Math.round(video.videoWidth * scale),
    height: Math.round(video.videoHeight * scale),
    stopped: false,
  };
  badge.className = 'badge rec';
  recordBtn.disabled = true;
  stopBtn.disabled = false;
});

stopBtn.addEventListener('click', stopRecording);

function stopRecording(): void {
  if (!recorder || recorder.stopped) return;
  recorder.stopped = true;
  stopBtn.disabled = true;
  badge.textContent = 'Encoding…';
  if (recorder.pending === 0) void finishRecording();
}

async function finishRecording(): Promise<void> {
  const job = recorder;
  if (!job) return;
  recorder = null;
  recordBtn.disabled = false;
  badge.className = 'badge';

  const frames = job.frames.filter((f): f is ArrayBuffer => f !== null);
  if (frames.length < 4) return setStatus('That recording was too short to loop.', 'warn');

  const seconds = Math.max(0.2, (performance.now() - job.startedAt) / 1000);
  const fps = Math.max(5, Math.min(TARGET_FPS, Math.round(frames.length / seconds)));
  const id = newClipId();
  const clip: ClipRecord = {
    id,
    name: `Clip ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    frameCount: frames.length,
    fps,
    width: job.width,
    height: job.height,
    pinned: false,
    loopStyle: settings.loopStyle,
    createdAt: Date.now(),
    thumbnail: await makeThumbnail(frames[0]),
    frames,
  };
  await putClip(clip);
  settings = await writeSettings({ activeClipId: id });
  await refreshClips();
  setStatus(
    `Saved “${clip.name}” — ${frames.length} frames, ${(frames.length / fps).toFixed(1)}s at ${fps} fps, ${formatSize(job.bytes)}.`,
  );
}

async function makeThumbnail(buf: ArrayBuffer): Promise<string> {
  const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/webp' }));
  const w = 192;
  const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL('image/webp', 0.7);
}

// -------------------------------------------------------------- ghost frame

async function loadGhost(): Promise<void> {
  ghostBitmap?.close();
  ghostBitmap = null;
  const id = settings.activeClipId;
  if (id) {
    const clip = await getClip(id);
    if (clip?.frames.length) {
      ghostBitmap = await createImageBitmap(new Blob([clip.frames[0]], { type: 'image/webp' }));
    }
  }
  drawGhost();
}

function drawGhost(): void {
  const ctx = ghost.getContext('2d');
  if (!ctx) return;
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  if (ghost.width !== w || ghost.height !== h) { ghost.width = w; ghost.height = h; }
  ctx.clearRect(0, 0, w, h);
  if (!ghostBitmap) return;
  ctx.globalAlpha = Number(ghostAlpha.value) / 100;
  ctx.drawImage(ghostBitmap, 0, 0, w, h);
  ctx.globalAlpha = 1;
}

// -------------------------------------------------------------- clip library

async function refreshClips(): Promise<void> {
  clips = await listClips();
  renderClips();
  await loadGhost();
  syncTrim();
}

function renderClips(): void {
  clipsBox.innerHTML = '';
  if (!clips.length) {
    clipsBox.innerHTML = '<div class="empty">No clips yet. Line yourself up and hit Record.</div>';
    return;
  }

  for (const clip of clips) {
    const active = clip.id === settings.activeClipId;
    const row = document.createElement('div');
    row.className = `clip${active ? ' active' : ''}`;
    row.innerHTML = `
      <img alt="">
      <div class="meta">
        <input class="name" value="">
        <div class="sub"></div>
        <div class="acts">
          <button data-act="use">${active ? 'In use' : 'Use'}</button>
          <button data-act="pin">${clip.pinned ? 'Unpin' : 'Pin'}</button>
          <button data-act="export">Export</button>
          <button data-act="delete" class="bad">Delete</button>
        </div>
      </div>`;

    const img = row.querySelector('img') as HTMLImageElement;
    img.src = clip.thumbnail;
    const name = row.querySelector('.name') as HTMLInputElement;
    name.value = clip.name;
    (row.querySelector('.sub') as HTMLElement).textContent =
      `${(clip.frameCount / Math.max(1, clip.fps)).toFixed(1)}s · ${clip.frameCount} frames · ${clip.width}×${clip.height} · ${clip.loopStyle}`;

    name.addEventListener('change', async () => {
      await updateClip(clip.id, { name: name.value.trim() || clip.name });
      await refreshClips();
    });
    (row.querySelector('.acts') as HTMLElement).addEventListener('click', (event) => {
      const act = (event.target as HTMLElement).dataset.act;
      if (act) void clipAction(act, clip);
    });
    clipsBox.appendChild(row);
  }
}

async function clipAction(act: string, clip: ClipMeta): Promise<void> {
  switch (act) {
    case 'use':
      settings = await writeSettings({ activeClipId: clip.id, loopStyle: clip.loopStyle });
      loopStyleSel.value = clip.loopStyle;
      await refreshClips();
      return;
    case 'pin':
      await updateClip(clip.id, { pinned: !clip.pinned });
      await refreshClips();
      return;
    case 'delete':
      if (!confirm(`Delete “${clip.name}”?`)) return;
      await deleteClip(clip.id);
      if (settings.activeClipId === clip.id) settings = await writeSettings({ activeClipId: null });
      await refreshClips();
      return;
    case 'export':
      await exportClip(clip.id);
      return;
  }
}

// ------------------------------------------------------------ import/export

async function exportClip(id: string): Promise<void> {
  const clip = await getClip(id);
  if (!clip) return;
  const { frames, ...meta } = clip;
  const payload = JSON.stringify({ camboi: 1, meta, frames: frames.map(bufferToBase64) });
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${clip.name.replace(/[^\w\-]+/g, '_')}.camboiclip`;
  a.click();
  URL.revokeObjectURL(url);
}

$('import').addEventListener('click', () => $<HTMLInputElement>('importFile').click());
$('importFile').addEventListener('change', async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed?.camboi !== 1 || !Array.isArray(parsed.frames)) throw new Error('not a CamBoi clip');
    const frames = (parsed.frames as string[]).map(base64ToBuffer);
    const id = newClipId();
    await putClip({ ...parsed.meta, id, frames, frameCount: frames.length, createdAt: Date.now() });
    await refreshClips();
    setStatus(`Imported “${parsed.meta.name}”.`);
  } catch (err) {
    setStatus(`Import failed: ${String(err)}`, 'bad');
  } finally {
    (event.target as HTMLInputElement).value = '';
  }
});

// ---------------------------------------------------------------------- trim

function syncTrim(): void {
  const clip = clips.find((c) => c.id === settings.activeClipId);
  trimRow.className = clip ? 'trim show' : 'trim';
  if (!clip) return;
  trimStart.max = String(clip.frameCount - 1);
  trimEnd.max = String(clip.frameCount - 1);
  trimStart.value = '0';
  trimEnd.value = String(clip.frameCount - 1);
  updateTrimLabel();
}

function updateTrimLabel(): void {
  const clip = clips.find((c) => c.id === settings.activeClipId);
  if (!clip) return;
  if (Number(trimStart.value) >= Number(trimEnd.value)) trimStart.value = String(Number(trimEnd.value) - 1);
  const count = Number(trimEnd.value) - Number(trimStart.value) + 1;
  $('trimLabel').textContent = `${count} f · ${(count / clip.fps).toFixed(1)}s`;
}

trimStart.addEventListener('input', updateTrimLabel);
trimEnd.addEventListener('input', updateTrimLabel);

$('trimApply').addEventListener('click', async () => {
  const id = settings.activeClipId;
  if (!id) return;
  const clip = await getClip(id);
  if (!clip) return;
  const from = Number(trimStart.value);
  const to = Number(trimEnd.value);
  if (to - from < 3) return setStatus('Keep at least four frames.', 'warn');

  const frames = clip.frames.slice(from, to + 1);
  await putClip({ ...clip, frames, frameCount: frames.length, thumbnail: await makeThumbnail(frames[0]) });
  await refreshClips();
  setStatus(`Trimmed to ${frames.length} frames.`);
});

// ----------------------------------------------------------------- bootstrap

async function init(): Promise<void> {
  settings = await readSettings();
  loopStyleSel.value = settings.loopStyle;
  autoStopBox.checked = settings.maxClipMs > 0;
  durationInput.disabled = !autoStopBox.checked;
  if (settings.maxClipMs > 0) durationInput.value = String(Math.round(settings.maxClipMs / 1000));
  applyMirror();
  await refreshClips();
  await startCamera();
  setInterval(drawGhost, 500);
}

void init();
