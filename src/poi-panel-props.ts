import type { PanelProps } from './ui';

// The minimal shape needed to show any POI in the detail panel. Satisfied by an autocomplete
// SearchResult, a smart-search SmartResult, and a map feature's properties alike.
export interface PoiLike {
  name: string;
  type: string;
  lat: number;
  lng: number;
  elevation?: number | string | null;
  via_ferrata_scale?: string | null;
  osm_id?: number | string | null;
  website?: string;
  description?: string;
}

// Pure mapping POI → panel props. Single source of truth for the via-ferrata special case
// (label its grade where elevation would go) — previously duplicated and drifted ("Scale" vs "Grade").
export function buildPoiPanelProps(poi: PoiLike): PanelProps {
  if (poi.type === 'ferrata') {
    return {
      name: poi.name,
      type: poi.type,
      elevation: poi.via_ferrata_scale ? `Grade ${poi.via_ferrata_scale}` : null,
      via_ferrata_scale: poi.via_ferrata_scale ?? null,
      description: poi.description ?? 'Via ferrata route segment.',
      osm_id: poi.osm_id ?? null,
      website: poi.website ?? '',
    };
  }

  return {
    name: poi.name,
    type: poi.type,
    elevation: poi.elevation ?? null,
    osm_id: poi.osm_id ?? null,
    website: poi.website,
    description: poi.description,
  };
}
