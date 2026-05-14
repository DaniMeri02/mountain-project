import { test, expect } from '@playwright/test';

type DebugRouteResult = {
  error?: string;
  altsFound: number;
  altDistances: number[];
  fromCoord?: number[];
  toCoord?: number[];
};

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const TRAILS_FC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { osm_id: 1001, name: 'long-path' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [9.0, 46.0],
          [9.01, 46.0],
          [9.01, 45.995],
          [9.001, 45.995],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { osm_id: 1002, name: 'short-path' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [9.001, 46.0],
          [9.001, 45.995],
        ],
      },
    },
  ],
};

test('routing prefers the shortest snapped path', async ({ page }) => {
  await page.route('**/api/trails**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TRAILS_FC),
    }),
  );
  await page.route('**/api/ferrata**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_FC),
    }),
  );
  await page.route('**/api/pois**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_FC),
    }),
  );

  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as { __debugRoute?: unknown }).__debugRoute));

  const result = await page.evaluate(async () => {
    const debugRoute = (window as unknown as { __debugRoute: (start: number[], end: number[]) => Promise<DebugRouteResult> }).__debugRoute;
    return debugRoute([9.0, 46.0], [9.001, 45.995]);
  });

  expect(result.error).toBeUndefined();
  expect(result.altsFound).toBeGreaterThan(0);
  expect(result.altDistances[0]).toBeLessThan(1000);
  expect(result.fromCoord).toBeDefined();
  expect(result.toCoord).toBeDefined();
  expect(result.fromCoord![0]).toBeCloseTo(9.001, 6);
  expect(result.fromCoord![1]).toBeCloseTo(46.0, 6);
  expect(result.toCoord![0]).toBeCloseTo(9.001, 6);
  expect(result.toCoord![1]).toBeCloseTo(45.995, 6);
});
