import type { RouteStep } from './graph';

function escapeXml(s: string): string {
  return String(s).replace(/[<>&"]/g, (c) => {
    const map: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' };
    return map[c] ?? c;
  });
}

export function generateGpx(edges: RouteStep[], name: string): string {
  const coords: [number, number][] = [];
  for (const { coords: segCoords, reversed } of edges) {
    const seg = reversed ? [...segCoords].reverse() : segCoords;
    const start = coords.length > 0 ? 1 : 0; // avoid duplicate junction points
    for (let i = start; i < seg.length; i++) {
      coords.push(seg[i]);
    }
  }

  const trkpts = coords
    .map(([lng, lat]) => `    <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"/>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Mountain Portal"
     xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${escapeXml(name)}</name><trkseg>
${trkpts}
  </trkseg></trk>
</gpx>`;
}

export function downloadGpx(gpxString: string, filename: string): void {
  const blob = new Blob([gpxString], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
