import { updatePanel } from './ui.js';

let latestSearchSelectionToken = 0;

function hasValidElevationValue(elevation) {
  const numericElevation = Number(elevation);
  if (Number.isFinite(numericElevation)) {
    return numericElevation > 0;
  }

  if (typeof elevation === 'string') {
    const trimmed = elevation.trim();
    if (!trimmed || trimmed === 'N/D') {
      return false;
    }

    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed > 0;
    }

    return true;
  }

  return false;
}

function queryElevationFromTerrain(map, coordinates) {
  if (!coordinates || typeof map.queryTerrainElevation !== 'function') {
    return null;
  }

  const value = map.queryTerrainElevation([coordinates.lng, coordinates.lat], { exaggerated: false });
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.round(value);
}

async function resolveElevationFromCoordinates(map, coordinates) {
  if (!coordinates || typeof map.queryTerrainElevation !== 'function') {
    return null;
  }

  // DEM tiles may still be loading; retry briefly before giving up.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const elevation = queryElevationFromTerrain(map, coordinates);
    if (elevation !== null) {
      return elevation;
    }

    await new Promise((resolve) => {
      window.setTimeout(resolve, 140);
    });
  }

  return null;
}

function waitForMapSettle(map, timeoutMs = 1800) {
  return new Promise((resolve) => {
    let finished = false;

    const finalize = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      map.off('moveend', onMoveEnd);
      map.off('idle', onIdle);
      resolve();
    };

    const onMoveEnd = () => finalize();
    const onIdle = () => finalize();

    map.on('moveend', onMoveEnd);
    map.on('idle', onIdle);

    const timer = window.setTimeout(finalize, timeoutMs);
  });
}

export async function initSearch(map) {
  const searchBox = document.getElementById('search-box');
  const searchResults = document.getElementById('search-results');

  if (!searchBox || !searchResults) {
    return;
  }

  const FULL_PLACEHOLDER = 'Search huts, peaks, bivouacs, via ferrata...';
  const MEDIUM_PLACEHOLDER = 'Search huts, peaks, bivouacs...';
  const SHORT_PLACEHOLDER = 'Search...';

  let debounceTimer;
  let lastMatches = [];
  let placeholderRaf = 0;

  function syncSearchPlaceholder() {
    const width = searchBox.clientWidth;

    if (width >= 360) {
      searchBox.placeholder = FULL_PLACEHOLDER;
      return;
    }

    if (width >= 250) {
      searchBox.placeholder = MEDIUM_PLACEHOLDER;
      return;
    }

    searchBox.placeholder = SHORT_PLACEHOLDER;
  }

  function schedulePlaceholderSync() {
    if (placeholderRaf) {
      cancelAnimationFrame(placeholderRaf);
    }

    placeholderRaf = requestAnimationFrame(() => {
      syncSearchPlaceholder();
      placeholderRaf = 0;
    });
  }

  schedulePlaceholderSync();
  window.addEventListener('resize', schedulePlaceholderSync);
  window.addEventListener('layout:changed', schedulePlaceholderSync);

  if (typeof ResizeObserver !== 'undefined') {
    const placeholderObserver = new ResizeObserver(() => {
      schedulePlaceholderSync();
    });
    placeholderObserver.observe(searchBox);
  }

  function getTypeIcon(type) {
    if (type === 'hut') return '🏠';
    if (type === 'bivouac') return '⛺';
    if (type === 'peak') return '⛰️';
    if (type === 'ferrata') return '🧗';
    return '📍';
  }

  async function goToFeature(feat) {
    const selectionToken = ++latestSearchSelectionToken;
    searchBox.value = feat.name;
    searchResults.innerHTML = '';
    searchResults.style.display = 'none';

    const coordinates =
      Number.isFinite(Number(feat.lat)) && Number.isFinite(Number(feat.lng))
        ? { lat: Number(feat.lat), lng: Number(feat.lng) }
        : null;

    map.flyTo({
      center: [feat.lng, feat.lat],
      zoom: 16,
      speed: 1.5,
      essential: true
    });

    const panelProps = feat.type === 'ferrata'
      ? {
          ...feat,
          elevation: feat.via_ferrata_scale ? `Scale ${feat.via_ferrata_scale}` : null,
          description: 'Via ferrata route segment.',
          website: ''
        }
      : { ...feat };

    updatePanel(panelProps, coordinates);

    if (!coordinates || hasValidElevationValue(panelProps.elevation)) {
      return;
    }

    await waitForMapSettle(map);
    const derivedElevation = await resolveElevationFromCoordinates(map, coordinates);
    if (selectionToken !== latestSearchSelectionToken || derivedElevation === null) {
      return;
    }

    updatePanel({ ...panelProps, elevation: derivedElevation }, coordinates);

  }

  searchBox.addEventListener('input', (e) => {
    const query = e.target.value;
    searchResults.innerHTML = '';
    searchResults.style.display = 'none';
    lastMatches = [];

    if (query.trim().length < 2) return;

    // Debounce the search to avoid hitting the DB on every single keystroke
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const matches = await res.json();
        lastMatches = matches;

        if (matches.length > 0) {
          searchResults.style.display = 'block';
          matches.forEach(feat => {
            const li = document.createElement('li');
            const typeIcon = getTypeIcon(feat.type);

            let meta = '';
            if (feat.type === 'ferrata') {
              meta = feat.via_ferrata_scale ? `Scale ${feat.via_ferrata_scale}` : 'Via ferrata';
            } else if (feat.elevation !== null && feat.elevation !== undefined && feat.elevation !== 'N/D') {
              meta = `${feat.elevation} m`;
            }

            li.innerHTML = meta
              ? `${typeIcon} <strong>${feat.name}</strong> <small>(${meta})</small>`
              : `${typeIcon} <strong>${feat.name}</strong>`;
            
            li.addEventListener('click', () => {
              goToFeature(feat);
            });
            
            searchResults.appendChild(li);
          });
        }
      } catch (err) {
        console.error("Error searching PostGIS DB: ", err);
      }
    }, 300); // Wait 300ms after user stops typing
  });

  searchBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && lastMatches.length > 0) {
      e.preventDefault();
      goToFeature(lastMatches[0]);
    }
  });

  // Hide dropdown if clicked outside
  document.addEventListener('click', (e) => {
    if(e.target.id !== 'search-box') {
      searchResults.style.display = 'none';
    }
  });
}
