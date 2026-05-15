import type mapboxgl from 'mapbox-gl';

export const appState = {
  map: null as mapboxgl.Map | null,
  geolocateControl: null as mapboxgl.GeolocateControl | null,
  offlineMode: false,
  routingMode: false,
  routingViaMode: false,
  drawMode: false,
  routingHasRoute: false,
};
