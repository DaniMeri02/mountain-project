import { test, expect, type Page } from '@playwright/test';

const FILTER = {
  types: ['hut'],
  minElevation: 2000,
  maxElevation: null,
  area: { kind: 'province', name: 'Bergamo' },
  difficulty: null,
  nameContains: null,
  sort: 'elevation_desc',
  limit: 50,
  offset: 0,
};

const HUT = (id: number, name: string, elevation: number, lng: number, lat: number) => ({
  id, osm_id: id, type: 'hut', name, elevation, lng, lat,
  via_ferrata_scale: null, sac_scale: null, source_type: null,
});

const PAGE1 = {
  filter: FILTER,
  results: [
    HUT(1, 'Rifugio Curò', 1915, 10.02, 46.02),
    HUT(2, 'Rifugio Coca', 1892, 9.98, 46.0),
    HUT(3, 'Rifugio Brunone', 2295, 9.95, 46.03),
  ],
  total: 5, offset: 0, limit: 3, modelUsed: 'Test Model',
};

const PAGE2 = {
  filter: FILTER,
  results: [HUT(4, 'Rifugio Calvi', 2015, 9.9, 46.05), HUT(5, 'Rifugio Laghi Gemelli', 1968, 9.85, 45.98)],
  total: 5, offset: 3, limit: 3, modelUsed: 'Test Model',
};

interface SmartCall { q?: string; filter?: unknown; offset?: number }

async function stubSmartSearch(page: Page): Promise<SmartCall[]> {
  const calls: SmartCall[] = [];
  await page.route('**/api/search/smart', async (route) => {
    const body = route.request().postDataJSON() as SmartCall;
    calls.push(body);
    const payload = body.q ? PAGE1 : PAGE2;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  return calls;
}

// #ai-search-btn exists in static HTML before the JS wires its click handler.
// The placeholder is upgraded only after search JS initialises → use it as a readiness gate.
async function waitReady(page: Page): Promise<void> {
  await page.waitForSelector('#ai-search-btn');
  await page.waitForFunction(
    () => document.getElementById('search-box')?.getAttribute('placeholder') !== 'Search…',
  );
}

async function runSearch(page: Page): Promise<void> {
  await page.goto('/');
  await waitReady(page);
  await page.fill('#search-box', 'rifugi sopra i 2000m in bergamasca');
  await page.click('#ai-search-btn');
  // Generous timeout: the first render after a cold Vite (re)compile can exceed the default.
  await expect(page.locator('.results-count')).toHaveText('Showing 3 of 5', { timeout: 15000 });
}

test.describe('smart filtering search', () => {
  test('renders the result list and drops markers on the map', async ({ page }) => {
    await stubSmartSearch(page);
    await runSearch(page);

    await expect(page.locator('.result-row')).toHaveCount(3);
    await expect(page.locator('.result-row').first()).toContainText('Rifugio Curò');

    const markerCount = await page.evaluate(() => {
      const w = window as unknown as {
        __debugMap?: { getSource: (id: string) => { serialize: () => { data?: { features?: unknown[] } } } | undefined };
      };
      const src = w.__debugMap?.getSource('search-results-src');
      return src?.serialize().data?.features?.length ?? -1;
    });
    expect(markerCount).toBe(3);

    await page.screenshot({ path: '.playwright-mcp/smart-search-list.png' }).catch(() => {});
  });

  test('clicking a result opens its detail view with a back button', async ({ page }) => {
    await stubSmartSearch(page);
    await runSearch(page);

    await page.locator('.result-row').first().click();
    await expect(page.locator('#panel h2')).toHaveText('Rifugio Curò');
    await expect(page.locator('.results-back')).toBeVisible();

    await page.locator('.results-back').click();
    await expect(page.locator('.results-count')).toHaveText('Showing 3 of 5');
  });

  test('"Load more" paginates by replaying the filter, not re-translating', async ({ page }) => {
    const calls = await stubSmartSearch(page);
    await runSearch(page);

    await page.locator('.results-more').click();
    await expect(page.locator('.result-row')).toHaveCount(5);
    await expect(page.locator('.results-more')).toHaveCount(0); // gone once all loaded

    expect(calls).toHaveLength(2);
    expect(calls[0].q).toBeTruthy();
    expect(calls[1].q).toBeUndefined();
    expect(calls[1].filter).toBeTruthy();
    expect(calls[1].offset).toBe(3);
  });

  test('shows a friendly message when the query cannot be interpreted (422)', async ({ page }) => {
    await page.route('**/api/search/smart', async (route) => {
      await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'nope' }) });
    });
    await page.goto('/');
    await waitReady(page);
    await page.fill('#search-box', 'qualcosa di incomprensibile');
    await page.click('#ai-search-btn');
    await expect(page.locator('.results-empty')).toContainText('understand');
  });
});

async function markerCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __debugMap?: { getSource: (id: string) => { serialize: () => { data?: { features?: unknown[] } } } | undefined };
    };
    return w.__debugMap?.getSource('search-results-src')?.serialize().data?.features?.length ?? -1;
  });
}

test.describe('smart results mode (B1)', () => {
  test('markers + back button persist across a map-click panel; Exit clears', async ({ page }) => {
    await stubSmartSearch(page);
    await runSearch(page);
    expect(await markerCount(page)).toBe(3);

    // Open a different panel by clicking the map — should stay in results mode.
    await page.locator('#map').click({ position: { x: 120, y: 220 } });
    await expect(page.locator('.results-back')).toBeVisible();
    expect(await markerCount(page)).toBe(3); // markers persist

    // Back → results list.
    await page.locator('.results-back').click();
    await expect(page.locator('.results-count')).toBeVisible();

    // Exit → markers cleared, list gone.
    await page.locator('.results-exit').click();
    await expect(page.locator('.results-list')).toHaveCount(0);
    expect(await markerCount(page)).toBe(0);
  });

  test('Escape closes the panel but keeps results mode (markers persist until Exit)', async ({ page }) => {
    await stubSmartSearch(page);
    await runSearch(page);
    await page.keyboard.press('Escape');
    expect(await markerCount(page)).toBe(3);
  });
});

test.describe('offline mode (B2)', () => {
  test('the AI search button is non-interactive in offline mode', async ({ page }) => {
    await page.goto('/');
    await waitReady(page);
    await page.evaluate(() => document.body.classList.add('offline-mode'));
    const pointerEvents = await page
      .locator('#ai-search-btn')
      .evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(pointerEvents).toBe('none');
  });
});

test.describe('clickable result markers (U2)', () => {
  test('clicking a result marker opens that result', async ({ page }) => {
    await stubSmartSearch(page);
    await runSearch(page);

    // Let fitBounds (800ms) finish, then click an actually-rendered marker at its true viewport
    // pixel (project() is container-relative, so add the container's bounding-rect offset).
    await page.waitForTimeout(1200);
    const pt = await page.evaluate(() => {
      const w = window as unknown as {
        __debugMap?: {
          queryRenderedFeatures: (opts: { layers: string[] }) => Array<{
            geometry: { coordinates: [number, number] };
            properties: Record<string, unknown>;
          }>;
          project: (c: [number, number]) => { x: number; y: number };
          getContainer: () => HTMLElement;
        };
      };
      const m = w.__debugMap;
      if (!m) return null;
      const feats = m.queryRenderedFeatures({ layers: ['search-results-circles'] });
      if (feats.length === 0) return null;
      const f = feats[0];
      const [lng, lat] = f.geometry.coordinates;
      const p = m.project([lng, lat]);
      const rect = m.getContainer().getBoundingClientRect();
      return { x: Math.round(rect.left + p.x), y: Math.round(rect.top + p.y), idx: Number(f.properties.idx) };
    });
    expect(pt).not.toBeNull();

    await page.mouse.click(pt!.x, pt!.y);
    const names = ['Rifugio Curò', 'Rifugio Coca', 'Rifugio Brunone'];
    await expect(page.locator('#panel h2')).toHaveText(names[pt!.idx]);
    await expect(page.locator('.results-back')).toBeVisible();
  });
});

test.describe('result markers survive basemap switch', () => {
  test('markers persist when switching basemap and back', async ({ page }) => {
    await stubSmartSearch(page);
    await runSearch(page);
    expect(await markerCount(page)).toBe(3);

    await page.click('#nav-burger'); // open the drawer (stays open on desktop)

    // Switch to OSM raster — setStyle wipes custom layers; markers must be re-asserted.
    await page.click('#osm');
    await page.waitForTimeout(2000); // style.load + re-assert
    expect(await markerCount(page)).toBe(3);

    // …and back to the first style.
    await page.click('#outdoors-v12');
    await page.waitForTimeout(2000);
    expect(await markerCount(page)).toBe(3);
  });
});

test.describe('busy state (U3)', () => {
  test('the search button shows a busy state during the request', async ({ page }) => {
    await page.route('**/api/search/smart', async (route) => {
      await new Promise((r) => setTimeout(r, 600)); // hold the response so the busy state is observable
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PAGE1) });
    });
    await page.goto('/');
    await waitReady(page);
    await page.fill('#search-box', 'rifugi sopra i 2000m in bergamasca');
    await page.click('#ai-search-btn');

    await expect(page.locator('#ai-search-btn')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.results-count')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#ai-search-btn')).toHaveAttribute('aria-busy', 'false');
  });
});
