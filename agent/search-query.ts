import type { FerrataScaleRange, SearchFilter } from './types';

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

// SAC scales that qualify a named trail as a "via ferrata" — mirrors /api/search.
const TRAIL_FERRATA_SAC = [
  'demanding_mountain_hiking',
  'alpine_hiking',
  'demanding_alpine_hiking',
  'difficult_alpine_hiking',
];

const ALL_TYPES = ['peak', 'hut', 'bivouac', 'ferrata'] as const;

// Ordered easiest → hardest. Index i ↔ letter ↔ numeric grade (i+1).
const FERRATA_GRADES = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * Via ferrata difficulty range → SQL predicate.
 *
 * `via_ferrata_scale` is free text mixing TWO grading systems: letters 'A'..'F'
 * and numbers '1'..'6' (A≈1 easiest … F≈6 hardest). We slice the ordered grade
 * list to [min..max] (min defaults to 'A', max to 'F') and expand each grade to
 * BOTH its letter and its numeric token so we match rows tagged either way, then
 * emit a parameterized `col = ANY($n)`. Returns null when no usable bound is set.
 */
function ferrataScaleClause(
  range: FerrataScaleRange,
  col: string,
  push: (value: unknown) => string,
): string | null {
  const min = range.min?.trim().toUpperCase();
  const max = range.max?.trim().toUpperCase();
  if (!min && !max) return null;

  const minIdx = min && FERRATA_GRADES.includes(min) ? FERRATA_GRADES.indexOf(min) : 0;
  const maxIdx = max && FERRATA_GRADES.includes(max) ? FERRATA_GRADES.indexOf(max) : FERRATA_GRADES.length - 1;
  if (minIdx > maxIdx) return null;

  const tokens: string[] = [];
  for (let i = minIdx; i <= maxIdx; i += 1) {
    tokens.push(FERRATA_GRADES[i], String(i + 1));
  }
  return `${col} = ANY(${push(tokens)})`;
}

/**
 * Builds a parameterized PostGIS query from an already-validated SearchFilter.
 * Reuses the pois ∪ (via_ferrata ∪ trails-as-ferrata) structure of /api/search.
 * Pure: no DB access, no I/O — fully unit-testable on its (sql, params) output.
 */
export function buildSearchQuery(filter: SearchFilter): BuiltQuery {
  const params: unknown[] = [];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const wanted = filter.types.length > 0 ? filter.types : [...ALL_TYPES];
  const poiTypes = wanted.filter((t) => t !== 'ferrata');
  const wantFerrata = wanted.includes('ferrata');

  const elevMin = filter.minElevation ?? null;
  const elevMax = filter.maxElevation ?? null;
  const hasElevation = elevMin != null || elevMax != null;

  // Spatial predicate shared by every branch. Points and lines both work with
  // ST_Intersects (point-in-polygon for POIs, any-overlap for ferrata lines).
  function areaClause(geomCol: string): string | null {
    const area = filter.area;
    if (!area) return null;
    if ((area.kind === 'province' || area.kind === 'region') && area.name) {
      return `ST_Intersects(${geomCol}, (SELECT geom FROM admin_areas WHERE kind = ${push(area.kind)} AND lower(name) = lower(${push(area.name)}) LIMIT 1))`;
    }
    if ((area.kind === 'viewport' || area.kind === 'bbox') && area.bbox) {
      const [minLng, minLat, maxLng, maxLat] = area.bbox;
      return `ST_Intersects(${geomCol}, ST_MakeEnvelope(${push(minLng)}, ${push(minLat)}, ${push(maxLng)}, ${push(maxLat)}, 4326))`;
    }
    return null;
  }

  function nameClause(col: string): string | null {
    if (!filter.nameContains) return null;
    return `${col} ILIKE ${push(`%${filter.nameContains}%`)}`;
  }

  function sacClause(col: string): string | null {
    const sac = filter.difficulty?.sacScale;
    if (!sac || sac.length === 0) return null;
    return `${col} = ANY(${push(sac)})`;
  }

  const branches: string[] = [];
  const ctes: string[] = [];

  // ── POIs branch (peak / hut / bivouac) ──────────────────────────────────────
  if (poiTypes.length > 0) {
    const where: string[] = [`type = ANY(${push(poiTypes)})`];
    if (elevMin != null) where.push(`elevation >= ${push(elevMin)}`);
    if (elevMax != null) where.push(`elevation <= ${push(elevMax)}`);
    const area = areaClause('geom');
    if (area) where.push(area);
    const name = nameClause('name');
    if (name) where.push(name);

    branches.push(`SELECT id, osm_id, type, name, elevation,
             ST_X(geom) AS lng, ST_Y(geom) AS lat,
             NULL::text AS via_ferrata_scale, NULL::text AS sac_scale, NULL::text AS source_type
      FROM pois
      WHERE ${where.join('\n        AND ')}`);
  }

  // ── Ferrata branch — excluded when an elevation filter is active (no data) ───
  if (wantFerrata && !hasElevation) {
    const vfRange = filter.difficulty?.viaFerrataScale;
    const vfClause = vfRange ? ferrataScaleClause(vfRange, 'via_ferrata_scale', push) : null;

    // Arm 1: the via_ferrata table.
    const vaWhere: string[] = [];
    const vaArea = areaClause('geom');
    if (vaArea) vaWhere.push(vaArea);
    const vaName = nameClause('name');
    if (vaName) vaWhere.push(vaName);
    const vaSac = sacClause('sac_scale');
    if (vaSac) vaWhere.push(vaSac);
    if (vfClause) vaWhere.push(vfClause);

    const arms: string[] = [
      `SELECT osm_id, name, via_ferrata_scale, sac_scale, source_type, geom
        FROM via_ferrata${vaWhere.length ? `\n        WHERE ${vaWhere.join('\n          AND ')}` : ''}`,
    ];

    // Arm 2: trails recognised as ferrata by name + SAC. Skipped when a via-ferrata
    // scale filter is set, since trails carry no via_ferrata_scale.
    if (!vfClause) {
      const trWhere: string[] = [
        `(t.name ILIKE 'ferrata %' OR t.name ILIKE '% via ferrata %' OR t.name ILIKE '%ferrata%')`,
        `t.sac_scale = ANY(${push(TRAIL_FERRATA_SAC)})`,
        `NOT EXISTS (SELECT 1 FROM via_ferrata vf WHERE vf.osm_id = t.osm_id)`,
      ];
      const trArea = areaClause('t.geom');
      if (trArea) trWhere.push(trArea);
      const trName = nameClause('t.name');
      if (trName) trWhere.push(trName);
      const trSac = sacClause('t.sac_scale');
      if (trSac) trWhere.push(trSac);

      arms.push(`SELECT t.osm_id, t.name, NULL::text AS via_ferrata_scale, t.sac_scale,
               'name:ferrata'::text AS source_type, t.geom
        FROM trails t
        WHERE ${trWhere.join('\n          AND ')}`);
    }

    ctes.push(`ferrata_rows AS (
        ${arms.join('\n        UNION ALL\n        ')}
      )`);
    ctes.push(`ferrata_matches AS (
        SELECT NULL::bigint AS id, MIN(osm_id) AS osm_id, 'ferrata'::text AS type, name,
               NULL::integer AS elevation,
               ST_X(ST_Centroid(ST_Collect(geom))) AS lng,
               ST_Y(ST_Centroid(ST_Collect(geom))) AS lat,
               MIN(via_ferrata_scale) FILTER (WHERE via_ferrata_scale IS NOT NULL) AS via_ferrata_scale,
               MIN(sac_scale) FILTER (WHERE sac_scale IS NOT NULL) AS sac_scale,
               CASE WHEN BOOL_OR(source_type <> 'name:ferrata') THEN 'via_ferrata' ELSE 'name:ferrata' END AS source_type
        FROM ferrata_rows
        WHERE name IS NOT NULL
        GROUP BY name
      )`);
    branches.push(`SELECT id, osm_id, type, name, elevation, lng, lat, via_ferrata_scale, sac_scale, source_type FROM ferrata_matches`);
  }

  // Nothing to match (e.g. types=['ferrata'] together with an elevation filter):
  // return a valid zero-row query so callers stay uniform.
  if (branches.length === 0) {
    return {
      sql: `SELECT NULL::bigint AS id, NULL::bigint AS osm_id, NULL::text AS type, NULL::text AS name,
             NULL::integer AS elevation, NULL::float8 AS lng, NULL::float8 AS lat,
             NULL::text AS via_ferrata_scale, NULL::text AS sac_scale, NULL::text AS source_type,
             0::bigint AS total
      WHERE false`,
      params: [],
    };
  }

  const orderBy =
    filter.sort === 'elevation_asc'
      ? 'elevation ASC NULLS LAST, name ASC'
      : filter.sort === 'name'
        ? 'name ASC'
        : 'elevation DESC NULLS LAST, name ASC';

  const combined = branches.join('\n      UNION ALL\n      ');
  const withClause = ctes.length
    ? `WITH ${ctes.join(',\n      ')},\n      combined AS (\n      ${combined}\n      )`
    : `WITH combined AS (\n      ${combined}\n      )`;

  const sql = `${withClause}
      SELECT id, osm_id, type, name, elevation, lng, lat, via_ferrata_scale, sac_scale, source_type,
             COUNT(*) OVER() AS total
      FROM combined
      ORDER BY ${orderBy}
      LIMIT ${push(filter.limit)} OFFSET ${push(filter.offset)}`;

  return { sql, params };
}
