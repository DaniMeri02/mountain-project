import { loadIcons } from './icons.js';
import { updatePanel, updateCoordinatesPanel } from './ui.js';
import { hasValidElevationValue, resolveElevationFromCoordinates } from './elevation.js';

// We store the current selection to know if 3D should be applied after a style loads
let currentMode = 'outdoors-v12';

export function getBasemapMode() {
  return currentMode;
}

export function setBasemapMode(mode) {
  currentMode = mode;
}

export function buildOsmStyle() {
  return {
    version: 8,
    glyphs: 'https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf?access_token=' + mapboxgl.accessToken,
    sources: {
      osm: {
        type: 'raster',
        tiles: [
          'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [{ id: 'osm-raster', type: 'raster', source: 'osm' }],
  };
}

export function buildTopoStyle() {
  return {
    version: 8,
    sources: {
      opentopo: {
        type: 'raster',
        tiles: [
          'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors',
      },
    },
    glyphs: 'https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf?access_token=' + mapboxgl.accessToken,
    layers: [{ id: 'opentopo-raster', type: 'raster', source: 'opentopo' }],
  };
}

let latestFetchToken = 0;
let latestPanelUpdateToken = 0;
let transientClickMarker = null;

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

function ensureTerrainSource(map) {
  if (map.getSource('mapbox-dem')) return;

  map.addSource('mapbox-dem', {
    type: 'raster-dem',
    url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
    tileSize: 512,
    maxzoom: 14
  });
}

function getFeatureCoordinates(feature, fallbackLngLat) {
  const geometry = feature && feature.geometry;
  if (geometry && geometry.type === 'Point' && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
    const [lng, lat] = geometry.coordinates;
    if (Number.isFinite(Number(lng)) && Number.isFinite(Number(lat))) {
      return { lng: Number(lng), lat: Number(lat) };
    }
  }

  if (
    fallbackLngLat
    && Number.isFinite(Number(fallbackLngLat.lng))
    && Number.isFinite(Number(fallbackLngLat.lat))
  ) {
    return { lng: Number(fallbackLngLat.lng), lat: Number(fallbackLngLat.lat) };
  }

  return null;
}

export function getTrailFeatureCache() { return trailFeatureCache; }
export function getFerrataFeatureCache() { return ferrataFeatureCache; }

export function bumpPanelToken() {
  return ++latestPanelUpdateToken;
}

export function removeTransientClickMarker() {
  if (transientClickMarker) {
    transientClickMarker.remove();
    transientClickMarker = null;
  }
}

function upsertTransientClickMarker(map, coordinates, className = 'map-click-ping') {
  if (!coordinates) return;

  if (!transientClickMarker || transientClickMarker.getElement().className !== className) {
    removeTransientClickMarker();
    const markerElement = document.createElement('div');
    markerElement.className = className;

    transientClickMarker = new mapboxgl.Marker({
      element: markerElement,
      anchor: className === 'map-draw-pin' ? 'center' : 'bottom'
    })
      .setLngLat([coordinates.lng, coordinates.lat])
      .addTo(map);
    return;
  }

  transientClickMarker.setLngLat([coordinates.lng, coordinates.lat]);
}

export function addMapLayers(map) {
  // Load custom marker icons
  loadIcons(map);

  // Keep terrain source available so click altitude can be resolved from Mapbox DEM.
  ensureTerrainSource(map);

  // Re-apply 3D Terrain if the selected mode demands it
  if (currentMode === 'satellite-3d') {
    // Enable 3D terrain with exaggeration — reduce on mobile to ease GPU load
    const exaggeration = window.innerWidth >= 768 ? 1.5 : 0.8;
    map.setTerrain({ 'source': 'mapbox-dem', exaggeration });

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
    // Keep terrain data queryable while preserving the flat visual style.
    map.setTerrain({ 'source': 'mapbox-dem', 'exaggeration': 0 });
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
        'icon-allow-overlap': false,
        'text-allow-overlap': false,
        'text-optional': true,
        'text-field': ['step', ['zoom'], '', 11, ['get', 'name']],
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 9, 14, 10, 17, 12],
        'text-anchor': 'top',
        'text-offset': [0, 0.6],
        'text-padding': 20
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
  // Route highlight sources and layers — sit above trail/ferrata layers
  if (!map.getSource('route-highlight-src')) {
    map.addSource('route-highlight-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }
  if (!map.getSource('route-alt-src')) {
    map.addSource('route-alt-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }
  if (!map.getSource('route-arrow-src')) {
    map.addSource('route-arrow-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }
  if (!map.getLayer('route-alt')) {
    map.addLayer({
      id: 'route-alt',
      type: 'line',
      source: 'route-alt-src',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#00BFFF'],
        'line-width': 10,
        'line-gap-width': 4,
        'line-opacity': 0.28,
        'line-blur': 0.6
      }
    });
  }
  if (!map.getLayer('route-highlight')) {
    map.addLayer({
      id: 'route-highlight',
      type: 'line',
      source: 'route-highlight-src',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#FFD700'],
        'line-width': 12,
        'line-gap-width': 5,
        'line-opacity': 0.35,
        'line-blur': 0.5
      }
    });
  }
  if (!map.getLayer('route-arrows')) {
    map.addLayer({
      id: 'route-arrows',
      type: 'symbol',
      source: 'route-arrow-src',
      layout: {
        'icon-image': 'route-arrow',
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-size': 0.55
      }
    });
  }
} // matches the original close of addMapLayers

// Live database fetcher based on current screen viewport!
export async function fetchDynamicData(map) {
  // Skip live fetches while a saved offline area is open — overlays come from IDB.
  if (window.__offlineMode) return;

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
    if (window.__routingMode || window.__routingViaMode || window.__drawMode) return;
    map.getCanvas().style.cursor = 'pointer';
  });

  map.on('mouseleave', 'pois-points', () => {
    if (window.__routingMode || window.__routingViaMode || window.__drawMode) return;
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'pois-points', async (e) => {
    if (window.__routingMode || window.__routingViaMode) return;
    removeTransientClickMarker();
    const panelToken = ++latestPanelUpdateToken;

    const feature = e.features && e.features[0];
    if (!feature) return;

    const coordinates = getFeatureCoordinates(feature, e.lngLat);
    const properties = feature.properties ? { ...feature.properties } : {};
    updatePanel(properties, coordinates);

    if (!coordinates || hasValidElevationValue(properties.elevation)) {
      return;
    }

    const derivedElevation = await resolveElevationFromCoordinates(map, coordinates);
    if (panelToken !== latestPanelUpdateToken || derivedElevation === null) {
      return;
    }

    updatePanel({ ...properties, elevation: derivedElevation }, coordinates);
  });

  map.on('click', async (e) => {
    // Keep POI click behavior intact; only show raw coordinates on plain map clicks.
    const poiAtPoint = map.getLayer('pois-points')
      ? map.queryRenderedFeatures(e.point, { layers: ['pois-points'] })
      : [];
    if (poiAtPoint.length > 0) return;

    const coordinates = { lng: e.lngLat.lng, lat: e.lngLat.lat };

    // Routing mode click is handled by mode.js — skip panel update.
    if (window.__routingMode || window.__routingViaMode) return;

     // Avoid replacing the route panel when clicking on a route line.
    if (window.__routingHasRoute) {
      const routeLayers = [];
      if (map.getLayer('route-highlight')) routeLayers.push('route-highlight');
      if (map.getLayer('route-alt')) routeLayers.push('route-alt');
      if (routeLayers.length > 0) {
        const routeHits = map.queryRenderedFeatures(e.point, { layers: routeLayers });
        if (routeHits.length > 0) return;
      }
    }

    // In draw mode show a neutral crosshair pin instead of the purple ping;
    // skip panel update since the click is for bbox selection, not POI lookup.
    if (window.__drawMode) {
      upsertTransientClickMarker(map, coordinates, 'map-draw-pin');
      return;
    }

    const panelToken = ++latestPanelUpdateToken;

    upsertTransientClickMarker(map, coordinates);
    updateCoordinatesPanel(coordinates.lng, coordinates.lat, null, true);

    const derivedElevation = await resolveElevationFromCoordinates(map, coordinates);
    if (panelToken !== latestPanelUpdateToken) {
      return;
    }

    updateCoordinatesPanel(coordinates.lng, coordinates.lat, derivedElevation, false);
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
      const layerId = e.target.value;

      if (currentMode === 'opentopo') {
        map.setStyle(buildTopoStyle());
      } else if (currentMode === 'osm') {
        map.setStyle(buildOsmStyle());
      } else {
        map.setStyle('mapbox://styles/mapbox/' + layerId);
      }

      // Instantly rotate the camera when switching to/from 3D mode
      if (currentMode === 'satellite-3d') {
        map.easeTo({ pitch: 70, bearing: 20 });
      } else {
        map.easeTo({ pitch: 0, bearing: 0 });
      }
    };
  }

  // Single source of truth for overlay visibility — keep checkbox state and
  // layer visibility in sync regardless of when style.load fires or layers
  // are recreated by setStyle().
  const VISIBILITY_PAIRS = [
    ['toggle-trails', 'trails-lines'],
    ['toggle-ferrata', 'ferrata-lines'],
    ['toggle-icons', 'pois-points'],
  ];

  for (const [inputId] of VISIBILITY_PAIRS) {
    const input = document.getElementById(inputId);
    if (!input) continue;
    input.addEventListener('change', () => applyOverlayVisibility(map));
  }
}

export function applyOverlayVisibility(map) {
  const pairs = [
    ['toggle-trails', 'trails-lines'],
    ['toggle-ferrata', 'ferrata-lines'],
    ['toggle-icons', 'pois-points'],
  ];
  for (const [inputId, layerId] of pairs) {
    const input = document.getElementById(inputId);
    if (!input || !map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', input.checked ? 'visible' : 'none');
  }
}
