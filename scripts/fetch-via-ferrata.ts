import fs from 'fs/promises';
import path from 'path';
import { Pool, PoolClient } from 'pg';

type BBox = {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
};

type RelationMember = {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role?: string;
};

type OverpassNode = {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
};

type OverpassWay = {
  type: 'way';
  id: number;
  nodes?: number[];
  tags?: Record<string, string>;
};

type OverpassRelation = {
  type: 'relation';
  id: number;
  members?: RelationMember[];
  tags?: Record<string, string>;
};

type OverpassElement = OverpassNode | OverpassWay | OverpassRelation;

type OverpassResponse = {
  elements?: OverpassElement[];
};

type FerrataFeature = {
  osmId: number;
  name: string | null;
  viaFerrataScale: string | null;
  sacScale: string | null;
  sourceType: string;
  relationIds: number[];
  tags: Record<string, string>;
  geometry: {
    type: 'LineString';
    coordinates: number[][];
  };
};

type FailedChunk = {
  chunkIndex: number;
  bbox: BBox;
  reason: string;
};

type ChunkStatus = 'completed' | 'failed';

type ChunkDescriptor = {
  chunkIndex: number;
  chunkKey: string;
  bbox: BBox;
};

type ChunkProgress = {
  chunkIndex: number;
  chunkKey: string;
  bbox: BBox;
  status: ChunkStatus;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
};

type ProgressSnapshot = {
  generatedAt: string;
  importMode: ImportMode;
  conflictMode: ConflictMode;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  pendingChunks: number;
  entries: ChunkProgress[];
};

type ImportMode = 'resume' | 'failed-only' | 'full';
type ConflictMode = 'nothing' | 'update';

// Monte Rosa massif + surrounding Italian/Swiss valleys (Valsesia, Gressoney, Ayas, Zermatt, Saas-Fee)
// Connects at lng 8.8 with the existing Lombardy dataset. Resume mode skips already-completed chunks.
const START_LAT = 45.5;
const END_LAT = 46.2;
const LAT_STEP = 0.15;
const START_LON = 7.4;
const END_LON = 8.8;
const LON_STEP = 0.3;

const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const FAILED_CHUNKS_FILE = path.join(process.cwd(), 'scripts', 'via-ferrata-failed-chunks.json');
const PROGRESS_FILE = path.join(process.cwd(), 'scripts', 'via-ferrata-progress.json');

function parseImportMode(rawMode: string | undefined): ImportMode {
  const normalized = (rawMode || 'resume').trim().toLowerCase();
  if (normalized === 'resume' || normalized === 'failed-only' || normalized === 'full') {
    return normalized;
  }

  throw new Error(`Invalid FERRATA_IMPORT_MODE="${rawMode}". Allowed values: resume, failed-only, full.`);
}

function parseConflictMode(rawMode: string | undefined): ConflictMode {
  const normalized = (rawMode || 'nothing').trim().toLowerCase();
  if (normalized === 'nothing' || normalized === 'update') {
    return normalized;
  }

  throw new Error(`Invalid FERRATA_CONFLICT_MODE="${rawMode}". Allowed values: nothing, update.`);
}

const IMPORT_MODE = parseImportMode(process.env.FERRATA_IMPORT_MODE);
const CONFLICT_MODE = parseConflictMode(process.env.FERRATA_CONFLICT_MODE);

const dbPort = Number(process.env.PGPORT || '5433');
if (!Number.isFinite(dbPort)) {
  throw new Error('Invalid PGPORT value');
}

const pool = new Pool({
  user: process.env.PGUSER || 'mountain_worker',
  password: process.env.PGPASSWORD || 'mountain_secret_123',
  host: process.env.PGHOST || 'localhost',
  port: dbPort,
  database: process.env.PGDATABASE || 'mountain_db'
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toOverpassBBox(bbox: BBox): string {
  return `(${bbox.minLat}, ${bbox.minLon}, ${bbox.maxLat}, ${bbox.maxLon})`;
}

function getChunkKey(bbox: BBox): string {
  return `${bbox.minLat.toFixed(3)}|${bbox.minLon.toFixed(3)}|${bbox.maxLat.toFixed(3)}|${bbox.maxLon.toFixed(3)}`;
}

function buildChunks(): ChunkDescriptor[] {
  const chunks: ChunkDescriptor[] = [];

  let chunkIndex = 1;
  for (let lat = START_LAT; lat < END_LAT; lat += LAT_STEP) {
    for (let lon = START_LON; lon < END_LON; lon += LON_STEP) {
      const bbox: BBox = {
        minLat: Number(lat.toFixed(3)),
        minLon: Number(lon.toFixed(3)),
        maxLat: Number(Math.min(lat + LAT_STEP, END_LAT).toFixed(3)),
        maxLon: Number(Math.min(lon + LON_STEP, END_LON).toFixed(3))
      };

      chunks.push({
        chunkIndex,
        chunkKey: getChunkKey(bbox),
        bbox
      });
      chunkIndex += 1;
    }
  }

  return chunks;
}

function createOverpassQuery(bbox: BBox): string {
  const area = toOverpassBBox(bbox);
  return `
[out:json][timeout:240];
relation["route"="via_ferrata"]${area}->.ferrata_rel;
(
  way["highway"="via_ferrata"]${area};
  way["via_ferrata_scale"]${area};
  way["sport"="via_ferrata"]${area};
  way(r.ferrata_rel);
  .ferrata_rel;
);
(._;>;);
out body;
`;
}

function buildFailedChunksFromProgress(progressByKey: Map<string, ChunkProgress>): FailedChunk[] {
  return Array.from(progressByKey.values())
    .filter((entry) => entry.status === 'failed')
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((entry) => ({
      chunkIndex: entry.chunkIndex,
      bbox: entry.bbox,
      reason: entry.lastError || 'Unknown error'
    }));
}

function selectChunksToProcess(chunks: ChunkDescriptor[], progressByKey: Map<string, ChunkProgress>): ChunkDescriptor[] {
  if (IMPORT_MODE === 'full') {
    return chunks;
  }

  if (IMPORT_MODE === 'failed-only') {
    return chunks.filter((chunk) => progressByKey.get(chunk.chunkKey)?.status === 'failed');
  }

  return chunks.filter((chunk) => progressByKey.get(chunk.chunkKey)?.status !== 'completed');
}

async function ensureTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS via_ferrata (
      id BIGSERIAL PRIMARY KEY,
      osm_id BIGINT UNIQUE NOT NULL,
      name TEXT,
      via_ferrata_scale TEXT,
      sac_scale TEXT,
      source_type TEXT NOT NULL,
      relation_ids BIGINT[] NOT NULL DEFAULT '{}',
      tags JSONB NOT NULL DEFAULT '{}'::jsonb,
      geom geometry(LineString, 4326) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS via_ferrata_geom_idx ON via_ferrata USING GIST (geom);');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS via_ferrata_import_chunks (
      chunk_key TEXT PRIMARY KEY,
      chunk_index INTEGER NOT NULL,
      min_lat DOUBLE PRECISION NOT NULL,
      min_lon DOUBLE PRECISION NOT NULL,
      max_lat DOUBLE PRECISION NOT NULL,
      max_lon DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 1,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS via_ferrata_import_chunks_status_idx ON via_ferrata_import_chunks(status);');
}

async function loadProgressFromDb(): Promise<Map<string, ChunkProgress>> {
  const progressByKey = new Map<string, ChunkProgress>();

  const result = await pool.query<{
    chunk_key: string;
    chunk_index: number;
    min_lat: number;
    min_lon: number;
    max_lat: number;
    max_lon: number;
    status: ChunkStatus;
    attempts: number;
    last_error: string | null;
    updated_at: string;
  }>(`
    SELECT
      chunk_key,
      chunk_index,
      min_lat,
      min_lon,
      max_lat,
      max_lon,
      status,
      attempts,
      last_error,
      updated_at::text
    FROM via_ferrata_import_chunks
  `);

  for (const row of result.rows) {
    progressByKey.set(row.chunk_key, {
      chunkIndex: Number(row.chunk_index),
      chunkKey: row.chunk_key,
      bbox: {
        minLat: Number(row.min_lat),
        minLon: Number(row.min_lon),
        maxLat: Number(row.max_lat),
        maxLon: Number(row.max_lon)
      },
      status: row.status,
      attempts: Number(row.attempts),
      lastError: row.last_error,
      updatedAt: String(row.updated_at)
    });
  }

  return progressByKey;
}

async function saveChunkProgressToDb(chunk: ChunkDescriptor, status: ChunkStatus, errorMessage: string | null): Promise<void> {
  await pool.query(
    `
      INSERT INTO via_ferrata_import_chunks (
        chunk_key,
        chunk_index,
        min_lat,
        min_lon,
        max_lat,
        max_lon,
        status,
        attempts,
        last_error,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, NOW())
      ON CONFLICT (chunk_key) DO UPDATE
      SET
        chunk_index = EXCLUDED.chunk_index,
        min_lat = EXCLUDED.min_lat,
        min_lon = EXCLUDED.min_lon,
        max_lat = EXCLUDED.max_lat,
        max_lon = EXCLUDED.max_lon,
        status = EXCLUDED.status,
        attempts = via_ferrata_import_chunks.attempts + 1,
        last_error = EXCLUDED.last_error,
        updated_at = NOW();
    `,
    [
      chunk.chunkKey,
      chunk.chunkIndex,
      chunk.bbox.minLat,
      chunk.bbox.minLon,
      chunk.bbox.maxLat,
      chunk.bbox.maxLon,
      status,
      errorMessage
    ]
  );
}

async function writeFailedChunks(failedChunks: FailedChunk[]): Promise<void> {
  if (failedChunks.length === 0) {
    try {
      await fs.unlink(FAILED_CHUNKS_FILE);
    } catch {
      // Ignore if file does not exist.
    }
    return;
  }

  const content = {
    generatedAt: new Date().toISOString(),
    failedChunks
  };
  await fs.writeFile(FAILED_CHUNKS_FILE, JSON.stringify(content, null, 2), 'utf8');
}

async function writeProgressSnapshot(chunks: ChunkDescriptor[], progressByKey: Map<string, ChunkProgress>): Promise<void> {
  const entries = Array.from(progressByKey.values()).sort((a, b) => a.chunkIndex - b.chunkIndex);
  const completedChunks = entries.filter((entry) => entry.status === 'completed').length;
  const failedChunks = entries.filter((entry) => entry.status === 'failed').length;

  const snapshot: ProgressSnapshot = {
    generatedAt: new Date().toISOString(),
    importMode: IMPORT_MODE,
    conflictMode: CONFLICT_MODE,
    totalChunks: chunks.length,
    completedChunks,
    failedChunks,
    pendingChunks: Math.max(chunks.length - completedChunks - failedChunks, 0),
    entries
  };

  await fs.writeFile(PROGRESS_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
}

async function fetchChunkWithRetries(bbox: BBox, chunkIndex: number, maxRetries: number): Promise<OverpassResponse> {
  const body = `data=${encodeURIComponent(createOverpassQuery(bbox))}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180000);

    try {
      const response = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'User-Agent': 'mountain-portal/1.0 (personal project)',
        },
        body,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.status === 429 || response.status === 504 || response.status >= 500) {
        if (attempt === maxRetries) {
          throw new Error(`HTTP ${response.status}`);
        }

        const waitMs = response.status === 429 ? 90000 : 45000;
        console.warn(`[WARN] Chunk ${chunkIndex}: Overpass returned ${response.status}. Retry ${attempt}/${maxRetries} in ${waitMs / 1000}s.`);
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as OverpassResponse;
      return payload;
    } catch (error) {
      clearTimeout(timeoutId);
      const reason = error instanceof Error ? error.message : String(error);

      if (attempt === maxRetries) {
        throw new Error(`Chunk ${chunkIndex} failed after ${maxRetries} attempts: ${reason}`);
      }

      const backoffMs = 8000 * attempt;
      console.warn(`[WARN] Chunk ${chunkIndex}: ${reason}. Retry ${attempt}/${maxRetries} in ${backoffMs / 1000}s.`);
      await sleep(backoffMs);
    }
  }

  throw new Error(`Chunk ${chunkIndex} failed unexpectedly`);
}

function isExplicitFerrataTag(tags: Record<string, string>): boolean {
  return (
    tags.highway === 'via_ferrata' ||
    typeof tags.via_ferrata_scale === 'string' ||
    tags.sport === 'via_ferrata' ||
    tags.route === 'via_ferrata'
  );
}

function deriveSourceType(tags: Record<string, string>, hasRelation: boolean): string {
  if (tags.highway === 'via_ferrata') return 'highway=via_ferrata';
  if (typeof tags.via_ferrata_scale === 'string') return 'via_ferrata_scale';
  if (tags.sport === 'via_ferrata') return 'sport=via_ferrata';
  if (tags.route === 'via_ferrata') return 'route=via_ferrata';
  if (hasRelation) return 'relation:route=via_ferrata';
  return 'unknown';
}

function parseFerrataFeatures(payload: OverpassResponse): FerrataFeature[] {
  const elements = payload.elements || [];
  const nodesById = new Map<number, [number, number]>();
  const ways: OverpassWay[] = [];
  const relationWayIds = new Map<number, Set<number>>();
  const relationNames = new Map<number, string>();
  const relationScales = new Map<number, string>();

  for (const element of elements) {
    if (element.type === 'node') {
      nodesById.set(element.id, [element.lon, element.lat]);
      continue;
    }

    if (element.type === 'way') {
      ways.push(element);
      continue;
    }

    if (element.type === 'relation') {
      const tags = element.tags || {};
      if (tags.route !== 'via_ferrata') continue;

      if (typeof tags.name === 'string') {
        relationNames.set(element.id, tags.name);
      }
      if (typeof tags.via_ferrata_scale === 'string') {
        relationScales.set(element.id, tags.via_ferrata_scale);
      }

      for (const member of element.members || []) {
        if (member.type !== 'way') continue;
        const current = relationWayIds.get(member.ref) || new Set<number>();
        current.add(element.id);
        relationWayIds.set(member.ref, current);
      }
    }
  }

  const features: FerrataFeature[] = [];

  for (const way of ways) {
    const tags = way.tags || {};
    const relationIdSet = relationWayIds.get(way.id) || new Set<number>();
    const relationIds = Array.from(relationIdSet.values());
    const linkedToFerrataRelation = relationIds.length > 0;

    if (!isExplicitFerrataTag(tags) && !linkedToFerrataRelation) {
      continue;
    }

    if (!Array.isArray(way.nodes) || way.nodes.length < 2) {
      continue;
    }

    const coordinates: number[][] = [];
    let validGeometry = true;

    for (const nodeId of way.nodes) {
      const point = nodesById.get(nodeId);
      if (!point) {
        validGeometry = false;
        break;
      }
      coordinates.push([point[0], point[1]]);
    }

    if (!validGeometry || coordinates.length < 2) {
      continue;
    }

    const firstRelationId = relationIds[0];
    const relationName = typeof firstRelationId === 'number' ? relationNames.get(firstRelationId) : undefined;
    const relationScale = typeof firstRelationId === 'number' ? relationScales.get(firstRelationId) : undefined;

    features.push({
      osmId: way.id,
      name: tags.name || relationName || null,
      viaFerrataScale: tags.via_ferrata_scale || relationScale || null,
      sacScale: tags.sac_scale || null,
      sourceType: deriveSourceType(tags, linkedToFerrataRelation),
      relationIds,
      tags,
      geometry: {
        type: 'LineString',
        coordinates
      }
    });
  }

  return features;
}

async function upsertFerrataFeatures(client: PoolClient, features: FerrataFeature[]): Promise<{ attempted: number; written: number }> {
  if (features.length === 0) return { attempted: 0, written: 0 };

  const conflictClause =
    CONFLICT_MODE === 'nothing'
      ? 'ON CONFLICT (osm_id) DO NOTHING'
      : `ON CONFLICT (osm_id) DO UPDATE
         SET
           name = EXCLUDED.name,
           via_ferrata_scale = EXCLUDED.via_ferrata_scale,
           sac_scale = EXCLUDED.sac_scale,
           source_type = EXCLUDED.source_type,
           relation_ids = EXCLUDED.relation_ids,
           tags = EXCLUDED.tags,
           geom = EXCLUDED.geom,
           updated_at = NOW()`;

  const upsertSql = `
    INSERT INTO via_ferrata (
      osm_id,
      name,
      via_ferrata_scale,
      sac_scale,
      source_type,
      relation_ids,
      tags,
      geom,
      updated_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7::jsonb,
      ST_SetSRID(ST_GeomFromGeoJSON($8), 4326),
      NOW()
    )
    ${conflictClause};
  `;

  let written = 0;

  for (const feature of features) {
    const result = await client.query(upsertSql, [
      feature.osmId,
      feature.name,
      feature.viaFerrataScale,
      feature.sacScale,
      feature.sourceType,
      feature.relationIds,
      JSON.stringify(feature.tags),
      JSON.stringify(feature.geometry)
    ]);

    written += result.rowCount || 0;
  }

  return { attempted: features.length, written };
}

function setInMemoryProgress(
  progressByKey: Map<string, ChunkProgress>,
  chunk: ChunkDescriptor,
  status: ChunkStatus,
  lastError: string | null
): void {
  const previousAttempts = progressByKey.get(chunk.chunkKey)?.attempts || 0;

  progressByKey.set(chunk.chunkKey, {
    chunkIndex: chunk.chunkIndex,
    chunkKey: chunk.chunkKey,
    bbox: chunk.bbox,
    status,
    attempts: previousAttempts + 1,
    lastError,
    updatedAt: new Date().toISOString()
  });
}

async function persistProgressState(chunks: ChunkDescriptor[], progressByKey: Map<string, ChunkProgress>): Promise<void> {
  await writeProgressSnapshot(chunks, progressByKey);
  await writeFailedChunks(buildFailedChunksFromProgress(progressByKey));
}

async function fetchViaFerrata(): Promise<void> {
  const chunks = buildChunks();

  console.log(`[INFO] Import mode: ${IMPORT_MODE}`);
  console.log(`[INFO] Conflict mode: ${CONFLICT_MODE}`);
  console.log(`[INFO] Overpass endpoint: ${OVERPASS_URL}`);

  await ensureTables();

  const progressByKey = await loadProgressFromDb();
  const chunksToProcess = selectChunksToProcess(chunks, progressByKey);
  const skippedChunks = chunks.length - chunksToProcess.length;

  console.log(`[INFO] Total chunks: ${chunks.length}`);
  console.log(`[INFO] Chunks to process: ${chunksToProcess.length}`);
  console.log(`[INFO] Chunks skipped: ${skippedChunks}`);

  if (chunksToProcess.length === 0) {
    await persistProgressState(chunks, progressByKey);
    console.log('[DONE] Nothing to process.');
    return;
  }

  let totalParsed = 0;
  let totalAttemptedWrites = 0;
  let totalWrittenRows = 0;

  for (let i = 0; i < chunksToProcess.length; i++) {
    const chunk = chunksToProcess[i];

    if (i > 0) {
      await sleep(2000);
    }

    console.log(
      `[INFO] Chunk ${chunk.chunkIndex}/${chunks.length} (${i + 1}/${chunksToProcess.length} pending): (${chunk.bbox.minLat}, ${chunk.bbox.minLon}, ${chunk.bbox.maxLat}, ${chunk.bbox.maxLon})`
    );

    try {
      const payload = await fetchChunkWithRetries(chunk.bbox, chunk.chunkIndex, 5);
      const features = parseFerrataFeatures(payload);
      totalParsed += features.length;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const writeStats = await upsertFerrataFeatures(client, features);
        await client.query('COMMIT');

        totalAttemptedWrites += writeStats.attempted;
        totalWrittenRows += writeStats.written;

        await saveChunkProgressToDb(chunk, 'completed', null);
        setInMemoryProgress(progressByKey, chunk, 'completed', null);

        console.log(
          `[OK] Chunk ${chunk.chunkIndex}: parsed ${features.length}, attempted writes ${writeStats.attempted}, affected rows ${writeStats.written}.`
        );
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await saveChunkProgressToDb(chunk, 'failed', reason);
      setInMemoryProgress(progressByKey, chunk, 'failed', reason);
      console.error(`[ERROR] Chunk ${chunk.chunkIndex} failed: ${reason}`);
    }

    await persistProgressState(chunks, progressByKey);
  }

  const unresolvedFailed = buildFailedChunksFromProgress(progressByKey);

  console.log('------------------------------------------------------------');
  console.log(`[DONE] Parsed ferrata features: ${totalParsed}`);
  console.log(`[DONE] Attempted writes: ${totalAttemptedWrites}`);
  console.log(`[DONE] Affected rows: ${totalWrittenRows}`);
  console.log(`[DONE] Unresolved failed chunks: ${unresolvedFailed.length}`);
  console.log(`[DONE] Progress file: ${PROGRESS_FILE}`);
  console.log('------------------------------------------------------------');
}

fetchViaFerrata()
  .catch((error) => {
    console.error('[FATAL] Via ferrata import failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
