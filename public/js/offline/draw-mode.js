import { removeTransientClickMarker } from '../map.js';

const DRAW_SOURCE_ID = 'offline-draw-source';
const DRAW_FILL_ID = 'offline-draw-fill';
const DRAW_LINE_ID = 'offline-draw-line';
const SAVE_BUTTON_DEFAULT = '📥 Save offline area';
const SAVE_BUTTON_CANCEL = '✖ Cancel drawing';

let drawState = null;

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

export function isDrawing() {
  return drawState !== null;
}

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
