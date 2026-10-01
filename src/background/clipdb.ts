import { DB_NAME, DB_VERSION, STORE_CLIPS } from '../shared/constants';
import type { ClipMeta, ClipRecord } from '../shared/types';

/**
 * Clips live in the extension origin's IndexedDB, so the service worker and any
 * extension page (Studio, popup, options) read them directly. Content scripts
 * cannot — they go through the service worker.
 */

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CLIPS)) {
        const store = db.createObjectStore(STORE_CLIPS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => {
      req.result.onclose = () => { dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE_CLIPS, mode);
        const req = fn(t.objectStore(STORE_CLIPS));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export function newClipId(): string {
  return `clip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Metadata for every clip, newest first, with frame payloads stripped. */
export async function listClips(): Promise<ClipMeta[]> {
  const all = await tx<ClipRecord[]>('readonly', (s) => s.getAll() as IDBRequest<ClipRecord[]>);
  return all
    .map(({ frames: _frames, ...meta }) => meta)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt);
}

export async function getClip(id: string): Promise<ClipRecord | undefined> {
  return tx<ClipRecord | undefined>('readonly', (s) => s.get(id) as IDBRequest<ClipRecord | undefined>);
}

export async function putClip(clip: ClipRecord): Promise<ClipRecord> {
  await tx('readwrite', (s) => s.put(clip));
  return clip;
}

export async function deleteClip(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

export async function updateClip(id: string, patch: Partial<ClipMeta>): Promise<ClipMeta | undefined> {
  const existing = await getClip(id);
  if (!existing) return undefined;
  const next = { ...existing, ...patch, id };
  await putClip(next);
  const { frames: _frames, ...meta } = next;
  return meta;
}
