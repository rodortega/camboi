import { installPatch } from './patch';

declare global {
  interface Window {
    __camboiInstalled?: boolean;
  }
}

if (window.__camboiInstalled) {
  console.debug('[camboi] already installed in this frame');
} else {
  window.__camboiInstalled = true;
  installPatch();
}
