import { buildGraph, snapToNode, findAlternatives, findRoundTrip, haversineMeters, dijkstra } from './graph.js';
import { generateGpx, downloadGpx } from './gpx.js';
import { setRouteHighlight, setRouteAlternatives, setRouteReturn, clearRouteHighlight } from './highlight.js';
import {
  startRoutingMode,
  cancelRoutingMode,
  clearRoutingMarkers,
  setRoutingMarkers,
  startViaMode,
  cancelViaMode,
  setViaMarker,
  clearViaMarker
} from './mode.js';
import { closeNav } from '../nav.js';
import { bumpPanelToken } from '../map.js';

let _map = null;
let _graph = null;
let _fromKey = null;
let _toKey = null;
let _alternatives = [];
let _selectedIdx = 0;
let _altClickAttached = false;
let _startCoord = null;
let _endCoord = null;
let _viaCoord = null;
let _viaKey = null;

export function initRoutingModule(map) {
  _map = map;
  injectDrawerSection();
  attachFindRouteButton();
  attachAltClickHandler();
}

function injectDrawerSection() {
  const target = document.getElementById('drawer-section-routing');
  if (!target || document.getElementById('routing-controls')) return;
  const block = document.createElement('div');
  block.id = 'routing-controls';
  block.innerHTML = `
    <button id="routing-find-btn" type="button" class="offline-btn routing-btn">🧭 Find Route</button>
  `;
  target.appendChild(block);
}

function attachFindRouteButton() {
  document.addEventListener('click', (e) => {
    if (!e.target || e.target.id !== 'routing-find-btn') return;
    if (window.__routingMode) {
      cancelRoutingMode(_map);
      clearRouteHighlight(_map);
      clearRoutingMarkers();
      cancelViaMode(_map);
      clearViaMarker();
      _viaCoord = null;
      _viaKey = null;
      window.__routingHasRoute = false;
      document.body.classList.remove('panel-open');
      return;
    }
    closeNav();
    cancelViaMode(_map);
    clearViaMarker();
    _viaCoord = null;
    _viaKey = null;
    startRoutingMode(_map, async (startCoord, endCoord) => {
      await computeAndDisplayRoute(startCoord, endCoord);
    });
  });
}

async function computeAndDisplayRoute(startCoord, endCoord) {
  const hadRoute = window.__routingHasRoute;
  window.__routingHasRoute = false;
  _startCoord = startCoord;
  _endCoord = endCoord;

  const expand = 0.05;
  const minLng = Math.min(startCoord[0], endCoord[0]) - expand;
  const minLat = Math.min(startCoord[1], endCoord[1]) - expand;
  const maxLng = Math.max(startCoord[0], endCoord[0]) + expand;
  const maxLat = Math.max(startCoord[1], endCoord[1]) + expand;

  try {
    const [trailsRes, ferrataRes] = await Promise.all([
      fetch(`/api/trails?minLng=${minLng}&minLat=${minLat}&maxLng=${maxLng}&maxLat=${maxLat}`),
      fetch(`/api/ferrata?minLng=${minLng}&minLat=${minLat}&maxLng=${maxLng}&maxLat=${maxLat}`)
    ]);
    if (!trailsRes.ok || !ferrataRes.ok) {
      throw new Error(`HTTP error while loading routes: trails=${trailsRes.status}, ferrata=${ferrataRes.status}`);
    }
    const trailsData = await trailsRes.json();
    const ferrataData = await ferrataRes.json();
    const features = [
      ...(trailsData.features || []),
      ...(ferrataData.features || [])
    ];

    _graph = buildGraph(features);
    if (!_graph.nodes.size) {
      clearRoutingMarkers();
      showToast('No trail data found in this area.');
      if (hadRoute) window.__routingHasRoute = true;
      return;
    }
    _fromKey = snapToNode(_graph, startCoord);
    _toKey = snapToNode(_graph, endCoord);

    if (!_fromKey) {
      clearRoutingMarkers();
      showToast('No trail nearby — click closer to a trail.');
      if (hadRoute) window.__routingHasRoute = true;
      return;
    }
    if (!_toKey) {
      clearRoutingMarkers();
      showToast('No trail nearby at end point — click closer to a trail.');
      if (hadRoute) window.__routingHasRoute = true;
      return;
    }

    const fromNode = _graph.nodes.get(_fromKey);
    const toNode = _graph.nodes.get(_toKey);
    if (fromNode || toNode) setRoutingMarkers(_map, fromNode && fromNode.coord, toNode && toNode.coord);

    if (_viaCoord) {
      const viaRoute = buildViaRoute();
      if (!viaRoute) {
        if (hadRoute) window.__routingHasRoute = true;
        return;
      }
      _alternatives = [viaRoute];
      _selectedIdx = 0;
      window.__routingHasRoute = true;
      renderRoute();
      return;
    }

    _alternatives = findAlternatives(_graph, _fromKey, _toKey);

    if (!_alternatives.length) {
      clearRoutingMarkers();
      showToast('No route found between these points.');
      if (hadRoute) window.__routingHasRoute = true;
      return;
    }

    _alternatives = sortAlternativesByDistance(_alternatives);
    _selectedIdx = 0;
    window.__routingHasRoute = true;
    renderRoute();
  } catch (err) {
    console.error('Route computation failed', err);
    if (hadRoute) window.__routingHasRoute = true;
    showToast('Failed to compute route.');
  }
}

function renderRoute() {
  const selected = _alternatives[_selectedIdx];
  setRouteHighlight(_map, selected);
  const altEntries = _alternatives
    .map((route, idx) => ({ route, idx }))
    .filter(({ idx }) => idx !== _selectedIdx);
  setRouteAlternatives(
    _map,
    altEntries.map((entry) => entry.route),
    altEntries.map((entry) => entry.idx)
  );
  showRoutePanel();
}

function selectRoute(idx) {
  if (!Number.isFinite(idx)) return;
  if (idx < 0 || idx >= _alternatives.length) return;
  if (idx === _selectedIdx) return;
  _selectedIdx = idx;
  renderRoute();
}

function routeDistanceKm(edges) {
  let total = 0;
  for (const { coords, reversed } of edges) {
    const seg = reversed ? [...coords].reverse() : coords;
    for (let i = 1; i < seg.length; i++) total += haversineMeters(seg[i], seg[i - 1]);
  }
  return total / 1000;
}

function sortAlternativesByDistance(routes) {
  return routes
    .map((route) => ({ route, distance: routeDistanceKm(route) }))
    .sort((a, b) => a.distance - b.distance)
    .map((entry) => entry.route);
}

function buildViaRoute() {
  if (!_graph || !_viaCoord || !_fromKey || !_toKey) return null;
  const viaKey = snapToNode(_graph, _viaCoord);
  if (!viaKey) {
    showToast('No trail nearby at pass-through point.');
    return null;
  }
  _viaKey = viaKey;
  const viaNode = _graph.nodes.get(viaKey);
  if (viaNode) setViaMarker(_map, viaNode.coord);
  const leg1 = dijkstra(_graph, _fromKey, viaKey);
  const leg2 = dijkstra(_graph, viaKey, _toKey);
  if (!leg1 || !leg2) {
    showToast('No route found through pass-through point.');
    return null;
  }
  return [...leg1, ...leg2];
}

function showRoutePanel() {
  bumpPanelToken();
  const panel = document.getElementById('panel');
  if (!panel) return;
  document.body.classList.add('panel-open');

  const selected = _alternatives[_selectedIdx];
  const distKm = routeDistanceKm(selected).toFixed(1);
  const viaActive = !!_viaCoord;
  const roundtripDisabled = viaActive ? 'disabled' : '';
  const roundtripTitle = viaActive ? 'Disable pass-through to enable round trip.' : '';

  const altItems = _alternatives.length > 1
    ? _alternatives.map((route, i) => {
      const d = routeDistanceKm(route).toFixed(1);
      return `<li class="route-alt-item${i === _selectedIdx ? ' route-alt-selected' : ''}" data-idx="${i}">
        ${i === 0 ? 'Shortest' : `Alternative ${i}`} — ${d} km
      </li>`;
    }).join('')
    : '';

  const altSection = _alternatives.length > 1
    ? `<ul class="route-alt-list">${altItems}</ul>`
    : `<p class="route-alt-empty">No alternatives for this route.</p>`;

  const viaButtonLabel = viaActive ? '✏️ Edit pass-through' : '📍 Pass through a point';
  const viaClearButton = viaActive
    ? '<button id="route-via-clear" class="offline-btn">Clear</button>'
    : '';
  const viaNote = viaActive
    ? '<p class="route-via-note">Pass-through point active.</p>'
    : '';

  panel.innerHTML = `
    <button id="panel-close" class="panel-close-btn" aria-label="Close">×</button>
    <h2>Route</h2>
    <p class="route-distance">${distKm} km</p>
    <label class="route-roundtrip-label" title="${roundtripTitle}">
      <input type="checkbox" id="route-roundtrip" ${roundtripDisabled}> 🔄 Round trip
    </label>
    <div class="route-via-row">
      <button id="route-via-btn" class="offline-btn">${viaButtonLabel}</button>
      ${viaClearButton}
    </div>
    ${viaNote}
    ${altSection}
    <div class="route-actions">
      <button id="route-download-gpx" class="offline-btn">⬇ Download GPX</button>
      <button id="routing-cancel-btn" class="offline-btn">✕ Cancel</button>
    </div>
  `;

  panel.querySelector('#panel-close').addEventListener('click', () => {
    document.body.classList.remove('panel-open');
  });

  panel.querySelector('#route-roundtrip').addEventListener('change', (e) => {
    if (viaActive) return;
    if (e.target.checked) {
      const result = findRoundTrip(_graph, _fromKey, _toKey);
      if (!result) return;
      if (result.onlyOnePath) showToast('Only one path available for round trip.');
      setRouteHighlight(_map, result.outbound);
      setRouteReturn(_map, result.returnRoute);
    } else {
      renderRoute();
    }
  });

  const altList = panel.querySelector('.route-alt-list');
  if (altList) {
    altList.addEventListener('click', (e) => {
      const item = e.target.closest('.route-alt-item');
      if (!item) return;
      selectRoute(parseInt(item.dataset.idx, 10));
    });
  }

  panel.querySelector('#route-via-btn').addEventListener('click', () => {
    if (!_startCoord || !_endCoord) return;
    cancelViaMode(_map);
    startViaMode(_map, (coord) => {
      _viaCoord = coord;
      computeAndDisplayRoute(_startCoord, _endCoord);
    });
  });

  const viaClear = panel.querySelector('#route-via-clear');
  if (viaClear) {
    viaClear.addEventListener('click', () => {
      _viaCoord = null;
      _viaKey = null;
      clearViaMarker();
      cancelViaMode(_map);
      if (_startCoord && _endCoord) computeAndDisplayRoute(_startCoord, _endCoord);
    });
  }

  panel.querySelector('#route-download-gpx').addEventListener('click', () => {
    const gpx = generateGpx(_alternatives[_selectedIdx], 'Mountain Route');
    downloadGpx(gpx, 'route.gpx');
  });

  panel.querySelector('#routing-cancel-btn').addEventListener('click', () => {
    clearRouteHighlight(_map);
    clearRoutingMarkers();
    cancelRoutingMode(_map);
    cancelViaMode(_map);
    clearViaMarker();
    _viaCoord = null;
    _viaKey = null;
    window.__routingHasRoute = false;
    document.body.classList.remove('panel-open');
  });
}

function attachAltClickHandler() {
  if (_altClickAttached || !_map) return;
  const bind = () => {
    if (_altClickAttached || !_map.getLayer('route-alt')) return;
    _map.on('click', 'route-alt', (e) => {
      const feature = e.features && e.features[0];
      const idx = feature && feature.properties ? Number(feature.properties.routeIndex) : NaN;
      if (Number.isFinite(idx)) selectRoute(idx);
    });
    _map.on('mouseenter', 'route-alt', () => {
      _map.getCanvas().style.cursor = 'pointer';
    });
    _map.on('mouseleave', 'route-alt', () => {
      if (!window.__routingMode) _map.getCanvas().style.cursor = '';
    });
    _altClickAttached = true;
  };
  if (_map.isStyleLoaded()) bind();
  _map.on('style.load', bind);
}

function showToast(msg) {
  const existing = document.getElementById('route-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'route-toast';
  toast.className = 'route-toast';
  toast.textContent = msg;
  const host = document.getElementById('map-container') || document.body;
  host.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}