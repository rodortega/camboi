import { STORAGE_KEY_SETTINGS } from './constants';
import { DEFAULT_SETTINGS, type Settings } from './types';

export async function readSettings(): Promise<Settings> {
  const bag = await chrome.storage.local.get(STORAGE_KEY_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(bag[STORAGE_KEY_SETTINGS] ?? {}) };
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await readSettings()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: next });
  return next;
}

export function onSettingsChanged(fn: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY_SETTINGS]) return;
    fn({ ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEY_SETTINGS].newValue ?? {}) });
  });
}

/** Whether the getUserMedia patch should be active for a given page. */
export function isEnabledFor(settings: Settings, hostname: string): boolean {
  if (settings.enableEverywhere) return !settings.enabledDomains.includes(`!${hostname}`);
  return settings.enabledDomains.includes(hostname);
}
