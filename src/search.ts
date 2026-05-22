import mapboxgl from 'mapbox-gl';
import { updatePanel, type PanelProps, type Coordinates } from './ui';
import { hasValidElevationValue, resolveElevationFromCoordinates } from './elevation';

interface SearchResult {
  name: string;
  type: string;
  lat: number;
  lng: number;
  elevation: string | number | null;
  via_ferrata_scale: string | null;
  osm_id?: number | string;
  website?: string;
  description?: string;
}

let latestSearchSelectionToken = 0;

function waitForMapSettle(map: mapboxgl.Map, timeoutMs = 1800): Promise<void> {
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

    const timer = setTimeout(finalize, timeoutMs);
  });
}

export async function initSearch(map: mapboxgl.Map): Promise<void> {
  const searchBoxEl = document.getElementById('search-box') as HTMLInputElement | null;
  const searchResultsEl = document.getElementById('search-results');
  const searchContainerEl = document.getElementById('search-container');

  if (!searchBoxEl || !searchResultsEl || !searchContainerEl) {
    return;
  }

  const searchBox = searchBoxEl;
  const searchResults = searchResultsEl;
  const searchContainer = searchContainerEl;

  const PLACEHOLDER_TIERS = [
    'Search huts, peaks, bivouacs, via ferrata',
    'Search huts, peaks, bivouacs',
    'Search huts, peaks',
    'Search huts',
    'Search'
  ];
  const ELLIPSIS = '…';

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let lastMatches: SearchResult[] = [];
  let highlightedIndex = -1;
  let placeholderRaf = 0;
  let measureCanvas: HTMLCanvasElement | null = null;

  function setHighlight(index: number): void {
    const items = searchResults.children;
    for (let i = 0; i < items.length; i++) items[i].classList.remove('active');
    highlightedIndex = index;
    if (index >= 0 && items[index]) {
      items[index].classList.add('active');
      items[index].scrollIntoView({ block: 'nearest' });
    }
  }

  function measureTextWidth(text: string, font: string): number {
    if (!measureCanvas) measureCanvas = document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d');
    if (!ctx) return 0;
    ctx.font = font;
    return ctx.measureText(text).width;
  }

  function syncSearchPlaceholder(): void {
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
      const candidate = PLACEHOLDER_TIERS[i] + ELLIPSIS;
      if (measureTextWidth(candidate, font) <= available) {
        if (searchBox.placeholder !== candidate) searchBox.placeholder = candidate;
        return;
      }
    }
    if (searchBox.placeholder !== ELLIPSIS) searchBox.placeholder = ELLIPSIS;
  }

  function schedulePlaceholderSync(): void {
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

  function getTypeIcon(type: string): string {
    if (type === 'hut') return '🏠';
    if (type === 'bivouac') return '⛺';
    if (type === 'peak') return '⛰️';
    if (type === 'ferrata') return '🧗';
    return '📍';
  }

  async function goToFeature(feat: SearchResult): Promise<void> {
    const selectionToken = ++latestSearchSelectionToken;
    searchBox.value = feat.name;
    searchResults.innerHTML = '';
    searchResults.style.display = 'none';

    const coordinates: Coordinates | null =
      Number.isFinite(Number(feat.lat)) && Number.isFinite(Number(feat.lng))
        ? { lat: Number(feat.lat), lng: Number(feat.lng) }
        : null;

    map.flyTo({
      center: [feat.lng, feat.lat],
      zoom: 16,
      speed: 1.5,
      essential: true
    });

    const panelProps: PanelProps = feat.type === 'ferrata'
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
    const derivedElevation = await resolveElevationFromCoordinates(map, coordinates as { lat: number; lng: number });
    if (selectionToken !== latestSearchSelectionToken || derivedElevation === null) {
      return;
    }

    updatePanel({ ...panelProps, elevation: derivedElevation }, coordinates);
  }

  searchBox.addEventListener('input', (e) => {
    const query = (e.target as HTMLInputElement).value;
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
        const matches = await res.json() as SearchResult[];
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
                  setHighlight(next);
                  (searchResults.children[next] as HTMLElement).focus();
                }
              } else if ((e.key === 'ArrowUp') || (e.key === 'Tab' && e.shiftKey)) {
                e.preventDefault();
                if (highlightedIndex > 0) {
                  setHighlight(highlightedIndex - 1);
                  (searchResults.children[highlightedIndex - 1] as HTMLElement).focus();
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
      const next = highlightedIndex < 0 ? 0 : Math.min(highlightedIndex + 1, total - 1);
      setHighlight(next);
      (searchResults.children[next] as HTMLElement | undefined)?.focus();
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
    if (!searchContainer.contains(e.target as Node)) {
      searchResults.style.display = 'none';
      highlightedIndex = -1;
    }
  });
}
