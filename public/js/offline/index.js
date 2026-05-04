import { getAllAreas, getArea, deleteArea, decrTileRefs } from './idb.js';
import { openDownloadModal, downloadArea, showSuccess, hideProgress } from './download.js';
import { isDrawing, startDrawMode, cancelDrawMode } from './draw-mode.js';
import { openArea } from './area.js';
import { closeNav } from '../nav.js';

export { tilesInBboxAtZoom, tileCountForRange, enumerateTiles } from '../tile-math.js';
export { getAllAreas, getArea, putArea, deleteArea, putOverlays, getOverlays, incrTileRefs, decrTileRefs } from './idb.js';
export { fetchBundle, downloadArea } from './download.js';
export { isDrawing, startDrawMode, cancelDrawMode } from './draw-mode.js';
export { openArea, exitOfflineArea } from './area.js';

function injectControls() {
  const target = document.getElementById('drawer-section-offline');
  if (!target || document.getElementById('offline-controls')) return;

  const block = document.createElement('div');
  block.id = 'offline-controls';
  block.className = 'offline-controls';
  block.innerHTML = `
    <button id="offline-save-btn" type="button" class="offline-btn">📥 Save offline area</button>
    <button id="offline-list-toggle" type="button" class="offline-btn" aria-expanded="false">📂 Saved areas</button>
  `;
  target.appendChild(block);

  const panel = document.createElement('aside');
  panel.id = 'offline-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="offline-panel-header">Saved Areas</div>
    <ul id="offline-areas-list"></ul>
  `;
  target.appendChild(panel);
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
    closeNav();
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
