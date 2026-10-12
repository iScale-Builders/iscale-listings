import { expect, test } from '@playwright/test';

test('home page renders the API landing', async ({ page }) => {
  const res = await page.goto('/');
  expect(res?.status() ?? 200).toBeLessThan(400);
  await expect(page.getByRole('heading', { name: /trademark api/i })).toBeVisible();
});
