// Web Mercator XYZ tile math — pure, no browser dependencies.

export function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}

export function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z)
  );
}

export function tilesInBboxAtZoom(bbox: [number, number, number, number], z: number): { z: number; minX: number; maxX: number; minY: number; maxY: number } {
  const [w, s, e, n] = bbox;
  const minX = lonToTileX(w, z);
  const maxX = lonToTileX(e, z);
  const minY = latToTileY(n, z);
  const maxY = latToTileY(s, z);
  return { z, minX, maxX, minY, maxY };
}

export function tileCountForRange(bbox: [number, number, number, number], zMin: number, zMax: number): number {
  let total = 0;
  for (let z = zMin; z <= zMax; z++) {
    const r = tilesInBboxAtZoom(bbox, z);
    total += (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
  }
  return total;
}

export function* enumerateTiles(bbox: [number, number, number, number], zMin: number, zMax: number): Generator<{ z: number; x: number; y: number }> {
  for (let z = zMin; z <= zMax; z++) {
    const r = tilesInBboxAtZoom(bbox, z);
    for (let x = r.minX; x <= r.maxX; x++) {
      for (let y = r.minY; y <= r.maxY; y++) {
        yield { z, x, y };
      }
    }
  }
}
