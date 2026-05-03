import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

const SHOT_DIR = path.resolve(__dirname, '../../.playwright-mcp');

async function openDrawer(page: Page) {
  await page.click('#nav-burger');
  await expect(page.locator('#nav-drawer.open')).toBeVisible();
}

async function getMapStyleInfo(page: Page) {
  return page.evaluate(() => {
    const map = (window as unknown as { __map?: any }).__map;
    if (!map) return null;
    const style = map.getStyle();
    return {
      sources: Object.keys(style.sources ?? {}),
      layerIds: (style.layers ?? []).map((l: { id: string }) => l.id),
    };
  });
}

test.describe('basemap drawer', () => {
  test('drawer lists 5 basemaps with correct labels and ids', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#nav-burger');
    await openDrawer(page);

    const radios = page.locator('#menu input[name="map-style"]');
    await expect(radios).toHaveCount(5);

    const expected: Array<[string, string]> = [
      ['outdoors-v12', 'MapBox'],
      ['satellite-streets-v12', 'MapBox sat 2D'],
      ['satellite-3d', 'MapBox sat 3D'],
      ['osm', 'OpenStreetMap'],
      ['opentopo', 'TopoMap'],
    ];

    for (const [id, label] of expected) {
      const input = page.locator(`#${id}`);
      await expect(input, `radio #${id} missing`).toBeVisible();
      const labelEl = input.locator('xpath=ancestor::label');
      await expect(labelEl).toContainText(label);
    }

    // Default checked = MapBox (outdoors-v12)
    await expect(page.locator('#outdoors-v12')).toBeChecked();

    await page.screenshot({ path: path.join(SHOT_DIR, 'basemap-drawer.png'), fullPage: false });
  });

  test('selecting OpenStreetMap switches map to OSM raster style', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as { __map?: any }).__map));
    // Wait for initial style.load
    await page.waitForTimeout(800);

    await openDrawer(page);
    await page.click('#osm');
    // Allow setStyle to settle
    await page.waitForTimeout(1500);

    const info = await getMapStyleInfo(page);
    expect(info, 'window.__map missing').not.toBeNull();
    expect(info!.sources, 'osm source not present').toContain('osm');
    expect(info!.layerIds, 'osm-raster layer not present').toContain('osm-raster');

    await page.screenshot({ path: path.join(SHOT_DIR, 'basemap-osm.png'), fullPage: false });
  });

  test('selecting TopoMap switches map to OpenTopo style', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as { __map?: any }).__map));
    await page.waitForTimeout(800);

    await openDrawer(page);
    await page.click('#opentopo');
    await page.waitForTimeout(1500);

    const info = await getMapStyleInfo(page);
    expect(info!.sources).toContain('opentopo');
    expect(info!.layerIds).toContain('opentopo-raster');

    await page.screenshot({ path: path.join(SHOT_DIR, 'basemap-topo.png'), fullPage: false });
  });
});
