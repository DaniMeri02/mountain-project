import { buildGraph, snapToNode, findAlternatives, findViaAlternatives, findRoundTrip, haversineMeters, dijkstra, findBestSnappedRoute } from './graph.js';
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
let _viaUiAttached = false;
let _panelUserClosed = false;
let _reopenBtn = null;

export function initRoutingModule(map) {
  _map = map;
  injectDrawerSection();
  attachFindRouteButton();
  attachAltClickHandler();
  attachViaUiHandlers();
  createReopenButton();
  window.__debugRoute = async (startCoord, endCoord) => {
    await computeAndDisplayRoute(startCoord, endCoord);
    if (!_graph) return { error: 'no graph' };
    const fromNode = _graph.nodes.get(_fromKey);
    const toNode = _graph.nodes.get(_toKey);
    const compSizes = new Map();
    for (const node of _graph.nodes.values()) compSizes.set(node.componentSize, (compSizes.get(node.componentSize) || 0) + 1);
    return {
      nodes: _graph.nodes.size, edges: _graph.edges.length,
      fromKey: _fromKey, toKey: _toKey,
      fromCoord: fromNode?.coord, toCoord: toNode?.coord,
      fromCompSize: fromNode?.componentSize, toCompSize: toNode?.componentSize,
      sameComp: fromNode && toNode && fromNode.componentSize === toNode.componentSize,
      altsFound: _alternatives.length,
      altDistances: _alternatives.map(alt => { let d=0; for(const {coords,reversed} of alt){const seg=reversed?[...coords].reverse():coords;for(let i=1;i<seg.length;i++){const[lg1,la1]=seg[i-1],[lg2,la2]=seg[i];const dLat=(la2-la1)*Math.PI/180,dLng=(lg2-lg1)*Math.PI/180;const a=Math.sin(dLat/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLng/2)**2;d+=6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}}return Math.round(d); }),
      compDistribution: Object.fromEntries([...compSizes].sort((a,b)=>b[0]-a[0]).slice(0,8)),
    };
  };
  window.__debugGaps = (compSizeA, compSizeB) => {
    if (!_graph) return 'no graph';
    const nodesA = [..._graph.nodes.values()].filter(n => n.componentSize === compSizeA);
    const nodesB = [..._graph.nodes.values()].filter(n => n.componentSize === compSizeB);
    let minDist = Infinity, bestA = null, bestB = null;
    for (const a of nodesA) {
      for (const b of nodesB) {
        const d = haversineMeters(a.coord, b.coord);
        if (d < minDist) { minDist = d; bestA = a.coord; bestB = b.coord; }
      }
    }
    return { minGapMeters: Math.round(minDist), coordA: bestA, coordB: bestB };
  };
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
      syncReopenButton();
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
  _panelUserClosed = false;
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
    let best = findBestSnappedRoute(_graph, startCoord, endCoord, { maxMeters: 300, candidateLimit: 6 });

    if (!best.startCandidates.length) {
      clearRoutingMarkers();
      showToast('No trail nearby — click closer to a trail.');
      if (hadRoute) window.__routingHasRoute = true;
      return;
    }
    if (!best.endCandidates.length) {
      clearRoutingMarkers();
      showToast('No trail nearby at end point — click closer to a trail.');
      if (hadRoute) window.__routingHasRoute = true;
      return;
    }

    // If no path was found, retry by preferring larger components.
    if (!best.path) {
      let maxComp = 0;
      for (const n of _graph.nodes.values()) if (n.componentSize > maxComp) maxComp = n.componentSize;
      const minComp = Math.max(10, Math.floor(maxComp * 0.05));
      const retry = findBestSnappedRoute(_graph, startCoord, endCoord, { maxMeters: 500, candidateLimit: 6, minComponentSize: minComp });
      if (retry.path) best = retry;
    }

    if (!best.path || !best.fromKey || !best.toKey) {
      clearRoutingMarkers();
      showToast('No route found between these points.');
      if (hadRoute) window.__routingHasRoute = true;
      return;
    }

    _fromKey = best.fromKey;
    _toKey = best.toKey;

    const fromNode = _graph.nodes.get(_fromKey);
    const toNode = _graph.nodes.get(_toKey);
    if (fromNode || toNode) setRoutingMarkers(_map, fromNode && fromNode.coord, toNode && toNode.coord);

    if (_viaCoord) {
      const viaRoutes = buildViaRoute();
      if (!viaRoutes) {
        if (hadRoute) window.__routingHasRoute = true;
        return;
      }
      _alternatives = viaRoutes;
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
  if (!_panelUserClosed) {
    showRoutePanel();
  }
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
  const alts = findViaAlternatives(_graph, _fromKey, viaKey, _toKey);
  if (!alts.length) {
    showToast('No route found through pass-through point.');
    return null;
  }
  return alts;
}

function showRoutePanel() {
  bumpPanelToken();
  const panel = document.getElementById('panel');
  if (!panel) return;
  document.body.classList.add('panel-open');

  const selected = _alternatives[_selectedIdx];
  const distKm = routeDistanceKm(selected).toFixed(1);
  const viaActive = !!_viaCoord;
  const viaPicking = !!window.__routingViaMode;
  const roundtripDisabled = (viaActive || viaPicking) ? 'disabled' : '';
  const roundtripTitle = viaPicking
    ? 'Finish or cancel pass-through selection to enable round trip.'
    : (viaActive ? 'Disable pass-through to enable round trip.' : '');

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

  const viaButtonLabel = viaActive ? 'Change pass-through' : 'Add pass-through';
  const viaPrimaryButton = viaPicking
    ? ''
    : `<button id="route-via-btn" class="offline-btn route-via-btn">${viaButtonLabel}</button>`;
  const viaClearButton = viaActive && !viaPicking
    ? '<button id="route-via-clear" class="offline-btn route-via-btn">Clear</button>'
    : '';
  const viaCancelButton = viaPicking
    ? '<button id="route-via-cancel" class="offline-btn route-via-btn route-via-btn-cancel">Cancel selection</button>'
    : '';
  const viaNote = viaPicking
    ? 'Click on the map to set the pass-through point.'
    : (viaActive ? 'Pass-through point active.' : 'Add a mandatory waypoint to shape the route.');
  const viaStatusClass = viaPicking
    ? 'route-via-status is-picking'
    : (viaActive ? 'route-via-status is-active' : 'route-via-status');
  const viaStatusText = viaPicking ? 'Selecting' : (viaActive ? 'Active' : 'Not set');
  const viaCardClass = viaPicking
    ? 'route-via-card is-picking'
    : (viaActive ? 'route-via-card is-active' : 'route-via-card');

  panel.innerHTML = `
    <button id="panel-close" class="panel-close-btn" aria-label="Close">×</button>
    <h2>Route</h2>
    <p class="route-distance">${distKm} km</p>
    <label class="route-roundtrip-label" title="${roundtripTitle}">
      <input type="checkbox" id="route-roundtrip" ${roundtripDisabled}> 🔄 Round trip
    </label>
    <div class="${viaCardClass}">
      <div class="route-via-header">
        <span class="route-via-title">Pass-through point</span>
        <span class="${viaStatusClass}">${viaStatusText}</span>
      </div>
      <p class="route-via-note">${viaNote}</p>
      <div class="route-via-actions">
        ${viaPrimaryButton}
        ${viaClearButton}
        ${viaCancelButton}
      </div>
    </div>
    ${altSection}
    <div class="route-actions">
      <button id="route-download-gpx" class="offline-btn">⬇ Download GPX</button>
      <button id="routing-cancel-btn" class="offline-btn">✕ Cancel</button>
    </div>
  `;

  panel.querySelector('#panel-close').addEventListener('click', () => {
    _panelUserClosed = true;
    document.body.classList.remove('panel-open');
    syncReopenButton();
  });

  panel.querySelector('#route-roundtrip').addEventListener('change', (e) => {
    if (viaActive || viaPicking) return;
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

  const viaBtn = panel.querySelector('#route-via-btn');
  if (viaBtn) {
    viaBtn.addEventListener('click', () => {
      if (!_startCoord || !_endCoord) return;
      cancelViaMode(_map);
      startViaMode(_map, (coord) => {
        _viaCoord = coord;
        computeAndDisplayRoute(_startCoord, _endCoord);
      });
      showRoutePanel();
    });
  }

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

  const viaCancel = panel.querySelector('#route-via-cancel');
  if (viaCancel) {
    viaCancel.addEventListener('click', () => {
      cancelViaMode(_map);
      showRoutePanel();
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
    syncReopenButton();
    showNewRoutePanel();
  });
}

function showNewRoutePanel() {
  bumpPanelToken();
  const panel = document.getElementById('panel');
  if (!panel) return;
  document.body.classList.add('panel-open');
  _panelUserClosed = false;

  panel.innerHTML = `
    <button id="panel-close" class="panel-close-btn" aria-label="Close">×</button>
    <h2>Route</h2>
    <p class="route-alt-empty">Pick start and end points on the map.</p>
    <div class="route-actions">
      <button id="route-new-btn" class="offline-btn routing-btn">🧭 New Route</button>
    </div>
  `;

  panel.querySelector('#panel-close').addEventListener('click', () => {
    _panelUserClosed = true;
    document.body.classList.remove('panel-open');
    syncReopenButton();
  });

  panel.querySelector('#route-new-btn').addEventListener('click', () => {
    document.body.classList.remove('panel-open');
    cancelViaMode(_map);
    clearViaMarker();
    _viaCoord = null;
    _viaKey = null;
    startRoutingMode(_map, async (startCoord, endCoord) => {
      await computeAndDisplayRoute(startCoord, endCoord);
    });
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
      if (window.__routingMode || window.__routingViaMode || window.__drawMode) return;
      _map.getCanvas().style.cursor = 'pointer';
    });
    _map.on('mouseleave', 'route-alt', () => {
      if (!window.__routingMode && !window.__routingViaMode && !window.__drawMode) _map.getCanvas().style.cursor = '';
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

function attachViaUiHandlers() {
  if (_viaUiAttached) return;
  window.addEventListener('routing:via-start', () => {
    if (document.body.classList.contains('panel-open')) showRoutePanel();
  });
  window.addEventListener('routing:via-cancel', () => {
    if (document.body.classList.contains('panel-open')) showRoutePanel();
  });
  _viaUiAttached = true;
}

function syncReopenButton() {
  if (!_reopenBtn) return;
  const hasRoute = !!window.__routingHasRoute;
  const panelOpen = document.body.classList.contains('panel-open');
  _reopenBtn.hidden = !(hasRoute && !panelOpen);
}

function createReopenButton() {
  const btn = document.createElement('button');
  btn.id = 'route-reopen-btn';
  btn.type = 'button';
  btn.className = 'route-reopen-btn';
  btn.textContent = '🗺 Route';
  btn.hidden = true;
  btn.addEventListener('click', () => {
    _panelUserClosed = false;
    showRoutePanel();
    syncReopenButton();
  });
  const host = document.getElementById('map-container') || document.body;
  host.appendChild(btn);
  _reopenBtn = btn;

  new MutationObserver(() => {
    if (!document.body.classList.contains('panel-open') && window.__routingHasRoute) {
      _panelUserClosed = true;
    }
    syncReopenButton();
  }).observe(document.body, { attributeFilter: ['class'] });
}