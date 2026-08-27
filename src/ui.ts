import DOMPurify from 'dompurify';
import { yieldToMain } from './util/yield';
import { openPanel, closePanel } from './panel';

export { closePanel };

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

function attachPanelClose(): void {
  const closeBtn = document.getElementById('panel-close');
  if (closeBtn) closeBtn.addEventListener('click', closePanel);
}

// One owner for the detail-panel shell: inject the close button + the caller's body, wire the
// close button, open the panel, and announce the update. Both panel renderers go through here.
function renderPanel(bodyHtml: string): void {
  const panel = document.getElementById('panel');
  if (!panel) return;
  panel.innerHTML = `<button id="panel-close" aria-label="Close details">×</button>${bodyHtml}`;
  attachPanelClose();
  openPanel();
  window.dispatchEvent(new Event('panel:updated'));
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

// DOMPurify's default HTML attribute allow-list includes `rel` but not `target`, so the Google
// Maps link the agent appends would be stripped of target="_blank" and navigate away from the PWA
// in the same tab. rel="noopener noreferrer" survives on its own and is emitted alongside.
function sanitizeAiHtml(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target'] });
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

/**
 * Copies text, falling back to execCommand when the Clipboard API is unavailable.
 *
 * navigator.clipboard exists only in a secure context. The portal is reached over plain HTTP on
 * the LAN box, so on the device it matters most the modern API is simply absent — the deprecated
 * path is the working one there, not a legacy nicety.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or blocked — fall through to the textarea approach
    }
  }

  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', '');
  scratch.style.position = 'fixed';
  scratch.style.top = '-1000px';
  scratch.style.opacity = '0';
  document.body.appendChild(scratch);
  scratch.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(scratch);
  return copied;
}

/**
 * Wires the copy buttons the agent appends alongside a Google Maps link. Called after every render
 * of the AI result, since innerHTML replaces the previous nodes and their listeners with them.
 */
function attachCopyButtons(container: HTMLElement): void {
  const buttons = container.querySelectorAll<HTMLButtonElement>('.gmaps-copy');

  buttons.forEach((button) => {
    button.addEventListener('click', async () => {
      const link = button.parentElement?.querySelector('a');
      if (!link) return;

      const copied = await copyToClipboard(link.href);

      // The button is icon-only — feedback is the glyph swapping to a tick, drawn in CSS from the
      // state class. Only the tooltip carries words.
      button.classList.remove('is-copied', 'is-failed');
      button.classList.add(copied ? 'is-copied' : 'is-failed');
      button.title = copied ? 'Copiato' : 'Copia non riuscita';

      window.setTimeout(() => {
        button.classList.remove('is-copied', 'is-failed');
        button.title = 'Copia link';
      }, 1600);
    });
  });
}

export async function updatePanel(props: PanelProps, coordinates: Coordinates | null): Promise<void> {
  const aiModels = await fetchAiModels();

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
  const willResolveElevation = !hasElevation
    && Boolean(coordinates)
    && Number.isFinite(Number(coordinates?.lat))
    && Number.isFinite(Number(coordinates?.lng));
  const elevationBadgeHTML = hasElevation
    ? `<span class="badge badge-elevation" id="poi-elevation">${elevationText}</span>`
    : willResolveElevation
      ? `<span class="badge badge-elevation is-loading" id="poi-elevation">…</span>`
      : '';
  const hasCoordinates = coordinates
    && Number.isFinite(Number(coordinates.lat))
    && Number.isFinite(Number(coordinates.lng));
  const latFixed = hasCoordinates ? Number(coordinates.lat).toFixed(6) : '';
  const lngFixed = hasCoordinates ? Number(coordinates.lng).toFixed(6) : '';
  const coordinateBadgeHTML = hasCoordinates
    ? `<span class="badge badge-coordinates">${latFixed}, ${lngFixed}</span>`
    : '';

  renderPanel(`
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
        Generate a full description with difficulty, access, practical info and data from web sources.
      </p>
      <div class="ai-model-wrapper">
        <label for="ai-model-select" class="ai-model-label">AI model:</label>
        <select id="ai-model-select" class="ai-model-select">
          ${aiModels.map((m, i) => `<option value="${m.slug}"${i === 0 ? ' selected' : ''}>${escapeHtml(m.label)}</option>`).join('\n          ')}
        </select>
      </div>
      <button id="generate-ai-btn" class="ai-magic-btn">✨ Generate AI Guide</button>

      <div id="ai-loading" class="ai-loading is-hidden">
        <em>Searching web sources… ⏳</em>
      </div>

      <div id="ai-result" class="ai-result is-hidden">
        <div id="ai-result-content" class="ai-result-content"></div>
        <div id="ai-meta" class="ai-meta-row"></div>
        <button id="regenerate-ai-btn" class="ai-regenerate-btn" style="display: none;">
          🔄 Regenerate description
        </button>
      </div>
    </div>
  `);

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

    // Yield once so the spinner-state paint commits before we head into
    // fetch/sanitize/innerHTML. Without this the user can see no feedback
    // until the whole pipeline finishes.
    await yieldToMain();

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
        // Yield before DOMPurify — sanitize on large AI descriptions can be
        // 20–100ms of regex work. Splitting it from fetch handling keeps
        // each task bounded.
        await yieldToMain();
        let html = sanitizeAiHtml(data.description ?? '');
        if (data.modelUsed) {
          html += `<p class="ai-model-used-note">🤖 Generated by: ${escapeHtml(data.modelUsed)}</p>`;
        }
        await yieldToMain();
        resultContent.innerHTML = html;
        attachCopyButtons(resultContent);
      }

      if (metaDiv) {
        const cacheLabel = data.fromCache
          ? '<span class="ai-cache-cached">📦 From cache</span>'
          : '<span class="ai-cache-fresh">✨ Generated now</span>';
        const sourcesText = Array.isArray(data.sources) && data.sources.length > 0
          ? ` &middot; Sources: ${data.sources.map(s => escapeHtml(s)).join(', ')}`
          : '';
        const expiryText = data.expiresAt
          ? ` &middot; Expires: ${new Date(data.expiresAt).toLocaleString('it-IT')}`
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
        resultContent.innerHTML = '<p class="ai-error-msg">Generation failed. Try again.</p>';
      }
      if (generateBtn) {
        generateBtn.style.display = 'inline-block';
        generateBtn.textContent = '🔄 Retry';
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
}

export function updateCoordinatesPanel(lng: number, lat: number, elevation: number | null | undefined, isLoading = false): void {
  const latFixed = Number(lat).toFixed(6);
  const lngFixed = Number(lng).toFixed(6);
  const altitudeText = renderAltitudeText(elevation, isLoading);

  renderPanel(`
    <h2>Clicked Coordinates</h2>
    <div class="panel-badges">
      <span class="badge badge-type">Map Click</span>
    </div>
    <p class="panel-info-line"><strong>Altitude:</strong> <span id="coord-elevation">${altitudeText}</span></p>
    <p class="panel-info-line"><strong>Latitude:</strong> ${latFixed}</p>
    <p class="panel-info-line"><strong>Longitude:</strong> ${lngFixed}</p>
    <p class="panel-info-secondary">Decimal format: ${latFixed}, ${lngFixed}</p>
  `);
}

// Targeted DOM patches — used to update a single field after the panel has
// already painted, so we don't block INP on slow terrain elevation fetches.
export function patchPoiElevation(elevation: number | null): void {
  const badge = document.getElementById('poi-elevation');
  if (!badge) return;
  if (elevation == null) {
    badge.remove();
    return;
  }
  badge.textContent = `${Math.round(elevation)}m asl`;
  badge.classList.remove('is-loading');
}

export function patchCoordinatesElevation(elevation: number | null): void {
  const span = document.getElementById('coord-elevation');
  if (!span) return;
  span.innerHTML = renderAltitudeText(elevation, false);
}
