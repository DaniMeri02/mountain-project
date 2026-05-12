const HIGHLIGHT_SRC = 'route-highlight-src';
const ALT_SRC = 'route-alt-src';
const ARROW_SRC = 'route-arrow-src';

function haversineMeters([lng1, lat1], [lng2, lat2]) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDegrees([lng1, lat1], [lng2, lat2]) {
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  const brng = Math.atan2(y, x) * 180 / Math.PI;
  return (brng + 360) % 360;
}

function interpolateCoord([lng1, lat1], [lng2, lat2], t) {
  return [lng1 + (lng2 - lng1) * t, lat1 + (lat2 - lat1) * t];
}

function buildArrowFeatures(edges, spacingMeters = 120) {
  const features = [];
  let carry = 0;
  let lastSeg = null;

  for (const { coords, reversed } of edges) {
    const seg = reversed ? [...coords].reverse() : coords;
    for (let i = 1; i < seg.length; i++) {
      const p1 = seg[i - 1];
      const p2 = seg[i];
      const segDist = haversineMeters(p1, p2);
      if (!Number.isFinite(segDist) || segDist <= 0) continue;
      lastSeg = { p1, p2 };

      let remaining = spacingMeters - carry;
      let traveled = 0;

      while (segDist - traveled >= remaining) {
        const t = (traveled + remaining) / segDist;
        const coord = interpolateCoord(p1, p2, t);
        features.push({
          type: 'Feature',
          properties: { bearing: bearingDegrees(p1, p2) },
          geometry: { type: 'Point', coordinates: coord }
        });
        traveled += remaining;
        remaining = spacingMeters;
        carry = 0;
      }

      carry += segDist - traveled;
    }
  }

  if (!features.length && lastSeg) {
    const coord = interpolateCoord(lastSeg.p1, lastSeg.p2, 0.5);
    features.push({
      type: 'Feature',
      properties: { bearing: bearingDegrees(lastSeg.p1, lastSeg.p2) },
      geometry: { type: 'Point', coordinates: coord }
    });
  }

  return features;
}

function toFeatures(edges, color, routeIndex) {
  return edges.map(({ featureId, coords, reversed }) => {
    const properties = { featureId, color };
    if (routeIndex !== undefined && routeIndex !== null) properties.routeIndex = routeIndex;
    return {
      type: 'Feature',
      properties,
      geometry: {
        type: 'LineString',
        coordinates: reversed ? [...coords].reverse() : coords
      }
    };
  });
}

export function setRouteHighlight(map, edges) {
  const src = map.getSource(HIGHLIGHT_SRC);
  if (src) src.setData({ type: 'FeatureCollection', features: toFeatures(edges, '#FFD700') });
  const arrows = map.getSource(ARROW_SRC);
  if (arrows) arrows.setData({ type: 'FeatureCollection', features: buildArrowFeatures(edges) });
}

export function setRouteReturn(map, edges) {
  const src = map.getSource(ALT_SRC);
  if (src) src.setData({ type: 'FeatureCollection', features: toFeatures(edges, '#20B2AA') });
}

export function setRouteAlternatives(map, edgeSets, routeIndices = []) {
  const features = edgeSets.flatMap((edges, i) => toFeatures(edges, '#00BFFF', routeIndices[i]));
  const src = map.getSource(ALT_SRC);
  if (src) src.setData({ type: 'FeatureCollection', features });
}

export function clearRouteHighlight(map) {
  const empty = { type: 'FeatureCollection', features: [] };
  const hs = map.getSource(HIGHLIGHT_SRC);
  const as = map.getSource(ALT_SRC);
  const ar = map.getSource(ARROW_SRC);
  if (hs) hs.setData(empty);
  if (as) as.setData(empty);
  if (ar) ar.setData(empty);
}
