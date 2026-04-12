import { readFileSync } from 'fs';
import { join } from 'path';

const PROMPT_PATH = join(process.cwd(), 'ai-agent-conf', 'agent-prompt.md');

// In-memory cache — cleared each server restart.
// Because the file is small and rarely changes, one read per process is fine.
// Call reloadPrompt() if you want hot-reload without restarting the server.
let cachedPrompt: string | null = null;

export function loadAgentPrompt(): string {
  if (cachedPrompt !== null) return cachedPrompt;
  cachedPrompt = readFileSync(PROMPT_PATH, 'utf-8');
  return cachedPrompt;
}

/** Force re-read the file on the next call to loadAgentPrompt(). */
export function reloadPrompt(): void {
  cachedPrompt = null;
}
