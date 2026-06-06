import { test, expect } from '@playwright/test';

// Characterization tests for the two panel renderers (refactor guard for unifying the shell).
test.describe('detail panel rendering', () => {
  test('a plain map click opens the coordinates panel with a close button', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1500); // let the map initialize

    // Click the canvas centre. At the default (zoomed-out) view there are no POI markers,
    // so this is a plain coordinate click rather than a POI click.
    await page.locator('#map canvas').click();

    // The × is CSS-hidden on the desktop side-by-side layout, so assert it's in the DOM, not visible.
    await expect(page.locator('#panel')).toContainText('Clicked Coordinates');
    await expect(page.locator('#panel-close')).toBeAttached();
  });
});
