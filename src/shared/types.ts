/** What the outgoing video track is showing right now. */
export type RouterState = 'live' | 'loop' | 'transition-to-loop' | 'transition-to-live' | 'frozen';

/** How a clip's frames are sequenced during playback. */
export type LoopStyle = 'pingpong' | 'crossfade' | 'lag';

/** Cosmetic distortions applied to whatever the router is showing. */
export type EffectId = 'none' | 'stutter' | 'catchup' | 'lowbitrate';

export interface ClipMeta {
  id: string;
  name: string;
  /** Number of stored frames. */
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  pinned: boolean;
  loopStyle: LoopStyle;
  createdAt: number;
  /** data: URL, small, used in pickers. */
  thumbnail: string;
}

/** A clip as stored: metadata plus one WebP-encoded still per frame. */
export interface ClipRecord extends ClipMeta {
  frames: ArrayBuffer[];
}

export interface Settings {
  /** When true the patch runs everywhere; otherwise only on `enabledDomains`. */
  enableEverywhere: boolean;
  enabledDomains: string[];
  activeClipId: string | null;
  loopStyle: LoopStyle;
  /** Crossfade duration for live<->loop switches, in ms. */
  transitionMs: number;
  /** Refuse to go live until the camera has settled on a presentable frame. */
  cleanFrameGuard: boolean;
  /** Start on the loop the moment a site opens the camera, rather than live. */
  autoStepAway: boolean;
  /** Begin each takeover at a different point in the clip. */
  randomStart: boolean;
  /** Overrides the camera label reported to the page. Empty = passthrough. */
  customCameraLabel: string;
  effect: EffectId;
  overlayVisible: boolean;
  showToasts: boolean;
  /** Hard cap on recording length, in ms. */
  maxClipMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  enableEverywhere: true,
  enabledDomains: [],
  activeClipId: null,
  loopStyle: 'pingpong',
  transitionMs: 260,
  cleanFrameGuard: true,
  autoStepAway: false,
  randomStart: false,
  customCameraLabel: '',
  effect: 'none',
  overlayVisible: true,
  showToasts: true,
  maxClipMs: 0,
};

/** Live status the page pushes up to the overlay/popup. */
export interface PipelineStatus {
  attached: boolean;
  state: RouterState;
  effect: EffectId;
  width: number;
  height: number;
  fps: number;
  clipId: string | null;
  clipLoaded: boolean;
  cleanFrame: boolean;
  recording: boolean;
  /** Milliseconds since the frame clock last ticked. */
  clockAgeMs: number;
}
