import { describe, test, expect } from 'vitest';
import { buildGraph, snapToNode, dijkstra, findBestSnappedRoute } from '../public/js/routing/graph.js';

function makeLine(id, coords) {
  return {
    id,
    properties: { osm_id: id },
    geometry: { type: 'LineString', coordinates: coords },
  };
}

function pathDistanceMeters(graph, path) {
  let total = 0;
  for (const step of path) {
    const edge = graph.edges[step.edgeIndex];
    if (edge) total += edge.weight;
  }
  return total;
}

describe('findBestSnappedRoute', () => {
  test('prefers nearby node that yields shorter path', () => {
    const longPath = makeLine('long', [
      [9.0, 46.0],
      [9.01, 46.0],
      [9.01, 45.995],
      [9.001, 45.995],
    ]);
    const shortPath = makeLine('short', [
      [9.001, 46.0],
      [9.001, 45.995],
    ]);
    const graph = buildGraph([longPath, shortPath]);

    const start = [9.0, 46.0];
    const end = [9.001, 45.995];

    const naiveFrom = snapToNode(graph, start);
    const naiveTo = snapToNode(graph, end);
    expect(naiveFrom).not.toBeNull();
    expect(naiveTo).not.toBeNull();

    const naivePath = dijkstra(graph, naiveFrom, naiveTo);
    expect(naivePath).not.toBeNull();

    const naiveDistance = pathDistanceMeters(graph, naivePath);

    const best = findBestSnappedRoute(graph, start, end, { maxMeters: 300, candidateLimit: 6 });
    expect(best.path).not.toBeNull();
    expect(best.distance).toBeLessThan(naiveDistance);
    expect(best.fromKey).not.toBeNull();

    const bestCoord = graph.nodes.get(best.fromKey).coord;
    expect(bestCoord[0]).toBeCloseTo(9.001, 6);
    expect(bestCoord[1]).toBeCloseTo(46.0, 6);
  });
});
