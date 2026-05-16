import { test, expect } from '@playwright/test';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

// Helper: simulate a plain map click (no POI features) to trigger the
// coordinate panel and the transient click marker (ping).
// We call the 'click' event listeners registered on the map directly,
// building a fake event that satisfies the general click handler.
// We bypass map.fire() because Mapbox's internal handler calls
// queryRenderedFeatures(e.point) which requires an internal Point instance.
async function fireMapClick(
  page: import('@playwright/test').Page,
  lng: number,
  lat: number,
): Promise<void> {
  await page.evaluate(({ lng, lat }) => {
    const map = (window as unknown as { __debugMap: mapboxgl.Map }).__debugMap;

    // Craft a fake LngLat and point that satisfies the click handler.
    // The general 'click' handler uses e.lngLat.lng/lat and e.point (only
    // to call queryRenderedFeatures) — so we need a proper-looking point.
    // Use mapboxgl's own Point class via the map canvas to create a valid point.
    const canvas = map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Build a minimal MapMouseEvent-like object with a real Point instance.
    const fakePoint = map.project([lng, lat]);

    const fakeEvent = {
      lngLat: { lng, lat },
      point: fakePoint,
      originalEvent: new MouseEvent('click', { clientX: centerX, clientY: centerY }),
    };

    const listeners = (map as unknown as { _listeners: Record<string, ((e: unknown) => void)[]> })._listeners;
    const clickKey = 'click';
    if (listeners && listeners[clickKey]) {
      for (const fn of listeners[clickKey]) {
        fn(fakeEvent);
      }
    }
  }, { lng, lat });
}

test.describe('map pin dismiss', () => {
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
    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as { __debugMap?: unknown }).__debugMap));
    // Wait for map style to load so layers are registered
    await page.waitForFunction(() => {
      const map = (window as unknown as { __debugMap: mapboxgl.Map }).__debugMap;
      return map.isStyleLoaded();
    });
  });

  test('clicking the map places a pin and opens the panel', async ({ page }) => {
    await fireMapClick(page, 9.64, 46.26);

    await page.waitForFunction(() => document.body.classList.contains('panel-open'));
    // The transient click marker element should be in the DOM
    await page.waitForFunction(() => Boolean(document.querySelector('.map-click-ping')));
    await expect(page.locator('.map-click-ping')).toBeAttached();
  });

  test('Escape removes the pin and closes the panel', async ({ page }) => {
    await fireMapClick(page, 9.64, 46.26);

    await page.waitForFunction(() => document.body.classList.contains('panel-open'));
    await page.waitForFunction(() => Boolean(document.querySelector('.map-click-ping')));

    await page.keyboard.press('Escape');

    // Panel should be closed
    await page.waitForFunction(() => !document.body.classList.contains('panel-open'));
    await expect(page.locator('body')).not.toHaveClass(/panel-open/);
    // Pin marker element should be gone from the DOM
    await page.waitForFunction(() => !document.querySelector('.map-click-ping'));
    await expect(page.locator('.map-click-ping')).not.toBeAttached();
  });

  test('clicking the pin element itself removes the pin and closes the panel', async ({ page }) => {
    await fireMapClick(page, 9.64, 46.26);

    await page.waitForFunction(() => document.body.classList.contains('panel-open'));
    await page.waitForFunction(() => Boolean(document.querySelector('.map-click-ping')));

    // Click the ping marker element directly (simulates re-clicking the pin)
    await page.evaluate(() => {
      const pin = document.querySelector('.map-click-ping') as HTMLElement | null;
      if (pin) pin.click();
    });

    await page.waitForFunction(() => !document.querySelector('.map-click-ping'));
    await expect(page.locator('.map-click-ping')).not.toBeAttached();
    // Panel should also be closed by the pin's click handler
    await page.waitForFunction(() => !document.body.classList.contains('panel-open'));
    await expect(page.locator('body')).not.toHaveClass(/panel-open/);
  });

  test('a new map click replaces the existing pin', async ({ page }) => {
    // First click
    await fireMapClick(page, 9.64, 46.26);
    await page.waitForFunction(() => Boolean(document.querySelector('.map-click-ping')));

    // Second click at different coordinates
    await fireMapClick(page, 9.65, 46.27);
    await page.waitForFunction(() => Boolean(document.querySelector('.map-click-ping')));

    // There should be exactly one pin, not two
    const pinCount = await page.locator('.map-click-ping').count();
    expect(pinCount).toBe(1);
  });
});
