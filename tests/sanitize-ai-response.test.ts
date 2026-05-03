import { describe, it, expect } from 'vitest';
import { sanitizeAiResponse } from '../agent/orchestrator';

describe('sanitizeAiResponse', () => {
  it('returns clean HTML untouched', () => {
    const input = '<h3>Panoramica</h3><p>Rifugio in Valtellina.</p>';
    expect(sanitizeAiResponse(input)).toBe(input);
  });

  it('strips <think>...</think> blocks (lowercase)', () => {
    const input = '<think>internal monologue here</think><h3>Panoramica</h3><p>ok</p>';
    expect(sanitizeAiResponse(input)).toBe('<h3>Panoramica</h3><p>ok</p>');
  });

  it('strips <thinking>...</thinking> blocks (alternate tag)', () => {
    const input = '<thinking>plan...</thinking><h3>Panoramica</h3><p>ok</p>';
    expect(sanitizeAiResponse(input)).toBe('<h3>Panoramica</h3><p>ok</p>');
  });

  it('strips reasoning prose before first HTML tag', () => {
    const input = `Okay, let me start by understanding what the user needs. The data shows...

<h3>Panoramica</h3><p>Rifugio in Valtellina.</p>`;
    expect(sanitizeAiResponse(input)).toBe('<h3>Panoramica</h3><p>Rifugio in Valtellina.</p>');
  });

  it('strips multi-paragraph reasoning leak (Qwen3 style)', () => {
    const input = `Okay, let me start by understanding what the user needs.
They want a comprehensive description for the Rifugio.
First, I need to parse all the data collected from various sources.
The construction year is 1937 from Wikidata.

<h3>Panoramica</h3>
<p>Situato in Valtellina a 2100 m, il Rifugio Antonio Omio...</p>`;
    const result = sanitizeAiResponse(input);
    expect(result.startsWith('<h3>Panoramica</h3>')).toBe(true);
    expect(result).not.toContain('Okay, let me start');
    expect(result).not.toContain('parse all the data');
  });

  it('strips ```html code-fence wrappers', () => {
    const input = '```html\n<h3>Panoramica</h3><p>ok</p>\n```';
    expect(sanitizeAiResponse(input)).toBe('<h3>Panoramica</h3><p>ok</p>');
  });

  it('strips bare ``` code-fence wrappers', () => {
    const input = '```\n<h3>Panoramica</h3>\n```';
    expect(sanitizeAiResponse(input)).toBe('<h3>Panoramica</h3>');
  });

  it('handles think block + leading prose + trailing fence together', () => {
    const input = `<think>plan</think>
Some reasoning leaked here.
\`\`\`html
<h3>Panoramica</h3><p>ok</p>
\`\`\``;
    expect(sanitizeAiResponse(input)).toBe('<h3>Panoramica</h3><p>ok</p>');
  });

  it('preserves <h3> with attributes', () => {
    const input = '<h3 class="x">Title</h3><p>body</p>';
    expect(sanitizeAiResponse(input)).toBe('<h3 class="x">Title</h3><p>body</p>');
  });

  it('keeps content as-is when no leading garbage and no fences', () => {
    const input = '<p>Solo paragrafo.</p>';
    expect(sanitizeAiResponse(input)).toBe('<p>Solo paragrafo.</p>');
  });

  it('trims surrounding whitespace', () => {
    const input = '\n\n  <h3>Title</h3>\n\n';
    expect(sanitizeAiResponse(input)).toBe('<h3>Title</h3>');
  });
});
