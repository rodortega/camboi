import type { ToPage } from '../shared/messages';
import { DEFAULT_SETTINGS, type ClipMeta, type EffectId, type Settings } from '../shared/types';
import { onFromExt, sendToExt } from './bridge';
import { LoopPlayer } from './loop';
import { Pipeline, type PipelineHost } from './pipeline';

const STATUS_INTERVAL_MS = 600;

/**
 * The MAIN-world singleton. Holds settings and the active clip, owns every
 * intercepted camera, and translates overlay/hotkey commands into pipeline
 * state changes.
 */
class Controller implements PipelineHost {
  settings: Settings = { ...DEFAULT_SETTINGS };
  private clip: { meta: ClipMeta; frames: ArrayBuffer[] } | null = null;
  private readonly pipelines = new Set<Pipeline>();
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private autoStepAwayPending = false;

  constructor() {
    onFromExt((msg) => this.handle(msg));
    sendToExt({ type: 'ready' });
  }

  // ------------------------------------------------------------- pipelines

  register(pipeline: Pipeline): void {
    this.pipelines.add(pipeline);
    pipeline.setEffect(this.settings.effect);
    this.ensureStatusTimer();

    if (!this.settings.autoStepAway) return;
    if (this.clip) {
      void pipeline.stepAway(true);
      this.toast('Started on your loop — press Go live when you are ready');
    } else {
      // The clip is still being streamed in; take over the moment it lands.
      this.autoStepAwayPending = true;
    }
  }

  private forEach(fn: (p: Pipeline) => void): void {
    for (const pipeline of [...this.pipelines]) {
      if (!pipeline.status().attached) {
        this.pipelines.delete(pipeline);
        continue;
      }
      try {
        fn(pipeline);
      } catch (err) {
        console.error('[camboi] pipeline command failed', err);
      }
    }
  }

  private get primary(): Pipeline | null {
    for (const pipeline of this.pipelines) if (pipeline.status().attached) return pipeline;
    return null;
  }

  // ---------------------------------------------------------- PipelineHost

  buildLoopPlayer(): LoopPlayer | null {
    if (!this.clip || !this.clip.frames.length) return null;
    return new LoopPlayer(this.clip.meta, this.clip.frames, this.settings.loopStyle);
  }

  toast(text: string, tone: 'info' | 'warn' = 'info'): void {
    if (!this.settings.showToasts) return;
    sendToExt({ type: 'toast', text, tone });
  }

  onCaptureDone(frames: ArrayBuffer[], width: number, height: number, fps: number): void {
    sendToExt({ type: 'capture-done', frames, width, height, fps }, frames);
  }

  onCaptureFailed(reason: string): void {
    sendToExt({ type: 'capture-failed', reason });
  }

  onCaptureProgress(frames: number, durationMs: number, bytes: number): void {
    sendToExt({ type: 'capture-progress', frames, durationMs, bytes });
  }

  // ---------------------------------------------------------------- inbound

  private handle(msg: ToPage): void {
    switch (msg.type) {
      case 'settings': {
        const previous = this.settings;
        this.settings = msg.settings;
        this.forEach((p) => p.setEffect(msg.settings.effect));
        if (!msg.settings.autoStepAway) this.autoStepAwayPending = false;
        if (previous.activeClipId !== msg.settings.activeClipId) {
          this.clip = null;
          sendToExt({ type: 'need-clip', clipId: msg.settings.activeClipId });
        } else if (previous.loopStyle !== msg.settings.loopStyle) {
          this.forEach((p) => p.refreshClip());
        }
        return;
      }

      case 'clip-data':
        this.clip = { meta: msg.meta, frames: msg.frames };
        this.forEach((p) => p.refreshClip());
        if (this.autoStepAwayPending) {
          this.autoStepAwayPending = false;
          let took = false;
          this.forEach((p) => { if (p.isLive) { void p.stepAway(true); took = true; } });
          if (took) this.toast('Started on your loop — press Go live when you are ready');
        }
        return;

      case 'clip-cleared':
        this.clip = null;
        return;

      case 'command':
        this.runCommand(msg.command);
        return;

      case 'set-effect':
        this.setEffect(msg.effect);
        return;

      case 'request-status':
        this.reportStatus();
        return;

      case 'start-capture': {
        const pipeline = this.primary;
        if (!pipeline) return this.onCaptureFailed('No camera is active on this page');
        pipeline.goLive();
        pipeline.startCapture(msg.durationMs);
        return;
      }

      case 'stop-capture':
        this.primary?.stopCapture();
        return;
    }
  }

  private runCommand(command: 'toggle-loop' | 'go-live' | 'step-away' | 'panic-freeze'): void {
    if (!this.pipelines.size) {
      this.toast('No camera in use on this page', 'warn');
      return;
    }
    switch (command) {
      case 'toggle-loop':
        this.forEach((p) => p.toggle());
        break;
      case 'step-away':
        this.forEach((p) => void p.stepAway());
        break;
      case 'go-live':
        this.forEach((p) => p.goLive());
        break;
      case 'panic-freeze':
        this.forEach((p) => p.freeze());
        break;
    }
    this.reportStatus();
  }

  private setEffect(effect: EffectId): void {
    this.settings = { ...this.settings, effect };
    this.forEach((p) => p.setEffect(effect));
    this.reportStatus();
  }

  // ----------------------------------------------------------------- status

  private ensureStatusTimer(): void {
    if (this.statusTimer) return;
    this.statusTimer = setInterval(() => this.reportStatus(), STATUS_INTERVAL_MS);
  }

  private reportStatus(): void {
    const pipeline = this.primary;
    if (!pipeline) {
      sendToExt({
        type: 'status',
        status: {
          attached: false,
          state: 'live',
          effect: this.settings.effect,
          width: 0,
          height: 0,
          fps: 0,
          clipId: this.settings.activeClipId,
          clipLoaded: !!this.clip,
          cleanFrame: false,
          recording: false,
          clockAgeMs: 0,
        },
      });
      return;
    }
    sendToExt({ type: 'status', status: { ...pipeline.status(), clipLoaded: !!this.clip } });
  }
}

export const controller = new Controller();
