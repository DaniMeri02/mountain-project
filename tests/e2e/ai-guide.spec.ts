import { test, expect } from '@playwright/test';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const MOCK_MODELS = [
  { slug: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq)' },
  { slug: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
];

const MOCK_AI_RESPONSE = {
  description: '<p>Il Rifugio Alpe Corte è un rifugio alpino situato a 1410m di quota.</p>',
  fromCache: false,
  sources: ['wikidata', 'komoot'],
  expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  modelUsed: 'llama-3.3-70b-versatile',
};

const MOCK_AI_RESPONSE_CACHED = {
  ...MOCK_AI_RESPONSE,
  fromCache: true,
};

// Trigger the pois-points layer click listener directly via Mapbox internals
function triggerPoiClick(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const map = (window as unknown as { __debugMap: Record<string, unknown> }).__debugMap;
    const delegated = map._delegatedListeners as Record<string, Array<Record<string, unknown>>> | undefined;
    if (!delegated || !delegated['click']) return;
    const poisEntry = delegated['click'].find((item) => {
      const targets = item['targets'] as string[];
      return Array.isArray(targets) && targets.includes('pois-points');
    });
    if (!poisEntry) return;
    const listenerFn = poisEntry['listener'] as ((e: unknown) => void) | undefined;
    if (!listenerFn) return;
    listenerFn({
      lngLat: { lng: 9.64, lat: 46.26 },
      features: [
        {
          type: 'Feature',
          properties: { osm_id: 42, name: 'Rifugio Alpe Corte', type: 'hut', elevation: 1410 },
          geometry: { type: 'Point', coordinates: [9.64, 46.26] },
        },
      ],
      originalEvent: new MouseEvent('click'),
    });
  });
}

test.describe('AI Guide section', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/pois**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_FC) }),
    );
    await page.route('**/api/trails**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_FC) }),
    );
    await page.route('**/api/ferrata**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_FC) }),
    );
    await page.route('**/api/ai/models**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_MODELS) }),
    );
    await page.route('**/api/ai/research', (route) => {
      if (route.request().url().includes('regenerate')) return route.continue();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_AI_RESPONSE) });
    });
    await page.route('**/api/ai/research/regenerate', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_AI_RESPONSE_CACHED) }),
    );

    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as { __debugMap?: unknown }).__debugMap));
    // Wait for map style to load so layer click listeners are registered
    await page.waitForFunction(
      () => (window as unknown as { __debugMap: { isStyleLoaded: () => boolean } }).__debugMap?.isStyleLoaded?.(),
    );

    await triggerPoiClick(page);

    await page.waitForFunction(() => document.body.classList.contains('panel-open'));
    // Wait for panel content to be rendered (updatePanel is async due to fetchAiModels)
    await page.waitForSelector('#generate-ai-btn');
  });

  test('AI Guide section is rendered inside the panel', async ({ page }) => {
    await expect(page.locator('#ai-container')).toBeVisible();
    await expect(page.locator('#generate-ai-btn')).toBeVisible();
    await expect(page.locator('#generate-ai-btn')).toContainText('Genera AI Guide');
  });

  test('model selector is populated from /api/ai/models', async ({ page }) => {
    const select = page.locator('#ai-model-select');
    await expect(select).toBeVisible();
    const options = select.locator('option');
    await expect(options).toHaveCount(MOCK_MODELS.length);
    await expect(options.nth(0)).toHaveText(MOCK_MODELS[0].label);
    await expect(options.nth(1)).toHaveText(MOCK_MODELS[1].label);
  });

  test('clicking Genera AI Guide shows AI description', async ({ page }) => {
    await page.click('#generate-ai-btn');

    // Wait for result section to appear (display changes from none to block)
    await page.waitForFunction(() => {
      const el = document.getElementById('ai-result');
      return el !== null && el.style.display !== 'none' && el.style.display !== '';
    });

    await expect(page.locator('#ai-result-content')).toContainText('Rifugio Alpe Corte');
  });

  test('fresh response shows ✨ Generato ora cache indicator', async ({ page }) => {
    await page.click('#generate-ai-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('ai-result');
      return el !== null && el.style.display !== 'none' && el.style.display !== '';
    });

    await expect(page.locator('.ai-cache-fresh')).toBeVisible();
    await expect(page.locator('.ai-cache-fresh')).toContainText('Generato ora');
  });

  test('cached response shows 📦 Da cache indicator', async ({ page }) => {
    await page.click('#generate-ai-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('ai-result');
      return el !== null && el.style.display !== 'none' && el.style.display !== '';
    });

    // Click rigenera to get the cached mock response
    await page.waitForSelector('#regenerate-ai-btn:not([disabled])');
    await page.click('#regenerate-ai-btn');

    await page.waitForFunction(() => {
      const fresh = document.querySelector('.ai-cache-fresh');
      const cached = document.querySelector('.ai-cache-cached');
      return cached !== null && fresh === null;
    });

    await expect(page.locator('.ai-cache-cached')).toBeVisible();
    await expect(page.locator('.ai-cache-cached')).toContainText('Da cache');
  });

  test('AI result shows model used note', async ({ page }) => {
    await page.click('#generate-ai-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('ai-result');
      return el !== null && el.style.display !== 'none' && el.style.display !== '';
    });

    await expect(page.locator('#ai-result-content')).toContainText('llama-3.3-70b-versatile');
  });

  test('Rigenera button appears after first generation', async ({ page }) => {
    // Before clicking, regenerate button should not be visible
    await expect(page.locator('#regenerate-ai-btn')).not.toBeVisible();

    await page.click('#generate-ai-btn');

    await page.waitForFunction(() => {
      const el = document.getElementById('ai-result');
      return el !== null && el.style.display !== 'none' && el.style.display !== '';
    });

    await expect(page.locator('#regenerate-ai-btn')).toBeVisible();
    await expect(page.locator('#regenerate-ai-btn')).toContainText('Rigenera descrizione');
  });
});
