import { readFileSync } from 'fs';
import { join } from 'path';

// One owner for reading editable prompt files (ai-agent-conf/*.md). Each file is read once
// and memoized by its absolute path — the files are small and rarely change, so one read per
// process is fine. Call reloadPrompt() to force a re-read without restarting the server.
const cache = new Map<string, string>();

/** Read a prompt file once and memoize by absolute path. */
export function loadPrompt(absPath: string): string {
  const hit = cache.get(absPath);
  if (hit !== undefined) return hit;
  const content = readFileSync(absPath, 'utf-8');
  cache.set(absPath, content);
  return content;
}

/** Drop a cached prompt (or all of them, with no argument) so the next load re-reads from disk. */
export function reloadPrompt(absPath?: string): void {
  if (absPath === undefined) cache.clear();
  else cache.delete(absPath);
}

const AGENT_PROMPT_PATH = join(process.cwd(), 'ai-agent-conf', 'agent-prompt.md');

/** The agent system prompt (ai-agent-conf/agent-prompt.md). */
export function loadAgentPrompt(): string {
  return loadPrompt(AGENT_PROMPT_PATH);
}
