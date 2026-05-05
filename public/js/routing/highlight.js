const HIGHLIGHT_SRC = 'route-highlight-src';
const ALT_SRC = 'route-alt-src';

function toFeatures(edges, color) {
  return edges.map(({ featureId, coords, reversed }) => ({
    type: 'Feature',
    properties: { featureId, color },
    geometry: {
      type: 'LineString',
      coordinates: reversed ? [...coords].reverse() : coords
    }
  }));
}

export function setRouteHighlight(map, edges) {
  const src = map.getSource(HIGHLIGHT_SRC);
  if (src) src.setData({ type: 'FeatureCollection', features: toFeatures(edges, '#FFD700') });
}

export function setRouteReturn(map, edges) {
  const src = map.getSource(ALT_SRC);
  if (src) src.setData({ type: 'FeatureCollection', features: toFeatures(edges, '#20B2AA') });
}

export function setRouteAlternatives(map, edgeSets) {
  const features = edgeSets.flatMap(edges => toFeatures(edges, '#00BFFF'));
  const src = map.getSource(ALT_SRC);
  if (src) src.setData({ type: 'FeatureCollection', features });
}

export function clearRouteHighlight(map) {
  const empty = { type: 'FeatureCollection', features: [] };
  const hs = map.getSource(HIGHLIGHT_SRC);
  const as = map.getSource(ALT_SRC);
  if (hs) hs.setData(empty);
  if (as) as.setData(empty);
}
