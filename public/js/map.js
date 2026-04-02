import { loadIcons } from './icons.js';
import { updatePanel } from './ui.js';

// We store the current selection to know if 3D should be applied after a style loads
let currentMode = 'outdoors-v12';

export function addMapLayers(map) {
  // Load custom marker icons
  loadIcons(map);

  // Re-apply 3D Terrain if the selected mode demands it
  if (currentMode === 'satellite-3d') {
    if (!map.getSource('mapbox-dem')) {
      map.addSource('mapbox-dem', {
        'type': 'raster-dem',
        'url': 'mapbox://mapbox.mapbox-terrain-dem-v1',
        'tileSize': 512,
        'maxzoom': 14
      });
    }
    // Enable 3D terrain with exaggeration
    map.setTerrain({ 'source': 'mapbox-dem', 'exaggeration': 1.5 });

    // Add sky layer for better atmosphere effect when tilted
    if (!map.getLayer('sky')) {
      map.addLayer({
        'id': 'sky',
        'type': 'sky',
        'paint': {
          'sky-type': 'atmosphere',
          'sky-atmosphere-sun': [0.0, 0.0],
          'sky-atmosphere-sun-intensity': 15
        }
      });
    }
  } else {
    // Reset to flat/top-down logic for non-3D modes (though setStyle clears some natively)
    map.setTerrain(null);
  }

  // Add data source
  if (!map.getSource('mountain-pois')) {
    map.addSource('mountain-pois', {
      type: 'geojson',
      data: '/data/pois.geojson'
    });
  }

  // Add visualization layer
  if (!map.getLayer('pois-points')) {
    map.addLayer({
      id: 'pois-points',
      type: 'symbol',
      source: 'mountain-pois',
      minzoom: 7, // Load icons even when zoomed out a bit
      layout: {
        'symbol-sort-key': ['*', -1, ['to-number', ['get', 'sort_elevation']]], // Prioritize higher peaks
        // This adds a "buffer" space around icons, pushing lesser peaks further away
        'icon-padding': 15,
        'text-padding': 10,
        'icon-image': [
          'match',
          ['get', 'type'],
          'hut', 'hut-icon',
          'bivouac', 'bivouac-icon',
          'peak', 'peak-icon',
          'hut-icon'
        ],
        'icon-size': 1,
        'icon-allow-overlap': false, // Let Mapbox organically hide colliding icons!
        'text-allow-overlap': false,
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-size': 11,
        'text-anchor': 'top',
        'text-offset': [0, 0.6]
      },
      paint: {
        'text-color': '#4a4a4a',
        'text-halo-color': 'rgba(255,255,255,0.9)',
        'text-halo-width': 1.5
      }
    });
  }

  // Add trails data source
  if (!map.getSource('mountain-trails')) {
    map.addSource('mountain-trails', {
      type: 'geojson',
      data: '/data/trails.geojson'
    });
  }

  // Add trails visual layer
  if (!map.getLayer('trails-lines')) {
    map.addLayer({
      id: 'trails-lines',
      type: 'line',
      source: 'mountain-trails',
      minzoom: 12, // Ensure trails are hidden when zoomed out
      layout: {
        'line-join': 'round',
        'line-cap': 'round'
      },
      paint: {
        'line-color': [
          'match',
          ['get', 'sac_scale'],
          'hiking', '#4CAF50',
          'mountain_hiking', '#FFC107',
          'demanding_mountain_hiking', '#FF9800',
          'alpine_hiking', '#F44336',
          'demanding_alpine_hiking', '#9C27B0',
          'difficult_alpine_hiking', '#000000',
          '#607D8B'
        ],
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          10, 1.5,
          15, 3,
          20, 5
        ],
        'line-dasharray': [
          'case',
          ['==', ['get', 'trail_visibility'], 'no'], ['literal', [1, 3]],
          ['==', ['get', 'trail_visibility'], 'bad'], ['literal', [2, 2]],
          ['literal', [1, 0]]
        ]
      }
    }, 'pois-points');
  }
}

export function setupMapInteractivity(map) {
  map.on('mouseenter', 'pois-points', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  
  map.on('mouseleave', 'pois-points', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'pois-points', (e) => {
    updatePanel(e.features[0].properties);
  });
}

export function setupStyleSwitcher(map) {
  const layerList = document.getElementById('menu');
  const inputs = layerList.getElementsByTagName('input');

  for (const input of inputs) {
    input.onclick = (e) => {
      currentMode = e.target.id;
      const layerId = e.target.value; // The actual style URL reference

      // Set the style
      map.setStyle('mapbox://styles/mapbox/' + layerId);

      // Instantly rotate the camera when switching to/from 3D mode
      if (currentMode === 'satellite-3d') {
        map.easeTo({ pitch: 70, bearing: 20 }); // Angle the camera!
      } else {
        map.easeTo({ pitch: 0, bearing: 0 }); // Reset to flat
      }
    };
  }
}
