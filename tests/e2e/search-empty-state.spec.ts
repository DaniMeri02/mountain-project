import { test, expect } from '@playwright/test';

// The search box is shared between plain name autocomplete and the ✨ smart (AI) search.
// A natural-language query ("bivacchi sopra 1500m") has no name match, so the empty state must
// point the user at smart search rather than dead-ending. A failed request is a separate case.
test.describe('plain search empty + error states', () => {
  test('no name match nudges to AI search, and activating it starts smart search', async ({ page }) => {
    await page.goto('/');
    await page.locator('#search-box').fill('zzqxwv'); // gibberish — no DB match

    const hint = page.locator('#search-results .search-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(/AI search/i);

    await hint.click();
    // run() renders "Interpreting…" into the panel synchronously, before any AI round-trip.
    await expect(page.locator('#panel')).toContainText(/Interpreting/i);
  });

  test('a failed search request shows an unavailable row', async ({ page }) => {
    await page.route('**/api/search**', (route) => route.abort());
    await page.goto('/');
    await page.locator('#search-box').fill('rifugio');

    const hint = page.locator('#search-results .search-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(/unavailable/i);
  });
});
