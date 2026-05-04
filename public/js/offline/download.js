import { putOverlays, putArea, incrTileRefs } from './idb.js';
import { buildOsmUrls, buildOpentopoUrls, buildMapboxUrls, throttledFetchAll } from './tile-urls.js';
import { tileCountForRange } from '../tile-math.js';

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

export function hideProgress() {
  const host = document.getElementById('offline-progress');
  if (host) host.hidden = true;
}

export function showSuccess(area) {
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

function newAreaId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'area-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
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

export function openDownloadModal(bbox) {
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

      Array.from(zMaxInput.options).forEach((opt) => {
        opt.disabled = Number(opt.value) > max;
      });
      Array.from(zMinInput.options).forEach((opt) => {
        opt.disabled = Number(opt.value) > max;
      });

      zMaxInput.value = String(max);

      const currentMin = Number(zMinInput.value);
      if (!Number.isFinite(currentMin)) {
        zMinInput.value = String(Math.min(12, max));
      } else if (currentMin > max) {
        zMinInput.value = String(max);
      }

      refreshEstimates();
    }

    nameInput.value = defaultName;
    zMinInput.value = '12';

    form.querySelectorAll('input[name="basemap"]').forEach((radio) => {
      radio.addEventListener('change', () => applyBasemapZoom(radio.value));
    });

    function refreshEstimates() {
      const zMin = Number(zMinInput.value);
      if (!Number.isFinite(zMin)) {
        radioEsts.forEach((el) => { el.textContent = '—'; });
        return;
      }

      const ranges = [
        { basemap: 'opentopo', max: BASEMAP_MAX_ZOOM.opentopo ?? zMin },
        { basemap: 'osm', max: BASEMAP_MAX_ZOOM.osm ?? zMin },
        { basemap: 'mapbox', max: BASEMAP_MAX_ZOOM.mapbox ?? zMin },
      ];

      ranges.forEach((range, index) => {
        if (!Number.isFinite(range.max) || zMin > range.max) {
          radioEsts[index].textContent = '—';
          return;
        }

        const tiles = tileCountForRange(bbox, zMin, range.max);
        const sizeBytes = tiles * TILE_SIZE_BYTES[range.basemap] + FIXED_OVERHEAD_BYTES[range.basemap];
        if (range.basemap === 'mapbox') {
          radioEsts[index].textContent = `~${tiles} tiles + style/glyphs/DEM · ~${formatMB(sizeBytes)} MB`;
        } else {
          radioEsts[index].textContent = `~${tiles} tiles · ~${formatMB(sizeBytes)} MB`;
        }
      });
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
