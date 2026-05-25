import mapboxgl from 'mapbox-gl';
import { haversineMeters } from './graph';
import type { RouteStep } from './graph';
import RoutingWorker from './routing.worker?worker';
import type { ComputeRequest, ResultMessage, ErrorMessage } from './routing.worker';
import { generateGpx, downloadGpx } from './gpx';
import { setRouteHighlight, setRouteAlternatives, setRouteReturn, clearRouteHighlight } from './highlight';
import {
  startRoutingMode,
  cancelRoutingMode,
  clearRoutingMarkers,
  setRoutingMarkers,
  startViaMode,
  cancelViaMode,
  addViaMarker,
  removeViaMarkerAt,
  clearViaMarkers,
} from './mode';
import { closeNav } from '../nav';
import { bumpPanelToken } from '../map';
import { appState } from '../state';

type Coord = [number, number];
type WorkerResponse = ResultMessage | ErrorMessage;

let _map: mapboxgl.Map | null = null;
let _alternatives: RouteStep[][] = [];
let _selectedIdx = 0;
let _altClickAttached = false;
let _startCoord: Coord | null = null;
let _endCoord: Coord | null = null;
let _viaCoords: Coord[] = [];
let _viaUiAttached = false;
let _panelUserClosed = false;
let _reopenBtn: HTMLElement | null = null;
let _worker: Worker | null = null;
let _latestJobSeq = 0;
let _roundTripActive = false;

export function initRoutingModule(map: mapboxgl.Map): void {
  _map = map;
  injectDrawerSection();
  attachFindRouteButton();
  attachAltClickHandler();
  attachViaUiHandlers();
  createReopenButton();
  if (import.meta.env.DEV) {
    (window as Window & { __debugRoute?: unknown }).__debugRoute = async (startCoord: Coord, endCoord: Coord) => {
      await computeAndDisplayRoute(startCoord, endCoord);
      return {
        altsFound: _alternatives.length,
        altDistances: _alternatives.map((alt) => Math.round(routeDistanceKm(alt) * 1000)),
      };
    };
  }
}

function getWorker(): Worker {
  if (!_worker) _worker = new RoutingWorker();
  return _worker;
}

// Run a compute on the routing worker. Latest-wins: stale results are dropped
// silently so a slow recompute can't overwrite a newer one.
function runWorkerCompute(payload: Omit<ComputeRequest, 'kind' | 'jobId'>): Promise<WorkerResponse | null> {
  const jobId = String(++_latestJobSeq);
  const worker = getWorker();
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.jobId !== jobId) return;
      worker.removeEventListener('message', onMessage);
      if (jobId !== String(_latestJobSeq)) {
        resolve(null);
        return;
      }
      resolve(e.data);
    };
    worker.addEventListener('message', onMessage);
    const request: ComputeRequest = { ...payload, kind: 'compute', jobId };
    worker.postMessage(request);
  });
}

function injectDrawerSection(): void {
  const target = document.getElementById('drawer-section-routing');
  if (!target || document.getElementById('routing-controls')) return;
  const block = document.createElement('div');
  block.id = 'routing-controls';
  block.innerHTML = `
    <button id="routing-find-btn" type="button" class="offline-btn routing-btn">🧭 Find Route</button>
  `;
  target.appendChild(block);
}

function attachFindRouteButton(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target || target.id !== 'routing-find-btn') return;
    if (appState.routingMode) {
      cancelRoutingMode(_map!);
      clearRouteHighlight(_map!);
      clearRoutingMarkers();
      cancelViaMode(_map!);
      clearViaMarkers();
      _viaCoords = [];
      appState.routingHasRoute = false;
      document.body.classList.remove('panel-open');
      syncReopenButton();
      return;
    }
    closeNav();
    cancelViaMode(_map!);
    clearViaMarkers();
    _viaCoords = [];
    startRoutingMode(_map!, async (startCoord, endCoord) => {
      await computeAndDisplayRoute(startCoord, endCoord);
    });
  });
}

async function computeAndDisplayRoute(startCoord: Coord, endCoord: Coord, roundTrip = false): Promise<void> {
  const hadRoute = appState.routingHasRoute;
  appState.routingHasRoute = false;
  _panelUserClosed = false;
  _startCoord = startCoord;
  _endCoord = endCoord;
  _roundTripActive = roundTrip;

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
    const trailsData = await trailsRes.json() as { features?: mapboxgl.GeoJSONFeature[] };
    const ferrataData = await ferrataRes.json() as { features?: mapboxgl.GeoJSONFeature[] };
    const features = [
      ...(trailsData.features ?? []),
      ...(ferrataData.features ?? [])
    ];

    const response = await runWorkerCompute({
      features,
      startCoord,
      endCoord,
      viaCoords: [..._viaCoords],
      roundTrip,
    });

    if (response === null) return; // superseded by a newer request

    if (response.kind === 'error') {
      console.error('Routing worker error:', response.message);
      showToast('Failed to compute route.');
      if (hadRoute) appState.routingHasRoute = true;
      return;
    }

    const outcome = response.outcome;
    switch (outcome.type) {
      case 'no-trails':
        clearRoutingMarkers();
        showToast('No trail data found in this area.');
        if (hadRoute) appState.routingHasRoute = true;
        return;
      case 'no-start':
        clearRoutingMarkers();
        showToast('No trail nearby — click closer to a trail.');
        if (hadRoute) appState.routingHasRoute = true;
        return;
      case 'no-end':
        clearRoutingMarkers();
        showToast('No trail nearby at end point — click closer to a trail.');
        if (hadRoute) appState.routingHasRoute = true;
        return;
      case 'no-via':
        showToast(`No trail nearby at pass-through point ${outcome.viaIdx + 1}.`);
        if (hadRoute) appState.routingHasRoute = true;
        return;
      case 'no-route':
        clearRoutingMarkers();
        showToast('No route found between these points.');
        if (hadRoute) appState.routingHasRoute = true;
        return;
      case 'ok': {
        setRoutingMarkers(_map!, outcome.fromCoord, outcome.toCoord);

        clearViaMarkers();
        for (const coord of outcome.viaCoordsResolved) {
          addViaMarker(_map!, coord);
        }

        _alternatives = outcome.alternatives;
        _selectedIdx = 0;
        appState.routingHasRoute = true;

        if (outcome.roundTrip) {
          setRouteHighlight(_map!, outcome.roundTrip.outbound);
          setRouteReturn(_map!, outcome.roundTrip.returnRoute);
          if (outcome.roundTrip.onlyOnePath) {
            showToast('Only one path available for round trip.');
          }
          if (!_panelUserClosed) showRoutePanel();
        } else {
          renderRoute();
        }
        return;
      }
    }
  } catch (err) {
    console.error('Route computation failed', err);
    if (hadRoute) appState.routingHasRoute = true;
    showToast('Failed to compute route.');
  }
}

function renderRoute(): void {
  const selected = _alternatives[_selectedIdx];
  setRouteHighlight(_map!, selected);
  const altEntries = _alternatives
    .map((route, idx) => ({ route, idx }))
    .filter(({ idx }) => idx !== _selectedIdx);
  setRouteAlternatives(
    _map!,
    altEntries.map((entry) => entry.route),
    altEntries.map((entry) => entry.idx)
  );
  if (!_panelUserClosed) {
    showRoutePanel();
  }
}

function selectRoute(idx: number): void {
  if (!Number.isFinite(idx)) return;
  if (idx < 0 || idx >= _alternatives.length) return;
  if (idx === _selectedIdx) return;
  _selectedIdx = idx;
  renderRoute();
}

function routeDistanceKm(edges: RouteStep[]): number {
  let total = 0;
  for (const { coords, reversed } of edges) {
    const seg = reversed ? [...coords].reverse() : coords;
    for (let i = 1; i < seg.length; i++) total += haversineMeters(seg[i], seg[i - 1]);
  }
  return total / 1000;
}

function showRoutePanel(): void {
  bumpPanelToken();
  const panel = document.getElementById('panel');
  if (!panel) return;
  document.body.classList.add('panel-open');

  const selected = _alternatives[_selectedIdx];
  const distKm = routeDistanceKm(selected).toFixed(1);
  const viaActive = _viaCoords.length > 0;
  const viaPicking = !!appState.routingViaMode;
  const roundtripDisabled = (viaActive || viaPicking) ? 'disabled' : '';
  const roundtripTitle = viaPicking
    ? 'Finish or cancel pass-through selection to enable round trip.'
    : (viaActive ? 'Disable pass-through points to enable round trip.' : '');

  const primaryLabel = viaActive ? 'Least overlap' : 'Shortest';
  const altItems = _alternatives.length > 1
    ? _alternatives.map((route, i) => {
      const d = routeDistanceKm(route).toFixed(1);
      return `<li class="route-alt-item${i === _selectedIdx ? ' route-alt-selected' : ''}" data-idx="${i}">
        ${i === 0 ? primaryLabel : `Alternative ${i}`} — ${d} km
      </li>`;
    }).join('')
    : '';

  const altSection = _alternatives.length > 1
    ? `<ul class="route-alt-list">${altItems}</ul>`
    : `<p class="route-alt-empty">No alternatives for this route.</p>`;

  const viaListItems = _viaCoords.map((_, i) =>
    `<li class="route-via-list-item">
      <span class="route-via-list-label">Via ${i + 1}</span>
      <button class="route-via-remove" data-idx="${i}" aria-label="Remove via ${i + 1}">✕</button>
    </li>`
  ).join('');

  const viaListSection = viaActive
    ? `<ul class="route-via-list">${viaListItems}</ul>`
    : '';

  const viaCardClass = viaPicking ? 'route-via-card is-picking' : (viaActive ? 'route-via-card is-active' : 'route-via-card');
  const atMax = _viaCoords.length >= 4;
  const viaAddBtn = viaPicking
    ? `<button id="route-via-cancel" class="offline-btn route-via-btn route-via-btn-cancel">Cancel selection</button>`
    : `<button id="route-via-add" class="offline-btn route-via-btn" ${atMax ? 'disabled title="Maximum 4 pass-through points"' : ''}>+ Add pass-through</button>`;
  const viaNote = viaPicking
    ? 'Click on the map to set the pass-through point.'
    : (viaActive ? `${_viaCoords.length} / 4 active — route passes through each.` : 'Add mandatory waypoints to shape the route.');

  panel.innerHTML = `
    <button id="panel-close" class="panel-close-btn" aria-label="Close">×</button>
    <h2>Route</h2>
    <p class="route-distance">${distKm} km</p>
    <label class="route-roundtrip-label" title="${roundtripTitle}">
      <input type="checkbox" id="route-roundtrip" ${roundtripDisabled}> 🔄 Round trip
    </label>
    <div class="${viaCardClass}">
      <div class="route-via-header">
        <span class="route-via-title">Pass-through points</span>
        ${viaActive ? `<span class="route-via-count">${_viaCoords.length} / 4</span>` : ''}
      </div>
      ${viaListSection}
      <p class="route-via-note">${viaNote}</p>
      <div class="route-via-actions">
        ${viaAddBtn}
      </div>
    </div>
    ${altSection}
    <div class="route-actions">
      <button id="route-download-gpx" class="offline-btn">⬇ Download GPX</button>
      <button id="routing-cancel-btn" class="offline-btn">✕ Cancel</button>
    </div>
  `;

  panel.querySelector('#panel-close')!.addEventListener('click', () => {
    _panelUserClosed = true;
    document.body.classList.remove('panel-open');
    syncReopenButton();
  });

  const roundtripEl = panel.querySelector('#route-roundtrip') as HTMLInputElement;
  if (_roundTripActive) roundtripEl.checked = true;
  roundtripEl.addEventListener('change', (e) => {
    if (viaActive || viaPicking) return;
    const checked = (e.target as HTMLInputElement).checked;
    if (checked) {
      if (_startCoord && _endCoord) void computeAndDisplayRoute(_startCoord, _endCoord, true);
    } else {
      _roundTripActive = false;
      renderRoute();
    }
  });

  const altList = panel.querySelector('.route-alt-list');
  if (altList) {
    altList.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.route-alt-item') as HTMLElement | null;
      if (!item) return;
      selectRoute(parseInt(item.dataset['idx'] ?? '', 10));
    });
  }

  const viaAddBtnEl = panel.querySelector('#route-via-add');
  if (viaAddBtnEl) {
    viaAddBtnEl.addEventListener('click', () => {
      if (!_startCoord || !_endCoord || _viaCoords.length >= 4) return;
      cancelViaMode(_map!);
      startViaMode(_map!, (coord) => {
        _viaCoords.push(coord);
        void computeAndDisplayRoute(_startCoord!, _endCoord!);
      });
      showRoutePanel();
    });
  }

  const viaCancel = panel.querySelector('#route-via-cancel');
  if (viaCancel) {
    viaCancel.addEventListener('click', () => {
      cancelViaMode(_map!);
      showRoutePanel();
    });
  }

  panel.querySelectorAll('.route-via-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset['idx'] ?? '', 10);
      if (!Number.isFinite(idx)) return;
      _viaCoords.splice(idx, 1);
      removeViaMarkerAt(idx);
      if (_startCoord && _endCoord) void computeAndDisplayRoute(_startCoord, _endCoord);
    });
  });

  panel.querySelector('#route-download-gpx')!.addEventListener('click', () => {
    const gpx = generateGpx(_alternatives[_selectedIdx], 'Mountain Route');
    downloadGpx(gpx, 'route.gpx');
  });

  panel.querySelector('#routing-cancel-btn')!.addEventListener('click', () => {
    clearRouteHighlight(_map!);
    clearRoutingMarkers();
    cancelRoutingMode(_map!);
    cancelViaMode(_map!);
    _viaCoords = [];
    appState.routingHasRoute = false;
    _roundTripActive = false;
    syncReopenButton();
    showNewRoutePanel();
  });
}

function showNewRoutePanel(): void {
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

  panel.querySelector('#panel-close')!.addEventListener('click', () => {
    _panelUserClosed = true;
    document.body.classList.remove('panel-open');
    syncReopenButton();
  });

  panel.querySelector('#route-new-btn')!.addEventListener('click', () => {
    document.body.classList.remove('panel-open');
    cancelViaMode(_map!);
    clearViaMarkers();
    _viaCoords = [];
    startRoutingMode(_map!, async (startCoord, endCoord) => {
      await computeAndDisplayRoute(startCoord, endCoord);
    });
  });
}

function attachAltClickHandler(): void {
  if (_altClickAttached || !_map) return;
  const bind = () => {
    if (_altClickAttached || !_map!.getLayer('route-alt')) return;
    _map!.on('click', 'route-alt', (e) => {
      const feature = e.features && e.features[0];
      const idx = feature && feature.properties ? Number(feature.properties['routeIndex']) : NaN;
      if (Number.isFinite(idx)) selectRoute(idx);
    });
    _map!.on('mouseenter', 'route-alt', () => {
      if (appState.routingMode || appState.routingViaMode || appState.drawMode) return;
      _map!.getCanvas().style.cursor = 'pointer';
    });
    _map!.on('mouseleave', 'route-alt', () => {
      if (!appState.routingMode && !appState.routingViaMode && !appState.drawMode) _map!.getCanvas().style.cursor = '';
    });
    _altClickAttached = true;
  };
  if (_map.isStyleLoaded()) bind();
  _map.on('style.load', bind);
}

function showToast(msg: string): void {
  const existing = document.getElementById('route-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'route-toast';
  toast.className = 'route-toast';
  toast.textContent = msg;
  const host = document.getElementById('map-container') ?? document.body;
  host.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function attachViaUiHandlers(): void {
  if (_viaUiAttached) return;
  window.addEventListener('routing:via-start', () => {
    if (document.body.classList.contains('panel-open')) showRoutePanel();
  });
  window.addEventListener('routing:via-cancel', () => {
    if (document.body.classList.contains('panel-open')) showRoutePanel();
  });
  _viaUiAttached = true;
}

function syncReopenButton(): void {
  if (!_reopenBtn) return;
  const hasRoute = !!appState.routingHasRoute;
  const panelOpen = document.body.classList.contains('panel-open');
  _reopenBtn.hidden = !(hasRoute && !panelOpen);
}

function createReopenButton(): void {
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
  const host = document.getElementById('map-container') ?? document.body;
  host.appendChild(btn);
  _reopenBtn = btn;

  new MutationObserver(() => {
    if (!document.body.classList.contains('panel-open') && appState.routingHasRoute) {
      _panelUserClosed = true;
    }
    syncReopenButton();
  }).observe(document.body, { attributeFilter: ['class'] });
}
