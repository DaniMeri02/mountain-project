import { test, expect } from '@playwright/test';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

test.describe('offline area UI', () => {
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
    // Wait for offline controls to be injected
    await page.waitForSelector('#offline-save-btn');
  });

  test('Save offline area and Saved areas buttons are injected', async ({ page }) => {
    await page.click('#nav-burger');
    await expect(page.locator('#offline-save-btn')).toBeVisible();
    await expect(page.locator('#offline-list-toggle')).toBeVisible();
  });

  test('Saved areas panel is hidden by default', async ({ page }) => {
    await expect(page.locator('#offline-panel')).toBeHidden();
  });

  test('clicking Saved areas toggles the panel open', async ({ page }) => {
    await page.click('#nav-burger');
    await page.click('#offline-list-toggle');

    await expect(page.locator('#offline-panel')).toBeVisible();
    await expect(page.locator('#offline-list-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  test('empty saved areas list shows placeholder text', async ({ page }) => {
    await page.click('#nav-burger');
    await page.click('#offline-list-toggle');

    await expect(page.locator('#offline-areas-list')).toContainText('No saved areas yet');
  });

  test('clicking Saved areas twice closes the panel', async ({ page }) => {
    await page.click('#nav-burger');
    await page.click('#offline-list-toggle');
    await expect(page.locator('#offline-panel')).toBeVisible();

    await page.click('#offline-list-toggle');
    await expect(page.locator('#offline-panel')).toBeHidden();
    await expect(page.locator('#offline-list-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  test('clicking Save offline area starts draw mode — hint appears', async ({ page }) => {
    await page.evaluate(() => document.getElementById('offline-save-btn')!.click());

    // startDrawMode shows #offline-draw-hint and sets cursor to crosshair
    await page.waitForSelector('#offline-draw-hint', { state: 'visible' });
    await expect(page.locator('#offline-draw-hint')).toBeVisible();
  });

  test('clicking Save offline area again cancels draw mode — hint hides', async ({ page }) => {
    await page.evaluate(() => document.getElementById('offline-save-btn')!.click());
    await page.waitForSelector('#offline-draw-hint', { state: 'visible' });

    await page.evaluate(() => document.getElementById('offline-save-btn')!.click());

    await expect(page.locator('#offline-draw-hint')).toBeHidden();
  });
});
