import { readSettings, writeSettings } from '../shared/settings';
import type { LoopStyle, Settings } from '../shared/types';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let settings: Settings;
let savedTimer: ReturnType<typeof setTimeout> | null = null;

function flashSaved(): void {
  const el = $('saved');
  el.classList.add('on');
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('on'), 1200);
}

async function patch(next: Partial<Settings>): Promise<void> {
  settings = await writeSettings(next);
  flashSaved();
}

/**
 * One textarea serves both modes: a blocklist when CamBoi runs everywhere, an
 * allowlist when it does not. Blocked hosts are stored with a `!` prefix.
 */
function renderDomains(): void {
  const blocking = settings.enableEverywhere;
  $('domainsLabel').textContent = blocking ? 'Blocked sites' : 'Allowed sites';
  $('domainsDesc').textContent = blocking
    ? 'One hostname per line. CamBoi stays out of the way on these.'
    : 'One hostname per line. CamBoi only runs on these.';
  const list = settings.enabledDomains
    .filter((d) => d.startsWith('!') === blocking)
    .map((d) => (blocking ? d.slice(1) : d));
  $<HTMLTextAreaElement>('domains').value = list.join('\n');
}

function render(): void {
  $<HTMLSelectElement>('loopStyle').value = settings.loopStyle;
  $<HTMLInputElement>('transitionMs').value = String(settings.transitionMs);
  $('transitionVal').textContent = `${settings.transitionMs} ms`;
  $<HTMLInputElement>('cleanFrameGuard').checked = settings.cleanFrameGuard;
  $<HTMLInputElement>('maxClipMs').value = String(settings.maxClipMs);
  $('maxClipVal').textContent = `${(settings.maxClipMs / 1000).toFixed(0)} s`;
  $<HTMLInputElement>('overlayVisible').checked = settings.overlayVisible;
  $<HTMLInputElement>('showToasts').checked = settings.showToasts;
  $<HTMLInputElement>('customCameraLabel').value = settings.customCameraLabel;
  $<HTMLInputElement>('enableEverywhere').checked = settings.enableEverywhere;
  renderDomains();
}

$('loopStyle').addEventListener('change', (e) =>
  void patch({ loopStyle: (e.target as HTMLSelectElement).value as LoopStyle }),
);
$('transitionMs').addEventListener('input', (e) => {
  const ms = Number((e.target as HTMLInputElement).value);
  $('transitionVal').textContent = `${ms} ms`;
  void patch({ transitionMs: ms });
});
$('maxClipMs').addEventListener('input', (e) => {
  const ms = Number((e.target as HTMLInputElement).value);
  $('maxClipVal').textContent = `${(ms / 1000).toFixed(0)} s`;
  void patch({ maxClipMs: ms });
});
$('cleanFrameGuard').addEventListener('change', (e) =>
  void patch({ cleanFrameGuard: (e.target as HTMLInputElement).checked }),
);
$('overlayVisible').addEventListener('change', (e) =>
  void patch({ overlayVisible: (e.target as HTMLInputElement).checked }),
);
$('showToasts').addEventListener('change', (e) =>
  void patch({ showToasts: (e.target as HTMLInputElement).checked }),
);
$('customCameraLabel').addEventListener('change', (e) =>
  void patch({ customCameraLabel: (e.target as HTMLInputElement).value.trim() }),
);

$('enableEverywhere').addEventListener('change', async (e) => {
  await patch({ enableEverywhere: (e.target as HTMLInputElement).checked });
  renderDomains();
});

$('domains').addEventListener('change', async (e) => {
  const blocking = settings.enableEverywhere;
  const entered = (e.target as HTMLTextAreaElement).value
    .split('\n')
    .map((line) => line.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean)
    .map((host) => (blocking ? `!${host}` : host));
  // Preserve the other mode's list so toggling back does not lose it.
  const other = settings.enabledDomains.filter((d) => d.startsWith('!') !== blocking);
  await patch({ enabledDomains: [...new Set([...other, ...entered])] });
  renderDomains();
});

$('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

void readSettings().then((s) => {
  settings = s;
  render();
});
