/// <reference lib="webworker" />

// Routing compute runs off the main thread so a long buildGraph + Dijkstra
// cascade doesn't block paint. Each compute call rebuilds the graph from the
// supplied features (cheap to ship via structured clone) — no persistent state.

import {
  buildGraph,
  findBestSnappedRoute,
  findAlternatives,
  findRoundTrip,
  findBestMultiViaAlternatives,
  nearestNodes,
} from './graph';
import type { Graph, RouteStep } from './graph';

type Coord = [number, number];

export interface ComputeRequest {
  kind: 'compute';
  jobId: string;
  features: unknown[];
  startCoord: Coord;
  endCoord: Coord;
  viaCoords: Coord[];
  roundTrip: boolean;
}

export interface CancelRequest {
  kind: 'cancel';
  jobId: string;
}

export type WorkerRequest = ComputeRequest | CancelRequest;

export type RouteOutcome =
  | { type: 'no-trails' }
  | { type: 'no-start' }
  | { type: 'no-end' }
  | { type: 'no-route' }
  | { type: 'no-via'; viaIdx: number }
  | {
      type: 'ok';
      fromCoord: Coord;
      toCoord: Coord;
      viaCoordsResolved: Coord[];
      alternatives: RouteStep[][];
      roundTrip?: { outbound: RouteStep[]; returnRoute: RouteStep[]; onlyOnePath: boolean };
      viaActive: boolean;
    };

export interface ResultMessage {
  kind: 'result';
  jobId: string;
  outcome: RouteOutcome;
}

export interface ErrorMessage {
  kind: 'error';
  jobId: string;
  message: string;
}

export type WorkerResponse = ResultMessage | ErrorMessage;

let currentJobId: string | null = null;

const workerSelf = self as unknown as DedicatedWorkerGlobalScope;

workerSelf.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.kind === 'cancel') {
    if (currentJobId === msg.jobId) currentJobId = null;
    return;
  }

  if (msg.kind === 'compute') {
    currentJobId = msg.jobId;
    try {
      const result = computeRoute(msg);
      if (currentJobId !== msg.jobId) return;
      workerSelf.postMessage(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errMsg: ErrorMessage = { kind: 'error', jobId: msg.jobId, message };
      workerSelf.postMessage(errMsg);
    }
  }
});

function pathDistanceMeters(graph: Graph, route: RouteStep[]): number {
  let total = 0;
  for (const step of route) {
    const edge = graph.edges[step.edgeIndex];
    if (edge) total += edge.weight;
  }
  return total;
}

function sortAlternativesByDistance(graph: Graph, routes: RouteStep[][]): RouteStep[][] {
  return routes
    .map((route) => ({ route, distance: pathDistanceMeters(graph, route) }))
    .sort((a, b) => a.distance - b.distance)
    .map((entry) => entry.route);
}

function computeRoute(req: ComputeRequest): ResultMessage {
  const graph = buildGraph(req.features as Parameters<typeof buildGraph>[0]);

  if (!graph.nodes.size) {
    return { kind: 'result', jobId: req.jobId, outcome: { type: 'no-trails' } };
  }

  let best = findBestSnappedRoute(graph, req.startCoord, req.endCoord, { maxMeters: 300, candidateLimit: 6 });

  if (!best.startCandidates.length) return { kind: 'result', jobId: req.jobId, outcome: { type: 'no-start' } };
  if (!best.endCandidates.length) return { kind: 'result', jobId: req.jobId, outcome: { type: 'no-end' } };

  if (!best.path) {
    let maxComp = 0;
    for (const node of graph.nodes.values()) {
      if (node.componentSize > maxComp) maxComp = node.componentSize;
    }
    const minComp = Math.max(10, Math.floor(maxComp * 0.05));
    const retry = findBestSnappedRoute(graph, req.startCoord, req.endCoord, { maxMeters: 500, candidateLimit: 6, minComponentSize: minComp });
    if (retry.path) best = retry;
  }

  if (!best.path || !best.fromKey || !best.toKey) {
    return { kind: 'result', jobId: req.jobId, outcome: { type: 'no-route' } };
  }

  const fromNode = graph.nodes.get(best.fromKey);
  const toNode = graph.nodes.get(best.toKey);
  if (!fromNode || !toNode) {
    return { kind: 'result', jobId: req.jobId, outcome: { type: 'no-route' } };
  }

  if (req.viaCoords.length > 0) {
    const candidateLimit = 4;
    const viaCandidates: string[][] = [];
    for (let i = 0; i < req.viaCoords.length; i++) {
      const candidates = nearestNodes(graph, req.viaCoords[i], 300, candidateLimit)
        .map((c) => c.key)
        .filter((key, idx, arr) => arr.indexOf(key) === idx);
      if (!candidates.length) {
        return { kind: 'result', jobId: req.jobId, outcome: { type: 'no-via', viaIdx: i } };
      }
      viaCandidates.push(candidates);
    }
    const result = findBestMultiViaAlternatives(graph, best.fromKey, viaCandidates, best.toKey);
    if (!result.alts.length || !result.viaKeys.length) {
      return { kind: 'result', jobId: req.jobId, outcome: { type: 'no-route' } };
    }
    const viaCoordsResolved = result.viaKeys.map((k) => graph.nodes.get(k)!.coord);
    return {
      kind: 'result',
      jobId: req.jobId,
      outcome: {
        type: 'ok',
        fromCoord: fromNode.coord,
        toCoord: toNode.coord,
        viaCoordsResolved,
        alternatives: result.alts,
        viaActive: true,
      },
    };
  }

  let alternatives = findAlternatives(graph, best.fromKey, best.toKey);
  if (!alternatives.length) {
    return { kind: 'result', jobId: req.jobId, outcome: { type: 'no-route' } };
  }
  alternatives = sortAlternativesByDistance(graph, alternatives);

  let roundTrip: { outbound: RouteStep[]; returnRoute: RouteStep[]; onlyOnePath: boolean } | undefined;
  if (req.roundTrip) {
    const rt = findRoundTrip(graph, best.fromKey, best.toKey);
    if (rt) roundTrip = rt;
  }

  return {
    kind: 'result',
    jobId: req.jobId,
    outcome: {
      type: 'ok',
      fromCoord: fromNode.coord,
      toCoord: toNode.coord,
      viaCoordsResolved: [],
      alternatives,
      roundTrip,
      viaActive: false,
    },
  };
}
