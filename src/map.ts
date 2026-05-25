import mapboxgl from 'mapbox-gl';
import { loadIcons } from './icons';
import { updatePanel, updateCoordinatesPanel, closePanel, patchPoiElevation, patchCoordinatesElevation } from './ui';
import { hasValidElevationValue, resolveElevationFromCoordinates } from './elevation';
import { appState } from './state';

// We store the current selection to know if 3D should be applied after a style loads
let currentMode = 'outdoors-v12';

export function getBasemapMode(): string {
  return currentMode;
}

export function setBasemapMode(mode: string): void {
  currentMode = mode;
}

export function buildOsmStyle(): object {
  return {
    version: 8,
    sprite: '',
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

export function buildTopoStyle(): object {
  return {
    version: 8,
    sprite: '',
    glyphs: 'https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf?access_token=' + mapboxgl.accessToken,
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
    layers: [{ id: 'opentopo-raster', type: 'raster', source: 'opentopo' }],
  };
}

let latestFetchController: AbortController | null = null;
let latestPanelUpdateToken = 0;
let transientClickMarker: mapboxgl.Marker | null = null;

// Cache features by OSM id so zoom transitions do not blank the layer
// while awaiting the next viewport response.
const trailFeatureCache = new Map<string, mapboxgl.MapboxGeoJSONFeature>();
const poiFeatureCache = new Map<string, mapboxgl.MapboxGeoJSONFeature>();
const ferrataFeatureCache = new Map<string, mapboxgl.MapboxGeoJSONFeature>();

function featureKey(feature: mapboxgl.MapboxGeoJSONFeature): string {
  const props = feature && feature.properties ? feature.properties : {};
  return String((props as Record<string, unknown>).osm_id || (props as Record<string, unknown>).id || '');
}

function mergeIntoCache(cache: Map<string, mapboxgl.MapboxGeoJSONFeature>, features: mapboxgl.MapboxGeoJSONFeature[]): void {
  if (!Array.isArray(features)) return;
  for (const feature of features) {
    const key = featureKey(feature);
    if (key) cache.set(key, feature);
  }
}

function cacheToFeatureCollection(cache: Map<string, mapboxgl.MapboxGeoJSONFeature>): { type: 'FeatureCollection'; features: mapboxgl.MapboxGeoJSONFeature[] } {
  return {
    type: 'FeatureCollection',
    features: Array.from(cache.values())
  };
}

function ensureTerrainSource(map: mapboxgl.Map): void {
  if (map.getSource('mapbox-dem')) return;

  map.addSource('mapbox-dem', {
    type: 'raster-dem',
    url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
    tileSize: 512,
    maxzoom: 14
  });
}

function getFeatureCoordinates(
  feature: mapboxgl.MapboxGeoJSONFeature | null | undefined,
  fallbackLngLat: mapboxgl.LngLat | null
): { lng: number; lat: number } | null {
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

export function getTrailFeatureCache(): Map<string, mapboxgl.MapboxGeoJSONFeature> { return trailFeatureCache; }
export function getFerrataFeatureCache(): Map<string, mapboxgl.MapboxGeoJSONFeature> { return ferrataFeatureCache; }

export function bumpPanelToken(): number {
  return ++latestPanelUpdateToken;
}

export function removeTransientClickMarker(): void {
  if (transientClickMarker) {
    transientClickMarker.remove();
    transientClickMarker = null;
  }
}

function upsertTransientClickMarker(map: mapboxgl.Map, coordinates: { lng: number; lat: number } | null, className = 'map-click-ping'): void {
  if (!coordinates) return;

  if (!transientClickMarker || transientClickMarker.getElement().className !== className) {
    removeTransientClickMarker();
    const markerElement = document.createElement('div');
    markerElement.className = className;

    if (className === 'map-click-ping') {
      markerElement.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTransientClickMarker();
        closePanel();
      });
    }

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

export function addMapLayers(map: mapboxgl.Map): void {
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
        'symbol-sort-key': ['*', -1, ['to-number', ['get', 'sort_elevation']]] as unknown as mapboxgl.Expression, // Prioritize higher peaks
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
        ] as unknown as mapboxgl.Expression,
        'icon-size': 1,
        'icon-allow-overlap': false,
        'text-allow-overlap': false,
        'text-optional': true,
        'text-field': ['step', ['zoom'], '', 11, ['get', 'name']] as unknown as mapboxgl.Expression,
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 9, 14, 10, 17, 12] as unknown as mapboxgl.Expression,
        'text-anchor': 'top',
        'text-offset': [0, 0.6],
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

    const styleLayers: mapboxgl.Layer[] | undefined = map.getStyle().layers || [];
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
        ] as unknown as mapboxgl.Expression,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          10, 1.5,
          15, 3,
          20, 5,
          24, 8
        ] as unknown as mapboxgl.Expression,
        'line-opacity': 0.95
      }
    }, trailsBeforeLayerId ?? undefined);
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

    const styleLayers: mapboxgl.Layer[] | undefined = map.getStyle().layers || [];
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
        ] as unknown as mapboxgl.Expression,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          10, 1.5,
          14, 2.5,
          18, 4,
          22, 6
        ] as unknown as mapboxgl.Expression,
        'line-opacity': 0.95,
        'line-dasharray': [1.3, 1.1]
      }
    }, ferrataBeforeLayerId ?? undefined);
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
        'line-color': ['coalesce', ['get', 'color'], '#00BFFF'] as unknown as mapboxgl.Expression,
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
        'line-color': ['coalesce', ['get', 'color'], '#FFD700'] as unknown as mapboxgl.Expression,
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
        'icon-rotate': ['get', 'bearing'] as unknown as mapboxgl.Expression,
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-size': 0.55
      }
    });
  }
} // matches the original close of addMapLayers

// Live database fetcher based on current screen viewport!
export async function fetchDynamicData(map: mapboxgl.Map): Promise<void> {
  // Skip live fetches while a saved offline area is open — overlays come from IDB.
  if (appState.offlineMode) return;

  // Abort any in-flight fetch from a previous pan/zoom — its data is now stale.
  if (latestFetchController) {
    latestFetchController.abort();
  }
  const ctrl = new AbortController();
  latestFetchController = ctrl;

  const bounds = map.getBounds();
  if (!bounds) return;

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
    const [trailsRes, poisRes, ferrataRes] = await Promise.all([
      fetch(trailsUrl, { signal: ctrl.signal }),
      fetch(poisUrl, { signal: ctrl.signal }),
      fetch(ferrataUrl, { signal: ctrl.signal }),
    ]);

    if (!trailsRes.ok || !poisRes.ok || !ferrataRes.ok) {
      throw new Error(`HTTP error while loading layers: trails=${trailsRes.status}, pois=${poisRes.status}, ferrata=${ferrataRes.status}`);
    }

    const trailsData = await trailsRes.json() as { features?: mapboxgl.MapboxGeoJSONFeature[] };
    const poisData = await poisRes.json() as { features?: mapboxgl.MapboxGeoJSONFeature[] };
    const ferrataData = await ferrataRes.json() as { features?: mapboxgl.MapboxGeoJSONFeature[] };

    // Merge new viewport data into cache to prevent brief/empty responses
    // from wiping already visible features during zoom transitions.
    mergeIntoCache(trailFeatureCache, trailsData && trailsData.features ? trailsData.features : []);
    mergeIntoCache(poiFeatureCache, poisData && poisData.features ? poisData.features : []);
    mergeIntoCache(ferrataFeatureCache, ferrataData && ferrataData.features ? ferrataData.features : []);

    const trailSrc = map.getSource('mountain-trails') as mapboxgl.GeoJSONSource | undefined;
    if (trailSrc) trailSrc.setData(cacheToFeatureCollection(trailFeatureCache));

    const poiSrc = map.getSource('mountain-pois') as mapboxgl.GeoJSONSource | undefined;
    if (poiSrc) poiSrc.setData(cacheToFeatureCollection(poiFeatureCache));

    const ferrataSrc = map.getSource('mountain-ferrata') as mapboxgl.GeoJSONSource | undefined;
    if (ferrataSrc) ferrataSrc.setData(cacheToFeatureCollection(ferrataFeatureCache));
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    console.error("Error fetching live trails from DB:", error);
  }
}

export function setupMapInteractivity(map: mapboxgl.Map): void {
  map.on('mouseenter', 'pois-points', () => {
    if (appState.routingMode || appState.routingViaMode || appState.drawMode) return;
    map.getCanvas().style.cursor = 'pointer';
  });

  map.on('mouseleave', 'pois-points', () => {
    if (appState.routingMode || appState.routingViaMode || appState.drawMode) return;
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'pois-points', (e) => {
    if (appState.routingMode || appState.routingViaMode) return;
    removeTransientClickMarker();
    const panelToken = ++latestPanelUpdateToken;

    const feature = e.features && e.features[0];
    if (!feature) return;

    const coordinates = getFeatureCoordinates(feature, e.lngLat);
    const properties = feature.properties ? { ...feature.properties } : {};

    // Render panel immediately so the click "responds" within the INP budget.
    // Elevation, if missing, is fetched in the background and patched into the
    // existing badge once the terrain tile resolves — no rebuild, no await chain.
    void updatePanel(properties as Parameters<typeof updatePanel>[0], coordinates).then(() => {
      if (!coordinates || hasValidElevationValue((properties as Record<string, unknown>).elevation)) {
        return;
      }
      return resolveElevationFromCoordinates(map, coordinates).then((derivedElevation) => {
        if (panelToken !== latestPanelUpdateToken) return;
        patchPoiElevation(derivedElevation);
      });
    });
  });

  map.on('click', (e) => {
    // Keep POI click behavior intact; only show raw coordinates on plain map clicks.
    const poiAtPoint = map.getLayer('pois-points')
      ? map.queryRenderedFeatures(e.point, { layers: ['pois-points'] })
      : [];
    if (poiAtPoint.length > 0) return;

    const coordinates = { lng: e.lngLat.lng, lat: e.lngLat.lat };

    // Routing mode click is handled by mode.js — skip panel update.
    if (appState.routingMode || appState.routingViaMode) return;

    // Avoid replacing the route panel when clicking on a route line.
    if (appState.routingHasRoute) {
      const routeLayers: string[] = [];
      if (map.getLayer('route-highlight')) routeLayers.push('route-highlight');
      if (map.getLayer('route-alt')) routeLayers.push('route-alt');
      if (routeLayers.length > 0) {
        const routeHits = map.queryRenderedFeatures(e.point, { layers: routeLayers });
        if (routeHits.length > 0) return;
      }
    }

    // In draw mode show a neutral crosshair pin instead of the purple ping;
    // skip panel update since the click is for bbox selection, not POI lookup.
    if (appState.drawMode) {
      upsertTransientClickMarker(map, coordinates, 'map-draw-pin');
      return;
    }

    const panelToken = ++latestPanelUpdateToken;

    upsertTransientClickMarker(map, coordinates);
    updateCoordinatesPanel(coordinates.lng, coordinates.lat, null, true);

    // Fire-and-patch: avoid blocking INP on the 5×140ms terrain retry loop.
    void resolveElevationFromCoordinates(map, coordinates).then((derivedElevation) => {
      if (panelToken !== latestPanelUpdateToken) return;
      patchCoordinatesElevation(derivedElevation);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && transientClickMarker) {
      removeTransientClickMarker();
      closePanel();
    }
  });

  // Listen to map pan/zoom events to dynamically fetch from PostGIS backend
  map.on('moveend', () => fetchDynamicData(map));
  map.on('zoomend', () => fetchDynamicData(map));
}

export function setupStyleSwitcher(map: mapboxgl.Map): void {
  const layerList = document.getElementById('menu');
  const inputs = layerList ? layerList.getElementsByTagName('input') : [];

  for (const input of Array.from(inputs)) {
    input.onclick = (e) => {
      const target = e.target as HTMLInputElement;
      currentMode = target.id;
      const layerId = target.value;

      if (currentMode === 'opentopo') {
        map.setStyle(buildTopoStyle() as mapboxgl.StyleSpecification, { diff: false, localFontFamily: undefined, localIdeographFontFamily: undefined });
      } else if (currentMode === 'osm') {
        map.setStyle(buildOsmStyle() as mapboxgl.StyleSpecification, { diff: false, localFontFamily: undefined, localIdeographFontFamily: undefined });
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
  const VISIBILITY_PAIRS: [string, string][] = [
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

export function applyOverlayVisibility(map: mapboxgl.Map): void {
  const pairs: [string, string][] = [
    ['toggle-trails', 'trails-lines'],
    ['toggle-ferrata', 'ferrata-lines'],
    ['toggle-icons', 'pois-points'],
  ];
  for (const [inputId, layerId] of pairs) {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (!input || !map.getLayer(layerId)) continue;
    map.setLayoutProperty(layerId, 'visibility', input.checked ? 'visible' : 'none');
  }
}
