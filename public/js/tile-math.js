// Web Mercator XYZ tile math — pure, no browser dependencies.

export function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}

export function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z)
  );
}

export function tilesInBboxAtZoom(bbox, z) {
  const [w, s, e, n] = bbox;
  const minX = lonToTileX(w, z);
  const maxX = lonToTileX(e, z);
  // Latitude axis flips in tile coords — northern lat = lower Y.
  const minY = latToTileY(n, z);
  const maxY = latToTileY(s, z);
  return { z, minX, maxX, minY, maxY };
}

export function tileCountForRange(bbox, zMin, zMax) {
  let total = 0;
  for (let z = zMin; z <= zMax; z++) {
    const r = tilesInBboxAtZoom(bbox, z);
    total += (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
  }
  return total;
}

export function* enumerateTiles(bbox, zMin, zMax) {
  for (let z = zMin; z <= zMax; z++) {
    const r = tilesInBboxAtZoom(bbox, z);
    for (let x = r.minX; x <= r.maxX; x++) {
      for (let y = r.minY; y <= r.maxY; y++) {
        yield { z, x, y };
      }
    }
  }
}
