import { describe, test, expect } from 'vitest';
import { buildGraph, snapToNode, findViaAlternatives, findMultiViaAlternatives, findBestMultiViaAlternatives, dijkstra } from '../src/routing/graph.ts';

// Graph shape:
//   A --[direct]--> B --[direct]--> C
//   A --[detour]--> B --[detour]--> C
// Gives leg1 × leg2 combinations for diversity tests.
function makeViaGraph() {
  const A = [9.0, 46.0];
  const B = [9.01, 46.0];   // via-point
  const C = [9.02, 46.0];
  const Mab = [9.005, 46.005]; // detour node between A and B
  const Mbc = [9.015, 46.005]; // detour node between B and C

  return buildGraph([
    { id: 'ab-direct', properties: { osm_id: 'ab-direct' }, geometry: { type: 'LineString', coordinates: [A, B] } },
    { id: 'ab-detour', properties: { osm_id: 'ab-detour' }, geometry: { type: 'LineString', coordinates: [A, Mab, B] } },
    { id: 'bc-direct', properties: { osm_id: 'bc-direct' }, geometry: { type: 'LineString', coordinates: [B, C] } },
    { id: 'bc-detour', properties: { osm_id: 'bc-detour' }, geometry: { type: 'LineString', coordinates: [B, Mbc, C] } },
  ]);
}

describe('findViaAlternatives', () => {
  test('returns at least one route through via point', () => {
    const graph = makeViaGraph();
    const fromKey = snapToNode(graph, [9.0, 46.0]);
    const viaKey = snapToNode(graph, [9.01, 46.0]);
    const toKey = snapToNode(graph, [9.02, 46.0]);
    expect(fromKey).not.toBeNull();
    expect(viaKey).not.toBeNull();
    expect(toKey).not.toBeNull();

    const alts = findViaAlternatives(graph, fromKey, viaKey, toKey);
    expect(alts.length).toBeGreaterThan(0);
  });

  test('all routes pass through via node', () => {
    const graph = makeViaGraph();
    const fromKey = snapToNode(graph, [9.0, 46.0]);
    const viaKey = snapToNode(graph, [9.01, 46.0]);
    const toKey = snapToNode(graph, [9.02, 46.0]);
    const viaNode = graph.nodes.get(viaKey);

    const alts = findViaAlternatives(graph, fromKey, viaKey, toKey);
    for (const route of alts) {
      const coords = route.flatMap(e => e.coords);
      const passesVia = coords.some(
        ([lng, lat]) =>
          Math.abs(lng - viaNode.coord[0]) < 0.0001 &&
          Math.abs(lat - viaNode.coord[1]) < 0.0001
      );
      expect(passesVia).toBe(true);
    }
  });

  test('returns multiple alternatives when diverging paths exist', () => {
    const graph = makeViaGraph();
    const fromKey = snapToNode(graph, [9.0, 46.0]);
    const viaKey = snapToNode(graph, [9.01, 46.0]);
    const toKey = snapToNode(graph, [9.02, 46.0]);

    const alts = findViaAlternatives(graph, fromKey, viaKey, toKey);
    expect(alts.length).toBeGreaterThan(1);
  });

  test('returns at most 4 alternatives', () => {
    const graph = makeViaGraph();
    const fromKey = snapToNode(graph, [9.0, 46.0]);
    const viaKey = snapToNode(graph, [9.01, 46.0]);
    const toKey = snapToNode(graph, [9.02, 46.0]);

    const alts = findViaAlternatives(graph, fromKey, viaKey, toKey);
    expect(alts.length).toBeLessThanOrEqual(4);
  });

  test('shortest route is first', () => {
    const graph = makeViaGraph();
    const fromKey = snapToNode(graph, [9.0, 46.0]);
    const viaKey = snapToNode(graph, [9.01, 46.0]);
    const toKey = snapToNode(graph, [9.02, 46.0]);

    const alts = findViaAlternatives(graph, fromKey, viaKey, toKey);
    const weights = alts.map(route =>
      route.reduce((sum, e) => sum + graph.edges[e.edgeIndex].weight, 0)
    );
    for (let i = 1; i < weights.length; i++) {
      expect(weights[0]).toBeLessThanOrEqual(weights[i]);
    }
  });

  test('returns empty array when no path exists', () => {
    // Disconnected graph: A→B has no path to C
    const graph = buildGraph([
      { id: 'ab', properties: { osm_id: 'ab' }, geometry: { type: 'LineString', coordinates: [[9.0, 46.0], [9.01, 46.0]] } },
      { id: 'cd', properties: { osm_id: 'cd' }, geometry: { type: 'LineString', coordinates: [[9.05, 46.0], [9.06, 46.0]] } },
    ]);
    const fromKey = snapToNode(graph, [9.0, 46.0]);
    const viaKey = snapToNode(graph, [9.01, 46.0]);
    const toKey = snapToNode(graph, [9.05, 46.0]);

    const alts = findViaAlternatives(graph, fromKey, viaKey, toKey);
    expect(alts.length).toBe(0);
  });
});

// Graph shape:
// A -- B
// |    \
// C -- D
// with a long detour path from B to C to force the shortest route
// to reuse A->B and A->C edges across legs.
function makeMultiViaGraph() {
  const A = [9.0, 46.0];
  const B = [9.001, 46.0];
  const C = [9.0, 46.001];
  const D = [9.0, 46.002];
  const X = [9.01, 46.01];

  return {
    graph: buildGraph([
      { id: 'ab', properties: { osm_id: 'ab' }, geometry: { type: 'LineString', coordinates: [A, B] } },
      { id: 'ac', properties: { osm_id: 'ac' }, geometry: { type: 'LineString', coordinates: [A, C] } },
      { id: 'cd', properties: { osm_id: 'cd' }, geometry: { type: 'LineString', coordinates: [C, D] } },
      { id: 'bc-detour', properties: { osm_id: 'bc-detour' }, geometry: { type: 'LineString', coordinates: [B, X, C] } },
    ]),
    coords: { A, B, C, D }
  };
}

function pathDistanceMeters(graph, path) {
  let total = 0;
  for (const step of path) total += graph.edges[step.edgeIndex].weight;
  return total;
}

describe('findMultiViaAlternatives', () => {
  test('prefers routes with minimal edge reuse', () => {
    const { graph, coords } = makeMultiViaGraph();
    const fromKey = snapToNode(graph, coords.A);
    const viaKey1 = snapToNode(graph, coords.B);
    const viaKey2 = snapToNode(graph, coords.C);
    const toKey = snapToNode(graph, coords.D);

    expect(fromKey).not.toBeNull();
    expect(viaKey1).not.toBeNull();
    expect(viaKey2).not.toBeNull();
    expect(toKey).not.toBeNull();

    const alts = findMultiViaAlternatives(graph, fromKey, [viaKey1, viaKey2], toKey);
    expect(alts.length).toBeGreaterThan(0);

    const dupFraction = (path) => {
      const seen = new Set();
      let dups = 0;
      for (const step of path) {
        if (seen.has(step.edgeIndex)) dups += 1;
        else seen.add(step.edgeIndex);
      }
      return path.length > 0 ? dups / path.length : 0;
    };

    const scored = alts.map((path) => ({
      dup: dupFraction(path),
      dist: pathDistanceMeters(graph, path)
    }));

    const minDup = Math.min(...scored.map(s => s.dup));
    const bestDist = Math.min(...scored.filter(s => Math.abs(s.dup - minDup) < 0.001).map(s => s.dist));

    expect(scored[0].dup).toBeCloseTo(minDup, 4);
    expect(scored[0].dist).toBeCloseTo(bestDist, 4);
  });
});

function makeViaCandidateGraph() {
  const A = [9.0, 46.0];
  const B = [9.001, 46.0];
  const C = [9.002, 46.0];
  const D = [9.003, 46.0];
  const B2 = [9.001, 46.01];
  const C2 = [9.002, 46.01];

  return {
    graph: buildGraph([
      { id: 'ab', properties: { osm_id: 'ab' }, geometry: { type: 'LineString', coordinates: [A, B] } },
      { id: 'bc', properties: { osm_id: 'bc' }, geometry: { type: 'LineString', coordinates: [B, C] } },
      { id: 'cd', properties: { osm_id: 'cd' }, geometry: { type: 'LineString', coordinates: [C, D] } },
      { id: 'ab2', properties: { osm_id: 'ab2' }, geometry: { type: 'LineString', coordinates: [A, B2] } },
      { id: 'b2c2', properties: { osm_id: 'b2c2' }, geometry: { type: 'LineString', coordinates: [B2, C2] } },
      { id: 'c2d', properties: { osm_id: 'c2d' }, geometry: { type: 'LineString', coordinates: [C2, D] } },
    ]),
    coords: { A, B, C, D, B2, C2 }
  };
}

describe('findBestMultiViaAlternatives', () => {
  test('selects the best via snap candidates', () => {
    const { graph, coords } = makeViaCandidateGraph();
    const fromKey = snapToNode(graph, coords.A);
    const toKey = snapToNode(graph, coords.D);
    const viaKey1 = snapToNode(graph, coords.B);
    const viaKey1Alt = snapToNode(graph, coords.B2);
    const viaKey2 = snapToNode(graph, coords.C);
    const viaKey2Alt = snapToNode(graph, coords.C2);

    const result = findBestMultiViaAlternatives(
      graph,
      fromKey,
      [
        [viaKey1Alt, viaKey1],
        [viaKey2Alt, viaKey2]
      ],
      toKey
    );

    expect(result.alts.length).toBeGreaterThan(0);
    expect(result.viaKeys).toEqual([viaKey1, viaKey2]);
  });
});
