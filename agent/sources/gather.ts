import type { AgentInput, SourceResult } from '../types';

/** A source paired with the name to attribute its result to — used even when the fetch throws. */
export interface NamedSource {
  name: string;
  fetch: (input: AgentInput) => Promise<SourceResult>;
}

/**
 * Run every source concurrently and always return one SourceResult per source. A source that
 * throws becomes a failed result tagged with its name, so provenance is never lost, and the
 * error is surfaced through onError instead of being silently swallowed. One failure never
 * blocks the others.
 */
export async function gatherSources(
  sources: NamedSource[],
  input: AgentInput,
  onError: (name: string, err: unknown) => void = () => {},
): Promise<SourceResult[]> {
  return Promise.all(
    sources.map(async ({ name, fetch }) => {
      try {
        return await fetch(input);
      } catch (err) {
        onError(name, err);
        return { sourceName: name, content: '', success: false };
      }
    }),
  );
}
