import { test, expect } from '@playwright/test';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const TRAILS_FC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { osm_id: 1001, name: 'test-trail' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [9.0, 46.0],
          [9.001, 46.0],
          [9.001, 45.995],
          [9.0, 45.995],
        ],
      },
    },
  ],
};

type DebugRouteResult = {
  error?: string;
  altsFound: number;
  altDistances: number[];
  fromCoord?: number[];
  toCoord?: number[];
};

test.describe('routing UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/trails**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TRAILS_FC) }),
    );
    await page.route('**/api/ferrata**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_FC) }),
    );
    await page.route('**/api/pois**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_FC) }),
    );

    await page.goto('/');
    await page.waitForFunction(() =>
      Boolean((window as unknown as { __debugRoute?: unknown }).__debugRoute),
    );
  });

  test('Find Route button is injected into the drawer', async ({ page }) => {
    await page.click('#nav-burger');
    await expect(page.locator('#routing-find-btn')).toBeVisible();
    await expect(page.locator('#routing-find-btn')).toContainText('Find Route');
  });

  test('clicking Find Route activates routing mode', async ({ page }) => {
    await page.click('#nav-burger');
    await page.click('#routing-find-btn');

    // startRoutingMode adds 'routing-active' to body and shows #route-hint
    await expect(page.locator('body')).toHaveClass(/routing-active/);
    await expect(page.locator('#route-hint')).toBeVisible();
  });

  test('clicking Find Route again cancels routing mode', async ({ page }) => {
    await page.click('#nav-burger');
    await page.click('#routing-find-btn');
    await expect(page.locator('body')).toHaveClass(/routing-active/);

    // Click Find Route again via programmatic click (drawer may be closed)
    await page.evaluate(() => document.getElementById('routing-find-btn')!.click());

    await expect(page.locator('body')).not.toHaveClass(/routing-active/);
  });

  test('route panel shows distance after a route is computed', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const debugRoute = (window as unknown as {
        __debugRoute: (s: number[], e: number[]) => Promise<DebugRouteResult>;
      }).__debugRoute;
      return debugRoute([9.0, 46.0], [9.0, 45.995]);
    });

    expect(result.error).toBeUndefined();
    expect(result.altsFound).toBeGreaterThan(0);

    await page.waitForFunction(() => document.body.classList.contains('panel-open'));
    await expect(page.locator('#panel')).toContainText('km');
  });

  test('route panel shows Download GPX button', async ({ page }) => {
    await page.evaluate(async () => {
      const debugRoute = (window as unknown as {
        __debugRoute: (s: number[], e: number[]) => Promise<DebugRouteResult>;
      }).__debugRoute;
      return debugRoute([9.0, 46.0], [9.0, 45.995]);
    });

    await page.waitForFunction(() => document.body.classList.contains('panel-open'));
    await expect(page.locator('#route-download-gpx')).toBeVisible();
  });

  test('route panel shows Cancel button', async ({ page }) => {
    await page.evaluate(async () => {
      const debugRoute = (window as unknown as {
        __debugRoute: (s: number[], e: number[]) => Promise<DebugRouteResult>;
      }).__debugRoute;
      return debugRoute([9.0, 46.0], [9.0, 45.995]);
    });

    await page.waitForFunction(() => document.body.classList.contains('panel-open'));
    await expect(page.locator('#routing-cancel-btn')).toBeVisible();
  });

  test('toast appears when no trail is nearby', async ({ page }) => {
    // Reroute trails to empty so no graph exists
    await page.route('**/api/trails**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_FC) }),
    );

    await page.evaluate(async () => {
      const debugRoute = (window as unknown as {
        __debugRoute: (s: number[], e: number[]) => Promise<DebugRouteResult>;
      }).__debugRoute;
      return debugRoute([0.0, 0.0], [1.0, 1.0]);
    });

    await page.waitForSelector('#route-toast', { timeout: 5_000 });
    await expect(page.locator('#route-toast')).toBeVisible();
  });
});
