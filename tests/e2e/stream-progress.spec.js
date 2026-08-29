import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const STRIDE80 = path.resolve('Log_sample/extracted/data_sys_6_stride80.csv');

test('stride80 stream advances the progress bar and does not hang the tab', async ({ page }) => {
  test.skip(!fs.existsSync(STRIDE80), 'Log_sample/extracted/data_sys_6_stride80.csv is not in this checkout');
  test.setTimeout(180_000);

  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto('/');
  await page.setInputFiles('#csvFileInput', STRIDE80);
  await expect(page.getByRole('button', { name: /분석 포함 \(스트리밍 시작\)/ })).toBeVisible({ timeout: 90_000 });

  const percents = [];
  await page.getByRole('button', { name: /분석 포함 \(스트리밍 시작\)/ }).click();

  await expect.poll(async () => {
    const fill = page.locator('.progress-fill').first();
    if (await fill.count()) {
      const width = await fill.getAttribute('style');
      const m = /width:(\d+)%/.exec(width || '');
      if (m) percents.push(Number(m[1]));
    }
    const sub = page.locator('.source-sub').first();
    return (await sub.count()) ? (await sub.textContent()) : '';
  }, { timeout: 120_000, intervals: [200, 400, 800] }).toMatch(/240,603행|240603행/);

  const rising = percents.filter((p, i) => i === 0 || p >= percents[i - 1]);
  expect(rising.length, `progress samples: ${percents.join(',')}`).toBe(percents.length);
  expect(new Set(percents).size).toBeGreaterThan(1);
  expect(pageErrors).toEqual([]);
});
