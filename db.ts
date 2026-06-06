// Database helpers shared by the server and scripts.
import { Pool, type PoolConfig } from 'pg';

/** Build the pg connection config from environment variables (one source of truth). */
export function poolConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  return {
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    host: env.DB_HOST,
    // Unset/empty DB_PORT must be undefined (pg falls back to 5432), never NaN.
    port: env.DB_PORT ? Number(env.DB_PORT) : undefined,
    database: env.DB_NAME,
  };
}

/** Create a pg Pool from the environment, with optional per-caller overrides. */
export function createPool(overrides: PoolConfig = {}): Pool {
  return new Pool({ ...poolConfigFromEnv(), ...overrides });
}

/** Extract a Postgres error `code` if the value looks like a pg error, else undefined. */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * True when the error is Postgres' 42P01 (undefined_table). The app treats a missing table as
 * "this feature isn't migrated yet" and degrades to an empty result set rather than 500-ing.
 */
export function isMissingTableError(error: unknown): boolean {
  return getErrorCode(error) === '42P01';
}
