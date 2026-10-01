import { FRAME_QUALITY, MAX_CLIP_EDGE, TARGET_FPS } from '../shared/constants';
import type { EffectId, PipelineStatus, RouterState, Settings } from '../shared/types';
import { CleanFrameDetector } from './cleanframe';
import { EffectChain } from './effects';
import { LoopPlayer } from './loop';

export interface PipelineHost {
  readonly settings: Settings;
  buildLoopPlayer(): LoopPlayer | null;
  toast(text: string, tone?: 'info' | 'warn'): void;
  onCaptureDone(frames: ArrayBuffer[], width: number, height: number, fps: number): void;
  onCaptureFailed(reason: string): void;
  onCaptureProgress(frames: number, durationMs: number, bytes: number): void;
}

/** Give up waiting for a clean frame after this long and go live anyway. */
const CLEAN_FRAME_TIMEOUT_MS = 4000;
/** Concurrent WebP encodes allowed while recording from the page. */
const ENCODE_IN_FLIGHT = 4;

interface CaptureJob {
  frames: (ArrayBuffer | null)[];
  inFlight: number;
  startedAt: number;
  /** Infinity when recording until an explicit stop. */
  endsAt: number;
  bytes: number;
  width: number;
  height: number;
  canvas: OffscreenCanvas;
  stopping: boolean;
}

/** Chrome-only, but so is this extension. Without it we do not intercept at all. */
export function canIntercept(): boolean {
  return typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor === 'function';
}

/**
 * Owns one intercepted camera: the reader pulling frames off the real track, the
 * output canvas whose captureStream the page actually receives, and the state
 * machine deciding which of the two the viewer sees.
 *
 * Frames come from MediaStreamTrackProcessor rather than a hidden <video>.
 * A video element only presents frames when Chrome thinks it is visible, so an
 * off-screen one silently stops delivering — the track reader has no such
 * heuristic, and it keeps running in a backgrounded tab, which is exactly when
 * someone has stepped away.
 */
export class Pipeline {
  private readonly host: PipelineHost;
  private readonly realStream: MediaStream;
  private readonly realTrack: MediaStreamTrack;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly outStream: MediaStream;
  private readonly outTrack: MediaStreamTrack;
  private readonly detector = new CleanFrameDetector();
  private readonly effects = new EffectChain();

  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private frame: VideoFrame | null = null;
  private loop: LoopPlayer | null = null;
  private state: RouterState = 'live';
  private stateBeforeFreeze: RouterState = 'live';
  private transitionStart = 0;
  private pendingLiveSince = 0;
  private capture: CaptureJob | null = null;
  private holdUntil = 0;

  private refs = 0;
  private disposed = false;
  private lastTick = 0;
  private sampleCounter = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(host: PipelineHost, realStream: MediaStream) {
    this.host = host;
    this.realStream = realStream;
    const track = realStream.getVideoTracks()[0];
    if (!track) throw new Error('camboi: stream has no video track');
    this.realTrack = track;

    const settings = track.getSettings();
    this.canvas = document.createElement('canvas');
    this.canvas.width = settings.width ?? 1280;
    this.canvas.height = settings.height ?? 720;
    const ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('camboi: 2d context unavailable');
    this.ctx = ctx;
    this.ctx.fillStyle = '#101014';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // captureStream(0) + requestFrame(): the canvas is deliberately not in the
    // document (nothing on the page should be able to see or restyle it), and
    // Chrome's automatic capture mode produces no frames for a detached canvas
    // because there is no compositor pass to drive it. Explicit frame requests
    // work regardless, and make our clock the only thing setting output rate.
    this.outStream = this.canvas.captureStream(0);
    this.outTrack = this.outStream.getVideoTracks()[0];

    this.realTrack.addEventListener('ended', () => this.dispose());
    void this.pump();

    this.watchdog = setInterval(() => {
      if (this.disposed || !this.lastTick) return;
      if (performance.now() - this.lastTick > 2000) {
        console.warn('[camboi] no camera frames for 2s');
      }
    }, 2000);
  }

  // ------------------------------------------------------------ attachment

  /** A stream for one getUserMedia caller: our video, their untouched audio. */
  attach(): MediaStream {
    this.refs++;
    const clone = this.outTrack.clone();
    this.shim(clone);
    return new MediaStream([clone, ...this.realStream.getAudioTracks()]);
  }

  private release(): void {
    if (--this.refs <= 0) this.dispose();
  }

  /**
   * Meeting apps read track metadata constantly to label devices and pick
   * encodings. Report the real camera's, not the canvas's.
   */
  private shim(clone: MediaStreamTrack): void {
    const real = this.realTrack;
    const host = this.host;
    const define = (prop: string, value: unknown) =>
      Object.defineProperty(clone, prop, { configurable: true, enumerable: false, value });

    Object.defineProperty(clone, 'label', {
      configurable: true,
      get: () => host.settings.customCameraLabel || real.label,
    });

    define('getSettings', function getSettings(): MediaTrackSettings {
      return { ...real.getSettings(), frameRate: TARGET_FPS };
    });
    define('getCapabilities', function getCapabilities(): MediaTrackCapabilities {
      return real.getCapabilities ? real.getCapabilities() : {};
    });
    define('getConstraints', function getConstraints(): MediaTrackConstraints {
      return real.getConstraints();
    });
    define('applyConstraints', function applyConstraints(c?: MediaTrackConstraints): Promise<void> {
      return real.applyConstraints(c);
    });

    const originalStop = clone.stop.bind(clone);
    define('stop', () => {
      originalStop();
      this.release();
    });
  }

  // ------------------------------------------------------------ frame clock

  /** Camera frame delivery is the clock: one render per frame off the track. */
  private async pump(): Promise<void> {
    const Processor = (globalThis as unknown as {
      MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => {
        readable: ReadableStream<VideoFrame>;
      };
    }).MediaStreamTrackProcessor;

    const processor = new Processor({ track: this.realTrack, maxBufferSize: 1 });
    this.reader = processor.readable.getReader();

    try {
      while (!this.disposed) {
        const { value, done } = await this.reader.read();
        if (done || !value) break;
        this.frame?.close();
        this.frame = value;
        try {
          this.tick(performance.now());
        } catch (err) {
          console.error('[camboi] render failed', err);
        }
      }
    } catch (err) {
      if (!this.disposed) console.error('[camboi] camera reader stopped', err);
    } finally {
      this.frame?.close();
      this.frame = null;
    }
  }

  // ---------------------------------------------------------------- render

  private tick(now: number): void {
    this.lastTick = now;
    this.syncSize();

    // Sampling every frame is wasted work; brightness does not move that fast.
    if (++this.sampleCounter % 3 === 0 && this.frame) this.detector.sample(this.frame);

    this.settleState(now);
    if (this.loop) this.loop.advance(1000 / TARGET_FPS);

    if (this.holdUntil) {
      if (this.state === 'loop' || this.state === 'transition-to-loop') this.holdUntil = 0;
      else if (now < this.holdUntil) return;
      else {
        this.holdUntil = 0;
        this.host.toast('Clip was not ready in time — you are live', 'warn');
      }
    }

    if (this.state !== 'frozen') {
      const w = this.canvas.width;
      const h = this.canvas.height;
      this.effects.render(this.ctx, w, h, (target) => this.paint(target), now);
    }

    this.pumpCapture(now);

    if (this.state !== 'frozen') this.emit();
  }

  /** Push exactly one frame to every consumer of our canvas track. */
  private emit(): void {
    const track = this.outTrack as MediaStreamTrack & { requestFrame?: () => void };
    track.requestFrame?.();
  }

  private syncSize(): void {
    const frame = this.frame;
    if (!frame) return;
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (!w || !h || (this.canvas.width === w && this.canvas.height === h)) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.effects.reset();
  }

  /** Advances transitions and resolves a pending clean-frame-gated go-live. */
  private settleState(now: number): void {
    const dur = Math.max(1, this.host.settings.transitionMs);

    if (this.pendingLiveSince) {
      const waited = now - this.pendingLiveSince;
      if (this.detector.isClean || waited > CLEAN_FRAME_TIMEOUT_MS) {
        if (waited > CLEAN_FRAME_TIMEOUT_MS) this.host.toast('Going live without a clean frame', 'warn');
        this.pendingLiveSince = 0;
        this.state = 'transition-to-live';
        this.transitionStart = now;
      }
      return;
    }

    if (this.state === 'transition-to-loop' && now - this.transitionStart >= dur) this.state = 'loop';
    else if (this.state === 'transition-to-live' && now - this.transitionStart >= dur) this.state = 'live';
  }

  private paint(target: CanvasRenderingContext2D): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const dur = Math.max(1, this.host.settings.transitionMs);
    const t = Math.min(1, (this.lastTick - this.transitionStart) / dur);

    switch (this.state) {
      case 'loop':
        this.paintLoop(target, w, h, 1);
        return;
      case 'transition-to-loop':
        this.paintLive(target, w, h);
        this.paintLoop(target, w, h, t);
        return;
      case 'transition-to-live':
        this.paintLoop(target, w, h, 1);
        target.save();
        target.globalAlpha = t;
        this.paintLive(target, w, h);
        target.restore();
        return;
      case 'live':
      default:
        this.paintLive(target, w, h);
    }
  }

  private paintLive(target: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.frame) target.drawImage(this.frame, 0, 0, w, h);
  }

  private paintLoop(target: CanvasRenderingContext2D, w: number, h: number, alpha: number): void {
    const loop = this.loop;
    if (!loop) return;
    const { image, next, blend } = loop.frame();
    if (!image) return;

    target.save();
    target.globalAlpha = alpha;
    target.drawImage(image, 0, 0, w, h);
    if (next && blend > 0) {
      target.globalAlpha = alpha * blend;
      target.drawImage(next, 0, 0, w, h);
    }
    target.restore();
  }

  // ------------------------------------------------------------ transitions

  /**
   * `immediate` cuts straight to the loop with no crossfade — used when a call
   * starts on the loop, where there is no live picture to fade away from.
   */
  async stepAway(immediate = false): Promise<void> {
    if (this.state === 'loop' || this.state === 'transition-to-loop') return;

    const player = this.host.buildLoopPlayer();
    if (!player) {
      if (!immediate) this.host.toast('No clip selected — record one in the Studio', 'warn');
      return;
    }
    this.loop?.dispose();
    this.loop = player;
    // A standby player is already decoded, so this stays synchronous and the
    // state flips before a single live frame can reach the page.
    if (!player.isReady) await player.prime();

    this.pendingLiveSince = 0;
    this.state = immediate ? 'loop' : 'transition-to-loop';
    this.transitionStart = performance.now();
  }

  /** True while nothing has pulled this pipeline off the live camera yet. */
  get isLive(): boolean {
    return this.state === 'live';
  }

  /**
   * Emit nothing at all until the loop is ready, for up to `ms`.
   *
   * Used when a call is meant to start on the loop but the clip is still being
   * fetched. Sending no frames stalls the page harmlessly — sending the live
   * camera would defeat the entire point. It expires so a slow or missing clip
   * can never leave a real call permanently dark.
   */
  holdForLoop(ms: number): void {
    this.holdUntil = performance.now() + ms;
  }

  goLive(): void {
    if (this.state === 'live' || this.state === 'transition-to-live') return;

    if (this.state === 'frozen') {
      this.state = this.stateBeforeFreeze;
      if (this.state === 'live') return;
    }

    if (this.host.settings.cleanFrameGuard && !this.detector.isClean) {
      this.pendingLiveSince = performance.now();
      this.host.toast('Waiting for a clean frame…');
      return;
    }
    this.state = 'transition-to-live';
    this.transitionStart = performance.now();
  }

  toggle(): void {
    if (this.state === 'live' || this.state === 'transition-to-live') void this.stepAway();
    else this.goLive();
  }

  /** Panic: hold whatever is on screen right now, instantly. */
  freeze(): void {
    if (this.state === 'frozen') {
      this.state = this.stateBeforeFreeze;
      return;
    }
    this.stateBeforeFreeze = this.state === 'transition-to-live' ? 'live' : this.state;
    this.state = 'frozen';
  }

  setEffect(effect: EffectId): void {
    this.effects.setEffect(effect);
  }

  /** Reload the loop player after the active clip or style changed. */
  refreshClip(): void {
    if (this.state === 'live' || !this.loop) return;
    const player = this.host.buildLoopPlayer();
    if (!player) return;
    this.loop.dispose();
    this.loop = player;
    void player.prime();
  }

  // ------------------------------------------------------------- recording

  startCapture(durationMs: number): void {
    if (this.capture) return;
    if (!this.frame) {
      this.host.onCaptureFailed('Camera is not ready yet');
      return;
    }
    if (this.host.settings.cleanFrameGuard && !this.detector.isClean) {
      this.host.onCaptureFailed('Waiting for a clean frame — try again in a second');
      return;
    }

    const fw = this.frame.displayWidth;
    const fh = this.frame.displayHeight;
    const scale = Math.min(1, MAX_CLIP_EDGE / Math.max(fw, fh));
    const width = Math.round(fw * scale);
    const height = Math.round(fh * scale);
    const now = performance.now();

    this.capture = {
      frames: [],
      inFlight: 0,
      startedAt: now,
      endsAt: durationMs > 0 ? now + durationMs : Infinity,
      bytes: 0,
      width,
      height,
      canvas: new OffscreenCanvas(width, height),
      stopping: false,
    };
  }

  stopCapture(): void {
    if (this.capture) this.capture.stopping = true;
  }

  /** Encodes the live feed to WebP stills as it records; no giant frame buffer. */
  private pumpCapture(now: number): void {
    const job = this.capture;
    if (!job) return;

    const finished = job.stopping || now >= job.endsAt;

    if (!finished && this.frame && job.inFlight < ENCODE_IN_FLIGHT) {
      const ctx = job.canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(this.frame, 0, 0, job.width, job.height);
        const index = job.frames.length;
        job.frames.push(null);
        job.inFlight++;
        job.canvas
          .convertToBlob({ type: 'image/webp', quality: FRAME_QUALITY })
          .then((blob) => blob.arrayBuffer())
          .then((buf) => { job.frames[index] = buf; job.bytes += buf.byteLength; })
          .catch((err) => console.warn('[camboi] frame encode failed', err))
          .finally(() => {
            job.inFlight--;
            if (job.stopping || performance.now() >= job.endsAt) this.finishCapture();
          });
      }
      this.host.onCaptureProgress(job.frames.length, now - job.startedAt, job.bytes);
      return;
    }

    if (finished && job.inFlight === 0) this.finishCapture();
  }

  private finishCapture(): void {
    const job = this.capture;
    if (!job || job.inFlight > 0) return;
    this.capture = null;

    const frames = job.frames.filter((f): f is ArrayBuffer => f !== null);
    if (frames.length < 4) {
      this.host.onCaptureFailed('Recording was too short');
      return;
    }
    const elapsedSec = Math.max(0.2, (performance.now() - job.startedAt) / 1000);
    const fps = Math.max(5, Math.min(TARGET_FPS, Math.round(frames.length / elapsedSec)));
    this.host.onCaptureDone(frames, job.width, job.height, fps);
  }

  // ---------------------------------------------------------------- status

  status(): PipelineStatus {
    return {
      attached: !this.disposed,
      state: this.state,
      effect: this.effects.current,
      width: this.canvas.width,
      height: this.canvas.height,
      fps: TARGET_FPS,
      clipId: this.loop?.meta.id ?? null,
      clipLoaded: !!this.loop,
      cleanFrame: this.detector.isClean,
      recording: this.capture !== null,
      clockAgeMs: this.lastTick ? Math.round(performance.now() - this.lastTick) : 0,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    void this.reader?.cancel().catch(() => {});
    this.reader = null;
    this.loop?.dispose();
    this.loop = null;
    for (const track of this.realStream.getTracks()) track.stop();
    this.outTrack.stop();
  }
}
