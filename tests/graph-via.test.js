import { describe, test, expect } from 'vitest';
import { buildGraph, snapToNode, findViaAlternatives } from '../public/js/routing/graph.js';

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
