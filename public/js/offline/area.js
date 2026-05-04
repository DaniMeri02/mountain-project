import { getArea, getOverlays } from './idb.js';
import {
  addMapLayers, applyOverlayVisibility, setBasemapMode, getBasemapMode,
  buildOsmStyle, buildTopoStyle,
} from '../map.js';

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
  const container = document.getElementById('offline-controls') || document.getElementById('drawer-section-offline');
  if (container) container.appendChild(btn);
  return btn;
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
    setBasemapMode('osm');
    map.once('style.load', onStyleLoad);
    map.setStyle(buildOsmStyle());
    syncRadio('osm');
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
