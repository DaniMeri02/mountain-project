// Shared terrain elevation helpers — used by map.ts and search.ts.

import mapboxgl from 'mapbox-gl';
import { appState } from './state';

export function hasValidElevationValue(elevation: unknown): boolean {
  const numericElevation = Number(elevation);
  if (Number.isFinite(numericElevation)) {
    return numericElevation > 0;
  }

  if (typeof elevation === 'string') {
    const trimmed = elevation.trim();
    return trimmed !== '' && trimmed !== 'N/D';
  }

  return false;
}

function queryElevationFromTerrain(map: mapboxgl.Map, coordinates: { lng: number; lat: number } | null): number | null {
  if (!coordinates || typeof map.queryTerrainElevation !== 'function') {
    return null;
  }

  const value = map.queryTerrainElevation([coordinates.lng, coordinates.lat], { exaggerated: false });
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.round(value as number);
}

// Network fallback: the backend proxies a keyless DEM API so any coordinate resolves,
// even when its terrain tile isn't loaded (cold/off-screen). Skipped offline, where
// terrain over cached tiles stays the only source. Returns null on any failure.
async function fetchElevationFromApi(coordinates: { lng: number; lat: number }): Promise<number | null> {
  if (appState.offlineMode || (typeof navigator !== 'undefined' && !navigator.onLine)) {
    return null;
  }

  try {
    const res = await fetch(`/api/elevation?lat=${coordinates.lat}&lng=${coordinates.lng}`);
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { elevation?: number | null };
    return typeof data.elevation === 'number' && Number.isFinite(data.elevation) ? Math.round(data.elevation) : null;
  } catch {
    return null;
  }
}

// Resolve altitude for a coordinate. Primary source is Mapbox terrain (instant once
// the DEM tile is cached, works offline); terrain tiles stream asynchronously, so we
// retry briefly. If the tile still isn't loaded, fall back to the backend DEM proxy —
// this removes the old "tiles not ready within 700ms → Not available, stuck" failure.
export async function resolveElevationFromCoordinates(map: mapboxgl.Map, coordinates: { lng: number; lat: number } | null): Promise<number | null> {
  if (!coordinates) {
    return null;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const elevation = queryElevationFromTerrain(map, coordinates);
    if (elevation !== null) {
      return elevation;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 140);
    });
  }

  return fetchElevationFromApi(coordinates);
}
