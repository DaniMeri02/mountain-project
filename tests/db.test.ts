import { describe, it, expect } from 'vitest';
import { isMissingTableError } from '../db';

// 42P01 is Postgres' "undefined_table". The app treats it as "feature not migrated yet"
// and degrades to an empty result set, so the predicate must recognise exactly that code
// and nothing else.
describe('isMissingTableError', () => {
  it('is true for a Postgres 42P01 error', () => {
    expect(isMissingTableError({ code: '42P01' })).toBe(true);
  });

  it('is false for any other Postgres error code', () => {
    expect(isMissingTableError({ code: '23505' })).toBe(false);
  });

  it('is false for non-object / nullish values', () => {
    expect(isMissingTableError(null)).toBe(false);
    expect(isMissingTableError(undefined)).toBe(false);
    expect(isMissingTableError('42P01')).toBe(false);
  });

  it('is false for an Error without a code', () => {
    expect(isMissingTableError(new Error('boom'))).toBe(false);
  });
});
