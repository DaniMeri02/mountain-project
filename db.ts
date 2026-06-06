// Database helpers shared by the server and scripts.

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
