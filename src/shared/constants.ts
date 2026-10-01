/** Marker on every window.postMessage we send, so we ignore everyone else's. */
export const WIRE = '__camboi__';

export const STORAGE_KEY_SETTINGS = 'settings';

export const DB_NAME = 'camboi';
export const DB_VERSION = 1;
export const STORE_CLIPS = 'clips';

/** Target frame rate for the outgoing canvas track. */
export const TARGET_FPS = 30;

/** Frames decoded ahead of the playhead during loop playback. */
export const DECODE_LOOKAHEAD = 8;

/** Quality for the per-frame WebP stills clips are stored as. */
export const FRAME_QUALITY = 0.82;

/** Longest edge a stored clip frame is downscaled to. */
export const MAX_CLIP_EDGE = 1280;

export const COMMANDS = {
  toggleLoop: 'toggle-loop',
  goLive: 'go-live',
  panicFreeze: 'panic-freeze',
  nextClip: 'next-clip',
} as const;
