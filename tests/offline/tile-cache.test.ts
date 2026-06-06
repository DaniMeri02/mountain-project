import { describe, it, expect } from 'vitest';
import { tileCacheName } from '../../src/offline/tile-cache';

// These names are the contract between where tiles are written (workbox runtimeCaching in
// vite.config.ts) and where an offline area's tiles are evicted on delete. If they drift, area
// deletion silently stops freeing tiles, so pin them here.
describe('tileCacheName', () => {
  it('maps each basemap to its workbox runtime cache', () => {
    expect(tileCacheName('opentopo')).toBe('topo-tiles-v1');
    expect(tileCacheName('osm')).toBe('osm-tiles-v1');
    expect(tileCacheName('mapbox')).toBe('mapbox-tiles-v1');
  });

  it('returns null for an unknown basemap', () => {
    expect(tileCacheName('bogus')).toBeNull();
  });
});
