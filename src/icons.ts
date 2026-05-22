import mapboxgl from 'mapbox-gl';

export const customIcons: Record<string, string> = {
  // A small, simple dark red house for huts (like OSM)
  'hut-icon': 'data:image/svg+xml;charset=UTF-8,%3Csvg%20width%3D%2220%22%20height%3D%2220%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M10%203%20L3%209%20h2%20v8%20h10%20V9%20h2%20L10%203%20z%22%20fill%3D%22%23c0392b%22%20stroke%3D%22%23ffffff%22%20stroke-width%3D%221.5%22%2F%3E%3C%2Fsvg%3E',
  // A small orange tent for bivouacs
  'bivouac-icon': 'data:image/svg+xml;charset=UTF-8,%3Csvg%20width%3D%2220%22%20height%3D%2220%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M10%205%20L3%2015%20h14%20L10%205%20z%20m0%203%20l3%206%20H7%20l3%20-6%20z%22%20fill%3D%22%23d35400%22%20stroke%3D%22%23ffffff%22%20stroke-width%3D%221.5%22%2F%3E%3C%2Fsvg%3E',
  // A simple brown/purple triangle for peaks (classic topo map symbol)
  'peak-icon': 'data:image/svg+xml;charset=UTF-8,%3Csvg%20width%3D%2218%22%20height%3D%2218%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpolygon%20points%3D%229%2C2%203%2C14%2015%2C14%22%20fill%3D%22%238e44ad%22%20stroke%3D%22%23ffffff%22%20stroke-width%3D%221.5%22%2F%3E%3C%2Fsvg%3E',
  // Small arrow for route direction
  'route-arrow': 'data:image/svg+xml;charset=UTF-8,%3Csvg%20width%3D%2216%22%20height%3D%2216%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M8%201%20L14%2014%20L8%2011%20L2%2014%20Z%22%20fill%3D%22%23111%22%20stroke%3D%22%23ffffff%22%20stroke-width%3D%221.2%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E'
};

export function loadIcons(map: mapboxgl.Map): void {
  Object.keys(customIcons).forEach(id => {
    const img = new Image();
    img.src = customIcons[id];
    img.onload = () => {
      if (!map.hasImage(id)) map.addImage(id, img);
    };
    img.onerror = () => { console.error(`[icons] Failed to load icon: ${id}`); };
  });
}
