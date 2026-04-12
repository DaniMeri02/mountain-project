function formatElevationLabel(elevation) {
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

function renderAltitudeText(elevation, isLoading) {
  if (isLoading) {
    return '<em>Loading...</em>';
  }

  const numericElevation = Number(elevation);
  if (Number.isFinite(numericElevation) && numericElevation > 0) {
    return `${Math.round(numericElevation)}m asl`;
  }

  return 'Not available';
}

export function updatePanel(props, coordinates) {
  const panel = document.getElementById('panel');
  
  const typeLabel = typeof props.type === 'string' ? props.type : 'unknown';
  const typeCapitalized = typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1);
  const descHTML = props.description ? `<p>${props.description}</p>` : `<p><em>No description available.</em></p>`;
  const siteHTML = props.website ? `<p><a href="${props.website}" target="_blank">Visit website</a></p>` : '';
  const elevationText = formatElevationLabel(props.elevation);
  const hasElevation = elevationText !== '';
  const elevationBadgeHTML = hasElevation
    ? `<span style="background-color: #7f8c8d; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; margin-left: 5px;">
        ${elevationText}
      </span>`
    : '';
  const hasCoordinates = coordinates
    && Number.isFinite(Number(coordinates.lat))
    && Number.isFinite(Number(coordinates.lng));
  const latFixed = hasCoordinates ? Number(coordinates.lat).toFixed(6) : '';
  const lngFixed = hasCoordinates ? Number(coordinates.lng).toFixed(6) : '';
  const coordinateBadgeHTML = hasCoordinates
    ? `<span style="background-color: #2980b9; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; margin-left: 5px;">
        ${latFixed}, ${lngFixed}
      </span>`
    : '';

  panel.innerHTML = `
    <h2>${props.name}</h2>
    <div style="margin-bottom: 20px;">
      <span style="background-color: #2c3e50; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem;">
        ${typeCapitalized}
      </span>
      ${elevationBadgeHTML}
      ${coordinateBadgeHTML}
    </div>
    ${descHTML}
    ${siteHTML}

    <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
    <div id="ai-container" style="background: #f8f9fa; padding: 15px; border-radius: 8px; border: 1px solid #e9ecef;">
      <h3 style="margin-top: 0; font-size: 1.1rem; color: #333;">🤖 AI Guide</h3>
      <p id="ai-intro" style="font-size: 0.9rem; color: #666; margin-bottom: 10px;">
        Genera una descrizione completa con difficoltà, accesso, informazioni pratiche e dati da fonti web.
      </p>
      <button id="generate-ai-btn" class="ai-magic-btn">✨ Genera AI Guide</button>

      <div id="ai-loading" style="display: none; text-align: center; color: #666; padding: 12px 0;">
        <em>Ricerca in corso su fonti web... ⏳</em>
      </div>

      <div id="ai-result" style="display: none; margin-top: 12px;">
        <div id="ai-result-content" style="font-size: 0.95rem; line-height: 1.6; color: #333;"></div>
        <div id="ai-meta" style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #e9ecef;"></div>
        <button id="regenerate-ai-btn" style="display: none; margin-top: 10px; padding: 6px 14px; font-size: 0.85rem; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">
          🔄 Rigenera descrizione
        </button>
      </div>
    </div>
  `;

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

  async function runAiRequest(forceRegenerate) {
    // Enter loading state
    if (generateBtn) generateBtn.style.display = 'none';
    if (introP) introP.style.display = 'none';
    if (regenerateBtn) regenerateBtn.disabled = true;
    if (loadingDiv) loadingDiv.style.display = 'block';
    if (resultSection) resultSection.style.display = 'none';

    const endpoint = forceRegenerate ? '/api/ai/research/regenerate' : '/api/ai/research';

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aiPayload),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (loadingDiv) loadingDiv.style.display = 'none';
      if (resultSection) resultSection.style.display = 'block';

      // The AI returns HTML directly — inject it
      if (resultContent) resultContent.innerHTML = data.description ?? '';

      // Show metadata row: cache status + sources used
      if (metaDiv) {
        const cacheLabel = data.fromCache
          ? '<span style="color: #888;">📦 Da cache</span>'
          : '<span style="color: #27ae60;">✨ Generato ora</span>';
        const sourcesText = Array.isArray(data.sources) && data.sources.length > 0
          ? ` &middot; Fonti: ${data.sources.join(', ')}`
          : '';
        const expiryText = data.expiresAt
          ? ` &middot; Scade: ${new Date(data.expiresAt).toLocaleString('it-IT')}`
          : '';
        metaDiv.innerHTML = `<small style="font-size:0.8rem;">${cacheLabel}${sourcesText}${expiryText}</small>`;
      }

      if (regenerateBtn) {
        regenerateBtn.style.display = 'inline-block';
        regenerateBtn.disabled = false;
      }
    } catch (error) {
      console.error('AI request failed:', error);
      if (loadingDiv) loadingDiv.style.display = 'none';
      if (resultSection) resultSection.style.display = 'block';
      if (resultContent) {
        resultContent.innerHTML =
          '<p style="color: #e74c3c; font-weight: bold;">Errore durante la generazione. Riprova.</p>';
      }
      // Re-show generate button so user can retry
      if (generateBtn) {
        generateBtn.style.display = 'inline-block';
        generateBtn.textContent = '🔄 Riprova';
      }
      if (regenerateBtn) regenerateBtn.disabled = false;
    }
  }

  if (generateBtn) {
    generateBtn.addEventListener('click', () => runAiRequest(false));
  }
  if (regenerateBtn) {
    regenerateBtn.addEventListener('click', () => runAiRequest(true));
  }
}

export function updateCoordinatesPanel(lng, lat, elevation, isLoading = false) {
  const panel = document.getElementById('panel');
  const latFixed = Number(lat).toFixed(6);
  const lngFixed = Number(lng).toFixed(6);
  const altitudeText = renderAltitudeText(elevation, isLoading);

  panel.innerHTML = `
    <h2>Clicked Coordinates</h2>
    <div style="margin-bottom: 20px;">
      <span style="background-color: #2c3e50; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem;">
        Map Click
      </span>
    </div>
    <p style="margin: 0 0 10px 0;"><strong>Altitude:</strong> ${altitudeText}</p>
    <p style="margin: 0 0 10px 0;"><strong>Latitude:</strong> ${latFixed}</p>
    <p style="margin: 0 0 10px 0;"><strong>Longitude:</strong> ${lngFixed}</p>
    <p style="margin: 0; color: #666; font-size: 0.9rem;">
      Decimal format: ${latFixed}, ${lngFixed}
    </p>
  `;
}

