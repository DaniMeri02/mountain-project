import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

const SHOT_DIR = path.resolve(__dirname, '../../.playwright-mcp');
const ELLIPSIS = '…';

async function getPlaceholderRenderInfo(page: Page) {
  return page.evaluate(() => {
    const input = document.getElementById('search-box') as HTMLInputElement;
    const cs = window.getComputedStyle(input);
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
    const borderRight = parseFloat(cs.borderRightWidth) || 0;
    const contentBox = input.offsetWidth - padLeft - padRight - borderLeft - borderRight;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const placeholder = input.placeholder;
    const textWidth = ctx.measureText(placeholder).width;

    return {
      placeholder,
      contentBox,
      textWidth,
      offsetWidth: input.offsetWidth,
    };
  });
}

test.describe('search placeholder responsive truncation', () => {
  test('does not chop mid-word at any common viewport', async ({ page }) => {
    const widths = [320, 360, 480, 640, 768, 1024, 1280, 1440];

    for (const w of widths) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.goto('/');
      await page.waitForSelector('#search-box');
      // Allow rAF + ResizeObserver to settle
      await page.waitForTimeout(150);

      const info = await getPlaceholderRenderInfo(page);

      // Placeholder must end with ellipsis char (or be exactly ellipsis at extreme small)
      expect(info.placeholder.endsWith(ELLIPSIS), `viewport ${w}: placeholder='${info.placeholder}' missing ellipsis`).toBe(true);

      // Placeholder must NOT contain literal "..." (three dots) — that's the old bug
      expect(info.placeholder.includes('...'), `viewport ${w}: literal '...' present in '${info.placeholder}'`).toBe(false);

      // Stripped of trailing ellipsis, must be a clean phrase from our tier list (no mid-word cut)
      const allowedStems = [
        'Search huts, peaks, bivouacs, via ferrata',
        'Search huts, peaks, bivouacs',
        'Search huts, peaks',
        'Search huts',
        'Search',
        '',
      ];
      const stem = info.placeholder.replace(/…$/, '');
      expect(allowedStems, `viewport ${w}: stem '${stem}' not in allowed list`).toContain(stem);

      // Rendered text width must fit available content box (with 6px buffer match)
      expect(info.textWidth, `viewport ${w}: text ${info.textWidth}px overflows content ${info.contentBox}px`).toBeLessThanOrEqual(info.contentBox);

      await page.screenshot({
        path: path.join(SHOT_DIR, `placeholder-${w}.png`),
        clip: { x: 0, y: 0, width: w, height: 80 },
      });
    }
  });

  test('focus does not change placeholder truncation', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/');
    await page.waitForSelector('#search-box');
    await page.waitForTimeout(150);

    const before = await getPlaceholderRenderInfo(page);
    await page.screenshot({ path: path.join(SHOT_DIR, 'placeholder-360-blur.png'), clip: { x: 0, y: 0, width: 360, height: 80 } });

    await page.click('#search-box');
    await page.waitForTimeout(150);
    const after = await getPlaceholderRenderInfo(page);
    await page.screenshot({ path: path.join(SHOT_DIR, 'placeholder-360-focus.png'), clip: { x: 0, y: 0, width: 360, height: 80 } });

    expect(after.placeholder).toBe(before.placeholder);
    expect(after.textWidth).toBeLessThanOrEqual(after.contentBox);
  });

  test('reload state matches loaded state (no flash of stale text)', async ({ page, request }) => {
    // Inspect raw HTML — JS not run yet, so this is what user sees during reload
    const res = await request.get('/');
    const html = await res.text();
    const match = html.match(/id="search-box"[^>]*placeholder="([^"]+)"/);
    expect(match, 'search-box placeholder attr not found').not.toBeNull();
    const rawPlaceholder = match![1];
    // Default must be the always-fits fallback so reload never shows mid-word truncation
    expect(rawPlaceholder).toBe('Search…');

    // Now load page and confirm JS upgrades to a fitting variant
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await page.waitForSelector('#search-box');
    await page.waitForTimeout(200);
    const afterJs = await getPlaceholderRenderInfo(page);
    expect(afterJs.placeholder.endsWith(ELLIPSIS)).toBe(true);
    expect(afterJs.textWidth).toBeLessThanOrEqual(afterJs.contentBox);
  });
});
