import { loadIcons } from './icons.js';
import { updatePanel } from './ui.js';

// We store the current selection to know if 3D should be applied after a style loads
let currentMode = 'outdoors-v12';
let latestFetchToken = 0;

// Cache features by OSM id so zoom transitions do not blank the layer
// while awaiting the next viewport response.
const trailFeatureCache = new Map();
const poiFeatureCache = new Map();
const ferrataFeatureCache = new Map();

function featureKey(feature) {
  const props = feature && feature.properties ? feature.properties : {};
  return String(props.osm_id || props.id || '');
}

function mergeIntoCache(cache, features) {
  if (!Array.isArray(features)) return;
  for (const feature of features) {
    const key = featureKey(feature);
    if (key) cache.set(key, feature);
  }
}

function cacheToFeatureCollection(cache) {
  return {
    type: 'FeatureCollection',
    features: Array.from(cache.values())
  };
}

export function addMapLayers(map) {
  // Load custom marker icons
  loadIcons(map);

  // Re-apply 3D Terrain if the selected mode demands it
  if (currentMode === 'satellite-3d') {
    if (!map.getSource('mapbox-dem')) {
      map.addSource('mapbox-dem', {
        'type': 'raster-dem',
        'url': 'mapbox://mapbox.mapbox-terrain-dem-v1',
        'tileSize': 512,
        'maxzoom': 14
      });
    }
    // Enable 3D terrain with exaggeration
    map.setTerrain({ 'source': 'mapbox-dem', 'exaggeration': 1.5 });

    // Add sky layer for better atmosphere effect when tilted
    if (!map.getLayer('sky')) {
      map.addLayer({
        'id': 'sky',
        'type': 'sky',
        'paint': {
          'sky-type': 'atmosphere',
          'sky-atmosphere-sun': [0.0, 0.0],
          'sky-atmosphere-sun-intensity': 15
        }
      });
    }
  } else {
    // Reset to flat/top-down logic for non-3D modes (though setStyle clears some natively)
    map.setTerrain(null);
  }

  // Add data source
  if (!map.getSource('mountain-pois')) {
    map.addSource('mountain-pois', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      maxzoom: 14,
      buffer: 128
    });
  }

  // Add visualization layer
  if (!map.getLayer('pois-points')) {
    map.addLayer({
      id: 'pois-points',
      type: 'symbol',
      source: 'mountain-pois',
      minzoom: 7, // Load icons even when zoomed out a bit
      layout: {
        'symbol-sort-key': ['*', -1, ['to-number', ['get', 'sort_elevation']]], // Prioritize higher peaks
        // This adds a "buffer" space around icons, pushing lesser peaks further away
        'icon-padding': 15,
        'text-padding': 10,
        'icon-image': [
          'match',
          ['get', 'type'],
          'hut', 'hut-icon',
          'bivouac', 'bivouac-icon',
          'peak', 'peak-icon',
          'hut-icon'
        ],
        'icon-size': 1,
        'icon-allow-overlap': false, // Let Mapbox organically hide colliding icons!
        'text-allow-overlap': false,
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-size': 11,
        'text-anchor': 'top',
        'text-offset': [0, 0.6]
      },
      paint: {
        'text-color': '#4a4a4a',
        'text-halo-color': 'rgba(255,255,255,0.9)',
        'text-halo-width': 1.5
      }
    });
  }

  // Add trails data source (Starting empty instead of huge file)
  if (!map.getSource('mountain-trails')) {
    map.addSource('mountain-trails', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      buffer: 256, // Increased buffer for high-zoom line rendering
      lineMetrics: true
    });
  }

  // Add trails visual layer
  if (!map.getLayer('trails-lines')) {
    // Always start trails as visible - setupStyleSwitcher will sync checkbox state
    const isVisible = 'visible';

    const styleLayers = map.getStyle().layers || [];
    const labelAnchorIds = [
      'road-label',
      'poi-label',
      'mountain_peak-label',
      'settlement-label',
      'place-label'
    ];
    const explicitAnchor = styleLayers.find((layer) => labelAnchorIds.includes(layer.id));
    const firstSymbolLayer = styleLayers.find((layer) => layer.type === 'symbol');
    const trailsBeforeLayerId = (explicitAnchor && explicitAnchor.id) || (firstSymbolLayer && firstSymbolLayer.id);

    map.addLayer({
      id: 'trails-lines',
      type: 'line',
      source: 'mountain-trails',
      minzoom: 12,
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
        'visibility': isVisible
      },
      paint: {
        'line-color': [
          'match',
          ['get', 'sac_scale'],
          'track', '#9E9E9E',
          'footway', '#B0BEC5',
          'bridleway', '#8D6E63',
          'steps', '#607D8B',
          'cycleway', '#26A69A',
          'hiking', '#4CAF50',
          'mountain_hiking', '#FFC107',
          'demanding_mountain_hiking', '#FF9800',
          'alpine_hiking', '#F44336',
          'demanding_alpine_hiking', '#9C27B0',
          'difficult_alpine_hiking', '#000000',
          'unknown', '#9E9E9E',
          '#9E9E9E'
        ],
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          10, 1.5,
          15, 3,
          20, 5,
          24, 8
        ],
        'line-opacity': 0.95
      }
    }, trailsBeforeLayerId);
  }

  // Add via ferrata data source
  if (!map.getSource('mountain-ferrata')) {
    map.addSource('mountain-ferrata', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      buffer: 256,
      lineMetrics: true
    });
  }

  // Add via ferrata visual layer
  if (!map.getLayer('ferrata-lines')) {
    const isVisible = 'visible';

    const styleLayers = map.getStyle().layers || [];
    const labelAnchorIds = [
      'road-label',
      'poi-label',
      'mountain_peak-label',
      'settlement-label',
      'place-label'
    ];
    const explicitAnchor = styleLayers.find((layer) => labelAnchorIds.includes(layer.id));
    const firstSymbolLayer = styleLayers.find((layer) => layer.type === 'symbol');
    const ferrataBeforeLayerId = (explicitAnchor && explicitAnchor.id) || (firstSymbolLayer && firstSymbolLayer.id);

    map.addLayer({
      id: 'ferrata-lines',
      type: 'line',
      source: 'mountain-ferrata',
      minzoom: 11,
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
        'visibility': isVisible
      },
      paint: {
        'line-color': [
          'match',
          ['get', 'via_ferrata_scale'],
          'A', '#ffcc80',
          'B', '#ffab40',
          'C', '#ff8f00',
          'D', '#ff6f00',
          'E', '#e65100',
          'F', '#bf360c',
          '1', '#ffab40',
          '2', '#ff8f00',
          '3', '#ff6f00',
          '4', '#e65100',
          '5', '#bf360c',
          '6', '#8d1b00',
          '#f4511e'
        ],
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          10, 1.5,
          14, 2.5,
          18, 4,
          22, 6
        ],
        'line-opacity': 0.95,
        'line-dasharray': [1.3, 1.1]
      }
    }, ferrataBeforeLayerId);
  }
} // matches the original close of addMapLayers

// Live database fetcher based on current screen viewport!
export async function fetchDynamicData(map) {
  const fetchToken = ++latestFetchToken;
  const bounds = map.getBounds();
  
  // Expand the bounding box
  const expand = 0.05; 
  const minLng = bounds.getWest() - expand;
  const minLat = bounds.getSouth() - expand;
  const maxLng = bounds.getEast() + expand;
  const maxLat = bounds.getNorth() + expand;

  // Don't fetch below zoom 10 to avoid heavy server queries
  if (map.getZoom() < 10) return;

  try {
    const trailsUrl = `/api/trails?minLng=${minLng}&minLat=${minLat}&maxLng=${maxLng}&maxLat=${maxLat}`;
    const poisUrl = `/api/pois?minLng=${minLng}&minLat=${minLat}&maxLng=${maxLng}&maxLat=${maxLat}`;
    const ferrataUrl = `/api/ferrata?minLng=${minLng}&minLat=${minLat}&maxLng=${maxLng}&maxLat=${maxLat}`;
    const [trailsRes, poisRes, ferrataRes] = await Promise.all([fetch(trailsUrl), fetch(poisUrl), fetch(ferrataUrl)]);

    // Ignore stale responses from previous zoom/pan requests.
    if (fetchToken !== latestFetchToken) return;

    if (!trailsRes.ok || !poisRes.ok || !ferrataRes.ok) {
      throw new Error(`HTTP error while loading layers: trails=${trailsRes.status}, pois=${poisRes.status}, ferrata=${ferrataRes.status}`);
    }

    const trailsData = await trailsRes.json();
    const poisData = await poisRes.json();
    const ferrataData = await ferrataRes.json();

    // Merge new viewport data into cache to prevent brief/empty responses
    // from wiping already visible features during zoom transitions.
    mergeIntoCache(trailFeatureCache, trailsData && trailsData.features ? trailsData.features : []);
    mergeIntoCache(poiFeatureCache, poisData && poisData.features ? poisData.features : []);
    mergeIntoCache(ferrataFeatureCache, ferrataData && ferrataData.features ? ferrataData.features : []);

    if (map.getSource('mountain-trails')) {
      map.getSource('mountain-trails').setData(cacheToFeatureCollection(trailFeatureCache));
    }
    if (map.getSource('mountain-pois')) {
      map.getSource('mountain-pois').setData(cacheToFeatureCollection(poiFeatureCache));
    }
    if (map.getSource('mountain-ferrata')) {
      map.getSource('mountain-ferrata').setData(cacheToFeatureCollection(ferrataFeatureCache));
    }
  } catch (error) {
    console.error("Error fetching live trails from DB:", error);
  }
}

export function setupMapInteractivity(map) {
  map.on('mouseenter', 'pois-points', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  
  map.on('mouseleave', 'pois-points', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'pois-points', (e) => {
    updatePanel(e.features[0].properties);
  });

  // Listen to map pan/zoom events to dynamically fetch from PostGIS backend
  map.on('moveend', () => fetchDynamicData(map));
  map.on('zoomend', () => fetchDynamicData(map));
}

export function setupStyleSwitcher(map) {
  const layerList = document.getElementById('menu');
  const inputs = layerList.getElementsByTagName('input');

  for (const input of inputs) {
    input.onclick = (e) => {
      currentMode = e.target.id;
      const layerId = e.target.value; // The actual style URL reference

      // Set the style
      map.setStyle('mapbox://styles/mapbox/' + layerId);

      // Instantly rotate the camera when switching to/from 3D mode
      if (currentMode === 'satellite-3d') {
        map.easeTo({ pitch: 70, bearing: 20 }); // Angle the camera!
      } else {
        map.easeTo({ pitch: 0, bearing: 0 }); // Reset to flat
      }
    };
  }

  // Setup toggle button for trails visibility
  const toggleTrailsBtn = document.getElementById('toggle-trails');
  if (toggleTrailsBtn) {
    toggleTrailsBtn.addEventListener('change', (e) => {
      if (map.getLayer('trails-lines')) {
        map.setLayoutProperty('trails-lines', 'visibility', e.target.checked ? 'visible' : 'none');
      }
    });
  }

  const toggleFerrataBtn = document.getElementById('toggle-ferrata');
  if (toggleFerrataBtn) {
    toggleFerrataBtn.addEventListener('change', (e) => {
      if (map.getLayer('ferrata-lines')) {
        map.setLayoutProperty('ferrata-lines', 'visibility', e.target.checked ? 'visible' : 'none');
      }
    });
  }
}
