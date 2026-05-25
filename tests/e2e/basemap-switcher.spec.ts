import { test, expect, type Page } from '@playwright/test';

async function openDrawer(page: Page) {
  await page.click('#nav-burger');
  await expect(page.locator('#nav-drawer.open')).toBeVisible();
}

async function waitForMap(page: Page) {
  await page.waitForFunction(() => Boolean((window as unknown as { __debugMap?: unknown }).__debugMap));
  await page.waitForFunction(() => (window as unknown as { __debugMap?: { isStyleLoaded: () => boolean } }).__debugMap?.isStyleLoaded() === true);
}

async function getMapSources(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const map = (window as unknown as { __debugMap?: { getStyle: () => { sources?: Record<string, unknown> } } }).__debugMap;
    if (!map) return [];
    return Object.keys(map.getStyle().sources ?? {});
  });
}

async function getMapCamera(page: Page): Promise<{ pitch: number; bearing: number }> {
  return page.evaluate(() => {
    const map = (window as unknown as { __debugMap?: { getPitch: () => number; getBearing: () => number } }).__debugMap;
    if (!map) return { pitch: 0, bearing: 0 };
    return { pitch: map.getPitch(), bearing: map.getBearing() };
  });
}

test.describe('basemap switcher INP guards', () => {
  test('no-op click on already-active basemap does not show loading overlay', async ({ page }) => {
    await page.goto('/');
    await waitForMap(page);
    await openDrawer(page);

    // outdoors-v12 is the default-checked basemap on page load
    await expect(page.locator('#outdoors-v12')).toBeChecked();
    const overlay = page.locator('#basemap-loading-overlay');
    await expect(overlay).toBeHidden();

    const sourcesBefore = await getMapSources(page);

    await page.click('#outdoors-v12');

    // Overlay must never become visible on a no-op click; race the assertion
    // against a short timeout to confirm it stays hidden.
    await page.waitForTimeout(200);
    await expect(overlay).toBeHidden();

    const sourcesAfter = await getMapSources(page);
    expect(sourcesAfter).toEqual(sourcesBefore);
  });

  test('switching to a different basemap shows the loading overlay then hides it', async ({ page }) => {
    await page.goto('/');
    await waitForMap(page);
    await openDrawer(page);

    const overlay = page.locator('#basemap-loading-overlay');
    await expect(overlay).toBeHidden();

    await page.click('#osm');

    // Overlay appears synchronously inside the click handler — it must be
    // visible by the next microtask, well within Playwright's default poll.
    await expect(overlay).toBeVisible({ timeout: 500 });
    await expect(overlay).toContainText(/switching basemap/i);

    // After Mapbox finishes rebuilding (style.load), the overlay hides.
    await expect(overlay).toBeHidden({ timeout: 5000 });
  });

  test('switching between flat basemaps does not tilt the camera', async ({ page }) => {
    await page.goto('/');
    await waitForMap(page);
    await openDrawer(page);

    const initial = await getMapCamera(page);
    expect(initial.pitch).toBeLessThan(0.5);
    expect(Math.abs(initial.bearing)).toBeLessThan(0.5);

    await page.click('#satellite-streets-v12');
    await expect(page.locator('#basemap-loading-overlay')).toBeHidden({ timeout: 5000 });

    // After a flat→flat switch the camera must stay at pitch=0/bearing=0 —
    // easeTo is a no-op when target equals current.
    const after = await getMapCamera(page);
    expect(after.pitch).toBeLessThan(0.5);
    expect(Math.abs(after.bearing)).toBeLessThan(0.5);
  });

  test('switching to satellite-3d tilts the camera, switching back resets it', async ({ page }) => {
    await page.goto('/');
    await waitForMap(page);
    await openDrawer(page);

    await page.click('#satellite-3d');
    await expect(page.locator('#basemap-loading-overlay')).toBeHidden({ timeout: 5000 });
    // easeTo is animated; give it room to settle.
    await page.waitForFunction(
      () => {
        const map = (window as unknown as { __debugMap?: { getPitch: () => number } }).__debugMap;
        return map ? map.getPitch() > 60 : false;
      },
      { timeout: 4000 },
    );
    const tilted = await getMapCamera(page);
    expect(tilted.pitch).toBeGreaterThan(60);

    await page.click('#outdoors-v12');
    await expect(page.locator('#basemap-loading-overlay')).toBeHidden({ timeout: 5000 });
    await page.waitForFunction(
      () => {
        const map = (window as unknown as { __debugMap?: { getPitch: () => number } }).__debugMap;
        return map ? map.getPitch() < 1 : false;
      },
      { timeout: 4000 },
    );
    const flat = await getMapCamera(page);
    expect(flat.pitch).toBeLessThan(1);
  });
});
