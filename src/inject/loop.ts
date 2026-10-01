import { DECODE_LOOKAHEAD } from '../shared/constants';
import type { ClipMeta, LoopStyle } from '../shared/types';

/**
 * Clips are stored as one WebP still per frame rather than a video file. That
 * costs a little disk but buys three things that matter here: exact random
 * access (so ping-pong is just walking the index backwards, with no reverse
 * re-encode), no blob: URLs (so a page's CSP can never block playback), and
 * instant seeking for the alignment ghost.
 */
export class LoopPlayer {
  readonly meta: ClipMeta;
  private readonly frames: ArrayBuffer[];
  private readonly cache = new Map<number, ImageBitmap>();
  private readonly pending = new Set<number>();
  private style: LoopStyle;
  private readonly fade: number;

  /** Frames kept decoded regardless of the playhead, so any can start instantly. */
  private readonly pinned = new Set<number>();
  private pos = 0;
  private dir: 1 | -1 = 1;
  private accMs = 0;
  private holdFrames = 0;
  private nextHiccupMs = 1200;

  constructor(meta: ClipMeta, frames: ArrayBuffer[], style: LoopStyle) {
    this.meta = meta;
    this.frames = frames;
    this.style = style;
    this.fade = Math.min(10, Math.max(2, Math.floor(frames.length / 6)));
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Frames in one pass, before wrapping. Crossfade reserves a tail to blend into. */
  private get span(): number {
    return this.style === 'crossfade' ? Math.max(1, this.frames.length - this.fade) : this.frames.length;
  }

  setStyle(style: LoopStyle): void {
    if (style === this.style) return;
    this.style = style;
    this.pos = 0;
    this.dir = 1;
    this.accMs = 0;
  }

  /** Decode enough frames around the playhead that the first one is never blank. */
  async prime(): Promise<void> {
    const tasks = [];
    for (let k = 0; k <= Math.min(DECODE_LOOKAHEAD, this.frames.length - 1); k++) {
      tasks.push(this.decode(this.indexAhead(k)));
    }
    await Promise.all(tasks);
  }

  /**
   * Decode `count` frames spread across the whole clip and keep them resident,
   * so a takeover can begin at any of them with no decode latency. Used when a
   * site opens the camera for a moment and we have to be looping already.
   */
  async primeSpread(count: number): Promise<void> {
    const n = this.frames.length;
    const step = Math.max(1, Math.floor(n / count));
    for (let i = 0; i < n && this.pinned.size < count; i += step) this.pinned.add(i);
    await Promise.all([...this.pinned].map((i) => this.decode(i)));
  }

  /** Positions that are decoded and ready to display right now. */
  get anchors(): number[] {
    return [...this.pinned].filter((i) => this.cache.has(i));
  }

  /** True when the current playhead can be painted without waiting on a decode. */
  get isReady(): boolean {
    return this.cache.has(this.pos);
  }

  /** Jump the playhead, picking a direction at random where that makes sense. */
  startAt(index: number): void {
    const limit = this.span - 1;
    this.pos = Math.max(0, Math.min(limit, index));
    this.dir = this.style !== 'crossfade' && this.pos > 0 && Math.random() < 0.5 ? -1 : 1;
    this.accMs = 0;
  }

  /** Steps the playhead by elapsed wall time, honouring the clip's own fps. */
  advance(dtMs: number): void {
    const step = 1000 / Math.max(1, this.meta.fps);
    this.accMs += dtMs;

    // A throttled tab can hand us a huge delta; don't spin through the clip.
    let budget = 10;
    while (this.accMs >= step && budget-- > 0) {
      this.accMs -= step;
      this.stepOne(step);
    }
    if (this.accMs > step * 4) this.accMs = 0;

    this.schedule();
  }

  private stepOne(stepMs: number): void {
    if (this.style === 'lag') {
      this.nextHiccupMs -= stepMs;
      if (this.holdFrames > 0) {
        this.holdFrames--;
        return;
      }
      if (this.nextHiccupMs <= 0) {
        this.holdFrames = 2 + Math.floor(Math.random() * 4);
        this.nextHiccupMs = 900 + Math.random() * 2600;
        return;
      }
    }

    if (this.style === 'crossfade') {
      this.pos = (this.pos + 1) % this.span;
      return;
    }

    // Ping-pong (and 'lag', which rides on top of it): walk forward, then back.
    const last = this.frames.length - 1;
    if (last <= 0) return;
    this.pos += this.dir;
    if (this.pos >= last) {
      this.pos = last;
      this.dir = -1;
    } else if (this.pos <= 0) {
      this.pos = 0;
      this.dir = 1;
    }
  }

  /**
   * What to paint this tick. `blend` > 0 means draw `image`, then draw `next`
   * over it at that alpha.
   */
  frame(): { image: ImageBitmap | null; next: ImageBitmap | null; blend: number } {
    const image = this.cache.get(this.pos) ?? null;

    if (this.style === 'crossfade' && this.pos < this.fade) {
      const tailIdx = this.span + this.pos;
      const next = this.cache.get(tailIdx) ?? null;
      // At pos 0 we are mostly showing the tail; by pos `fade` it is all head.
      const blend = 1 - (this.pos + 1) / (this.fade + 1);
      return { image, next, blend };
    }

    return { image, next: null, blend: 0 };
  }

  /** The clip's first frame, for the alignment ghost. */
  firstFrame(): ImageBitmap | null {
    return this.cache.get(0) ?? null;
  }

  private indexAhead(k: number): number {
    if (this.frames.length <= 1) return 0;
    if (this.style === 'crossfade') return (this.pos + k) % this.span;

    let p = this.pos;
    let d = this.dir;
    const last = this.frames.length - 1;
    for (let i = 0; i < k; i++) {
      p += d;
      if (p >= last) { p = last; d = -1; }
      else if (p <= 0) { p = 0; d = 1; }
    }
    return p;
  }

  /** Keep a decoded window around the playhead; close everything outside it. */
  private schedule(): void {
    const wanted = new Set<number>();
    for (let k = 0; k <= DECODE_LOOKAHEAD; k++) wanted.add(this.indexAhead(k));
    if (this.style === 'crossfade') {
      for (let k = 0; k < this.fade; k++) wanted.add(this.span + k);
    }
    wanted.add(0); // the ghost frame
    for (const i of this.pinned) wanted.add(i);

    for (const idx of wanted) {
      if (!this.cache.has(idx) && !this.pending.has(idx)) void this.decode(idx);
    }
    for (const [idx, bitmap] of this.cache) {
      if (!wanted.has(idx)) {
        bitmap.close();
        this.cache.delete(idx);
      }
    }
  }

  private async decode(index: number): Promise<void> {
    const buf = this.frames[index];
    if (!buf || this.pending.has(index) || this.cache.has(index)) return;
    this.pending.add(index);
    try {
      const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/webp' }));
      if (this.cache.has(index)) bitmap.close();
      else this.cache.set(index, bitmap);
    } catch (err) {
      console.warn('[camboi] frame decode failed', index, err);
    } finally {
      this.pending.delete(index);
    }
  }

  dispose(): void {
    this.pinned.clear();
    for (const bitmap of this.cache.values()) bitmap.close();
    this.cache.clear();
    this.pending.clear();
  }
}
