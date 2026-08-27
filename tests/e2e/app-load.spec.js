import { test, expect } from '@playwright/test';

test('development app renders the intake form without module 404s', async ({ page }) => {
  const failed = [];
  page.on('response', r => { if (r.status() >= 400) failed.push(r.url()); });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto('/');
  await expect(page).toHaveTitle('ESS BMS 이슈 분석 워크스테이션');
  await expect(page.locator('#viewRoot .panel')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /이상 구간 탐지 시작/ })).toBeVisible();

  expect(failed.filter(url => url.endsWith('/api.js'))).toEqual([]);
  expect(pageErrors).toEqual([]);
});
