/**
 * "Never start dark, never go live mid-adjust."
 *
 * The web has no equivalent of AVCaptureDevice.isAdjustingExposure, so this
 * samples a tiny downscale of the live feed and waits for brightness to be
 * both reasonable and settled before declaring the picture presentable.
 */

const GRID = 32;
const HISTORY = 16;

const MIN_MEAN = 0.1; // below this the lens is covered or the room is dark
const MAX_MEAN = 0.96; // blown out, usually mid auto-exposure hunt
const MIN_VARIANCE = 0.0012; // a flat field means no real image yet
const MAX_DRIFT = 0.035; // brightness still moving => still adjusting

export class CleanFrameDetector {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly means: number[] = [];
  private variance = 0;

  constructor() {
    this.canvas.width = GRID;
    this.canvas.height = GRID;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('camboi: 2d context unavailable');
    this.ctx = ctx;
  }

  sample(source: CanvasImageSource): void {
    try {
      this.ctx.drawImage(source, 0, 0, GRID, GRID);
    } catch {
      return; // source not ready yet
    }
    const { data } = this.ctx.getImageData(0, 0, GRID, GRID);

    let sum = 0;
    const lumas = new Float32Array(GRID * GRID);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      // Rec. 601 luma, cheap and good enough for a brightness gate.
      const l = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
      lumas[p] = l;
      sum += l;
    }
    const mean = sum / lumas.length;

    let sq = 0;
    for (const l of lumas) sq += (l - mean) ** 2;
    this.variance = sq / lumas.length;

    this.means.push(mean);
    if (this.means.length > HISTORY) this.means.shift();
  }

  /** True once the live feed is bright, detailed and no longer drifting. */
  get isClean(): boolean {
    if (this.means.length < 6) return false;
    const mean = this.means[this.means.length - 1];
    if (mean < MIN_MEAN || mean > MAX_MEAN) return false;
    if (this.variance < MIN_VARIANCE) return false;
    const earlier = this.means[Math.max(0, this.means.length - 6)];
    return Math.abs(mean - earlier) < MAX_DRIFT;
  }

  reset(): void {
    this.means.length = 0;
    this.variance = 0;
  }
}
