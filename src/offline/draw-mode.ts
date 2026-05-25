import mapboxgl from 'mapbox-gl';
import { removeTransientClickMarker } from '../map';
import { appState } from '../state';

const DRAW_SOURCE_ID = 'offline-draw-source';
const DRAW_FILL_ID = 'offline-draw-fill';
const DRAW_LINE_ID = 'offline-draw-line';
const SAVE_BUTTON_DEFAULT = '📥 Save offline area';
const SAVE_BUTTON_CANCEL = '✖ Cancel drawing';

interface DrawState {
  firstCorner: { lng: number; lat: number } | null;
  onComplete: ((bbox: [number, number, number, number]) => void) | null;
  handleClick?: (e: mapboxgl.MapMouseEvent) => void;
  handleMove?: (e: mapboxgl.MapMouseEvent) => void;
  handleKey?: (e: KeyboardEvent) => void;
}

let drawState: DrawState | null = null;

function bboxPolygon([w, s, e, n]: [number, number, number, number]): GeoJSON.Feature<GeoJSON.Polygon> {
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    properties: {},
  };
}

function ensureDrawLayers(map: mapboxgl.Map): void {
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

function clearDrawLayers(map: mapboxgl.Map): void {
  if (map.getLayer(DRAW_LINE_ID)) map.removeLayer(DRAW_LINE_ID);
  if (map.getLayer(DRAW_FILL_ID)) map.removeLayer(DRAW_FILL_ID);
  if (map.getSource(DRAW_SOURCE_ID)) map.removeSource(DRAW_SOURCE_ID);
}

function setDrawData(map: mapboxgl.Map, feature: GeoJSON.Feature<GeoJSON.Polygon> | null): void {
  const src = map.getSource(DRAW_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
  if (!src) return;
  const data: GeoJSON.GeoJSON = feature
    ? { type: 'FeatureCollection', features: [feature] }
    : { type: 'FeatureCollection', features: [] };
  src.setData(data);
}

function normalizeBbox(
  p1: { lng: number; lat: number },
  p2: { lng: number; lat: number }
): [number, number, number, number] {
  return [
    Math.min(p1.lng, p2.lng),
    Math.min(p1.lat, p2.lat),
    Math.max(p1.lng, p2.lng),
    Math.max(p1.lat, p2.lat),
  ];
}

function showDrawHint(message: string): void {
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

function hideDrawHint(): void {
  const el = document.getElementById('offline-draw-hint');
  if (el) el.hidden = true;
}

function setSaveButtonMode(mode: 'cancel' | 'default'): void {
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

function detachDrawHandlers(map: mapboxgl.Map): void {
  if (!drawState) return;
  if (drawState.handleClick) map.off('click', drawState.handleClick);
  if (drawState.handleMove) map.off('mousemove', drawState.handleMove);
  if (drawState.handleKey) document.removeEventListener('keydown', drawState.handleKey);
}

function finishDrawMode(map: mapboxgl.Map): void {
  detachDrawHandlers(map);
  drawState = null;
  appState.drawMode = false;
  removeTransientClickMarker();
  map.getCanvas().style.cursor = '';
  hideDrawHint();
  setSaveButtonMode('default');
  // Keep the polygon visible until after the modal delay (1s); clear at 1.1s.
  setTimeout(() => clearDrawLayers(map), 1100);
}

export function isDrawing(): boolean {
  return drawState !== null;
}

export function startDrawMode(
  map: mapboxgl.Map,
  onComplete: (bbox: [number, number, number, number]) => void
): void {
  if (drawState) cancelDrawMode(map);
  appState.drawMode = true;
  ensureDrawLayers(map);
  map.getCanvas().style.cursor = 'crosshair';
  showDrawHint('Tap the map to set the first corner — tap Save again or press Esc to cancel');
  setSaveButtonMode('cancel');

  const state: DrawState = { firstCorner: null, onComplete };
  drawState = state;

  const handleClick = (e: mapboxgl.MapMouseEvent) => {
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

  // Coalesce mousemove repaints to one per animation frame; pointer events
  // can fire 200+/sec on high-Hz trackpads and each setData() triggers a
  // Mapbox layer repaint. Without this throttle, drawing produces long
  // animation frames that show up in INP/LoAF traces.
  let rafPending = false;
  let pendingBbox: [number, number, number, number] | null = null;
  const handleMove = (e: mapboxgl.MapMouseEvent) => {
    if (!state.firstCorner) return;
    pendingBbox = normalizeBbox(state.firstCorner, { lng: e.lngLat.lng, lat: e.lngLat.lat });
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (pendingBbox) setDrawData(map, bboxPolygon(pendingBbox));
    });
  };

  const handleKey = (e: KeyboardEvent) => {
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

export function cancelDrawMode(map: mapboxgl.Map): void {
  detachDrawHandlers(map);
  drawState = null;
  appState.drawMode = false;
  removeTransientClickMarker();
  map.getCanvas().style.cursor = '';
  hideDrawHint();
  setSaveButtonMode('default');
  clearDrawLayers(map);
}
