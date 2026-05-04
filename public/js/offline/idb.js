const DB_NAME = 'mountain-offline';
const DB_VERSION = 1;
const STORE_AREAS = 'areas';
const STORE_OVERLAYS = 'overlays';
const STORE_TILE_REFS = 'tile_refs';

let dbPromise = null;

function openDB() {
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

function tx(db, storeNames, mode = 'readonly') {
  return db.transaction(storeNames, mode);
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllAreas() {
  const db = await openDB();
  return reqAsPromise(tx(db, STORE_AREAS).objectStore(STORE_AREAS).getAll());
}

export async function getArea(id) {
  const db = await openDB();
  return reqAsPromise(tx(db, STORE_AREAS).objectStore(STORE_AREAS).get(id));
}

export async function putArea(area) {
  const db = await openDB();
  return reqAsPromise(tx(db, STORE_AREAS, 'readwrite').objectStore(STORE_AREAS).put(area));
}

export async function deleteArea(id) {
  const db = await openDB();
  const t = tx(db, [STORE_AREAS, STORE_OVERLAYS], 'readwrite');
  await Promise.all([
    reqAsPromise(t.objectStore(STORE_AREAS).delete(id)),
    reqAsPromise(t.objectStore(STORE_OVERLAYS).delete(id)),
  ]);
}

export async function putOverlays(areaId, overlays) {
  const db = await openDB();
  return reqAsPromise(
    tx(db, STORE_OVERLAYS, 'readwrite').objectStore(STORE_OVERLAYS).put({ areaId, ...overlays })
  );
}

export async function getOverlays(areaId) {
  const db = await openDB();
  return reqAsPromise(tx(db, STORE_OVERLAYS).objectStore(STORE_OVERLAYS).get(areaId));
}

// Tile ref-counting — cheap protection against evicting tiles still used by another saved area.
export async function incrTileRefs(urls) {
  if (!urls.length) return;
  const db = await openDB();
  const t = tx(db, STORE_TILE_REFS, 'readwrite');
  const store = t.objectStore(STORE_TILE_REFS);
  for (const url of urls) {
    const existing = await reqAsPromise(store.get(url));
    const next = existing ? { url, count: existing.count + 1 } : { url, count: 1 };
    await reqAsPromise(store.put(next));
  }
}

export async function decrTileRefs(urls) {
  if (!urls.length) return [];
  const db = await openDB();
  const t = tx(db, STORE_TILE_REFS, 'readwrite');
  const store = t.objectStore(STORE_TILE_REFS);
  const evictable = [];
  for (const url of urls) {
    const existing = await reqAsPromise(store.get(url));
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
