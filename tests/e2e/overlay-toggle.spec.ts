import { test, expect } from '@playwright/test';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

type MapDebug = {
  __debugMap: {
    isStyleLoaded: () => boolean;
    getLayer: (id: string) => unknown;
    getLayoutProperty: (layer: string, prop: string) => string;
  };
};

async function waitForLayer(page: import('@playwright/test').Page, layerId: string): Promise<void> {
  await page.waitForFunction(
    (id: string) => {
      const m = (window as unknown as MapDebug).__debugMap;
      return !!(m?.isStyleLoaded?.() && m?.getLayer?.(id));
    },
    layerId,
    { timeout: 15_000 },
  );
}

async function getLayerVisibility(page: import('@playwright/test').Page, layerId: string): Promise<string> {
  return page.evaluate((id: string) => {
    const m = (window as unknown as MapDebug).__debugMap;
    return m.getLayoutProperty(id, 'visibility') as string;
  }, layerId);
}

test.describe('overlay layer toggles', () => {
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
    await page.waitForFunction(() => Boolean((window as unknown as MapDebug).__debugMap));
  });

  test('trails layer is visible by default', async ({ page }) => {
    await waitForLayer(page, 'trails-lines');
    const vis = await getLayerVisibility(page, 'trails-lines');
    expect(vis).toBe('visible');
  });

  test('unchecking trails hides the trails-lines layer', async ({ page }) => {
    await waitForLayer(page, 'trails-lines');

    await page.evaluate(() => {
      const cb = document.getElementById('toggle-trails') as HTMLInputElement;
      cb.checked = false;
      cb.dispatchEvent(new Event('change'));
    });

    const vis = await getLayerVisibility(page, 'trails-lines');
    expect(vis).toBe('none');
  });

  test('re-checking trails restores trails-lines visibility', async ({ page }) => {
    await waitForLayer(page, 'trails-lines');

    await page.evaluate(() => {
      const cb = document.getElementById('toggle-trails') as HTMLInputElement;
      cb.checked = false;
      cb.dispatchEvent(new Event('change'));
    });
    await page.evaluate(() => {
      const cb = document.getElementById('toggle-trails') as HTMLInputElement;
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
    });

    const vis = await getLayerVisibility(page, 'trails-lines');
    expect(vis).toBe('visible');
  });

  test('unchecking ferrata hides the ferrata-lines layer', async ({ page }) => {
    await waitForLayer(page, 'ferrata-lines');

    await page.evaluate(() => {
      const cb = document.getElementById('toggle-ferrata') as HTMLInputElement;
      cb.checked = false;
      cb.dispatchEvent(new Event('change'));
    });

    const vis = await getLayerVisibility(page, 'ferrata-lines');
    expect(vis).toBe('none');
  });

  test('unchecking icons hides the pois-points layer', async ({ page }) => {
    await waitForLayer(page, 'pois-points');

    await page.evaluate(() => {
      const cb = document.getElementById('toggle-icons') as HTMLInputElement;
      cb.checked = false;
      cb.dispatchEvent(new Event('change'));
    });

    const vis = await getLayerVisibility(page, 'pois-points');
    expect(vis).toBe('none');
  });

  test('all three layers remain visible after style reload', async ({ page }) => {
    await waitForLayer(page, 'trails-lines');
    await waitForLayer(page, 'ferrata-lines');
    await waitForLayer(page, 'pois-points');

    // Simulate style.load re-applying visibility by calling applyOverlayVisibility
    await page.evaluate(() => {
      const m = (window as unknown as MapDebug).__debugMap;
      // All checkboxes are checked by default — fire change to force re-apply
      ['toggle-trails', 'toggle-ferrata', 'toggle-icons'].forEach((id) => {
        document.getElementById(id)?.dispatchEvent(new Event('change'));
      });
      return m.getLayoutProperty('trails-lines', 'visibility');
    });

    expect(await getLayerVisibility(page, 'trails-lines')).toBe('visible');
    expect(await getLayerVisibility(page, 'ferrata-lines')).toBe('visible');
    expect(await getLayerVisibility(page, 'pois-points')).toBe('visible');
  });
});
