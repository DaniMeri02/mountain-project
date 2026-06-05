import type mapboxgl from 'mapbox-gl';
import { updatePanel, patchPoiElevation } from './ui';
import { hasValidElevationValue, resolveElevationFromCoordinates } from './elevation';
import { buildPoiPanelProps, type PoiLike } from './poi-panel-props';

export type { PoiLike };

// One token across all entry points: a newer showPoiDetail() invalidates an older one's
// pending elevation patch, so a fast sequence of clicks never patches a stale panel.
let latestDetailToken = 0;

interface ShowPoiOptions {
  /** Fly the map to the POI. Set false when the POI is already under the cursor (map click). */
  fly?: boolean;
}

/**
 * The single way to render a POI into the detail panel: optionally fly to it, build the panel
 * props (handling the via-ferrata special case once), render, and — if elevation is missing —
 * resolve it from the terrain and patch the badge in place (INP-friendly: callers fire-and-forget).
 */
export async function showPoiDetail(map: mapboxgl.Map, poi: PoiLike, opts: ShowPoiOptions = {}): Promise<void> {
  const token = ++latestDetailToken;
  const coords = { lat: poi.lat, lng: poi.lng };

  if (opts.fly !== false) {
    map.flyTo({ center: [poi.lng, poi.lat], zoom: 15, speed: 1.4, essential: true });
  }

  await updatePanel(buildPoiPanelProps(poi), coords);

  if (poi.type !== 'ferrata' && !hasValidElevationValue(poi.elevation)) {
    const derived = await resolveElevationFromCoordinates(map, coords);
    if (token !== latestDetailToken) return; // a newer detail opened — don't patch the stale badge
    patchPoiElevation(derived);
  }
}
