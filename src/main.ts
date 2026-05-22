import 'mapbox-gl/dist/mapbox-gl.css';
import mapboxgl from 'mapbox-gl';
import { addMapLayers, setupMapInteractivity, setupStyleSwitcher, fetchDynamicData, applyOverlayVisibility } from './map';
import { initSearch } from './search';
import { initOfflineModule } from './offline/index';
import { initRoutingModule } from './routing/index';
import { closePanel } from './ui';
import { initNav } from './nav';
import { appState } from './state';

initNav();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('panel-open')) {
    closePanel();
  }
});

if (typeof (mapboxgl as Record<string, unknown>)['setTelemetryEnabled'] === 'function') {
  (mapboxgl as unknown as { setTelemetryEnabled: (v: boolean) => void }).setTelemetryEnabled(false);
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('SW registration failed', err);
    });
  });
}

// Rewrite mapbox:// URIs to real HTTPS so the service worker can cache them.
function mapboxTransformRequest(url: string): mapboxgl.RequestParameters {
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

(async () => {
  // Token is served from the backend env var — never hardcoded in source.
  let mapboxToken = '';
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const config = await res.json() as { mapboxToken?: string };
      mapboxToken = config.mapboxToken ?? '';
    }
  } catch (err) {
    console.error('Failed to fetch app config:', err);
  }

  if (!mapboxToken) {
    console.error('Mapbox token not configured. Add MAPBOX_TOKEN to server .env');
    return;
  }

  mapboxgl.accessToken = mapboxToken;

  let savedCenter: [number, number] = [9.64, 46.26];
  let savedZoom = 12;
  try {
    const sc = localStorage.getItem('map:center');
    const sz = localStorage.getItem('map:zoom');
    if (sc) savedCenter = JSON.parse(sc) as [number, number];
    if (sz) savedZoom = Number(sz);
  } catch { /* ignore corrupt localStorage */ }

  const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/outdoors-v12',
    center: savedCenter,
    zoom: savedZoom,
    performanceMetricsCollection: false,
    transformRequest: mapboxTransformRequest
  });

  appState.map = map;
  (window as Window & { __debugMap?: mapboxgl.Map }).__debugMap = map;
  map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');

  const geolocate = new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true
  });
  map.addControl(geolocate, 'bottom-right');
  appState.geolocateControl = geolocate;

  function setupFullscreenMapOption(mapInstance: mapboxgl.Map): void {
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

    let resizeRaf: number = 0;
    let resizeTailTimer: number = 0;
    let transitionResizeRaf: number = 0;

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
      resizeTailTimer = setTimeout(() => {
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
      const tick = (now: number) => {
        mapInstance.resize();
        if (now - start < durationMs) {
          transitionResizeRaf = requestAnimationFrame(tick);
        } else {
          transitionResizeRaf = 0;
        }
      };

      transitionResizeRaf = requestAnimationFrame(tick);
    };

    const setFullscreenState = (enabled: boolean) => {
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

    const onTransitionEnd = (event: TransitionEvent) => {
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

  // Initialize trail route finder
  initRoutingModule(map);

  map.on('moveend', () => {
    try {
      const c = map.getCenter();
      localStorage.setItem('map:center', JSON.stringify([c.lng, c.lat]));
      localStorage.setItem('map:zoom', String(map.getZoom()));
    } catch { /* ignore quota errors */ }
  });

  // Resize map when panel content changes (e.g. POI selected, AI description loaded)
  window.addEventListener('panel:updated', () => {
    requestAnimationFrame(() => map.resize());
  });
})();
