import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadPrompt, reloadPrompt, loadAgentPrompt } from '../agent/prompt-loader';

// Behavior: a prompt file is read once and memoized by its path; reload() forces a re-read.
// We verify through the public interface by mutating the file on disk and observing when the
// change becomes visible (only after reload), not by spying on fs internals.

const dir = mkdtempSync(join(tmpdir(), 'prompt-loader-'));

afterEach(() => {
  reloadPrompt(); // clear the whole cache between tests
});

function tmpPrompt(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

describe('loadPrompt', () => {
  it('reads the file content', () => {
    const path = tmpPrompt('a.md', 'first');
    expect(loadPrompt(path)).toBe('first');
  });

  it('memoizes: a later on-disk change is not seen until reload', () => {
    const path = tmpPrompt('b.md', 'original');
    expect(loadPrompt(path)).toBe('original');

    writeFileSync(path, 'changed', 'utf-8');
    expect(loadPrompt(path)).toBe('original'); // still cached

    reloadPrompt(path);
    expect(loadPrompt(path)).toBe('changed'); // re-read after reload
  });

  it('reload() with no argument clears every cached prompt', () => {
    const a = tmpPrompt('c.md', 'a1');
    const b = tmpPrompt('d.md', 'b1');
    loadPrompt(a);
    loadPrompt(b);

    writeFileSync(a, 'a2', 'utf-8');
    writeFileSync(b, 'b2', 'utf-8');
    reloadPrompt();

    expect(loadPrompt(a)).toBe('a2');
    expect(loadPrompt(b)).toBe('b2');
  });

  it('caches each path independently', () => {
    const a = tmpPrompt('e.md', 'EE');
    const b = tmpPrompt('f.md', 'FF');
    expect(loadPrompt(a)).toBe('EE');
    expect(loadPrompt(b)).toBe('FF');
  });
});

describe('loadAgentPrompt', () => {
  it('returns the real agent system prompt (non-empty)', () => {
    expect(loadAgentPrompt().length).toBeGreaterThan(0);
  });
});
