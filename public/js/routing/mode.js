let _clickHandler = null;
let _keyHandler = null;
let _viaClickHandler = null;
let _viaKeyHandler = null;
let _hintEl = null;
let _hintTextEl = null;
let _hintCancelBtn = null;
let _startMarker = null;
let _endMarker = null;
let _viaMarkers = [];
let _mapRef = null;

function buildRouteMarker(className) {
  const el = document.createElement('div');
  el.className = `route-point ${className}`;
  return new mapboxgl.Marker({ element: el, anchor: 'center' });
}

export function isRouting() {
  return !!window.__routingMode;
}

export function startRoutingMode(map, onBothPoints) {
  _mapRef = map;
  window.__routingMode = true;
  document.body.classList.add('routing-active');
  map.getCanvas().style.cursor = 'crosshair';
  clearRoutingMarkers();

  let startCoord = null;
  showHint('Click start point');

  _clickHandler = (e) => {
    const coord = [e.lngLat.lng, e.lngLat.lat];
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

  _keyHandler = (e) => {
    if (e.key === 'Escape') cancelRoutingMode(map);
  };

  map.on('click', _clickHandler);
  document.addEventListener('keydown', _keyHandler);
}

export function cancelRoutingMode(map) {
  if (!window.__routingMode) return;
  window.__routingMode = false;
  document.body.classList.remove('routing-active');
  map.getCanvas().style.cursor = '';
  if (_clickHandler) { map.off('click', _clickHandler); _clickHandler = null; }
  if (_keyHandler) { document.removeEventListener('keydown', _keyHandler); _keyHandler = null; }
  hideHint();
}

export function startViaMode(map, onPoint) {
  _mapRef = map;
  window.__routingViaMode = true;
  map.getCanvas().style.cursor = 'crosshair';
  showHint('Click pass-through point');
  window.dispatchEvent(new Event('routing:via-start'));

  _viaClickHandler = (e) => {
    const coord = [e.lngLat.lng, e.lngLat.lat];
    cancelViaMode(map);
    onPoint(coord);
  };

  _viaKeyHandler = (e) => {
    if (e.key === 'Escape') cancelViaMode(map);
  };

  map.on('click', _viaClickHandler);
  document.addEventListener('keydown', _viaKeyHandler);
}

export function cancelViaMode(map) {
  if (!window.__routingViaMode) return;
  window.__routingViaMode = false;
  if (!window.__routingMode) map.getCanvas().style.cursor = '';
  if (_viaClickHandler) { map.off('click', _viaClickHandler); _viaClickHandler = null; }
  if (_viaKeyHandler) { document.removeEventListener('keydown', _viaKeyHandler); _viaKeyHandler = null; }
  hideHint();
  window.dispatchEvent(new Event('routing:via-cancel'));
}

export function setRoutingMarkers(map, startCoord, endCoord) {
  if (startCoord) {
    if (!_startMarker) _startMarker = buildRouteMarker('route-point-start').setLngLat(startCoord).addTo(map);
    else _startMarker.setLngLat(startCoord);
  }
  if (endCoord) {
    if (!_endMarker) _endMarker = buildRouteMarker('route-point-end').setLngLat(endCoord).addTo(map);
    else _endMarker.setLngLat(endCoord);
  }
}

export function addViaMarker(map, coord) {
  if (!coord) return;
  const marker = buildRouteMarker('route-point-via').setLngLat(coord).addTo(map);
  _viaMarkers.push(marker);
}

export function removeViaMarkerAt(idx) {
  if (idx < 0 || idx >= _viaMarkers.length) return;
  _viaMarkers[idx].remove();
  _viaMarkers.splice(idx, 1);
}

export function clearViaMarkers() {
  for (const m of _viaMarkers) m.remove();
  _viaMarkers = [];
}

export function clearRoutingMarkers() {
  if (_startMarker) { _startMarker.remove(); _startMarker = null; }
  if (_endMarker) { _endMarker.remove(); _endMarker = null; }
  clearViaMarkers();
}

function showHint(text) {
  if (!_hintEl) {
    _hintEl = document.createElement('div');
    _hintEl.id = 'route-hint';
    _hintTextEl = document.createElement('span');
    _hintTextEl.className = 'route-hint-text';
    _hintCancelBtn = document.createElement('button');
    _hintCancelBtn.type = 'button';
    _hintCancelBtn.className = 'route-hint-cancel';
    _hintCancelBtn.textContent = 'Cancel';
    _hintCancelBtn.addEventListener('click', () => {
      if (!_mapRef) return;
      if (window.__routingMode) {
        cancelRoutingMode(_mapRef);
        clearRoutingMarkers();
        return;
      }
      if (window.__routingViaMode) cancelViaMode(_mapRef);
    });
    _hintEl.appendChild(_hintTextEl);
    _hintEl.appendChild(_hintCancelBtn);
    const host = document.getElementById('map-container') || document.body;
    host.appendChild(_hintEl);
  }
  if (_hintTextEl) _hintTextEl.textContent = text;
  _hintEl.hidden = false;
}

function hideHint() {
  if (_hintEl) _hintEl.hidden = true;
}
