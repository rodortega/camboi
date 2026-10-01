import { isEnabledFor, readSettings, writeSettings } from '../shared/settings';
import type { ClipMeta, EffectId, PipelineStatus, Settings } from '../shared/types';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const STATE_LABEL: Record<PipelineStatus['state'], string> = {
  live: 'Live',
  loop: 'Looping',
  'transition-to-loop': 'Stepping away…',
  'transition-to-live': 'Going live…',
  frozen: 'Frozen',
};

let settings: Settings;
let tabId: number | undefined;
let hostname = '';

async function send(msg: unknown): Promise<void> {
  if (tabId === undefined) return;
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    $('note').textContent = 'CamBoi is not running on this page. Reload it and try again.';
  }
}

function renderStatus(status: PipelineStatus | null): void {
  const attached = !!status?.attached;
  const state = status?.state ?? 'live';
  const looping = state === 'loop' || state === 'transition-to-loop';

  $('dot').className = `dot ${!attached ? '' : state === 'frozen' ? 'frozen' : looping ? 'loop' : 'live'}`;
  $('state').textContent = attached ? STATE_LABEL[state] : 'No camera in use';
  $('res').textContent = attached && status ? `${status.width}×${status.height}` : '';

  const main = $<HTMLButtonElement>('main');
  main.textContent = looping ? 'Go live' : 'Step away';
  main.disabled = !attached;
  const freeze = $<HTMLButtonElement>('freeze');
  freeze.textContent = state === 'frozen' ? 'Unfreeze' : 'Freeze';
  freeze.disabled = !attached;
  $<HTMLButtonElement>('record').disabled = !attached;

  if (attached && status && !status.clipLoaded) {
    $('note').textContent = 'No clip selected — record one in the Studio.';
  } else if (attached && status && status.clockAgeMs > 700) {
    $('note').textContent = 'The frame clock is stalling on this page.';
  } else if (!attached) {
    $('note').textContent = 'Join a call, then come back here.';
  } else {
    $('note').textContent = '';
  }
}

function renderClips(clips: ClipMeta[]): void {
  const select = $<HTMLSelectElement>('clips');
  select.innerHTML = '';
  if (!clips.length) select.append(new Option('No clips yet', '', true, true));
  for (const clip of clips) {
    const seconds = (clip.frameCount / Math.max(1, clip.fps)).toFixed(1);
    select.append(
      new Option(`${clip.pinned ? '★ ' : ''}${clip.name} · ${seconds}s`, clip.id, false, clip.id === settings.activeClipId),
    );
  }
}

async function patch(next: Partial<Settings>): Promise<void> {
  settings = await writeSettings(next);
}

async function init(): Promise<void> {
  settings = await readSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  try {
    hostname = tab?.url ? new URL(tab.url).hostname : '';
  } catch {
    hostname = '';
  }
  $('host').textContent = hostname || 'this site';

  const clips = ((await chrome.runtime.sendMessage({ type: 'list-clips' })) as ClipMeta[]) ?? [];
  renderClips(clips);
  $<HTMLSelectElement>('effect').value = settings.effect;
  $<HTMLInputElement>('overlayVisible').checked = settings.overlayVisible;
  $<HTMLInputElement>('siteEnabled').checked = hostname ? isEnabledFor(settings, hostname) : false;

  renderStatus((await chrome.runtime.sendMessage({ type: 'get-tab-status', tabId })) as PipelineStatus | null);
  await send({ type: 'request-status' });
  setTimeout(async () => {
    renderStatus((await chrome.runtime.sendMessage({ type: 'get-tab-status', tabId })) as PipelineStatus | null);
  }, 350);
}

$('main').addEventListener('click', () => void send({ type: 'command', command: 'toggle-loop' }));
$('freeze').addEventListener('click', () => void send({ type: 'command', command: 'panic-freeze' }));
$('record').addEventListener('click', () => void send({ type: 'start-recording' }).then(() => window.close()));

$('clips').addEventListener('change', (e) => void patch({ activeClipId: (e.target as HTMLSelectElement).value || null }));
$('effect').addEventListener('change', (e) => void patch({ effect: (e.target as HTMLSelectElement).value as EffectId }));
$('overlayVisible').addEventListener('change', (e) =>
  void patch({ overlayVisible: (e.target as HTMLInputElement).checked }),
);

$('siteEnabled').addEventListener('change', async (e) => {
  if (!hostname) return;
  const on = (e.target as HTMLInputElement).checked;
  const marker = `!${hostname}`;
  let list = settings.enabledDomains.filter((d) => d !== hostname && d !== marker);
  if (settings.enableEverywhere && !on) list = [...list, marker];
  if (!settings.enableEverywhere && on) list = [...list, hostname];
  await patch({ enabledDomains: list });
  $('note').textContent = 'Takes effect the next time this page asks for the camera — reload or rejoin.';
});

$('studio').addEventListener('click', () => void chrome.runtime.sendMessage({ type: 'open-studio' }));
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('shortcuts').addEventListener('click', () => void chrome.runtime.sendMessage({ type: 'open-shortcuts' }));

void init();
