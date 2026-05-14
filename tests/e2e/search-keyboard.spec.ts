import { test, expect } from '@playwright/test';

const MOCK_RESULTS = [
  { name: 'Curaton', type: 'peak', elevation: 2292, lat: 45.9, lng: 9.7 },
  { name: 'Curnasel', type: 'peak', elevation: 2809, lat: 45.91, lng: 9.71 },
  { name: 'Curvér Pintg da Neaza', type: 'peak', elevation: 2720, lat: 45.92, lng: 9.72 },
];

test.describe('search keyboard navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('/api/search*', (route) =>
      route.fulfill({ json: MOCK_RESULTS })
    );
    await page.goto('/');
    await page.waitForSelector('#search-box');
    await page.click('#search-box');
    await page.type('#search-box', 'cur');
    await page.waitForSelector('#search-results li');
  });

  test('ArrowDown highlights first then second item', async ({ page }) => {
    await page.keyboard.press('ArrowDown');
    const items = page.locator('#search-results li');
    await expect(items.nth(0)).toHaveClass(/active/);
    await expect(items.nth(1)).not.toHaveClass(/active/);

    await page.keyboard.press('ArrowDown');
    await expect(items.nth(0)).not.toHaveClass(/active/);
    await expect(items.nth(1)).toHaveClass(/active/);
  });

  test('ArrowUp from first item clears highlight', async ({ page }) => {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    const items = page.locator('#search-results li');
    for (let i = 0; i < MOCK_RESULTS.length; i++) {
      await expect(items.nth(i)).not.toHaveClass(/active/);
    }
  });

  test('ArrowDown does not go past last item', async ({ page }) => {
    for (let i = 0; i < MOCK_RESULTS.length + 3; i++) {
      await page.keyboard.press('ArrowDown');
    }
    const items = page.locator('#search-results li');
    await expect(items.nth(MOCK_RESULTS.length - 1)).toHaveClass(/active/);
  });

  test('Enter on highlighted item closes dropdown', async ({ page }) => {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('#search-results')).not.toBeVisible();
  });

  test('Escape closes dropdown', async ({ page }) => {
    await page.keyboard.press('Escape');
    await expect(page.locator('#search-results')).not.toBeVisible();
  });

  test('Enter with no highlight selects first result', async ({ page }) => {
    await page.keyboard.press('Enter');
    await expect(page.locator('#search-results')).not.toBeVisible();
    const value = await page.inputValue('#search-box');
    expect(value).toBe(MOCK_RESULTS[0].name);
  });

  test('Tab from search box focuses first item', async ({ page }) => {
    await page.keyboard.press('Tab');
    const items = page.locator('#search-results li');
    await expect(items.nth(0)).toHaveClass(/active/);
    await expect(items.nth(0)).toBeFocused();
  });

  test('Tab through items navigates forward', async ({ page }) => {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const items = page.locator('#search-results li');
    await expect(items.nth(1)).toHaveClass(/active/);
    await expect(items.nth(1)).toBeFocused();
  });

  test('Shift+Tab from first item returns focus to search box', async ({ page }) => {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    const items = page.locator('#search-results li');
    for (let i = 0; i < MOCK_RESULTS.length; i++) {
      await expect(items.nth(i)).not.toHaveClass(/active/);
    }
    await expect(page.locator('#search-box')).toBeFocused();
  });
});
