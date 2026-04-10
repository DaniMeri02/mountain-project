import { updatePanel } from './ui.js';

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

  function goToFeature(feat) {
    searchBox.value = feat.name;
    searchResults.innerHTML = '';
    searchResults.style.display = 'none';

    map.flyTo({
      center: [feat.lng, feat.lat],
      zoom: 16,
      speed: 1.5,
      essential: true
    });

    if (feat.type === 'ferrata') {
      updatePanel({
        ...feat,
        elevation: feat.via_ferrata_scale ? `Scale ${feat.via_ferrata_scale}` : null,
        description: 'Via ferrata route segment.',
        website: ''
      });
      return;
    }

    updatePanel(feat);
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
