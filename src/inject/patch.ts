import { isEnabledFor } from '../shared/settings';
import { controller } from './controller';
import { canIntercept, Pipeline } from './pipeline';

/** Make a replacement look like a built-in to casual `toString()` checks. */
function nativeize(fn: (...args: never[]) => unknown, name: string): void {
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  Object.defineProperty(fn, 'toString', {
    value: () => `function ${name}() { [native code] }`,
    configurable: true,
    writable: true,
  });
}

function enabled(): boolean {
  return isEnabledFor(controller.settings, location.hostname);
}

/**
 * Replaces the page's camera with ours before any of its own code runs.
 *
 * Every failure path falls back to handing over the untouched real stream —
 * breaking someone's call is far worse than not looping.
 */
export function installPatch(): void {
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) return;
  if (!canIntercept()) {
    console.warn('[camboi] MediaStreamTrackProcessor is unavailable; leaving the camera alone');
    return;
  }

  const realGetUserMedia = devices.getUserMedia.bind(devices);
  const realEnumerate = devices.enumerateDevices.bind(devices);

  const getUserMedia = async function (constraints?: MediaStreamConstraints): Promise<MediaStream> {
    const real = await realGetUserMedia(constraints);
    try {
      if (!constraints?.video || !enabled() || !real.getVideoTracks().length) return real;
      const pipeline = new Pipeline(controller, real);
      controller.register(pipeline);
      return pipeline.attach();
    } catch (err) {
      console.error('[camboi] interception failed, passing the camera through', err);
      return real;
    }
  };
  nativeize(getUserMedia, 'getUserMedia');

  const enumerateDevices = async function (): Promise<MediaDeviceInfo[]> {
    const list = await realEnumerate();
    const label = controller.settings.customCameraLabel;
    if (!label || !enabled()) return list;
    for (const device of list) {
      if (device.kind !== 'videoinput' || !device.label) continue;
      try {
        // Shadow the prototype getter on the instance, so identity survives.
        Object.defineProperty(device, 'label', { configurable: true, get: () => label });
      } catch {
        // Some builds lock this down; the real label is a cosmetic issue only.
      }
    }
    return list;
  };
  nativeize(enumerateDevices, 'enumerateDevices');

  const descriptor = { configurable: true, writable: true, enumerable: false };
  Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { ...descriptor, value: getUserMedia });
  Object.defineProperty(MediaDevices.prototype, 'enumerateDevices', { ...descriptor, value: enumerateDevices });

  // The pre-promise API some older embeds still reach for.
  const legacy = function (
    constraints: MediaStreamConstraints,
    onSuccess: (s: MediaStream) => void,
    onError: (e: unknown) => void,
  ): void {
    getUserMedia(constraints).then(onSuccess, onError);
  };
  nativeize(legacy, 'getUserMedia');
  Object.defineProperty(navigator, 'getUserMedia', { ...descriptor, value: legacy });
}
