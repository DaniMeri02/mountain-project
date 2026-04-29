// Offline area downloader + saved-area registry.
// Self-contained module: IndexedDB layer, draw mode, downloader, list UI, open-offline flow.

import { buildTopoStyle, buildOsmStyle, setBasemapMode, getBasemapMode, addMapLayers, applyOverlayVisibility, removeTransientClickMarker } from './map.js';
import { tilesInBboxAtZoom, tileCountForRange, enumerateTiles } from './tile-math.js';
export { tilesInBboxAtZoom, tileCountForRange, enumerateTiles };

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

// ── Tile prefetch ────────────────────────────────────────────────────────────

const OPENTOPO_SUBDOMAINS = ['a', 'b', 'c'];

function opentopoUrl(z, x, y, idx) {
  const sub = OPENTOPO_SUBDOMAINS[idx % OPENTOPO_SUBDOMAINS.length];
  return `https://${sub}.tile.opentopomap.org/${z}/${x}/${y}.png`;
}

// Throttled fetch queue. concurrency = max in-flight, minIntervalMs = floor between dispatches.
async function throttledFetchAll(urls, concurrency, minIntervalMs, onProgress) {
  let cursor = 0;
  let done = 0;
  let lastDispatch = 0;
  const failures = [];

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= urls.length) return;

      const wait = Math.max(0, lastDispatch + minIntervalMs - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastDispatch = Date.now();

      const url = urls[idx];
      try {
        const res = await fetch(url, { mode: 'cors', referrerPolicy: 'origin' });
        if (!res.ok && res.status !== 0) failures.push({ url, status: res.status });
      } catch (err) {
        failures.push({ url, error: err && err.message ? err.message : String(err) });
      }
      done++;
      if (onProgress) onProgress(done, urls.length);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return { failures };
}

function buildOpentopoUrls(bbox, zMin, zMax) {
  const urls = [];
  let i = 0;
  for (const { z, x, y } of enumerateTiles(bbox, zMin, zMax)) {
    urls.push(opentopoUrl(z, x, y, i++));
  }
  return urls;
}

const OSM_SUBDOMAINS = ['a', 'b', 'c'];

function osmUrl(z, x, y, idx) {
  const sub = OSM_SUBDOMAINS[idx % OSM_SUBDOMAINS.length];
  return `https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

function buildOsmUrls(bbox, zMin, zMax) {
  const urls = [];
  let i = 0;
  for (const { z, x, y } of enumerateTiles(bbox, zMin, zMax)) {
    urls.push(osmUrl(z, x, y, i++));
  }
  return urls;
}

// ── Mapbox style cache (Path B) ──────────────────────────────────────────────

const MAPBOX_STYLE = 'mapbox/outdoors-v12';
const GLYPH_RANGES = [
  [0, 255],
  // Mapbox glyph PBFs are stored in 256-unit ranges. Keep Latin only by default.
];

function withToken(url) {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'access_token=' + mapboxgl.accessToken;
}

function httpsify(url) {
  return url.replace(/^http:\/\//, 'https://');
}

function fillTileTemplate(template, z, x, y) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

function uniqueFontstacks(styleJson) {
  const stacks = new Set();
  for (const layer of styleJson.layers || []) {
    const stack = layer.layout && layer.layout['text-font'];
    if (Array.isArray(stack)) {
      stacks.add(stack.join(','));
    }
  }
  return Array.from(stacks);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return res.json();
}

// Resolve a `mapbox://fonts/{user}/{fontstack}/{range}.pbf` template into HTTPS form,
// preserving the {user} segment from the style (avoids dropping the username prefix).
function glyphsTemplateToHttps(glyphsUrl) {
  if (!glyphsUrl) return null;
  if (glyphsUrl.startsWith('mapbox://fonts/')) {
    return 'https://api.mapbox.com/fonts/v1/' + glyphsUrl.slice('mapbox://fonts/'.length);
  }
  return httpsify(glyphsUrl);
}

async function buildMapboxUrls(bbox, zMin, zMax) {
  const urls = new Set();

  // 1. Style JSON
  const styleUrl = withToken(`https://api.mapbox.com/styles/v1/${MAPBOX_STYLE}`);
  urls.add(styleUrl);
  const styleJson = await fetchJson(styleUrl);

  // 2. Tile sources (vector / raster / raster-dem) — resolve TileJSON, enumerate tiles.
  // Mapbox TileJSON returns templates on `*.tiles.mapbox.com` over HTTP — must be rewritten
  // to HTTPS or the page (served HTTPS) blocks them as mixed content.
  const sources = styleJson.sources || {};
  for (const sourceId of Object.keys(sources)) {
    const src = sources[sourceId];
    if (!['vector', 'raster', 'raster-dem'].includes(src.type)) continue;
    if (!src.url || !src.url.startsWith('mapbox://')) continue;
    const id = src.url.replace('mapbox://', '');
    const tileJsonUrl = withToken(`https://api.mapbox.com/v4/${id}.json`);
    urls.add(tileJsonUrl);
    const tileJson = await fetchJson(tileJsonUrl);
    const rawTemplate = tileJson.tiles && tileJson.tiles[0];
    if (!rawTemplate) continue;
    const template = httpsify(rawTemplate);
    const sourceMin = Math.max(zMin, tileJson.minzoom ?? 0);
    const sourceMax = Math.min(zMax, tileJson.maxzoom ?? zMax);
    if (sourceMin > sourceMax) continue;
    for (const { z, x, y } of enumerateTiles(bbox, sourceMin, sourceMax)) {
      urls.add(fillTileTemplate(template, z, x, y));
    }
  }

  // 3. Sprite (1x + 2x, png + json)
  if (styleJson.sprite) {
    const spriteBase = styleJson.sprite.startsWith('mapbox://sprites/')
      ? `https://api.mapbox.com/styles/v1/${styleJson.sprite.replace('mapbox://sprites/', '')}/sprite`
      : httpsify(styleJson.sprite);
    for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) {
      urls.add(withToken(spriteBase + suffix));
    }
  }

  // 4. Glyphs — Latin range only. Use the style's own glyphs template so the
  // `{user}` segment (e.g. `mapbox/`) is preserved instead of dropped.
  const glyphsTemplate = glyphsTemplateToHttps(styleJson.glyphs);
  if (glyphsTemplate) {
    const fontstacks = uniqueFontstacks(styleJson);
    for (const stack of fontstacks) {
      for (const [start, end] of GLYPH_RANGES) {
        const filled = glyphsTemplate
          .replace('{fontstack}', encodeURIComponent(stack))
          .replace('{range}', `${start}-${end}`);
        urls.add(withToken(filled));
      }
    }
  }

  return Array.from(urls);
}

// ── Progress UI ──────────────────────────────────────────────────────────────

function ensureProgressUI() {
  let host = document.getElementById('offline-progress');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'offline-progress';
  host.hidden = true;
  host.innerHTML = `
    <div class="offline-progress-card">
      <div class="offline-progress-label">Downloading tiles…</div>
      <div class="offline-progress-bar"><div class="offline-progress-fill"></div></div>
      <div class="offline-progress-count">0 / 0</div>
    </div>
  `;
  document.body.appendChild(host);
  return host;
}

function showProgress() {
  const host = ensureProgressUI();
  const card = host.querySelector('.offline-progress-card');
  if (card) {
    card.classList.remove('offline-success');
    card.innerHTML = `
      <div class="offline-progress-label">Downloading tiles…</div>
      <div class="offline-progress-bar"><div class="offline-progress-fill"></div></div>
      <div class="offline-progress-count">0 / 0</div>
    `;
  }
  host.hidden = false;
  setProgress(0, 0);
}

function hideProgress() {
  const host = document.getElementById('offline-progress');
  if (host) host.hidden = true;
}

function showSuccess(area) {
  const host = ensureProgressUI();
  const card = host.querySelector('.offline-progress-card');
  if (!card) return;
  const sizeMb = (area.sizeBytes / 1024 / 1024).toFixed(1);
  card.classList.add('offline-success');
  card.innerHTML = `
    <div class="offline-success-icon">✓</div>
    <div class="offline-success-title">Area saved!</div>
    <div class="offline-success-meta">${area.name} · ${sizeMb} MB · ${area.tileCount} tiles</div>
    <button class="offline-btn offline-success-close" type="button">Close</button>
  `;
  host.hidden = false;
  card.querySelector('.offline-success-close').addEventListener('click', () => {
    host.hidden = true;
  });
}

function setProgress(done, total) {
  const host = ensureProgressUI();
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const fill = host.querySelector('.offline-progress-fill');
  if (fill) fill.style.width = pct + '%';
  const count = host.querySelector('.offline-progress-count');
  if (count) count.textContent = `${done} / ${total}`;
}

// ── Bundle download ──────────────────────────────────────────────────────────

export async function fetchBundle(bbox) {
  const [w, s, e, n] = bbox;
  const url = `/api/offline/bundle?minLng=${w}&minLat=${s}&maxLng=${e}&maxLat=${n}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Bundle fetch failed (${res.status})`);
  }
  return res.json();
}

function approxByteSize(geojson) {
  try {
    return JSON.stringify(geojson).length;
  } catch {
    return 0;
  }
}

export async function downloadArea(bbox, options = {}) {
  const {
    name = `Area ${new Date().toISOString().slice(0, 10)}`,
    minZoom = 12,
    maxZoom = 16,
    basemap = 'opentopo',
  } = options;

  if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(() => {});
  }

  // 1. Overlays — single round-trip
  const bundle = await fetchBundle(bbox);
  const overlays = { trails: bundle.trails, pois: bundle.pois, ferrata: bundle.ferrata };
  const overlaysSize = approxByteSize(bundle.trails) + approxByteSize(bundle.pois) + approxByteSize(bundle.ferrata);

  // 2. Tile URLs
  let tileUrls = [];
  if (basemap === 'opentopo') {
    tileUrls = buildOpentopoUrls(bbox, minZoom, maxZoom);
  } else if (basemap === 'osm') {
    tileUrls = buildOsmUrls(bbox, minZoom, maxZoom);
  } else if (basemap === 'mapbox') {
    tileUrls = await buildMapboxUrls(bbox, minZoom, maxZoom);
  } else {
    throw new Error(`Unknown basemap: ${basemap}`);
  }

  // 3. Prefetch tiles through SW (cache-first), throttled to respect tile-server policies
  showProgress();
  setProgress(0, tileUrls.length);
  const concurrency = basemap === 'mapbox' ? 6 : 2;
  const minInterval = basemap === 'mapbox' ? 0 : 400; // ~2.5 req/s for raster tile servers
  const { failures } = await throttledFetchAll(
    tileUrls,
    concurrency,
    minInterval,
    (done, total) => setProgress(done, total)
  );

  const failureRate = tileUrls.length > 0 ? failures.length / tileUrls.length : 0;
  if (failureRate > 0.05) {
    throw new Error(`Tile prefetch failed for ${failures.length}/${tileUrls.length} tiles`);
  }
  if (failures.length > 0) {
    console.warn(`Tile prefetch tolerated ${failures.length} failures`, failures.slice(0, 5));
  }

  // 4. Persist area + overlays + tile refs
  const id = newAreaId();
  await putOverlays(id, overlays);
  await incrTileRefs(tileUrls);

  // Approximate tile bytes: OpenTopo ~25 KB, OSM ~18 KB, Mapbox vector ~40 KB.
  const avgTileSize = basemap === 'mapbox' ? 40000 : basemap === 'osm' ? 18000 : 25000;
  const sizeBytes = overlaysSize + tileUrls.length * avgTileSize;

  const area = {
    id,
    name,
    bbox,
    minZoom,
    maxZoom,
    basemap,
    tileUrls,
    createdAt: new Date().toISOString(),
    sizeBytes,
    tileCount: tileUrls.length,
  };
  await putArea(area);
  return area;
}

function newAreaId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'area-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

// ── Bbox draw mode ───────────────────────────────────────────────────────────

const DRAW_SOURCE_ID = 'offline-draw-source';
const DRAW_FILL_ID = 'offline-draw-fill';
const DRAW_LINE_ID = 'offline-draw-line';

function bboxPolygon([w, s, e, n]) {
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    properties: {},
  };
}

function ensureDrawLayers(map) {
  if (!map.getSource(DRAW_SOURCE_ID)) {
    map.addSource(DRAW_SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  }
  if (!map.getLayer(DRAW_FILL_ID)) {
    map.addLayer({
      id: DRAW_FILL_ID,
      type: 'fill',
      source: DRAW_SOURCE_ID,
      paint: { 'fill-color': '#2e7d32', 'fill-opacity': 0.18 },
    });
  }
  if (!map.getLayer(DRAW_LINE_ID)) {
    map.addLayer({
      id: DRAW_LINE_ID,
      type: 'line',
      source: DRAW_SOURCE_ID,
      paint: { 'line-color': '#2e7d32', 'line-width': 2, 'line-dasharray': [2, 2] },
    });
  }
}

function clearDrawLayers(map) {
  if (map.getLayer(DRAW_LINE_ID)) map.removeLayer(DRAW_LINE_ID);
  if (map.getLayer(DRAW_FILL_ID)) map.removeLayer(DRAW_FILL_ID);
  if (map.getSource(DRAW_SOURCE_ID)) map.removeSource(DRAW_SOURCE_ID);
}

function setDrawData(map, feature) {
  const src = map.getSource(DRAW_SOURCE_ID);
  if (!src) return;
  src.setData(feature ? { type: 'FeatureCollection', features: [feature] } : { type: 'FeatureCollection', features: [] });
}

function normalizeBbox(p1, p2) {
  return [
    Math.min(p1.lng, p2.lng),
    Math.min(p1.lat, p2.lat),
    Math.max(p1.lng, p2.lng),
    Math.max(p1.lat, p2.lat),
  ];
}

function showDrawHint(message) {
  let el = document.getElementById('offline-draw-hint');
  if (!el) {
    el = document.createElement('div');
    el.id = 'offline-draw-hint';
    const host = document.getElementById('map-container') || document.body;
    host.appendChild(el);
  }
  el.textContent = message;
  el.hidden = false;
}

function hideDrawHint() {
  const el = document.getElementById('offline-draw-hint');
  if (el) el.hidden = true;
}

const SAVE_BUTTON_DEFAULT = '📥 Save offline area';
const SAVE_BUTTON_CANCEL = '✖ Cancel drawing';

function setSaveButtonMode(mode) {
  const btn = document.getElementById('offline-save-btn');
  if (!btn) return;
  if (mode === 'cancel') {
    btn.textContent = SAVE_BUTTON_CANCEL;
    btn.classList.add('offline-cancel-mode');
  } else {
    btn.textContent = SAVE_BUTTON_DEFAULT;
    btn.classList.remove('offline-cancel-mode');
  }
}

export function isDrawing() {
  return drawState !== null;
}

let drawState = null;

export function startDrawMode(map, onComplete) {
  if (drawState) cancelDrawMode(map);
  window.__drawMode = true;
  ensureDrawLayers(map);
  map.getCanvas().style.cursor = 'crosshair';
  showDrawHint('Tap the map to set the first corner — tap Save again or press Esc to cancel');
  setSaveButtonMode('cancel');

  const state = { firstCorner: null, onComplete };
  drawState = state;

  const handleClick = (e) => {
    const p = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    if (!state.firstCorner) {
      state.firstCorner = p;
      showDrawHint('Tap the opposite corner — tap Save again or press Esc to cancel');
      return;
    }
    const bbox = normalizeBbox(state.firstCorner, p);
    const onDone = state.onComplete;
    finishDrawMode(map);
    // Let the user see the selected area for 1s before the modal appears.
    setTimeout(() => { if (onDone) onDone(bbox); }, 1000);
  };

  const handleMove = (e) => {
    if (!state.firstCorner) return;
    const bbox = normalizeBbox(state.firstCorner, { lng: e.lngLat.lng, lat: e.lngLat.lat });
    setDrawData(map, bboxPolygon(bbox));
  };

  const handleKey = (e) => {
    if (e.key === 'Escape') {
      cancelDrawMode(map);
    }
  };

  state.handleClick = handleClick;
  state.handleMove = handleMove;
  state.handleKey = handleKey;

  map.on('click', handleClick);
  map.on('mousemove', handleMove);
  document.addEventListener('keydown', handleKey);
}

function detachDrawHandlers(map) {
  if (!drawState) return;
  if (drawState.handleClick) map.off('click', drawState.handleClick);
  if (drawState.handleMove) map.off('mousemove', drawState.handleMove);
  if (drawState.handleKey) document.removeEventListener('keydown', drawState.handleKey);
}

function finishDrawMode(map) {
  detachDrawHandlers(map);
  drawState = null;
  window.__drawMode = false;
  removeTransientClickMarker();
  map.getCanvas().style.cursor = '';
  hideDrawHint();
  setSaveButtonMode('default');
  // Keep the polygon visible until after the modal delay (1s); clear at 1.1s.
  setTimeout(() => clearDrawLayers(map), 1100);
}

export function cancelDrawMode(map) {
  detachDrawHandlers(map);
  drawState = null;
  window.__drawMode = false;
  removeTransientClickMarker();
  map.getCanvas().style.cursor = '';
  hideDrawHint();
  setSaveButtonMode('default');
  clearDrawLayers(map);
}

// ── Download modal ───────────────────────────────────────────────────────────

const TILE_SIZE_BYTES = { opentopo: 25000, osm: 18000, mapbox: 40000 };
const FIXED_OVERHEAD_BYTES = { opentopo: 200000, osm: 200000, mapbox: 6 * 1024 * 1024 + 200000 };

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function ensureModalRoot() {
  let host = document.getElementById('offline-modal-root');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'offline-modal-root';
  document.body.appendChild(host);
  return host;
}

function closeModal() {
  const host = document.getElementById('offline-modal-root');
  if (host) host.innerHTML = '';
}

function openDownloadModal(bbox) {
  return new Promise((resolve) => {
    const host = ensureModalRoot();
    const defaultName = `Area ${new Date().toISOString().slice(0, 10)}`;

    host.innerHTML = `
      <div class="offline-modal-backdrop">
        <form class="offline-modal" novalidate>
          <h3>Save offline area</h3>

          <label class="offline-field">
            <span>Name</span>
            <input type="text" name="name" required maxlength="60">
          </label>

          <label class="offline-field">
            <span>Zoom range</span>
            <span class="offline-zoom-inputs">
              <select name="zMin">${Array.from({length:12},(_,i)=>`<option value="${i+8}">${i+8}</option>`).join('')}</select>
              –
              <select name="zMax">${Array.from({length:12},(_,i)=>`<option value="${i+8}">${i+8}</option>`).join('')}</select>
            </span>
          </label>

          <fieldset class="offline-field offline-basemap">
            <legend>Basemap</legend>
            <label class="offline-radio">
              <input type="radio" name="basemap" value="opentopo" checked>
              <span class="offline-radio-body">
                <strong>OpenTopoMap</strong>
                <small class="offline-radio-est"></small>
                <small>Lighter, contour lines, no ToS risk.</small>
              </span>
            </label>
            <label class="offline-radio">
              <input type="radio" name="basemap" value="osm">
              <span class="offline-radio-body">
                <strong>OpenStreetMap</strong>
                <small class="offline-radio-est"></small>
                <small>Standard OSM raster tiles. Personal use only.</small>
              </span>
            </label>
            <label class="offline-radio">
              <input type="radio" name="basemap" value="mapbox">
              <span class="offline-radio-body">
                <strong>Mapbox Outdoors</strong>
                <small class="offline-radio-est"></small>
                <small>Detailed vector style, labels, hillshade.</small>
              </span>
            </label>
          </fieldset>

          <div class="offline-modal-actions">
            <button type="button" class="offline-cancel">Cancel</button>
            <button type="submit" class="offline-confirm">Download</button>
          </div>
        </form>
      </div>
    `;

    const form = host.querySelector('form');
    const nameInput = form.querySelector('input[name="name"]');
    const zMinInput = form.querySelector('select[name="zMin"]');
    const zMaxInput = form.querySelector('select[name="zMax"]');
    const radioEsts = form.querySelectorAll('.offline-radio-est');

    const BASEMAP_MAX_ZOOM = { opentopo: 17, osm: 19, mapbox: 16 };

    function applyBasemapZoom(basemap) {
      const max = BASEMAP_MAX_ZOOM[basemap] ?? 17;
      zMaxInput.value = String(max);
      Array.from(zMaxInput.options).forEach((opt) => {
        opt.disabled = Number(opt.value) > max;
      });
      Array.from(zMinInput.options).forEach((opt) => {
        opt.disabled = Number(opt.value) > max;
      });
      refreshEstimates();
    }

    nameInput.value = defaultName;
    zMinInput.value = '12';

    form.querySelectorAll('input[name="basemap"]').forEach((radio) => {
      radio.addEventListener('change', () => applyBasemapZoom(radio.value));
    });

    function refreshEstimates() {
      const zMin = Number(zMinInput.value);
      const zMax = Number(zMaxInput.value);
      if (!Number.isFinite(zMin) || !Number.isFinite(zMax) || zMin > zMax) {
        radioEsts.forEach((el) => { el.textContent = '—'; });
        return;
      }
      const tiles = tileCountForRange(bbox, zMin, zMax);
      const opentopoSize = tiles * TILE_SIZE_BYTES.opentopo + FIXED_OVERHEAD_BYTES.opentopo;
      const osmSize = tiles * TILE_SIZE_BYTES.osm + FIXED_OVERHEAD_BYTES.osm;
      const mapboxSize = tiles * TILE_SIZE_BYTES.mapbox + FIXED_OVERHEAD_BYTES.mapbox;
      radioEsts[0].textContent = `~${tiles} tiles · ~${formatMB(opentopoSize)} MB`;
      radioEsts[1].textContent = `~${tiles} tiles · ~${formatMB(osmSize)} MB`;
      radioEsts[2].textContent = `~${tiles} tiles + style/glyphs/DEM · ~${formatMB(mapboxSize)} MB`;
    }
    // Set zMax to basemap max for whichever radio is initially checked
    const checkedBasemap = form.querySelector('input[name="basemap"]:checked')?.value ?? 'opentopo';
    applyBasemapZoom(checkedBasemap);
    zMinInput.addEventListener('change', refreshEstimates);
    zMaxInput.addEventListener('change', refreshEstimates);

    form.querySelector('.offline-cancel').addEventListener('click', () => {
      closeModal();
      resolve(null);
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = nameInput.value.trim() || defaultName;
      const zMin = Math.max(0, Math.min(22, Number(zMinInput.value)));
      const zMax = Math.max(zMin, Math.min(22, Number(zMaxInput.value)));
      const basemap = form.querySelector('input[name="basemap"]:checked').value;
      closeModal();
      resolve({ name, minZoom: zMin, maxZoom: zMax, basemap });
    });
  });
}

// ── Open-offline flow ────────────────────────────────────────────────────────

function setOfflineLockedUI(locked) {
  const searchBox = document.getElementById('search-box');
  if (searchBox) searchBox.disabled = locked;
  const searchResults = document.getElementById('search-results');
  if (searchResults && locked) searchResults.style.display = 'none';
  // AI buttons live in the right-hand panel (`ui.js` dynamically injects them).
  document.querySelectorAll('.ai-magic-btn, .ai-regen-btn').forEach((btn) => {
    btn.disabled = locked;
  });
  document.body.classList.toggle('offline-mode', locked);
}

function applyOverlays(map, overlays) {
  if (!overlays) return;
  const trailsSrc = map.getSource('mountain-trails');
  if (trailsSrc && overlays.trails) trailsSrc.setData(overlays.trails);
  const poisSrc = map.getSource('mountain-pois');
  if (poisSrc && overlays.pois) poisSrc.setData(overlays.pois);
  const ferrataSrc = map.getSource('mountain-ferrata');
  if (ferrataSrc && overlays.ferrata) ferrataSrc.setData(overlays.ferrata);
}

function ensureExitButton() {
  let btn = document.getElementById('offline-exit-btn');
  if (btn) return btn;
  btn = document.createElement('button');
  btn.id = 'offline-exit-btn';
  btn.type = 'button';
  btn.className = 'offline-btn';
  btn.textContent = '🚪 Exit offline';
  btn.hidden = true;
  const container = document.getElementById('offline-controls') || document.getElementById('top-controls');
  if (container) container.appendChild(btn);
  return btn;
}


export async function openArea(map, areaId) {
  const area = await getArea(areaId);
  if (!area) {
    console.warn('Area not found:', areaId);
    return;
  }
  const overlays = await getOverlays(areaId);

  window.__offlineMode = true;
  setOfflineLockedUI(true);

  const onStyleLoad = () => {
    addMapLayers(map);
    applyOverlayVisibility(map);
    applyOverlays(map, overlays);
    addBboxMask(map, area.bbox);
    const [w, s, e, n] = area.bbox;
    map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 600 });
    if (window.__geolocateControl && navigator.permissions) {
      navigator.permissions.query({ name: 'geolocation' }).then((status) => {
        if (status.state === 'granted') {
          try { window.__geolocateControl.trigger(); } catch { /* noop */ }
        }
      }).catch(() => {});
    }
  };

  // Determine whether a style change is needed.
  // For Mapbox outdoors: skip setStyle if already active — Mapbox GL JS v3 does
  // not re-fire 'style.load' for same-URL calls AND does async source cleanup
  // that would remove our layers. Call onStyleLoad directly instead.
  const needsMapboxSwitch = area.basemap === 'mapbox' && getBasemapMode() !== 'outdoors-v12';

  if (area.basemap === 'opentopo') {
    setBasemapMode('opentopo');
    map.once('style.load', onStyleLoad);
    map.setStyle(buildTopoStyle());
    syncOpentopoRadio();
  } else if (area.basemap === 'osm') {
    setBasemapMode('opentopo');
    map.once('style.load', onStyleLoad);
    map.setStyle(buildOsmStyle());
    syncOpentopoRadio();
  } else if (needsMapboxSwitch) {
    setBasemapMode('outdoors-v12');
    map.once('style.load', onStyleLoad);
    map.setStyle('mapbox://styles/mapbox/outdoors-v12');
    syncRadio('outdoors-v12');
  } else {
    // Style already correct — call directly without triggering a reload.
    setBasemapMode('outdoors-v12');
    syncRadio('outdoors-v12');
    onStyleLoad();
  }

  const exit = ensureExitButton();
  exit.hidden = false;
  exit.onclick = () => exitOfflineArea(map);
}

function syncRadio(id) {
  const radio = document.getElementById(id);
  if (radio && !radio.checked) radio.checked = true;
}

function syncOpentopoRadio() {
  syncRadio('opentopo');
}

function addBboxMask(map, bbox) {
  const [w, s, e, n] = bbox;
  const data = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]],
        [[w, s], [w, n], [e, n], [e, s], [w, s]],
      ],
    },
  };
  if (!map.getSource('offline-mask-src')) {
    map.addSource('offline-mask-src', { type: 'geojson', data });
  } else {
    map.getSource('offline-mask-src').setData(data);
  }
  if (!map.getLayer('offline-bbox-mask')) {
    const firstOverlay = ['mountain-trails', 'mountain-pois', 'mountain-ferrata']
      .find((id) => map.getLayer(id));
    map.addLayer(
      { id: 'offline-bbox-mask', type: 'fill', source: 'offline-mask-src',
        paint: { 'fill-color': '#000', 'fill-opacity': 0.38 } },
      firstOverlay
    );
  }
}

function removeBboxMask(map) {
  if (map.getLayer('offline-bbox-mask')) map.removeLayer('offline-bbox-mask');
  if (map.getSource('offline-mask-src')) map.removeSource('offline-mask-src');
}

export function exitOfflineArea(map) {
  window.__offlineMode = false;
  setOfflineLockedUI(false);
  removeBboxMask(map);
  setBasemapMode('outdoors-v12');
  map.setStyle('mapbox://styles/mapbox/outdoors-v12');
  syncRadio('outdoors-v12');
  const exit = document.getElementById('offline-exit-btn');
  if (exit) exit.hidden = true;
}

// ── UI scaffolding ───────────────────────────────────────────────────────────

function injectControls() {
  const topControls = document.getElementById('top-controls');
  if (!topControls || document.getElementById('offline-controls')) return;

  const block = document.createElement('div');
  block.id = 'offline-controls';
  block.className = 'menu';
  block.innerHTML = `
    <button id="offline-save-btn" type="button" class="offline-btn">📥 Save offline area</button>
    <button id="offline-list-toggle" type="button" class="offline-btn" aria-expanded="false">📂 Saved areas</button>
  `;
  topControls.appendChild(block);

  const panel = document.createElement('aside');
  panel.id = 'offline-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="offline-panel-header">Saved Areas</div>
    <ul id="offline-areas-list"></ul>
  `;
  topControls.appendChild(panel);
}

function attachListToggle(map) {
  const btn = document.getElementById('offline-list-toggle');
  const panel = document.getElementById('offline-panel');
  if (!btn || !panel) return;
  btn.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) renderAreasList();
  });
  panel.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const id = target.dataset.id;
    if (!id) return;
    if (target.classList.contains('offline-open')) {
      openArea(map, id);
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    } else if (target.classList.contains('offline-delete')) {
      removeArea(id).then(() => renderAreasList()).catch((err) => console.error(err));
    }
  });
}

async function removeArea(id) {
  const area = await getArea(id);
  if (!area) return;
  const tileUrls = Array.isArray(area.tileUrls) ? area.tileUrls : [];
  const evictable = await decrTileRefs(tileUrls);
  if (evictable.length > 0) {
    const cache = await caches.open('tiles-v1');
    await Promise.all(evictable.map((url) => cache.delete(url).catch(() => false)));
  }
  await deleteArea(id);
}

async function renderAreasList() {
  const list = document.getElementById('offline-areas-list');
  if (!list) return;
  const areas = await getAllAreas();
  if (!areas.length) {
    list.innerHTML = '<li class="offline-empty">No saved areas yet.</li>';
    return;
  }
  list.innerHTML = '';
  for (const area of areas.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const li = document.createElement('li');
    li.className = 'offline-row';
    const sizeMb = (area.sizeBytes / 1024 / 1024).toFixed(1);
    const created = new Date(area.createdAt).toLocaleDateString();
    li.innerHTML = `
      <div class="offline-row-info">
        <strong></strong>
        <small>${area.basemap === 'opentopo' ? 'OpenTopo' : area.basemap === 'osm' ? 'OSM' : 'Mapbox'} · ${sizeMb} MB · ${created}</small>
      </div>
      <button class="offline-open" type="button" data-id="${area.id}">📂</button>
      <button class="offline-delete" type="button" data-id="${area.id}">🗑</button>
    `;
    li.querySelector('strong').textContent = area.name;
    list.appendChild(li);
  }
}

function attachSaveButton(map) {
  const btn = document.getElementById('offline-save-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (isDrawing()) {
      cancelDrawMode(map);
      return;
    }
    startDrawMode(map, async (bbox) => {
      window.dispatchEvent(new CustomEvent('offline:bbox-ready', { detail: { bbox } }));
      const choice = await openDownloadModal(bbox);
      if (!choice) return;
      try {
        const area = await downloadArea(bbox, choice);
        await renderAreasList();
        showSuccess(area);
      } catch (err) {
        hideProgress();
        console.error('Failed to save area', err);
        window.alert(`Failed: ${err.message}`);
      }
    });
  });
}

export function initOfflineModule(map) {
  injectControls();
  attachListToggle(map);
  attachSaveButton(map);
  renderAreasList().catch((err) => console.warn('renderAreasList failed', err));
}
