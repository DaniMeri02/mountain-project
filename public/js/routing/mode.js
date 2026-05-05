let _clickHandler = null;
let _keyHandler = null;
let _hintEl = null;
let _hintTextEl = null;
let _hintCancelBtn = null;
let _startMarker = null;
let _endMarker = null;
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

export function setRoutingMarkers(map, startCoord, endCoord) {
  if (startCoord) {
    if (!_startMarker) _startMarker = buildRouteMarker('route-point-start').addTo(map);
    _startMarker.setLngLat(startCoord);
  }
  if (endCoord) {
    if (!_endMarker) _endMarker = buildRouteMarker('route-point-end').addTo(map);
    _endMarker.setLngLat(endCoord);
  }
}

export function clearRoutingMarkers() {
  if (_startMarker) { _startMarker.remove(); _startMarker = null; }
  if (_endMarker) { _endMarker.remove(); _endMarker = null; }
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
      cancelRoutingMode(_mapRef);
      clearRoutingMarkers();
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
