import { test, expect } from '@playwright/test';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const POIS_FC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        osm_id: 42,
        name: 'Rifugio Alpe Corte',
        type: 'hut',
        elevation: 1410,
      },
      geometry: {
        type: 'Point',
        coordinates: [9.64, 46.26],
      },
    },
  ],
};

// Helper: fire the pois-points layer click listener with a mock POI feature.
// We reach into Mapbox's _delegatedListeners to call the user callback directly,
// bypassing the canvas hit-test entirely.
async function openPoiPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
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

test.describe('POI click → panel opens', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/pois**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POIS_FC) }),
    );
    await page.route('**/api/trails**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_FC) }),
    );
    await page.route('**/api/ferrata**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_FC) }),
    );
    await page.route('**/api/ai/models**', (route) =>
      route.fulfill({ json: [{ slug: 'llama-test', label: 'Test Model' }] }),
    );
    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as { __debugMap?: unknown }).__debugMap));
    // Wait for the map style to fully load so layer click handlers are registered
    await page.waitForFunction(
      () => (window as unknown as { __debugMap: { isStyleLoaded: () => boolean } }).__debugMap?.isStyleLoaded?.(),
    );
  });

  test('programmatic POI click opens panel with POI name', async ({ page }) => {
    await openPoiPanel(page);

    // updatePanel() calls openPanel() which adds panel-open to body
    await page.waitForFunction(() => document.body.classList.contains('panel-open'));
    await expect(page.locator('#panel')).toContainText('Rifugio Alpe Corte');
  });

  test('panel contains POI type badge', async ({ page }) => {
    await openPoiPanel(page);
    await page.waitForFunction(() => document.body.classList.contains('panel-open'));
    // Type badge should be capitalised
    await expect(page.locator('#panel .badge-type')).toContainText('Hut');
  });

  test('Escape key closes the panel', async ({ page }) => {
    await openPoiPanel(page);
    await page.waitForFunction(() => document.body.classList.contains('panel-open'));

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('panel-open'));
    await expect(page.locator('body')).not.toHaveClass(/panel-open/);
  });

  test('panel close button closes the panel on mobile viewport', async ({ page }) => {
    // On desktop, #panel-close is hidden via CSS (panel is a static sidebar).
    // Switch to a mobile viewport where the close button is visible.
    await page.setViewportSize({ width: 375, height: 812 });
    await openPoiPanel(page);
    await page.waitForFunction(() => document.body.classList.contains('panel-open'));
    // Wait for the close button to become visible in the mobile layout
    await page.waitForSelector('#panel-close', { state: 'visible' });

    await page.click('#panel-close');
    await page.waitForFunction(() => !document.body.classList.contains('panel-open'));
    await expect(page.locator('body')).not.toHaveClass(/panel-open/);
  });
});
