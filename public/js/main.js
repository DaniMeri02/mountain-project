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

// Initialize layers and custom logic when map style loads
map.on('style.load', () => {
  addMapLayers(map);
  
  // Sync checkbox state AFTER layers are created
  const toggleTrailsBtn = document.getElementById('toggle-trails');
  if (toggleTrailsBtn && map.getLayer('trails-lines')) {
    const initialVis = toggleTrailsBtn.checked ? 'visible' : 'none';
    map.setLayoutProperty('trails-lines', 'visibility', initialVis);
  }
  
  // Automatically trigger the first fetch once layers are loaded!
  fetchDynamicData(map);
});

// Setup click and hover events
setupMapInteractivity(map);

// Setup the style switcher (Outdoors/Satellite)
setupStyleSwitcher(map);

// Initialize search bar functionality
initSearch(map);
