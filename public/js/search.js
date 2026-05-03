import { updatePanel } from './ui.js';
import { hasValidElevationValue, resolveElevationFromCoordinates } from './elevation.js';

let latestSearchSelectionToken = 0;

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
  const searchContainer = document.getElementById('search-container');

  if (!searchBox || !searchResults || !searchContainer) {
    return;
  }

  const PLACEHOLDER_TIERS = [
    'Search huts, peaks, bivouacs, via ferrata',
    'Search huts, peaks, bivouacs',
    'Search huts, peaks',
    'Search huts',
    'Search'
  ];
  const ELLIPSIS = '…';

  let debounceTimer;
  let lastMatches = [];
  let placeholderRaf = 0;
  let measureCanvas = null;

  function measureTextWidth(text, font) {
    if (!measureCanvas) measureCanvas = document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d');
    ctx.font = font;
    return ctx.measureText(text).width;
  }

  function syncSearchPlaceholder() {
    const cs = window.getComputedStyle(searchBox);
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
    const borderRight = parseFloat(cs.borderRightWidth) || 0;
    // Use offsetWidth (includes border) and subtract padding+border to get content box.
    // Reserve a small buffer so we never sit flush against the edge.
    const available = searchBox.offsetWidth - padLeft - padRight - borderLeft - borderRight - 6;
    if (available <= 0) return;

    const font = `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;

    for (const text of PLACEHOLDER_TIERS) {
      const candidate = text + ELLIPSIS;
      if (measureTextWidth(candidate, font) <= available) {
        if (searchBox.placeholder !== candidate) searchBox.placeholder = candidate;
        return;
      }
    }
    if (searchBox.placeholder !== ELLIPSIS) searchBox.placeholder = ELLIPSIS;
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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const matches = await res.json();
        if (!Array.isArray(matches)) throw new Error('Unexpected search response shape');
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

            // Build with DOM APIs to avoid XSS — feat.name comes from the database
            li.appendChild(document.createTextNode(`${typeIcon} `));
            const nameEl = document.createElement('strong');
            nameEl.textContent = feat.name;
            li.appendChild(nameEl);
            if (meta) {
              li.appendChild(document.createTextNode(' '));
              const metaEl = document.createElement('small');
              metaEl.textContent = `(${meta})`;
              li.appendChild(metaEl);
            }

            li.addEventListener('click', () => {
              goToFeature(feat);
            });

            searchResults.appendChild(li);
          });
        }
      } catch (err) {
        console.error("Error searching PostGIS DB: ", err);
      }
    }, 300);
  });

  searchBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && lastMatches.length > 0) {
      e.preventDefault();
      goToFeature(lastMatches[0]);
    }
  });

  // Hide dropdown when clicking outside — contains() covers touch on child <strong>/<small> nodes
  document.addEventListener('click', (e) => {
    if (!searchContainer.contains(e.target)) {
      searchResults.style.display = 'none';
    }
  });
}
