import { test, expect } from '@playwright/test';

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

test.describe('navigation drawer', () => {
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
    await page.waitForSelector('#nav-burger');
  });

  test('clicking nav-burger opens the drawer', async ({ page }) => {
    await expect(page.locator('#nav-drawer')).not.toHaveClass(/open/);
    await page.click('#nav-burger');
    await expect(page.locator('#nav-drawer')).toHaveClass(/open/);
  });

  test('drawer has aria-hidden=false when open', async ({ page }) => {
    await page.click('#nav-burger');
    await expect(page.locator('#nav-drawer')).toHaveAttribute('aria-hidden', 'false');
  });

  test('nav-burger aria-expanded is true when drawer is open', async ({ page }) => {
    await page.click('#nav-burger');
    await expect(page.locator('#nav-burger')).toHaveAttribute('aria-expanded', 'true');
  });

  test('Escape closes the drawer', async ({ page }) => {
    await page.click('#nav-burger');
    await expect(page.locator('#nav-drawer')).toHaveClass(/open/);

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('nav-drawer')!.classList.contains('open'));
    await expect(page.locator('#nav-drawer')).not.toHaveClass(/open/);
  });

  test('clicking the close button closes the drawer', async ({ page }) => {
    await page.click('#nav-burger');
    await expect(page.locator('#nav-drawer')).toHaveClass(/open/);

    await page.click('#nav-drawer-close');
    await page.waitForFunction(() => !document.getElementById('nav-drawer')!.classList.contains('open'));
    await expect(page.locator('#nav-drawer')).not.toHaveClass(/open/);
  });

  test('clicking the backdrop closes the drawer', async ({ page }) => {
    await page.click('#nav-burger');
    await expect(page.locator('#nav-drawer')).toHaveClass(/open/);

    // Wait for backdrop to become visible (it animates in)
    await page.waitForFunction(() => {
      const backdrop = document.getElementById('nav-backdrop');
      return backdrop !== null && !backdrop.hidden;
    });

    await page.click('#nav-backdrop');
    await page.waitForFunction(() => !document.getElementById('nav-drawer')!.classList.contains('open'));
    await expect(page.locator('#nav-drawer')).not.toHaveClass(/open/);
  });

  test('overlay layer checkboxes are present in the drawer', async ({ page }) => {
    await page.click('#nav-burger');
    await expect(page.locator('#nav-drawer')).toHaveClass(/open/);

    await expect(page.locator('#toggle-trails')).toBeVisible();
    await expect(page.locator('#toggle-ferrata')).toBeVisible();
    await expect(page.locator('#toggle-icons')).toBeVisible();
  });

  test('overlay layer checkboxes are checked by default', async ({ page }) => {
    await page.click('#nav-burger');

    await expect(page.locator('#toggle-trails')).toBeChecked();
    await expect(page.locator('#toggle-ferrata')).toBeChecked();
    await expect(page.locator('#toggle-icons')).toBeChecked();
  });

  test('basemap radio buttons are present', async ({ page }) => {
    await page.click('#nav-burger');

    const radios = page.locator('#menu input[name="map-style"]');
    await expect(radios).toHaveCount(5);
    await expect(page.locator('#outdoors-v12')).toBeChecked();
  });

  test('burger acts as toggle — programmatic second click closes the drawer', async ({ page }) => {
    await page.click('#nav-burger');
    await expect(page.locator('#nav-drawer')).toHaveClass(/open/);

    // The burger button is covered by the open drawer in a full-page overlay.
    // Dispatch the click event programmatically to verify the toggle logic.
    await page.evaluate(() => {
      (document.getElementById('nav-burger') as HTMLButtonElement).click();
    });
    await page.waitForFunction(() => !document.getElementById('nav-drawer')!.classList.contains('open'));
    await expect(page.locator('#nav-drawer')).not.toHaveClass(/open/);
  });

  test('drawer aria-hidden is true when closed', async ({ page }) => {
    // Initial state
    await expect(page.locator('#nav-drawer')).toHaveAttribute('aria-hidden', 'true');

    // Open then close
    await page.click('#nav-burger');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('nav-drawer')!.classList.contains('open'));

    await expect(page.locator('#nav-drawer')).toHaveAttribute('aria-hidden', 'true');
  });
});
