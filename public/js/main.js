import { addMapLayers, setupMapInteractivity, setupStyleSwitcher, fetchDynamicData, applyOverlayVisibility } from './map.js';
import { initSearch } from './search.js';
import { initOfflineModule } from './offline.js';
import { closePanel } from './ui.js';
import { initNav } from './nav.js';

initNav();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('panel-open')) {
    closePanel();
  }
});

mapboxgl.accessToken = 'pk.eyJ1IjoiZGFuaW1lcmkiLCJhIjoiY21uZzFhaWdpMDIyajJyczY4YWFudzJ2ZyJ9.CbG1-cZKowq0cF8qCw2RDw';

if (typeof mapboxgl.setTelemetryEnabled === 'function') {
  mapboxgl.setTelemetryEnabled(false);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('SW registration failed', err);
    });
  });
}

// Rewrite mapbox:// URIs to real HTTPS so the service worker can cache them.
function mapboxTransformRequest(url) {
  if (url.startsWith('mapbox://styles/')) {
    return { url: url.replace('mapbox://styles/', 'https://api.mapbox.com/styles/v1/') + '?access_token=' + mapboxgl.accessToken };
  }
  if (url.startsWith('mapbox://sprites/')) {
    return { url: url.replace('mapbox://sprites/', 'https://api.mapbox.com/styles/v1/') + '/sprite?access_token=' + mapboxgl.accessToken };
  }
  if (url.startsWith('mapbox://fonts/')) {
    return { url: url.replace('mapbox://fonts/', 'https://api.mapbox.com/fonts/v1/') + '?access_token=' + mapboxgl.accessToken };
  }
  if (url.startsWith('mapbox://')) {
    return { url: 'https://api.mapbox.com/v4/' + url.slice(9) + '?access_token=' + mapboxgl.accessToken };
  }
  if (url.includes('tile.openstreetmap.org')) {
    return { url, referrerPolicy: 'origin' };
  }
  return { url };
}

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/outdoors-v12',
  center: [9.64, 46.26],
  zoom: 12,
  performanceMetricsCollection: false,
  transformRequest: mapboxTransformRequest
});

window.__map = map;
map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');

const geolocate = new mapboxgl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  showUserHeading: true
});
map.addControl(geolocate, 'bottom-right');
window.__geolocateControl = geolocate;

function setupFullscreenMapOption(mapInstance) {
  const toggleBtn = document.getElementById('toggle-map-fullscreen');
  if (!toggleBtn) return;

  const allowFullscreen = window.matchMedia('(min-width: 768px)').matches;
  if (!allowFullscreen) {
    toggleBtn.setAttribute('aria-hidden', 'true');
    toggleBtn.tabIndex = -1;
    return;
  }

  const root = document.body;
  const main = document.querySelector('main');
  const panel = document.getElementById('panel');
  const mapContainer = document.getElementById('map-container');

  let resizeRaf = 0;
  let resizeTailTimer = 0;
  let transitionResizeRaf = 0;

  const scheduleResize = () => {
    if (resizeRaf) {
      cancelAnimationFrame(resizeRaf);
    }
    resizeRaf = requestAnimationFrame(() => {
      mapInstance.resize();
      resizeRaf = 0;
    });

    if (resizeTailTimer) {
      clearTimeout(resizeTailTimer);
    }
    resizeTailTimer = window.setTimeout(() => {
      mapInstance.resize();
      resizeTailTimer = 0;
    }, 320);
  };

  const runTransitionResize = (durationMs = 420) => {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      mapInstance.resize();
      return;
    }

    if (transitionResizeRaf) {
      cancelAnimationFrame(transitionResizeRaf);
    }

    const start = performance.now();
    const tick = (now) => {
      mapInstance.resize();
      if (now - start < durationMs) {
        transitionResizeRaf = requestAnimationFrame(tick);
      } else {
        transitionResizeRaf = 0;
      }
    };

    transitionResizeRaf = requestAnimationFrame(tick);
  };

  const setFullscreenState = (enabled) => {
    mapInstance.stop();
    root.classList.toggle('map-fullscreen', enabled);

    const label = enabled ? 'Exit fullscreen map mode' : 'Enter fullscreen map mode';
    toggleBtn.setAttribute('aria-pressed', String(enabled));
    toggleBtn.setAttribute('aria-label', label);
    toggleBtn.title = label;
    toggleBtn.innerHTML = enabled
      ? '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><polyline points="1,7 7,7 7,1"/><polyline points="11,1 11,7 17,7"/><polyline points="17,11 11,11 11,17"/><polyline points="7,17 7,11 1,11"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><polyline points="1,7 1,1 7,1"/><polyline points="11,1 17,1 17,7"/><polyline points="17,11 17,17 11,17"/><polyline points="7,17 1,17 1,11"/></svg>';

    window.dispatchEvent(new Event('layout:changed'));
    runTransitionResize();
  };

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setFullscreenState(!root.classList.contains('map-fullscreen'));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root.classList.contains('map-fullscreen')) {
      setFullscreenState(false);
    }
  });

  const onTransitionEnd = (event) => {
    if (
      event.propertyName === 'grid-template-columns' ||
      event.propertyName === 'transform' ||
      event.propertyName === 'padding' ||
      event.propertyName === 'gap' ||
      event.propertyName === 'border-width'
    ) {
      scheduleResize();
    }
  };

  if (main) {
    main.addEventListener('transitionend', onTransitionEnd);
  }
  if (panel) {
    panel.addEventListener('transitionend', onTransitionEnd);
  }

  if (mapContainer && typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      scheduleResize();
    });
    observer.observe(mapContainer);
  }

  scheduleResize();

  // Set initial icon (page loads in normal mode, not fullscreen)
  setFullscreenState(false);
}

// Initialize layers and custom logic when map style loads
map.on('style.load', () => {
  addMapLayers(map);
  applyOverlayVisibility(map);
  fetchDynamicData(map);
});

// Setup click and hover events
setupMapInteractivity(map);

// Setup the style switcher (Outdoors/Satellite)
setupStyleSwitcher(map);

// Setup fullscreen map mode
setupFullscreenMapOption(map);

// Initialize search bar functionality
initSearch(map);

// Initialize offline-area downloader and saved-area registry
initOfflineModule(map);

// Resize map when panel content changes (e.g. POI selected, AI description loaded)
window.addEventListener('panel:updated', () => {
  requestAnimationFrame(() => map.resize());
});
