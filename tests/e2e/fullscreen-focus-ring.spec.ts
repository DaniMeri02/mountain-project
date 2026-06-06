import { test, expect } from '@playwright/test';

// The fullscreen toggle is keyboard-reachable but had no :focus-visible style, unlike its
// siblings (.nav-burger, #ai-search-btn). A programmatic focus does not reliably trigger
// :focus-visible, so assert the rule is defined in the CSSOM instead.
test('fullscreen toggle defines a :focus-visible style', async ({ page }) => {
  await page.goto('/');
  const hasRule = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRule[];
      try {
        rules = Array.from(sheet.cssRules);
      } catch {
        continue; // cross-origin sheet — skip
      }
      for (const r of rules) {
        if (
          r instanceof CSSStyleRule &&
          r.selectorText.includes('#toggle-map-fullscreen') &&
          r.selectorText.includes(':focus-visible')
        ) {
          return true;
        }
      }
    }
    return false;
  });
  expect(hasRule).toBe(true);
});
