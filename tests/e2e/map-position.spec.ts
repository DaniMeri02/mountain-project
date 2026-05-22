import { test, expect } from '@playwright/test';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

type MapCenter = { lng: number; lat: number };

test.describe('map position persistence', () => {
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
  });

  test('map loads at default center when no localStorage entry', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as { __debugMap?: unknown }).__debugMap));

    const center = await page.evaluate(() => {
      const m = (window as unknown as { __debugMap: { getCenter: () => MapCenter } }).__debugMap;
      return m.getCenter();
    });

    // Default center from main.ts is [9.64, 46.26]
    expect(center.lng).toBeCloseTo(9.64, 1);
    expect(center.lat).toBeCloseTo(46.26, 1);
  });

  test('map restores saved center and zoom from localStorage', async ({ page }) => {
    // Inject saved position before page initialises
    await page.addInitScript(() => {
      localStorage.setItem('map:center', JSON.stringify([8.5, 45.8]));
      localStorage.setItem('map:zoom', '9');
    });

    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as { __debugMap?: unknown }).__debugMap));

    const { center, zoom } = await page.evaluate(() => {
      const m = (window as unknown as {
        __debugMap: { getCenter: () => MapCenter; getZoom: () => number };
      }).__debugMap;
      return { center: m.getCenter(), zoom: m.getZoom() };
    });

    expect(center.lng).toBeCloseTo(8.5, 1);
    expect(center.lat).toBeCloseTo(45.8, 1);
    expect(zoom).toBeCloseTo(9, 0);
  });

  test('map saves center to localStorage on moveend', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as { __debugMap?: unknown }).__debugMap));

    // Programmatically fly to a new position and fire moveend
    await page.evaluate(() => {
      const m = (window as unknown as {
        __debugMap: { jumpTo: (o: { center: [number, number]; zoom: number }) => void; fire: (e: string) => void };
      }).__debugMap;
      m.jumpTo({ center: [10.2, 47.1], zoom: 11 });
      m.fire('moveend');
    });

    const saved = await page.evaluate(() => {
      const raw = localStorage.getItem('map:center');
      return raw ? JSON.parse(raw) as [number, number] : null;
    });

    expect(saved).not.toBeNull();
    expect(saved![0]).toBeCloseTo(10.2, 1);
    expect(saved![1]).toBeCloseTo(47.1, 1);
  });

  test('corrupted localStorage falls back to default center', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('map:center', 'NOT_JSON');
      localStorage.setItem('map:zoom', 'NaN');
    });

    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as { __debugMap?: unknown }).__debugMap));

    const center = await page.evaluate(() => {
      const m = (window as unknown as { __debugMap: { getCenter: () => MapCenter } }).__debugMap;
      return m.getCenter();
    });

    // Should fall back to default [9.64, 46.26]
    expect(center.lng).toBeCloseTo(9.64, 1);
    expect(center.lat).toBeCloseTo(46.26, 1);
  });
});
