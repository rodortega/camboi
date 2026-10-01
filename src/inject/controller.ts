import type { ToPage } from '../shared/messages';
import { DEFAULT_SETTINGS, type ClipMeta, type EffectId, type Settings } from '../shared/types';
import { onFromExt, sendToExt } from './bridge';
import { LoopPlayer } from './loop';
import { Pipeline, type PipelineHost } from './pipeline';

const STATUS_INTERVAL_MS = 600;
/** Frames held decoded on standby, spread across the clip when starting randomly. */
const STANDBY_FRAMES = 8;
/** How long a call will wait, showing nothing, for a clip that is still loading. */
const LOOP_WAIT_MS = 5000;

/**
 * The MAIN-world singleton. Holds settings and the active clip, owns every
 * intercepted camera, and translates overlay/hotkey commands into pipeline
 * state changes.
 */
class Controller implements PipelineHost {
  settings: Settings = { ...DEFAULT_SETTINGS };
  private clip: { meta: ClipMeta; frames: ArrayBuffer[] } | null = null;
  private readonly pipelines = new Set<Pipeline>();
  /** A pre-decoded player, so a camera that opens for a moment is covered. */
  private standby: LoopPlayer | null = null;
  private standbyPending = false;
  private lastStart = -1;
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

    // Withhold output first, unconditionally. If the clip is on standby the
    // takeover below is synchronous and this never bites; if it is still
    // loading, or still decoding, the page waits rather than seeing the real
    // camera. Either way no live frame can escape.
    pipeline.holdForLoop(LOOP_WAIT_MS);

    if (this.clip) {
      void pipeline.stepAway(true);
      this.toast('Started on your loop — press Go live when you are ready');
    } else {
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

    const player =
      this.standby ?? new LoopPlayer(this.clip.meta, this.clip.frames, this.settings.loopStyle);
    this.standby = null;

    if (this.settings.randomStart) this.pickRandomStart(player);
    void this.prepareStandby();
    return player;
  }

  /**
   * Start somewhere new each time. Prefer the pre-decoded anchors so the first
   * painted frame needs no decode, and avoid repeating the previous start —
   * two identical snapshots in a row are the obvious tell.
   */
  private pickRandomStart(player: LoopPlayer): void {
    const pool = player.anchors.length ? player.anchors : [0];
    let pick = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && pick === this.lastStart) {
      pick = pool[(pool.indexOf(pick) + 1) % pool.length];
    }
    this.lastStart = pick;
    player.startAt(pick);
  }

  /**
   * Keep a decoded player in reserve whenever a takeover could happen without a
   * click. Some apps open the camera, grab a still and close it again inside a
   * few hundred milliseconds — there is no time to fetch and decode by then.
   */
  private async prepareStandby(): Promise<void> {
    const wanted = this.settings.autoStepAway || this.settings.randomStart;
    if (!wanted || !this.clip?.frames.length) {
      this.standby?.dispose();
      this.standby = null;
      return;
    }
    if (this.standby || this.standbyPending) return;

    this.standbyPending = true;
    try {
      const player = new LoopPlayer(this.clip.meta, this.clip.frames, this.settings.loopStyle);
      if (this.settings.randomStart) await player.primeSpread(STANDBY_FRAMES);
      else await player.prime();
      if (this.standby) player.dispose();
      else this.standby = player;
    } catch (err) {
      console.warn('[camboi] could not prepare a standby clip', err);
    } finally {
      this.standbyPending = false;
    }
  }

  private resetStandby(): void {
    this.standby?.dispose();
    this.standby = null;
    void this.prepareStandby();
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
          this.standby?.dispose();
          this.standby = null;
          sendToExt({ type: 'need-clip', clipId: msg.settings.activeClipId });
        } else if (previous.loopStyle !== msg.settings.loopStyle) {
          this.forEach((p) => p.refreshClip());
          this.resetStandby();
        } else if (
          previous.autoStepAway !== msg.settings.autoStepAway ||
          previous.randomStart !== msg.settings.randomStart
        ) {
          this.resetStandby();
        }
        return;
      }

      case 'clip-data':
        this.clip = { meta: msg.meta, frames: msg.frames };
        this.forEach((p) => p.refreshClip());
        void this.prepareStandby();
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
