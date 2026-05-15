import { describe, test, expect } from 'vitest';
import { buildGraph, snapToNode, dijkstra } from '../src/routing/graph.ts';

// Helpers to build GeoJSON LineString features
function makeLine(id, coords) {
  return { id, geometry: { type: 'LineString', coordinates: coords } };
}

// ── Scenario: two disconnected components, each 101 nodes ─────────────────────
// Main:      101 nodes along lat 46.00, lng 9.60..9.70
// Secondary: 101 nodes along lat 45.998, with node #50 only 22m south of main[50]
//            → gap at [9.65, 46.00] vs [9.65, 45.9998] ≈ 22m — within 50m threshold

const mainCoords = Array.from({ length: 101 }, (_, i) => [9.60 + i * 0.001, 46.00]);

// Secondary: mostly at lat 45.998 (~222m south), node 50 bumped up to 22m south of main
const secondaryCoords = Array.from({ length: 101 }, (_, i) => {
  if (i === 50) return [9.65, 45.9998]; // ~22m south of main[50]=[9.65, 46.00]
  return [9.60 + i * 0.001, 45.998];
});

const mainFeature = makeLine('main', mainCoords);
const loopFeature = makeLine('loop', secondaryCoords);

describe('gap-bridging', () => {
  test('bridges gap between main network and loop trail', () => {
    const graph = buildGraph([mainFeature, loopFeature]);

    // Should have bridge edge
    const bridgeEdges = graph.edges.filter(e => e.featureId === '__bridge__');
    expect(bridgeEdges.length).toBeGreaterThanOrEqual(1);

    // The bridge should be short (≤50m)
    if (bridgeEdges.length > 0) {
      expect(bridgeEdges[0].weight).toBeLessThanOrEqual(50);
    }
  });

  test('can route from main network through secondary', () => {
    const graph = buildGraph([mainFeature, loopFeature]);

    // Start on main network (left end), end on secondary (right end)
    const fromKey = snapToNode(graph, [9.60, 46.00], 50);
    const toKey = snapToNode(graph, [9.70, 45.998], 50);

    expect(fromKey).not.toBeNull();
    expect(toKey).not.toBeNull();

    const path = dijkstra(graph, fromKey, toKey);
    expect(path).not.toBeNull();
    expect(path.length).toBeGreaterThan(0);
  });

  test('no bridge between small isolated stubs', () => {
    // Two tiny 2-node features far from each other — should NOT be bridged (< BRIDGE_MIN_COMP_SIZE)
    const stub1 = makeLine('s1', [[9.60, 46.00], [9.601, 46.00]]);
    const stub2 = makeLine('s2', [[9.60, 46.001], [9.601, 46.001]]);
    const graph = buildGraph([stub1, stub2]);
    const bridges = graph.edges.filter(e => e.featureId === '__bridge__');
    expect(bridges.length).toBe(0);
  });
});
