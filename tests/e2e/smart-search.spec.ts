import { test, expect, type Page } from '@playwright/test';

const FILTER = {
  types: ['hut'],
  elevation: { min: 2000, max: null },
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
  await expect(page.locator('.results-count')).toHaveText('Mostrando 3 di 5');
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

    await page.screenshot({ path: 'tests/e2e/__screens__/smart-search-list.png' }).catch(() => {});
  });

  test('clicking a result opens its detail view with a back button', async ({ page }) => {
    await stubSmartSearch(page);
    await runSearch(page);

    await page.locator('.result-row').first().click();
    await expect(page.locator('#panel h2')).toHaveText('Rifugio Curò');
    await expect(page.locator('.results-back')).toBeVisible();

    await page.locator('.results-back').click();
    await expect(page.locator('.results-count')).toHaveText('Mostrando 3 di 5');
  });

  test('"Carica altri" paginates by replaying the filter, not re-translating', async ({ page }) => {
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
    await expect(page.locator('.results-empty')).toContainText('Non ho capito');
  });
});
