import type { ClipMeta, EffectId, PipelineStatus, Settings } from './types';

/** ISOLATED world -> MAIN world (the injected pipeline). */
export type ToPage =
  | { type: 'settings'; settings: Settings }
  | { type: 'clip-data'; meta: ClipMeta; frames: ArrayBuffer[] }
  | { type: 'clip-cleared' }
  | { type: 'command'; command: 'toggle-loop' | 'go-live' | 'step-away' | 'panic-freeze' }
  | { type: 'set-effect'; effect: EffectId }
  | { type: 'request-status' }
  /** durationMs 0 means record until an explicit stop-capture. */
  | { type: 'start-capture'; durationMs: number }
  | { type: 'stop-capture' };

/** MAIN world -> ISOLATED world. */
export type ToExt =
  | { type: 'ready' }
  | { type: 'status'; status: PipelineStatus }
  | { type: 'need-clip'; clipId: string | null }
  | { type: 'toast'; text: string; tone?: 'info' | 'warn' }
  | { type: 'capture-progress'; frames: number; durationMs: number; bytes: number }
  | { type: 'capture-done'; frames: ArrayBuffer[]; width: number; height: number; fps: number }
  | { type: 'capture-failed'; reason: string };

/** ISOLATED world <-> service worker. */
export type Runtime =
  | { type: 'get-settings' }
  | { type: 'set-settings'; patch: Partial<Settings> }
  | { type: 'list-clips' }
  | { type: 'get-clip'; id: string }
  | { type: 'save-clip'; meta: Omit<ClipMeta, 'id'> & { id?: string }; frames: ArrayBuffer[] }
  | { type: 'delete-clip'; id: string }
  | { type: 'update-clip'; id: string; patch: Partial<ClipMeta> }
  | { type: 'cycle-clip' }
  | { type: 'status-report'; status: PipelineStatus };
