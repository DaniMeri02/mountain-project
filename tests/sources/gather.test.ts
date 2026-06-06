import { describe, it, expect, vi } from 'vitest';
import { gatherSources, type NamedSource } from '../../agent/sources/gather';
import type { AgentInput } from '../../agent/types';

const input = { name: 'Rifugio X', type: 'hut' } as AgentInput;

describe('gatherSources', () => {
  it('returns one result per source, preserving order', async () => {
    const sources: NamedSource[] = [
      { name: 'A', fetch: async () => ({ sourceName: 'A', content: 'a', success: true }) },
      { name: 'B', fetch: async () => ({ sourceName: 'B', content: 'b', success: true }) },
    ];
    const results = await gatherSources(sources, input);
    expect(results.map((r) => r.sourceName)).toEqual(['A', 'B']);
  });

  it('turns a throwing source into a failed result tagged with its name', async () => {
    const sources: NamedSource[] = [
      { name: 'Good', fetch: async () => ({ sourceName: 'Good', content: 'ok', success: true }) },
      { name: 'Bad', fetch: async () => { throw new Error('network'); } },
    ];
    const results = await gatherSources(sources, input);
    expect(results[1]).toEqual({ sourceName: 'Bad', content: '', success: false });
  });

  it('reports the error and the failing source name via onError', async () => {
    const onError = vi.fn();
    const boom = new Error('boom');
    const sources: NamedSource[] = [{ name: 'Bad', fetch: async () => { throw boom; } }];
    await gatherSources(sources, input, onError);
    expect(onError).toHaveBeenCalledWith('Bad', boom);
  });

  it('lets the other sources succeed when one fails', async () => {
    const sources: NamedSource[] = [
      { name: 'Bad', fetch: async () => { throw new Error('x'); } },
      { name: 'Good', fetch: async () => ({ sourceName: 'Good', content: 'ok', success: true }) },
    ];
    const results = await gatherSources(sources, input);
    expect(results.find((r) => r.sourceName === 'Good')?.success).toBe(true);
  });
});
