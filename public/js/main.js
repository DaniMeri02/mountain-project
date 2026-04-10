import { addMapLayers, setupMapInteractivity, setupStyleSwitcher, fetchDynamicData } from './map.js';
import { initSearch } from './search.js';

mapboxgl.accessToken = 'pk.eyJ1IjoiZGFuaW1lcmkiLCJhIjoiY21uZzFhaWdpMDIyajJyczY4YWFudzJ2ZyJ9.CbG1-cZKowq0cF8qCw2RDw';

if (typeof mapboxgl.setTelemetryEnabled === 'function') {
  mapboxgl.setTelemetryEnabled(false);
}

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/outdoors-v12',
  center: [9.64, 46.26], // Centered around Val Masino / Disgrazia to view the downloaded paths!
  zoom: 12,
  performanceMetricsCollection: false
});

map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');

function setupFullscreenMapOption(mapInstance) {
  const toggleBtn = document.getElementById('toggle-map-fullscreen');
  if (!toggleBtn) return;

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
    mapInstance.resize();
    scheduleResize();

    root.classList.toggle('map-fullscreen', enabled);
    mapInstance.resize();

    const label = enabled ? 'Exit fullscreen map mode' : 'Enter fullscreen map mode';
    toggleBtn.setAttribute('aria-pressed', String(enabled));
    toggleBtn.setAttribute('aria-label', label);
    toggleBtn.title = label;
    toggleBtn.textContent = enabled ? '🗗' : '⛶';

    window.dispatchEvent(new Event('layout:changed'));

    scheduleResize();
    runTransitionResize();
  };

  toggleBtn.addEventListener('click', () => {
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
}

// Initialize layers and custom logic when map style loads
map.on('style.load', () => {
  addMapLayers(map);

  // Sync checkbox state AFTER layers are created
  const toggleTrailsBtn = document.getElementById('toggle-trails');
  if (toggleTrailsBtn && map.getLayer('trails-lines')) {
    const initialVis = toggleTrailsBtn.checked ? 'visible' : 'none';
    map.setLayoutProperty('trails-lines', 'visibility', initialVis);
  }

  const toggleFerrataBtn = document.getElementById('toggle-ferrata');
  if (toggleFerrataBtn && map.getLayer('ferrata-lines')) {
    const initialVis = toggleFerrataBtn.checked ? 'visible' : 'none';
    map.setLayoutProperty('ferrata-lines', 'visibility', initialVis);
  }
  
  // Automatically trigger the first fetch once layers are loaded!
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
