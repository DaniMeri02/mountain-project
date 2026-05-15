import mapboxgl from 'mapbox-gl';
import { appState } from '../state';

type Coord = [number, number];
type MapMouseHandler = (e: mapboxgl.MapMouseEvent) => void;

let _clickHandler: MapMouseHandler | null = null;
let _keyHandler: ((e: KeyboardEvent) => void) | null = null;
let _viaClickHandler: MapMouseHandler | null = null;
let _viaKeyHandler: ((e: KeyboardEvent) => void) | null = null;
let _hintEl: HTMLElement | null = null;
let _hintTextEl: HTMLElement | null = null;
let _hintCancelBtn: HTMLElement | null = null;
let _startMarker: mapboxgl.Marker | null = null;
let _endMarker: mapboxgl.Marker | null = null;
let _viaMarkers: mapboxgl.Marker[] = [];
let _mapRef: mapboxgl.Map | null = null;

function buildRouteMarker(className: string): mapboxgl.Marker {
  const el = document.createElement('div');
  el.className = `route-point ${className}`;
  return new mapboxgl.Marker({ element: el, anchor: 'center' });
}

export function isRouting(): boolean {
  return !!appState.routingMode;
}

export function startRoutingMode(map: mapboxgl.Map, onBothPoints: (start: Coord, end: Coord) => void): void {
  _mapRef = map;
  appState.routingMode = true;
  document.body.classList.add('routing-active');
  map.getCanvas().style.cursor = 'crosshair';
  clearRoutingMarkers();

  let startCoord: Coord | null = null;
  showHint('Click start point');

  _clickHandler = (e: mapboxgl.MapMouseEvent) => {
    const coord: Coord = [e.lngLat.lng, e.lngLat.lat];
    if (!startCoord) {
      startCoord = coord;
      _startMarker = buildRouteMarker('route-point-start').setLngLat(coord).addTo(map);
      showHint('Click end point (or a peak/hut)');
    } else {
      _endMarker = buildRouteMarker('route-point-end').setLngLat(coord).addTo(map);
      cancelRoutingMode(map);
      onBothPoints(startCoord, coord);
    }
  };

  _keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') cancelRoutingMode(map);
  };

  map.on('click', _clickHandler);
  document.addEventListener('keydown', _keyHandler);
}

export function cancelRoutingMode(map: mapboxgl.Map): void {
  if (!appState.routingMode) return;
  appState.routingMode = false;
  document.body.classList.remove('routing-active');
  map.getCanvas().style.cursor = '';
  if (_clickHandler) { map.off('click', _clickHandler); _clickHandler = null; }
  if (_keyHandler) { document.removeEventListener('keydown', _keyHandler); _keyHandler = null; }
  hideHint();
}

export function startViaMode(map: mapboxgl.Map, onPoint: (coord: Coord) => void): void {
  _mapRef = map;
  appState.routingViaMode = true;
  map.getCanvas().style.cursor = 'crosshair';
  showHint('Click pass-through point');
  window.dispatchEvent(new Event('routing:via-start'));

  _viaClickHandler = (e: mapboxgl.MapMouseEvent) => {
    const coord: Coord = [e.lngLat.lng, e.lngLat.lat];
    cancelViaMode(map);
    onPoint(coord);
  };

  _viaKeyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') cancelViaMode(map);
  };

  map.on('click', _viaClickHandler);
  document.addEventListener('keydown', _viaKeyHandler);
}

export function cancelViaMode(map: mapboxgl.Map): void {
  if (!appState.routingViaMode) return;
  appState.routingViaMode = false;
  if (!appState.routingMode) map.getCanvas().style.cursor = '';
  if (_viaClickHandler) { map.off('click', _viaClickHandler); _viaClickHandler = null; }
  if (_viaKeyHandler) { document.removeEventListener('keydown', _viaKeyHandler); _viaKeyHandler = null; }
  hideHint();
  window.dispatchEvent(new Event('routing:via-cancel'));
}

export function setRoutingMarkers(map: mapboxgl.Map, startCoord: Coord | null | undefined, endCoord: Coord | null | undefined): void {
  if (startCoord) {
    if (!_startMarker) _startMarker = buildRouteMarker('route-point-start').setLngLat(startCoord).addTo(map);
    else _startMarker.setLngLat(startCoord);
  }
  if (endCoord) {
    if (!_endMarker) _endMarker = buildRouteMarker('route-point-end').setLngLat(endCoord).addTo(map);
    else _endMarker.setLngLat(endCoord);
  }
}

export function addViaMarker(map: mapboxgl.Map, coord: Coord | null | undefined): void {
  if (!coord) return;
  const marker = buildRouteMarker('route-point-via').setLngLat(coord).addTo(map);
  _viaMarkers.push(marker);
}

export function removeViaMarkerAt(idx: number): void {
  if (idx < 0 || idx >= _viaMarkers.length) return;
  _viaMarkers[idx].remove();
  _viaMarkers.splice(idx, 1);
}

export function clearViaMarkers(): void {
  for (const m of _viaMarkers) m.remove();
  _viaMarkers = [];
}

export function clearRoutingMarkers(): void {
  if (_startMarker) { _startMarker.remove(); _startMarker = null; }
  if (_endMarker) { _endMarker.remove(); _endMarker = null; }
  clearViaMarkers();
}

function showHint(text: string): void {
  if (!_hintEl) {
    _hintEl = document.createElement('div');
    _hintEl.id = 'route-hint';
    _hintTextEl = document.createElement('span');
    _hintTextEl.className = 'route-hint-text';
    _hintCancelBtn = document.createElement('button');
    (_hintCancelBtn as HTMLButtonElement).type = 'button';
    _hintCancelBtn.className = 'route-hint-cancel';
    _hintCancelBtn.textContent = 'Cancel';
    _hintCancelBtn.addEventListener('click', () => {
      if (!_mapRef) return;
      if (appState.routingMode) {
        cancelRoutingMode(_mapRef);
        clearRoutingMarkers();
        return;
      }
      if (appState.routingViaMode) cancelViaMode(_mapRef);
    });
    _hintEl.appendChild(_hintTextEl);
    _hintEl.appendChild(_hintCancelBtn);
    const host = document.getElementById('map-container') ?? document.body;
    host.appendChild(_hintEl);
  }
  if (_hintTextEl) _hintTextEl.textContent = text;
  _hintEl.hidden = false;
}

function hideHint(): void {
  if (_hintEl) _hintEl.hidden = true;
}
