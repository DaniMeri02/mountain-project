export interface OfflineArea {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  basemap: string;
  tileUrls: string[];
  createdAt: string;
  sizeBytes: number;
  tileCount: number;
}

export interface OfflineOverlays {
  areaId: string;
  trails?: unknown;
  pois?: unknown;
  ferrata?: unknown;
}

interface TileRef {
  url: string;
  count: number;
}

const DB_NAME = 'mountain-offline';
const DB_VERSION = 1;
const STORE_AREAS = 'areas';
const STORE_OVERLAYS = 'overlays';
const STORE_TILE_REFS = 'tile_refs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_AREAS)) {
        db.createObjectStore(STORE_AREAS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_OVERLAYS)) {
        db.createObjectStore(STORE_OVERLAYS, { keyPath: 'areaId' });
      }
      if (!db.objectStoreNames.contains(STORE_TILE_REFS)) {
        db.createObjectStore(STORE_TILE_REFS, { keyPath: 'url' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db: IDBDatabase, storeNames: string | string[], mode: IDBTransactionMode = 'readonly'): IDBTransaction {
  return db.transaction(storeNames, mode);
}

function reqAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllAreas(): Promise<OfflineArea[]> {
  const db = await openDB();
  return reqAsPromise(tx(db, STORE_AREAS).objectStore(STORE_AREAS).getAll());
}

export async function getArea(id: string): Promise<OfflineArea | undefined> {
  const db = await openDB();
  return reqAsPromise(tx(db, STORE_AREAS).objectStore(STORE_AREAS).get(id));
}

export async function putArea(area: OfflineArea): Promise<IDBValidKey> {
  const db = await openDB();
  return reqAsPromise(tx(db, STORE_AREAS, 'readwrite').objectStore(STORE_AREAS).put(area));
}

export async function deleteArea(id: string): Promise<void> {
  const db = await openDB();
  const t = tx(db, [STORE_AREAS, STORE_OVERLAYS], 'readwrite');
  await Promise.all([
    reqAsPromise(t.objectStore(STORE_AREAS).delete(id)),
    reqAsPromise(t.objectStore(STORE_OVERLAYS).delete(id)),
  ]);
}

export async function putOverlays(areaId: string, overlays: Omit<OfflineOverlays, 'areaId'>): Promise<IDBValidKey> {
  const db = await openDB();
  return reqAsPromise(
    tx(db, STORE_OVERLAYS, 'readwrite').objectStore(STORE_OVERLAYS).put({ areaId, ...overlays })
  );
}

export async function getOverlays(areaId: string): Promise<OfflineOverlays | undefined> {
  const db = await openDB();
  return reqAsPromise(tx(db, STORE_OVERLAYS).objectStore(STORE_OVERLAYS).get(areaId));
}

export async function incrTileRefs(urls: string[]): Promise<void> {
  if (!urls.length) return;
  const db = await openDB();
  const t = tx(db, STORE_TILE_REFS, 'readwrite');
  const store = t.objectStore(STORE_TILE_REFS);
  for (const url of urls) {
    const existing = await reqAsPromise<TileRef | undefined>(store.get(url));
    const next: TileRef = existing ? { url, count: existing.count + 1 } : { url, count: 1 };
    await reqAsPromise(store.put(next));
  }
}

export async function decrTileRefs(urls: string[]): Promise<string[]> {
  if (!urls.length) return [];
  const db = await openDB();
  const t = tx(db, STORE_TILE_REFS, 'readwrite');
  const store = t.objectStore(STORE_TILE_REFS);
  const evictable: string[] = [];
  for (const url of urls) {
    const existing = await reqAsPromise<TileRef | undefined>(store.get(url));
    if (!existing) continue;
    if (existing.count <= 1) {
      await reqAsPromise(store.delete(url));
      evictable.push(url);
    } else {
      await reqAsPromise(store.put({ url, count: existing.count - 1 }));
    }
  }
  return evictable;
}
