import { FRAME_QUALITY } from '../shared/constants';

/**
 * Encodes captured frames to WebP off the main thread, so the Studio preview
 * stays smooth while recording.
 */

interface EncodeRequest {
  index: number;
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

let canvas: OffscreenCanvas | null = null;

self.onmessage = async (event: MessageEvent<EncodeRequest>) => {
  const { index, bitmap, width, height } = event.data;
  try {
    if (!canvas || canvas.width !== width || canvas.height !== height) {
      canvas = new OffscreenCanvas(width, height);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context in worker');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: FRAME_QUALITY });
    const buffer = await blob.arrayBuffer();
    (self as unknown as Worker).postMessage({ index, buffer }, [buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ index, error: String(err) });
  } finally {
    bitmap.close();
  }
};
