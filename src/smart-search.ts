import type mapboxgl from 'mapbox-gl';
import { updatePanel, closePanel, patchPoiElevation, type PanelProps } from './ui';
import { setSearchResultMarkers, clearSearchResultMarkers, setResultMarkerClickHandler } from './map';
import { hasValidElevationValue, resolveElevationFromCoordinates } from './elevation';
import { appState } from './state';

// Frontend-local DTO mirroring the server's PoiResult. The `filter` is opaque here —
// we just echo it back for pagination so the server doesn't re-run the LLM.
interface SmartResult {
  id: number | null;
  osm_id: number | string | null;
  type: string;
  name: string;
  elevation: number | null;
  lng: number;
  lat: number;
  via_ferrata_scale: string | null;
  sac_scale: string | null;
  source_type: string | null;
}

interface SmartResponse {
  filter: unknown;
  results: SmartResult[];
  total: number;
  offset: number;
  limit: number;
  modelUsed?: string;
}

const TYPE_ICON: Record<string, string> = { hut: '🏠', bivouac: '⛺', peak: '⛰️', ferrata: '🧗' };

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function initSmartSearch(map: mapboxgl.Map, searchBox: HTMLInputElement): void {
  const button = document.getElementById('ai-search-btn');
  const panel = document.getElementById('panel');
  if (!button || !panel) return;

  let currentFilter: unknown = null;
  let results: SmartResult[] = [];
  let total = 0;
  let modelUsed: string | undefined;
  let busy = false;
  // Sticky "smart results mode": once a search runs, markers + a way back to the list
  // persist across any panel the user opens, until they click 'Exit'.
  let resultsActive = false;

  function viewportBbox(): [number, number, number, number] | undefined {
    const b = map.getBounds();
    return b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : undefined;
  }

  function openPanel(): void {
    document.body.classList.add('panel-open');
    window.dispatchEvent(new Event('panel:updated'));
  }

  function resetResultsState(): void {
    currentFilter = null;
    results = [];
    total = 0;
    modelUsed = undefined;
    busy = false;
    resultsActive = false;
  }

  function exitResults(): void {
    clearSearchResultMarkers(map);
    resetResultsState();
    closePanel();
  }

  function makeExitButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'results-exit';
    btn.textContent = 'Exit';
    btn.setAttribute('aria-label', 'Close results');
    btn.addEventListener('click', exitResults);
    return btn;
  }

  function renderSingle(message: string, heading: string, loading: boolean): void {
    if (!panel) return;
    resultsActive = true;
    panel.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'results-header';
    const titleRow = document.createElement('div');
    titleRow.className = 'results-title-row';
    const h = document.createElement('h2');
    h.textContent = heading;
    titleRow.append(h, makeExitButton());
    header.appendChild(titleRow);
    const p = document.createElement('p');
    p.className = loading ? 'results-loading' : 'results-empty';
    p.textContent = message;
    panel.append(header, p);
    openPanel();
  }

  function metaText(r: SmartResult): string {
    if (r.type === 'ferrata') {
      return r.via_ferrata_scale ? `Via ferrata · grade ${r.via_ferrata_scale}` : 'Via ferrata';
    }
    const parts = [capitalize(r.type)];
    if (typeof r.elevation === 'number' && r.elevation > 0) parts.push(`${r.elevation} m`);
    return parts.join(' · ');
  }

  function makeRow(r: SmartResult): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'result-row';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');

    const icon = document.createElement('span');
    icon.className = 'result-icon';
    icon.textContent = TYPE_ICON[r.type] ?? '📍';

    const body = document.createElement('div');
    body.className = 'result-body';
    const name = document.createElement('strong');
    name.className = 'result-name';
    name.textContent = r.name; // textContent → XSS-safe (name comes from the DB)
    const meta = document.createElement('small');
    meta.className = 'result-meta';
    meta.textContent = metaText(r);
    body.append(name, meta);

    li.append(icon, body);
    li.addEventListener('click', () => void selectResult(r));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void selectResult(r);
      }
    });
    return li;
  }

  function renderResults(): void {
    if (!panel) return;
    resultsActive = true;
    panel.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'results-header';
    const titleRow = document.createElement('div');
    titleRow.className = 'results-title-row';
    const h = document.createElement('h2');
    h.textContent = 'Results';
    titleRow.append(h, makeExitButton());
    const count = document.createElement('p');
    count.className = 'results-count';
    count.textContent =
      total === 0
        ? 'No results'
        : total > results.length
          ? `Showing ${results.length} of ${total}`
          : `${total} ${total === 1 ? 'result' : 'results'}`;
    header.append(titleRow, count);
    panel.appendChild(header);

    if (results.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'results-empty';
      empty.textContent = 'No place matches. Try widening the criteria.';
      panel.appendChild(empty);
      openPanel();
      return;
    }

    const list = document.createElement('ul');
    list.className = 'results-list';
    for (const r of results) list.appendChild(makeRow(r));
    panel.appendChild(list);

    if (results.length < total) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'results-more';
      more.textContent = 'Load more';
      more.addEventListener('click', () => void loadMore());
      panel.appendChild(more);
    }

    if (modelUsed) {
      const note = document.createElement('p');
      note.className = 'results-model-note';
      note.textContent = `🤖 ${modelUsed}`;
      panel.appendChild(note);
    }

    openPanel();
  }

  function injectBackButton(): void {
    if (!panel || panel.querySelector('.results-back')) return;
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'results-back';
    back.textContent = '← Results';
    back.addEventListener('click', () => renderResults());
    panel.insertBefore(back, panel.firstChild);
  }

  async function selectResult(r: SmartResult): Promise<void> {
    map.flyTo({ center: [r.lng, r.lat], zoom: 15, speed: 1.4, essential: true });
    const coords = { lat: r.lat, lng: r.lng };
    const props: PanelProps =
      r.type === 'ferrata'
        ? {
            name: r.name,
            type: r.type,
            elevation: r.via_ferrata_scale ? `Grade ${r.via_ferrata_scale}` : null,
            via_ferrata_scale: r.via_ferrata_scale,
            description: 'Via ferrata route segment.',
            osm_id: r.osm_id,
            website: '',
          }
        : { name: r.name, type: r.type, elevation: r.elevation, osm_id: r.osm_id };

    await updatePanel(props, coords);
    // '← Results' is injected by the panel:updated listener while results mode is active.

    if (r.type !== 'ferrata' && !hasValidElevationValue(r.elevation)) {
      const derived = await resolveElevationFromCoordinates(map, coords);
      patchPoiElevation(derived);
    }
  }

  async function run(query: string): Promise<void> {
    if (appState.offlineMode) return; // offline = local IDB data only; smart search needs the server
    const q = query.trim();
    if (q.length < 2 || busy) return;
    busy = true;
    renderSingle(`Interpreting: “${q}”…`, 'Smart search', true);
    try {
      const res = await fetch('/api/search/smart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, viewport: viewportBbox() }),
      });
      if (res.status === 422) {
        renderSingle("Couldn't understand the question. Try rephrasing it.", 'Smart search', false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SmartResponse;
      currentFilter = data.filter;
      results = data.results;
      total = data.total;
      modelUsed = data.modelUsed;
      renderResults();
      setSearchResultMarkers(map, results.map((r) => ({ lng: r.lng, lat: r.lat })));
    } catch (err) {
      console.error('Smart search failed:', err);
      renderSingle('Search failed. Please try again.', 'Smart search', false);
    } finally {
      busy = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (busy || results.length >= total) return;
    busy = true;
    const moreBtn = panel?.querySelector('.results-more') as HTMLButtonElement | null;
    if (moreBtn) {
      moreBtn.disabled = true;
      moreBtn.textContent = 'Loading…';
    }
    try {
      const res = await fetch('/api/search/smart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter: currentFilter, offset: results.length }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SmartResponse;
      results = results.concat(data.results);
      total = data.total;
      renderResults();
      setSearchResultMarkers(map, results.map((r) => ({ lng: r.lng, lat: r.lat })));
    } catch (err) {
      console.error('Load more failed:', err);
      if (moreBtn) {
        moreBtn.disabled = false;
        moreBtn.textContent = 'Load more';
      }
    } finally {
      busy = false;
    }
  }

  button.addEventListener('click', () => {
    const dropdown = document.getElementById('search-results');
    if (dropdown) dropdown.style.display = 'none';
    void run(searchBox.value);
  });

  // While results mode is active, any panel that ISN'T the results view (a POI detail, a
  // map-click coordinates panel, a selected result) gets a '← Results' button so the user
  // can always get back to the list. Markers + mode persist until 'Exit' (exitResults).
  window.addEventListener('panel:updated', () => {
    if (!resultsActive || !panel) return;
    if (
      panel.querySelector('.results-list') ||
      panel.querySelector('.results-exit') ||
      panel.querySelector('.results-back')
    ) {
      return;
    }
    injectBackButton();
  });

  // Clicking a result marker on the map opens that result (same as clicking its list row).
  // Registered via map.ts so the listener binds at layer-creation time.
  setResultMarkerClickHandler((idx) => {
    if (idx >= 0 && idx < results.length) void selectResult(results[idx]);
  });
}
