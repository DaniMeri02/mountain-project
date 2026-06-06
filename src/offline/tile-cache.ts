// Workbox runtime cache names — must match runtimeCaching in vite.config.ts. Tiles are fetched
// through the service worker (CacheFirst), so an offline area's tiles live in the cache named
// for its basemap; that's where they must be deleted from when the area is removed.
const TILE_CACHE_BY_BASEMAP: Record<string, string> = {
  opentopo: 'topo-tiles-v1',
  osm: 'osm-tiles-v1',
  mapbox: 'mapbox-tiles-v1',
};

/** The Cache Storage bucket a basemap's tiles live in, or null for an unknown basemap. */
export function tileCacheName(basemap: string): string | null {
  return TILE_CACHE_BY_BASEMAP[basemap] ?? null;
}
