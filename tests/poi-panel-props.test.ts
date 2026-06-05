import { describe, it, expect } from 'vitest';
import { buildPoiPanelProps } from '../src/poi-panel-props';

describe('buildPoiPanelProps', () => {
  it('maps a via ferrata to a "Grade" label (single source of truth — no Scale/Grade drift)', () => {
    const p = buildPoiPanelProps({ name: 'Ferrata X', type: 'ferrata', lat: 46, lng: 10, via_ferrata_scale: 'D' });
    expect(p.elevation).toBe('Grade D');
    expect(p.via_ferrata_scale).toBe('D');
    expect(p.description).toBe('Via ferrata route segment.');
  });

  it('gives a ferrata without a scale a null elevation', () => {
    const p = buildPoiPanelProps({ name: 'F', type: 'ferrata', lat: 46, lng: 10, via_ferrata_scale: null });
    expect(p.elevation).toBeNull();
  });

  it('passes through a numeric elevation for a peak/hut/bivouac', () => {
    const p = buildPoiPanelProps({ name: 'Pizzo', type: 'peak', lat: 46, lng: 10, elevation: 2300 });
    expect(p.elevation).toBe(2300);
    expect(p.via_ferrata_scale).toBeUndefined();
  });

  it('preserves website and description when present', () => {
    const p = buildPoiPanelProps({
      name: 'Rifugio', type: 'hut', lat: 46, lng: 10, elevation: 1900,
      website: 'https://example.org', description: 'A hut.',
    });
    expect(p.website).toBe('https://example.org');
    expect(p.description).toBe('A hut.');
  });
});
