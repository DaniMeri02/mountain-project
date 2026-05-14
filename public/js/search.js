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
    'Search huts, peaks, bivouacs and via ferrata',
    'Search huts, peaks, bivouacs',
    'Search huts, peaks',
    'Search huts',
    'Search'
  ];
  const ELLIPSIS = '…';

  let debounceTimer;
  let lastMatches = [];
  let highlightedIndex = -1;
  let placeholderRaf = 0;
  let measureCanvas = null;

  function setHighlight(index) {
    const items = searchResults.children;
    for (let i = 0; i < items.length; i++) items[i].classList.remove('active');
    highlightedIndex = index;
    if (index >= 0 && items[index]) {
      items[index].classList.add('active');
      items[index].scrollIntoView({ block: 'nearest' });
    }
  }

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

    for (let i = 0; i < PLACEHOLDER_TIERS.length; i++) {
      const candidate = i === 0 ? PLACEHOLDER_TIERS[i] : PLACEHOLDER_TIERS[i] + ELLIPSIS;
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
        highlightedIndex = -1;

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

            const itemIndex = lastMatches.indexOf(feat);
            li.setAttribute('tabindex', '0');
            li.setAttribute('role', 'option');

            li.addEventListener('click', () => {
              goToFeature(feat);
            });

            li.addEventListener('focus', () => {
              setHighlight(itemIndex);
            });

            li.addEventListener('keydown', (e) => {
              const total = lastMatches.length;
              if ((e.key === 'ArrowDown') || (e.key === 'Tab' && !e.shiftKey)) {
                e.preventDefault();
                const next = highlightedIndex + 1;
                if (next < total) {
                  searchResults.children[next].focus();
                }
              } else if ((e.key === 'ArrowUp') || (e.key === 'Tab' && e.shiftKey)) {
                e.preventDefault();
                if (highlightedIndex > 0) {
                  searchResults.children[highlightedIndex - 1].focus();
                } else {
                  setHighlight(-1);
                  searchBox.focus();
                }
              } else if (e.key === 'Enter') {
                e.preventDefault();
                goToFeature(feat);
              } else if (e.key === 'Escape') {
                searchResults.innerHTML = '';
                searchResults.style.display = 'none';
                highlightedIndex = -1;
                searchBox.focus();
              }
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
    const total = lastMatches.length;
    if (total === 0) return;

    if ((e.key === 'ArrowDown' || e.key === 'Tab') && !e.shiftKey) {
      e.preventDefault();
      searchResults.children[0]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(Math.max(highlightedIndex - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      goToFeature(lastMatches[highlightedIndex >= 0 ? highlightedIndex : 0]);
    } else if (e.key === 'Escape') {
      searchResults.innerHTML = '';
      searchResults.style.display = 'none';
      highlightedIndex = -1;
      searchBox.blur();
    }
  });

  // Hide dropdown when clicking outside — contains() covers touch on child <strong>/<small> nodes
  document.addEventListener('click', (e) => {
    if (!searchContainer.contains(e.target)) {
      searchResults.style.display = 'none';
      highlightedIndex = -1;
    }
  });
}
