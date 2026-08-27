import { test, expect } from '@playwright/test';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'This spec is mobile-viewport specific');
});

test('at 390x844 the intake form (page title + log upload entry point) is visible without the sidebar taking the whole first viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#pageTitle')).toBeVisible();
  await expect(page.getByText('BMS/EMS 로그 데이터')).toBeVisible();

  const noHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(noHorizontalScroll).toBe(true);

  // The log-upload entry point should be reachable within the first
  // viewport's worth of scrolling (not buried below a full-height sidebar).
  const uploadButtonBox = await page.getByRole('button', { name: /CSV\/TXT\/LOG 파일 추가/ }).boundingBox();
  expect(uploadButtonBox).not.toBeNull();
  expect(uploadButtonBox.y).toBeLessThan(844 * 2);
});
