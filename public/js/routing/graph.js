const NODE_KEY_PRECISION = 100000; // ~1.1m coordinate precision at Alpine latitudes
const NODE_MERGE_METERS = 4; // merge near-miss junctions conservatively
const NODE_MERGE_RADIUS = 4; // in key units (~meters at this precision)

export function nodeKey([lng, lat]) {
  return `${Math.round(lng * NODE_KEY_PRECISION)}_${Math.round(lat * NODE_KEY_PRECISION)}`;
}

export function haversineMeters([lng1, lat1], [lng2, lat2]) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeCoord(coord) {
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const lng = Number(coord[0]);
  const lat = Number(coord[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

function extractLineStrings(feature) {
  const geometry = feature && feature.geometry ? feature.geometry : null;
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates || []];
  if (geometry.type === 'MultiLineString') return geometry.coordinates || [];
  return [];
}

export function buildGraph(features) {
  const nodes = new Map();
  const edges = [];

  function ensureNode(coord) {
    const lngKey = Math.round(coord[0] * NODE_KEY_PRECISION);
    const latKey = Math.round(coord[1] * NODE_KEY_PRECISION);
    const key = `${lngKey}_${latKey}`;
    if (nodes.has(key)) return key;

    if (NODE_MERGE_METERS > 0) {
      let bestKey = null;
      let bestDist = Infinity;
      for (let dx = -NODE_MERGE_RADIUS; dx <= NODE_MERGE_RADIUS; dx++) {
        for (let dy = -NODE_MERGE_RADIUS; dy <= NODE_MERGE_RADIUS; dy++) {
          const candidateKey = `${lngKey + dx}_${latKey + dy}`;
          const candidate = nodes.get(candidateKey);
          if (!candidate) continue;
          const d = haversineMeters(coord, candidate.coord);
          if (d < NODE_MERGE_METERS && d < bestDist) {
            bestDist = d;
            bestKey = candidateKey;
          }
        }
      }
      if (bestKey) return bestKey;
    }

    nodes.set(key, { coord, edgeIndices: [] });
    return key;
  }

  for (const feature of features) {
    const featureId = String(feature?.properties?.osm_id || feature?.id || Math.random());
    const lineStrings = extractLineStrings(feature);
    for (const line of lineStrings) {
      if (!Array.isArray(line) || line.length < 2) continue;
      let prev = normalizeCoord(line[0]);
      if (!prev) continue;
      for (let i = 1; i < line.length; i++) {
        const next = normalizeCoord(line[i]);
        if (!next) { prev = null; continue; }
        if (!prev) { prev = next; continue; }
        const from = ensureNode(prev);
        const to = ensureNode(next);
        if (from !== to) {
          const weight = haversineMeters(prev, next);
          const idx = edges.length;
          edges.push({ featureId, segmentCoords: [prev, next], from, to, weight });
          nodes.get(from).edgeIndices.push(idx);
          nodes.get(to).edgeIndices.push(idx);
        }
        prev = next;
      }
    }
  }

  // Union-Find to compute component sizes and annotate nodes
  const ufParent = new Map();
  const ufRank = new Map();
  function ufFind(k) {
    if (!ufParent.has(k)) { ufParent.set(k, k); ufRank.set(k, 0); }
    if (ufParent.get(k) !== k) ufParent.set(k, ufFind(ufParent.get(k)));
    return ufParent.get(k);
  }
  function ufUnion(a, b) {
    const ra = ufFind(a), rb = ufFind(b);
    if (ra === rb) return;
    if ((ufRank.get(ra) || 0) < (ufRank.get(rb) || 0)) ufParent.set(ra, rb);
    else if ((ufRank.get(ra) || 0) > (ufRank.get(rb) || 0)) ufParent.set(rb, ra);
    else { ufParent.set(rb, ra); ufRank.set(ra, (ufRank.get(ra) || 0) + 1); }
  }
  for (const { from, to } of edges) ufUnion(from, to);
  const compSizes = new Map();
  for (const key of nodes.keys()) {
    const root = ufFind(key);
    compSizes.set(root, (compSizes.get(root) || 0) + 1);
  }
  for (const [key, node] of nodes) {
    node.componentSize = compSizes.get(ufFind(key)) || 1;
  }

  return { nodes, edges };
}

// Snaps to the nearest node within maxMeters.
export function snapToNode(graph, coord, maxMeters = 300) {
  let bestKey = null;
  let bestDist = Infinity;
  for (const [key, node] of graph.nodes) {
    const d = haversineMeters(coord, node.coord);
    if (d < bestDist) {
      bestDist = d;
      bestKey = key;
    }
  }
  if (bestDist <= maxMeters) return bestKey;
  return null;
}

// Binary min-heap — stores [cost, nodeKey] entries, ordered by cost
function heapPush(heap, item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent][0] <= heap[i][0]) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    while (true) {
      let s = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
      if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
      if (s === i) break;
      [heap[i], heap[s]] = [heap[s], heap[i]];
      i = s;
    }
  }
  return top;
}

/**
 * Dijkstra shortest path.
 * penaltyByEdgeIndex: { [edgeIndex]: multiplier } — used by findAlternatives to discourage reuse
 * Returns array of { edgeIndex, featureId, coords, reversed } or null if unreachable.
 * reversed=false → use coords as-is; reversed=true → coords must be reversed for traversal order.
 */
export function dijkstra(graph, fromKey, toKey, penaltyByEdgeIndex = {}) {
  const dist = new Map([[fromKey, 0]]);
  const prev = new Map(); // nodeKey -> { edgeIndex, reversed }
  const visited = new Set();
  const heap = [[0, fromKey]];

  while (heap.length > 0) {
    const [cost, nodeKey] = heapPop(heap);
    if (visited.has(nodeKey)) continue;
    visited.add(nodeKey);
    if (nodeKey === toKey) break;
    const node = graph.nodes.get(nodeKey);
    if (!node) continue;
    for (const edgeIndex of node.edgeIndices) {
      const edge = graph.edges[edgeIndex];
      const isForward = edge.from === nodeKey;
      const neighbor = isForward ? edge.to : edge.from;
      const reversed = !isForward;
      const newCost = cost + edge.weight * (penaltyByEdgeIndex[edgeIndex] ?? 1);
      if (newCost < (dist.get(neighbor) ?? Infinity)) {
        dist.set(neighbor, newCost);
        prev.set(neighbor, { edgeIndex, reversed });
        heapPush(heap, [newCost, neighbor]);
      }
    }
  }

  if (!dist.has(toKey)) return null;

  // Reconstruct path from prev map
  const path = [];
  let cur = toKey;
  while (prev.has(cur)) {
    const { edgeIndex, reversed } = prev.get(cur);
    const edge = graph.edges[edgeIndex];
    path.unshift({ edgeIndex, featureId: edge.featureId, coords: edge.segmentCoords, reversed });
    cur = reversed ? edge.to : edge.from;
  }
  return path.length > 0 ? path : null;
}

function sharedFraction(r1, r2) {
  const set1 = new Set(r1.map(e => e.edgeIndex));
  const shared = r2.filter(e => set1.has(e.edgeIndex)).length;
  return shared / Math.max(r1.length, r2.length, 1);
}

// Runs Dijkstra 3 times, penalizing already-used edges 8× to find diverging alternatives
export function findAlternatives(graph, fromKey, toKey) {
  const p1 = dijkstra(graph, fromKey, toKey);
  if (!p1) return [];
  const results = [p1];

  const pen1 = {};
  for (const e of p1) pen1[e.edgeIndex] = 8;

  const p2 = dijkstra(graph, fromKey, toKey, pen1);
  if (p2 && sharedFraction(p1, p2) < 0.7) {
    results.push(p2);
    const pen2 = { ...pen1 };
    for (const e of p2) pen2[e.edgeIndex] = 8;
    const p3 = dijkstra(graph, fromKey, toKey, pen2);
    if (p3 && sharedFraction(p1, p3) < 0.7) results.push(p3);
  }

  return results;
}

export function findRoundTrip(graph, fromKey, toKey) {
  const outbound = dijkstra(graph, fromKey, toKey);
  if (!outbound) return null;
  const pen = {};
  for (const e of outbound) pen[e.edgeIndex] = 8;
  const returnRoute = dijkstra(graph, toKey, fromKey, pen);
  const onlyOnePath = !returnRoute || sharedFraction(outbound, returnRoute) > 0.7;
  return { outbound, returnRoute: returnRoute ?? [...outbound].reverse(), onlyOnePath };
}
