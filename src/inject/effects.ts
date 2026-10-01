import type { EffectId } from '../shared/types';

type DrawFn = (target: CanvasRenderingContext2D) => void;

/** How many frames of delay 'catchup' builds up before sprinting to real time. */
const CATCHUP_RING = 12;

/**
 * Cosmetic distortions layered on top of whatever the router is showing.
 * They exist to make a live<->loop switch look like an ordinary network
 * hiccup rather than a cut.
 */
export class EffectChain {
  private effect: EffectId = 'none';
  private scratch: HTMLCanvasElement | null = null;
  private ring: HTMLCanvasElement[] = [];
  private ringWrite = 0;
  private lag = 0;
  private catchingUp = false;
  private holdUntil = 0;
  private nextStutter = 0;

  setEffect(effect: EffectId): void {
    if (effect === this.effect) return;
    this.effect = effect;
    this.reset();
  }

  get current(): EffectId {
    return this.effect;
  }

  reset(): void {
    this.ring = [];
    this.ringWrite = 0;
    this.lag = 0;
    this.catchingUp = false;
    this.holdUntil = 0;
    this.nextStutter = 0;
  }

  /**
   * Renders one frame. `draw` paints the composed picture into whichever
   * context it is handed; the effect decides where that is and what happens
   * to it afterwards.
   */
  render(ctx: CanvasRenderingContext2D, w: number, h: number, draw: DrawFn, now: number): void {
    switch (this.effect) {
      case 'stutter':
        this.renderStutter(ctx, draw, now);
        return;
      case 'catchup':
        this.renderCatchup(ctx, w, h, draw);
        return;
      case 'lowbitrate':
        this.renderLowBitrate(ctx, w, h, draw);
        return;
      case 'none':
      default:
        draw(ctx);
    }
  }

  /** Irregular micro-freezes, the way a struggling uplink actually looks. */
  private renderStutter(ctx: CanvasRenderingContext2D, draw: DrawFn, now: number): void {
    if (now < this.holdUntil) return; // leave the previous frame on the canvas
    if (now >= this.nextStutter) {
      this.holdUntil = now + 80 + Math.random() * 220;
      this.nextStutter = this.holdUntil + 400 + Math.random() * 1400;
      return;
    }
    draw(ctx);
  }

  /** Falls behind real time, then sprints forward to close the gap. */
  private renderCatchup(ctx: CanvasRenderingContext2D, w: number, h: number, draw: DrawFn): void {
    if (this.ring.length !== CATCHUP_RING || this.ring[0].width !== w || this.ring[0].height !== h) {
      this.ring = Array.from({ length: CATCHUP_RING }, () => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      });
      this.ringWrite = 0;
      this.lag = 0;
    }

    const writeCanvas = this.ring[this.ringWrite];
    const writeCtx = writeCanvas.getContext('2d');
    if (writeCtx) draw(writeCtx);
    this.ringWrite = (this.ringWrite + 1) % CATCHUP_RING;

    if (this.catchingUp) {
      // Drain two frames per tick until we are back to live, then drift again.
      this.lag = Math.max(0, this.lag - 1);
      if (this.lag === 0) this.catchingUp = false;
    } else {
      if (this.lag < CATCHUP_RING - 2) this.lag += Math.random() < 0.25 ? 1 : 0;
      else this.catchingUp = true;
    }

    const readIdx = (this.ringWrite - 1 - this.lag + CATCHUP_RING * 2) % CATCHUP_RING;
    ctx.drawImage(this.ring[readIdx], 0, 0, w, h);
  }

  /** Blocky, desaturated, low-bitrate codec look. */
  private renderLowBitrate(ctx: CanvasRenderingContext2D, w: number, h: number, draw: DrawFn): void {
    const sw = Math.max(16, Math.round(w / 7));
    const sh = Math.max(9, Math.round(h / 7));
    if (!this.scratch) this.scratch = document.createElement('canvas');
    if (this.scratch.width !== sw || this.scratch.height !== sh) {
      this.scratch.width = sw;
      this.scratch.height = sh;
    }
    const sctx = this.scratch.getContext('2d');
    if (!sctx) return draw(ctx);

    sctx.save();
    sctx.scale(sw / w, sh / h);
    draw(sctx);
    sctx.restore();

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.filter = 'contrast(1.12) saturate(0.82)';
    ctx.drawImage(this.scratch, 0, 0, w, h);
    ctx.restore();
  }
}
