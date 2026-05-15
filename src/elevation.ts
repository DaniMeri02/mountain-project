// Shared terrain elevation helpers — used by map.ts and search.ts.

import mapboxgl from 'mapbox-gl';

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

// Terrain tiles stream asynchronously; brief retries prevent empty values when tiles are still loading.
export async function resolveElevationFromCoordinates(map: mapboxgl.Map, coordinates: { lng: number; lat: number } | null): Promise<number | null> {
  if (!coordinates || typeof map.queryTerrainElevation !== 'function') {
    return null;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const elevation = queryElevationFromTerrain(map, coordinates);
    if (elevation !== null) {
      return elevation;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 140);
    });
  }

  return null;
}
