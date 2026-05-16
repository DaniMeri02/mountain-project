import { test, expect } from '@playwright/test';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

test.describe('fullscreen map toggle', () => {
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

    // Use a desktop viewport so the fullscreen toggle is not hidden
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as { __debugMap?: unknown }).__debugMap));
    await page.waitForSelector('#toggle-map-fullscreen');
  });

  test('toggle button is visible on desktop', async ({ page }) => {
    await expect(page.locator('#toggle-map-fullscreen')).toBeVisible();
  });

  test('clicking toggle adds map-fullscreen class to body', async ({ page }) => {
    await expect(page.locator('body')).not.toHaveClass(/map-fullscreen/);
    await page.click('#toggle-map-fullscreen');
    await page.waitForFunction(() => document.body.classList.contains('map-fullscreen'));
    await expect(page.locator('body')).toHaveClass(/map-fullscreen/);
  });

  test('clicking toggle again removes map-fullscreen class', async ({ page }) => {
    await page.click('#toggle-map-fullscreen');
    await page.waitForFunction(() => document.body.classList.contains('map-fullscreen'));

    await page.click('#toggle-map-fullscreen');
    await page.waitForFunction(() => !document.body.classList.contains('map-fullscreen'));
    await expect(page.locator('body')).not.toHaveClass(/map-fullscreen/);
  });

  test('Escape while in fullscreen removes map-fullscreen class', async ({ page }) => {
    await page.click('#toggle-map-fullscreen');
    await page.waitForFunction(() => document.body.classList.contains('map-fullscreen'));

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('map-fullscreen'));
    await expect(page.locator('body')).not.toHaveClass(/map-fullscreen/);
  });

  test('aria-pressed reflects fullscreen state', async ({ page }) => {
    const btn = page.locator('#toggle-map-fullscreen');

    // Initial state — setFullscreenState(false) is called on init which sets aria-pressed="false"
    await expect(btn).toHaveAttribute('aria-pressed', 'false');

    await page.click('#toggle-map-fullscreen');
    await page.waitForFunction(() => document.body.classList.contains('map-fullscreen'));
    await expect(btn).toHaveAttribute('aria-pressed', 'true');

    await page.click('#toggle-map-fullscreen');
    await page.waitForFunction(() => !document.body.classList.contains('map-fullscreen'));
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  test('Escape does not affect fullscreen when not in fullscreen', async ({ page }) => {
    await expect(page.locator('body')).not.toHaveClass(/map-fullscreen/);
    await page.keyboard.press('Escape');
    // Still no fullscreen class — Escape only fires if already fullscreen
    await expect(page.locator('body')).not.toHaveClass(/map-fullscreen/);
  });
});
