import { updatePanel } from './ui.js';

export async function initSearch(map) {
  const searchBox = document.getElementById('search-box');
  const searchResults = document.getElementById('search-results');

  let debounceTimer;

  searchBox.addEventListener('input', (e) => {
    const query = e.target.value;
    searchResults.innerHTML = '';
    searchResults.style.display = 'none';

    if (query.trim().length < 2) return;

    // Debounce the search to avoid hitting the DB on every single keystroke
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const matches = await res.json();

        if (matches.length > 0) {
          searchResults.style.display = 'block';
          matches.forEach(feat => {
            const li = document.createElement('li');
            const typeIcon = feat.type === 'hut' ? '🏠' : (feat.type === 'bivouac' ? '⛺' : '⛰️');
            
            li.innerHTML = `${typeIcon} <strong>${feat.name}</strong> <small>(${feat.elevation} m)</small>`;
            
            li.addEventListener('click', () => {
              searchBox.value = feat.name;
              searchResults.innerHTML = '';
              searchResults.style.display = 'none';
              
              map.flyTo({ 
                center: [feat.lng, feat.lat], 
                zoom: 14, 
                speed: 1.5, 
                essential: true 
              });
              
              updatePanel(feat);
            });
            
            searchResults.appendChild(li);
          });
        }
      } catch (err) {
        console.error("Error searching PostGIS DB: ", err);
      }
    }, 300); // Wait 300ms after user stops typing
  });

  // Hide dropdown if clicked outside
  document.addEventListener('click', (e) => {
    if(e.target.id !== 'search-box') {
      searchResults.style.display = 'none';
    }
  });
}
