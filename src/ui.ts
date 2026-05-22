export interface PanelProps {
  name: string;
  type: string;
  elevation?: string | number | null;
  website?: string;
  description?: string;
  osm_id?: number | string | null;
  via_ferrata_scale?: string | null;
}

export interface Coordinates {
  lat: number | string;
  lng: number | string;
}

interface AiModel {
  slug: string;
  label: string;
}

interface AiResponse {
  description?: string;
  fromCache: boolean;
  sources?: string[];
  expiresAt?: string;
  modelUsed?: string;
}

export function closePanel(): void {
  document.body.classList.remove('panel-open');
  const panel = document.getElementById('panel');
  if (panel) panel.innerHTML = '';
}

function initPanelSwipeDismiss(): void {
  const panel = document.getElementById('panel');
  if (!panel) return;

  let startY = 0;
  let dragging = false;

  panel.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    dragging = false;
  }, { passive: true });

  panel.addEventListener('touchmove', (e) => {
    const dy = e.touches[0].clientY - startY;
    if (panel.scrollTop === 0 && dy > 0) {
      dragging = true;
      panel.style.transition = 'none';
      panel.style.transform = `translateY(${dy}px)`;
      e.preventDefault();
    }
  }, { passive: false });

  panel.addEventListener('touchend', (e) => {
    panel.style.transition = '';
    panel.style.transform = '';
    if (dragging && (e.changedTouches[0].clientY - startY) > 80) {
      closePanel();
    }
    dragging = false;
  }, { passive: true });
}

function openPanel(): void {
  document.body.classList.add('panel-open');
}

function attachPanelClose(): void {
  const closeBtn = document.getElementById('panel-close');
  if (closeBtn) closeBtn.addEventListener('click', closePanel);
}

function formatElevationLabel(elevation: string | number | null | undefined): string {
  const numericElevation = Number(elevation);
  if (Number.isFinite(numericElevation) && numericElevation > 0) {
    return `${Math.round(numericElevation)}m asl`;
  }

  if (typeof elevation === 'string') {
    const trimmed = elevation.trim();
    if (!trimmed || trimmed === 'N/D') return '';

    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return `${Math.round(parsed)}m asl`;
    }

    if (!Number.isFinite(parsed)) {
      return trimmed;
    }
  }

  return '';
}

function renderAltitudeText(elevation: number | null | undefined, isLoading: boolean): string {
  if (isLoading) {
    return '<em>Loading...</em>';
  }

  const numericElevation = Number(elevation);
  if (Number.isFinite(numericElevation) && numericElevation > 0) {
    return `${Math.round(numericElevation)}m asl`;
  }

  return 'Not available';
}

/** Strips <script> tags and inline event handlers from AI-generated HTML before DOM injection. */
function sanitizeAiHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, '')
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '');
}

export function escapeHtml(str: string | null | undefined): string {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? url : '';
  } catch {
    return '';
  }
}

// Fetch the model list from the backend — single source of truth.
// Cached after first call; pre-warmed at module load so it's ready before first click.
let cachedAiModels: AiModel[] | null = null;

async function fetchAiModels(): Promise<AiModel[]> {
  if (cachedAiModels) return cachedAiModels;
  try {
    const res = await fetch('/api/ai/models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cachedAiModels = await res.json() as AiModel[];
  } catch {
    cachedAiModels = [{ slug: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq)' }];
  }
  return cachedAiModels;
}

fetchAiModels().catch(() => {}); // pre-warm on module load
initPanelSwipeDismiss();

export async function updatePanel(props: PanelProps, coordinates: Coordinates | null): Promise<void> {
  const aiModels = await fetchAiModels();
  const panel = document.getElementById('panel');

  const typeLabel = typeof props.type === 'string' ? props.type : 'unknown';
  const typeCapitalized = escapeHtml(typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1));
  const descHTML = props.description
    ? `<p>${escapeHtml(props.description)}</p>`
    : `<p><em>No description available.</em></p>`;
  const safeWebsite = safeUrl(props.website);
  const siteHTML = safeWebsite
    ? `<p><a href="${escapeHtml(safeWebsite)}" target="_blank" rel="noopener noreferrer">Visit website</a></p>`
    : '';
  const elevationText = escapeHtml(formatElevationLabel(props.elevation));
  const hasElevation = elevationText !== '';
  const elevationBadgeHTML = hasElevation
    ? `<span class="badge badge-elevation">${elevationText}</span>`
    : '';
  const hasCoordinates = coordinates
    && Number.isFinite(Number(coordinates.lat))
    && Number.isFinite(Number(coordinates.lng));
  const latFixed = hasCoordinates ? Number(coordinates.lat).toFixed(6) : '';
  const lngFixed = hasCoordinates ? Number(coordinates.lng).toFixed(6) : '';
  const coordinateBadgeHTML = hasCoordinates
    ? `<span class="badge badge-coordinates">${latFixed}, ${lngFixed}</span>`
    : '';

  panel!.innerHTML = `
    <button id="panel-close" aria-label="Close details">×</button>
    <h2>${escapeHtml(props.name)}</h2>
    <div class="panel-badges">
      <span class="badge badge-type">${typeCapitalized}</span>
      ${elevationBadgeHTML}
      ${coordinateBadgeHTML}
    </div>
    ${descHTML}
    ${siteHTML}

    <hr class="panel-divider">
    <div id="ai-container" class="ai-container">
      <h3 class="ai-section-title">🤖 AI Guide</h3>
      <p id="ai-intro" class="ai-intro-text">
        Genera una descrizione completa con difficoltà, accesso, informazioni pratiche e dati da fonti web.
      </p>
      <div class="ai-model-wrapper">
        <label for="ai-model-select" class="ai-model-label">Modello AI:</label>
        <select id="ai-model-select" class="ai-model-select">
          ${aiModels.map((m, i) => `<option value="${m.slug}"${i === 0 ? ' selected' : ''}>${escapeHtml(m.label)}</option>`).join('\n          ')}
        </select>
      </div>
      <button id="generate-ai-btn" class="ai-magic-btn">✨ Genera AI Guide</button>

      <div id="ai-loading" class="ai-loading is-hidden">
        <em>Ricerca in corso su fonti web... ⏳</em>
      </div>

      <div id="ai-result" class="ai-result is-hidden">
        <div id="ai-result-content" class="ai-result-content"></div>
        <div id="ai-meta" class="ai-meta-row"></div>
        <button id="regenerate-ai-btn" class="ai-regenerate-btn" style="display: none;">
          🔄 Rigenera descrizione
        </button>
      </div>
    </div>
  `;

  window.dispatchEvent(new Event('panel:updated'));

  // Build the payload once — reused for both generate and regenerate
  const aiPayload = {
    name: props.name,
    type: props.type,
    elevation: props.elevation ?? null,
    osm_id: props.osm_id ?? null,
    lat: coordinates ? Number(coordinates.lat) : null,
    lng: coordinates ? Number(coordinates.lng) : null,
  };

  const generateBtn = document.getElementById('generate-ai-btn');
  const regenerateBtn = document.getElementById('regenerate-ai-btn');
  const loadingDiv = document.getElementById('ai-loading');
  const resultSection = document.getElementById('ai-result');
  const resultContent = document.getElementById('ai-result-content');
  const metaDiv = document.getElementById('ai-meta');
  const introP = document.getElementById('ai-intro');

  async function runAiRequest(forceRegenerate: boolean): Promise<void> {
    if (generateBtn) generateBtn.style.display = 'none';
    if (introP) introP.style.display = 'none';
    if (regenerateBtn) (regenerateBtn as HTMLButtonElement).disabled = true;
    if (loadingDiv) loadingDiv.style.display = 'block';
    if (resultSection) resultSection.style.display = 'none';

    const endpoint = forceRegenerate ? '/api/ai/research/regenerate' : '/api/ai/research';
    const modelSlug = (document.getElementById('ai-model-select') as HTMLSelectElement | null)?.value ?? null;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...aiPayload, modelSlug }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as AiResponse;

      if (loadingDiv) loadingDiv.style.display = 'none';
      if (resultSection) resultSection.style.display = 'block';

      if (resultContent) {
        let html = sanitizeAiHtml(data.description ?? '');
        if (data.modelUsed) {
          html += `<p class="ai-model-used-note">🤖 Generato da: ${escapeHtml(data.modelUsed)}</p>`;
        }
        resultContent.innerHTML = html;
      }

      if (metaDiv) {
        const cacheLabel = data.fromCache
          ? '<span class="ai-cache-cached">📦 Da cache</span>'
          : '<span class="ai-cache-fresh">✨ Generato ora</span>';
        const sourcesText = Array.isArray(data.sources) && data.sources.length > 0
          ? ` &middot; Fonti: ${data.sources.map(s => escapeHtml(s)).join(', ')}`
          : '';
        const expiryText = data.expiresAt
          ? ` &middot; Scade: ${new Date(data.expiresAt).toLocaleString('it-IT')}`
          : '';
        metaDiv.innerHTML = `<small class="ai-meta-text">${cacheLabel}${sourcesText}${expiryText}</small>`;
      }

      if (regenerateBtn) {
        regenerateBtn.style.display = 'inline-block';
        (regenerateBtn as HTMLButtonElement).disabled = false;
      }
    } catch (error) {
      console.error('AI request failed:', error);
      if (loadingDiv) loadingDiv.style.display = 'none';
      if (resultSection) resultSection.style.display = 'block';
      if (resultContent) {
        resultContent.innerHTML = '<p class="ai-error-msg">Errore durante la generazione. Riprova.</p>';
      }
      if (generateBtn) {
        generateBtn.style.display = 'inline-block';
        generateBtn.textContent = '🔄 Riprova';
      }
      if (regenerateBtn) (regenerateBtn as HTMLButtonElement).disabled = false;
    }
  }

  if (generateBtn) {
    generateBtn.addEventListener('click', () => runAiRequest(false));
  }
  if (regenerateBtn) {
    regenerateBtn.addEventListener('click', () => runAiRequest(true));
  }

  attachPanelClose();
  openPanel();
}

export function updateCoordinatesPanel(lng: number, lat: number, elevation: number | null | undefined, isLoading = false): void {
  const panel = document.getElementById('panel');
  const latFixed = Number(lat).toFixed(6);
  const lngFixed = Number(lng).toFixed(6);
  const altitudeText = renderAltitudeText(elevation, isLoading);

  panel!.innerHTML = `
    <button id="panel-close" aria-label="Close details">×</button>
    <h2>Clicked Coordinates</h2>
    <div class="panel-badges">
      <span class="badge badge-type">Map Click</span>
    </div>
    <p class="panel-info-line"><strong>Altitude:</strong> ${altitudeText}</p>
    <p class="panel-info-line"><strong>Latitude:</strong> ${latFixed}</p>
    <p class="panel-info-line"><strong>Longitude:</strong> ${lngFixed}</p>
    <p class="panel-info-secondary">Decimal format: ${latFixed}, ${lngFixed}</p>
  `;

  attachPanelClose();
  openPanel();
}
