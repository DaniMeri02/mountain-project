export interface GraphNode {
  coord: [number, number];
  edgeIndices: number[];
  componentSize: number;
}

export interface GraphEdge {
  featureId: string;
  segmentCoords: [[number, number], [number, number]];
  from: string;
  to: string;
  weight: number;
}

export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

export interface RouteStep {
  edgeIndex: number;
  featureId: string;
  coords: [number, number][];
  reversed: boolean;
}

export interface SnapResult {
  path: RouteStep[] | null;
  fromKey: string | null;
  toKey: string | null;
  distance: number | null;
  startCandidates: { key: string; distance: number }[];
  endCandidates: { key: string; distance: number }[];
}

export interface RoundTripResult {
  outbound: RouteStep[];
  returnRoute: RouteStep[];
  onlyOnePath: boolean;
}

interface RawFeature {
  geometry?: unknown;
  properties?: Record<string, unknown> | null;
  id?: unknown;
}

const NODE_KEY_PRECISION = 100000; // ~1.1m coordinate precision at Alpine latitudes
const NODE_MERGE_METERS = 4; // merge near-miss junctions conservatively
const NODE_MERGE_RADIUS = 4; // in key units (~meters at this precision)

export function nodeKey([lng, lat]: [number, number]): string {
  return `${Math.round(lng * NODE_KEY_PRECISION)}_${Math.round(lat * NODE_KEY_PRECISION)}`;
}

export function haversineMeters([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeCoord(coord: unknown): [number, number] | null {
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const lng = Number(coord[0]);
  const lat = Number(coord[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

function extractLineStrings(feature: RawFeature): unknown[][] {
  const geometry = feature && feature.geometry ? feature.geometry : null;
  if (!geometry || typeof geometry !== 'object') return [];
  const geom = geometry as { type?: string; coordinates?: unknown };
  if (geom.type === 'LineString') return [(geom.coordinates as unknown[][] | undefined) ?? []];
  if (geom.type === 'MultiLineString') return (geom.coordinates as unknown[][] | undefined) ?? [];
  return [];
}

export function buildGraph(features: RawFeature[]): Graph {
  const nodes: Map<string, GraphNode> = new Map();
  const edges: GraphEdge[] = [];

  function ensureNode(coord: [number, number]): string {
    const lngKey = Math.round(coord[0] * NODE_KEY_PRECISION);
    const latKey = Math.round(coord[1] * NODE_KEY_PRECISION);
    const key = `${lngKey}_${latKey}`;
    if (nodes.has(key)) return key;

    if (NODE_MERGE_METERS > 0) {
      let bestKey: string | null = null;
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

    nodes.set(key, { coord, edgeIndices: [], componentSize: 0 });
    return key;
  }

  for (const feature of features) {
    const featureId = String(feature?.properties?.['osm_id'] ?? feature?.id ?? Math.random());
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
          nodes.get(from)!.edgeIndices.push(idx);
          nodes.get(to)!.edgeIndices.push(idx);
        }
        prev = next;
      }
    }
  }

  // Union-Find to compute component sizes and annotate nodes
  const ufParent: Map<string, string> = new Map();
  const ufRank: Map<string, number> = new Map();
  function ufFind(k: string): string {
    if (!ufParent.has(k)) { ufParent.set(k, k); ufRank.set(k, 0); }
    if (ufParent.get(k) !== k) ufParent.set(k, ufFind(ufParent.get(k)!));
    return ufParent.get(k)!;
  }
  function ufUnion(a: string, b: string): void {
    const ra = ufFind(a), rb = ufFind(b);
    if (ra === rb) return;
    if ((ufRank.get(ra) ?? 0) < (ufRank.get(rb) ?? 0)) ufParent.set(ra, rb);
    else if ((ufRank.get(ra) ?? 0) > (ufRank.get(rb) ?? 0)) ufParent.set(rb, ra);
    else { ufParent.set(rb, ra); ufRank.set(ra, (ufRank.get(ra) ?? 0) + 1); }
  }
  for (const { from, to } of edges) ufUnion(from, to);
  const compSizes: Map<string, number> = new Map();
  for (const key of nodes.keys()) {
    const root = ufFind(key);
    compSizes.set(root, (compSizes.get(root) ?? 0) + 1);
  }
  for (const [key, node] of nodes) {
    node.componentSize = compSizes.get(ufFind(key)) ?? 1;
  }

  // Gap-bridging: connect large disconnected components that are nearly adjacent.
  const BRIDGE_MAX_METERS = 50;
  const BRIDGE_MIN_COMP_SIZE = 20;
  const BRIDGE_BUCKET_DEG = 0.0005; // ~55m per bucket at alpine latitudes

  const compNodeLists: Map<string, [string, GraphNode][]> = new Map();
  for (const [key, node] of nodes) {
    const root = ufFind(key);
    if ((compSizes.get(root) ?? 1) < BRIDGE_MIN_COMP_SIZE) continue;
    if (!compNodeLists.has(root)) compNodeLists.set(root, []);
    compNodeLists.get(root)!.push([key, node]);
  }

  const bridgeRoots = [...compNodeLists.keys()];
  for (let i = 0; i < bridgeRoots.length; i++) {
    for (let j = i + 1; j < bridgeRoots.length; j++) {
      const listA = compNodeLists.get(bridgeRoots[i])!;
      const listB = compNodeLists.get(bridgeRoots[j])!;

      // Build spatial bucket for B
      const bucketB: Map<string, [string, GraphNode][]> = new Map();
      for (const [keyB, nodeB] of listB) {
        const bx = Math.floor(nodeB.coord[0] / BRIDGE_BUCKET_DEG);
        const by = Math.floor(nodeB.coord[1] / BRIDGE_BUCKET_DEG);
        const bk = `${bx}_${by}`;
        if (!bucketB.has(bk)) bucketB.set(bk, []);
        bucketB.get(bk)!.push([keyB, nodeB]);
      }

      let minDist = Infinity;
      let bestKeyA: string | null = null;
      let bestKeyB: string | null = null;
      for (const [keyA, nodeA] of listA) {
        const ax = Math.floor(nodeA.coord[0] / BRIDGE_BUCKET_DEG);
        const ay = Math.floor(nodeA.coord[1] / BRIDGE_BUCKET_DEG);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const cands = bucketB.get(`${ax + dx}_${ay + dy}`);
            if (!cands) continue;
            for (const [keyB, nodeB] of cands) {
              const d = haversineMeters(nodeA.coord, nodeB.coord);
              if (d < minDist) { minDist = d; bestKeyA = keyA; bestKeyB = keyB; }
            }
          }
        }
      }

      if (bestKeyA && bestKeyB && minDist <= BRIDGE_MAX_METERS) {
        const idx = edges.length;
        edges.push({
          featureId: '__bridge__',
          segmentCoords: [nodes.get(bestKeyA)!.coord, nodes.get(bestKeyB)!.coord],
          from: bestKeyA,
          to: bestKeyB,
          weight: minDist
        });
        nodes.get(bestKeyA)!.edgeIndices.push(idx);
        nodes.get(bestKeyB)!.edgeIndices.push(idx);
      }
    }
  }

  return { nodes, edges };
}

export function snapToNode(graph: Graph, coord: [number, number], maxMeters = 300, minComponentSize = 0): string | null {
  let bestKey: string | null = null;
  let bestDist = Infinity;
  for (const [key, node] of graph.nodes) {
    if (node.componentSize < minComponentSize) continue;
    const d = haversineMeters(coord, node.coord);
    if (d < bestDist) {
      bestDist = d;
      bestKey = key;
    }
  }
  if (bestDist <= maxMeters) return bestKey;
  return null;
}

export function nearestNodes(graph: Graph, coord: [number, number], maxMeters = 300, limit = 6, minComponentSize = 0): { key: string; distance: number }[] {
  const candidates: { key: string; distance: number }[] = [];
  for (const [key, node] of graph.nodes) {
    if (node.componentSize < minComponentSize) continue;
    const d = haversineMeters(coord, node.coord);
    if (d <= maxMeters) candidates.push({ key, distance: d });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.slice(0, limit);
}

// Binary min-heap — stores [number, string] entries ([cost, nodeKey]), ordered by cost
function heapPush(heap: [number, string][], item: [number, string]): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent][0] <= heap[i][0]) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}

function heapPop(heap: [number, string][]): [number, string] {
  const top = heap[0];
  const last = heap.pop()!;
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

export function dijkstra(graph: Graph, fromKey: string, toKey: string, penaltyByEdgeIndex: Record<number, number> = {}): RouteStep[] | null {
  const dist: Map<string, number> = new Map([[fromKey, 0]]);
  const prev: Map<string, { edgeIndex: number; reversed: boolean }> = new Map();
  const visited: Set<string> = new Set();
  const heap: [number, string][] = [[0, fromKey]];

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

  const path: RouteStep[] = [];
  let cur = toKey;
  while (prev.has(cur)) {
    const { edgeIndex, reversed } = prev.get(cur)!;
    const edge = graph.edges[edgeIndex];
    path.unshift({ edgeIndex, featureId: edge.featureId, coords: edge.segmentCoords, reversed });
    cur = reversed ? edge.to : edge.from;
  }
  return path.length > 0 ? path : null;
}

function pathDistanceMeters(graph: Graph, path: RouteStep[]): number {
  let total = 0;
  for (const step of path) {
    const edge = graph.edges[step.edgeIndex];
    if (edge) total += edge.weight;
  }
  return total;
}

export function findBestSnappedRoute(
  graph: Graph,
  startCoord: [number, number],
  endCoord: [number, number],
  options: { maxMeters?: number; candidateLimit?: number; minComponentSize?: number } = {}
): SnapResult {
  const {
    maxMeters = 300,
    candidateLimit = 6,
    minComponentSize = 0,
  } = options;

  const startCandidates = nearestNodes(graph, startCoord, maxMeters, candidateLimit, minComponentSize);
  const endCandidates = nearestNodes(graph, endCoord, maxMeters, candidateLimit, minComponentSize);

  if (!startCandidates.length || !endCandidates.length) {
    return {
      path: null,
      fromKey: null,
      toKey: null,
      distance: null,
      startCandidates,
      endCandidates,
    };
  }

  let bestPath: RouteStep[] | null = null;
  let bestDist = Infinity;
  let bestFrom: string | null = null;
  let bestTo: string | null = null;

  for (const start of startCandidates) {
    for (const end of endCandidates) {
      const path = dijkstra(graph, start.key, end.key);
      if (!path) continue;
      const dist = pathDistanceMeters(graph, path);
      if (dist < bestDist) {
        bestDist = dist;
        bestPath = path;
        bestFrom = start.key;
        bestTo = end.key;
      }
    }
  }

  return {
    path: bestPath,
    fromKey: bestFrom,
    toKey: bestTo,
    distance: Number.isFinite(bestDist) ? bestDist : null,
    startCandidates,
    endCandidates,
  };
}

function sharedFraction(r1: RouteStep[], r2: RouteStep[]): number {
  const set1 = new Set(r1.map(e => e.edgeIndex));
  const shared = r2.filter(e => set1.has(e.edgeIndex)).length;
  return shared / Math.max(r1.length, r2.length, 1);
}

export function findAlternatives(graph: Graph, fromKey: string, toKey: string, basePenalty: Record<number, number> = {}): RouteStep[][] {
  const p1 = dijkstra(graph, fromKey, toKey, basePenalty);
  if (!p1) return [];
  const results: RouteStep[][] = [p1];

  const pen1: Record<number, number> = { ...basePenalty };
  for (const e of p1) pen1[e.edgeIndex] = 8;

  const p2 = dijkstra(graph, fromKey, toKey, pen1);
  if (p2 && sharedFraction(p1, p2) < 0.7) {
    results.push(p2);
    const pen2: Record<number, number> = { ...pen1 };
    for (const e of p2) pen2[e.edgeIndex] = 8;
    const p3 = dijkstra(graph, fromKey, toKey, pen2);
    if (p3 && sharedFraction(p1, p3) < 0.7) {
      results.push(p3);
      const pen3: Record<number, number> = { ...pen2 };
      for (const e of p3) pen3[e.edgeIndex] = 8;
      const p4 = dijkstra(graph, fromKey, toKey, pen3);
      if (p4 && sharedFraction(p1, p4) < 0.7) results.push(p4);
    }
  }

  return results;
}

export function findViaAlternatives(graph: Graph, fromKey: string, viaKey: string, toKey: string): RouteStep[][] {
  const leg1Alts = findAlternatives(graph, fromKey, viaKey);
  const leg2Alts = findAlternatives(graph, viaKey, toKey);
  if (!leg1Alts.length || !leg2Alts.length) return [];

  const combos: { path: RouteStep[]; weight: number }[] = [];
  for (const l1 of leg1Alts) {
    for (const l2 of leg2Alts) {
      const combined = [...l1, ...l2];
      const weight = combined.reduce((sum, e) => sum + graph.edges[e.edgeIndex].weight, 0);
      combos.push({ path: combined, weight });
    }
  }

  combos.sort((a, b) => a.weight - b.weight);

  const kept: RouteStep[][] = [];
  for (const { path } of combos) {
    if (kept.every(k => sharedFraction(k, path) < 0.7)) {
      kept.push(path);
      if (kept.length === 4) break;
    }
  }

  return kept;
}

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const perm of permutations(rest)) result.push([arr[i], ...perm]);
  }
  return result;
}

function distMatrixKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function buildDistanceMatrix(graph: Graph, keys: string[]): Map<string, number> {
  const dist: Map<string, number> = new Map();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const path = dijkstra(graph, keys[i], keys[j]);
      const d = path ? pathDistanceMeters(graph, path) : Infinity;
      dist.set(distMatrixKey(keys[i], keys[j]), d);
    }
  }
  return dist;
}

function orderingDistance(distMatrix: Map<string, number>, fromKey: string, orderedViaKeys: string[], toKey: string): number {
  let total = 0;
  let prev = fromKey;
  for (const k of orderedViaKeys) {
    total += distMatrix.get(distMatrixKey(prev, k)) ?? Infinity;
    prev = k;
  }
  total += distMatrix.get(distMatrixKey(prev, toKey)) ?? Infinity;
  return total;
}

function findOptimalOrdering(graph: Graph, fromKey: string, viaKeys: string[], toKey: string): string[] {
  if (viaKeys.length === 0) return [];
  if (viaKeys.length === 1) return viaKeys;
  const allKeys = [fromKey, ...viaKeys, toKey];
  const distMatrix = buildDistanceMatrix(graph, allKeys);
  let bestOrder = viaKeys;
  let bestDist = Infinity;
  for (const perm of permutations(viaKeys)) {
    const d = orderingDistance(distMatrix, fromKey, perm, toKey);
    if (d < bestDist) { bestDist = d; bestOrder = perm; }
  }
  return bestOrder;
}

function intraRouteDupFraction(path: RouteStep[]): number {
  const seen = new Set<number>();
  let dups = 0;
  for (const e of path) {
    if (seen.has(e.edgeIndex)) dups++;
    else seen.add(e.edgeIndex);
  }
  return path.length > 0 ? dups / path.length : 0;
}

function orderingInversionScore(graph: Graph, fromKey: string, orderedViaKeys: string[], toKey: string): number {
  if (orderedViaKeys.length === 0) return 0;
  const fromCoord = graph.nodes.get(fromKey)?.coord;
  const toCoord = graph.nodes.get(toKey)?.coord;
  if (!fromCoord || !toCoord) return 0;
  const dx = toCoord[0] - fromCoord[0];
  const dy = toCoord[1] - fromCoord[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return 0;
  const project = ([lng, lat]: [number, number]): number =>
    ((lng - fromCoord[0]) * dx + (lat - fromCoord[1]) * dy) / lenSq;
  const projs = orderedViaKeys.map(k => {
    const coord = graph.nodes.get(k)?.coord;
    return coord ? project(coord) : 0;
  });
  let inversions = 0;
  for (let i = 0; i < projs.length - 1; i++) {
    if (projs[i] > projs[i + 1]) inversions++;
  }
  return inversions / Math.max(1, projs.length - 1);
}

const MAX_DUP_FRACTION = 0.10;

export function findMultiViaAlternatives(graph: Graph, fromKey: string, viaKeys: string[], toKey: string): RouteStep[][] {
  if (!viaKeys.length) return [];

  const legAltLimit = 4;

  const orderings = viaKeys.length <= 3
    ? permutations(viaKeys)
    : [findOptimalOrdering(graph, fromKey, viaKeys, toKey)];

  const allResults: { path: RouteStep[]; weight: number; invScore: number }[] = [];

  for (const orderedVia of orderings) {
    const waypoints = [fromKey, ...orderedVia, toKey];
    const orderingResults: { path: RouteStep[]; weight: number; invScore: number }[] = [];
    const invScore = orderingInversionScore(graph, fromKey, orderedVia, toKey);

    let basePath: RouteStep[] = [];
    let baseWeight = 0;
    let baseOk = true;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const leg = dijkstra(graph, waypoints[i], waypoints[i + 1]);
      if (!leg) { baseOk = false; break; }
      basePath = basePath.concat(leg);
      baseWeight += pathDistanceMeters(graph, leg);
    }
    if (baseOk && basePath.length > 0) {
      orderingResults.push({ path: basePath, weight: baseWeight, invScore });
    }

    const maxOrderingResults = 48;
    const dfs = (legIdx: number, currentPath: RouteStep[], currentWeight: number, usedEdges: Set<number>): void => {
      if (orderingResults.length >= maxOrderingResults) return;
      if (legIdx === waypoints.length - 1) {
        orderingResults.push({ path: currentPath, weight: currentWeight, invScore });
        return;
      }
      const basePenalty: Record<number, number> = {};
      for (const idx of usedEdges) basePenalty[idx] = 8;
      const alts = findAlternatives(graph, waypoints[legIdx], waypoints[legIdx + 1], basePenalty);
      if (!alts.length) return;
      for (const leg of alts.slice(0, legAltLimit)) {
        const legWeight = leg.reduce((s, e) => s + graph.edges[e.edgeIndex].weight, 0);
        const nextEdges = new Set([...usedEdges, ...leg.map(e => e.edgeIndex)]);
        dfs(legIdx + 1, [...currentPath, ...leg], currentWeight + legWeight, nextEdges);
      }
    };

    dfs(0, [], 0, new Set());
    allResults.push(...orderingResults);
  }

  const scored = allResults.map(r => ({ ...r, dupFraction: intraRouteDupFraction(r.path) }));
  scored.sort((a, b) => {
    if (Math.abs(a.dupFraction - b.dupFraction) > 0.01) return a.dupFraction - b.dupFraction;
    if (Math.abs(a.weight - b.weight) > 1) return a.weight - b.weight;
    return a.invScore - b.invScore;
  });

  const kept: RouteStep[][] = [];
  for (const { path, dupFraction } of scored) {
    if (kept.length > 0 && dupFraction > MAX_DUP_FRACTION) continue;
    if (kept.every(k => sharedFraction(k, path) < 0.7)) {
      kept.push(path);
      if (kept.length === 4) break;
    }
  }
  return kept;
}

function cartesianProduct<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((acc, cur) => acc.flatMap(a => cur.map(c => [...a, c])), [[]]);
}

export function findBestMultiViaAlternatives(
  graph: Graph,
  fromKey: string,
  viaKeyCandidates: string[][],
  toKey: string
): { alts: RouteStep[][]; viaKeys: string[] } {
  if (!viaKeyCandidates.length) return { alts: [], viaKeys: [] };
  const combos = cartesianProduct(viaKeyCandidates);
  let best: { alts: RouteStep[][]; combo: string[]; dupFraction: number; weight: number } | null = null;

  for (const combo of combos) {
    const alts = findMultiViaAlternatives(graph, fromKey, combo, toKey);
    if (!alts.length) continue;
    const bestPath = alts[0];
    const dupFraction = intraRouteDupFraction(bestPath);
    const weight = pathDistanceMeters(graph, bestPath);

    if (!best) {
      best = { alts, combo, dupFraction, weight };
      continue;
    }

    if (Math.abs(dupFraction - best.dupFraction) > 0.01) {
      if (dupFraction < best.dupFraction) best = { alts, combo, dupFraction, weight };
      continue;
    }

    if (weight < best.weight) best = { alts, combo, dupFraction, weight };
  }

  return best ? { alts: best.alts, viaKeys: best.combo } : { alts: [], viaKeys: [] };
}

export function findRoundTrip(graph: Graph, fromKey: string, toKey: string): RoundTripResult | null {
  const outbound = dijkstra(graph, fromKey, toKey);
  if (!outbound) return null;
  const pen: Record<number, number> = {};
  for (const e of outbound) pen[e.edgeIndex] = 8;
  const returnRoute = dijkstra(graph, toKey, fromKey, pen);
  const onlyOnePath = !returnRoute || sharedFraction(outbound, returnRoute) > 0.7;
  return { outbound, returnRoute: returnRoute ?? [...outbound].reverse(), onlyOnePath };
}
