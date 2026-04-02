import { updatePanel } from './ui.js';

let allPoints = [];

export async function initSearch(map) {
  try {
    const res = await fetch('/data/pois.geojson');
    const data = await res.json();
    allPoints = data.features;
  } catch (err) {
    console.error("Error loading search data: ", err);
  }

  const searchBox = document.getElementById('search-box');
  const searchResults = document.getElementById('search-results');

  searchBox.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    searchResults.innerHTML = '';
    searchResults.style.display = 'none';

    if (query.length < 2) return;

    const matches = allPoints.filter(f => 
      f.properties.name && f.properties.name.toLowerCase().includes(query)
    ).slice(0, 10);

    if (matches.length > 0) {
      searchResults.style.display = 'block';
      matches.forEach(feat => {
        const li = document.createElement('li');
        const typeIcon = feat.properties.type === 'hut' ? '🏠' : (feat.properties.type === 'bivouac' ? '⛺' : '⛰️');
        
        li.innerHTML = `${typeIcon} <strong>${feat.properties.name}</strong> <small>(${feat.properties.elevation} m)</small>`;
        
        li.addEventListener('click', () => {
          searchBox.value = feat.properties.name;
          searchResults.innerHTML = '';
          searchResults.style.display = 'none';

          map.flyTo({
            center: feat.geometry.coordinates,
            zoom: 14,
            speed: 1.5,
            essential: true
          });

          updatePanel(feat.properties);
        });
        
        searchResults.appendChild(li);
      });
    }
  });

  document.addEventListener('click', (e) => {
    if(e.target.id !== 'search-box') {
      searchResults.style.display = 'none';
    }
  });
}
