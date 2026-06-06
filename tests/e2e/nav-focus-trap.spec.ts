import { test, expect } from '@playwright/test';

const focusInsideDrawer = () =>
  ((): boolean => {
    const d = document.getElementById('nav-drawer');
    return d != null && document.activeElement != null && d.contains(document.activeElement);
  });

test.describe('nav drawer focus trap', () => {
  test('opening the drawer moves focus inside it', async ({ page }) => {
    await page.goto('/');
    await page.locator('#nav-burger').click();
    expect(await page.evaluate(focusInsideDrawer())).toBe(true);
  });

  test('Tab pulls focus back in when it has escaped the open drawer', async ({ page }) => {
    await page.goto('/');
    await page.locator('#nav-burger').click();

    // Simulate focus leaving the drawer (e.g. programmatic focus elsewhere).
    await page.evaluate(() => (document.getElementById('search-box') as HTMLElement | null)?.focus());
    expect(await page.evaluate(focusInsideDrawer())).toBe(false);

    await page.keyboard.press('Tab');
    expect(await page.evaluate(focusInsideDrawer())).toBe(true);
  });
});
