import { test, expect } from './fixtures';

test.describe('Reports Page', () => {
  test.beforeEach(async ({ page, mockHub }) => {
    await mockHub;
  });

  test('displays reports list or empty state', async ({ page }) => {
    await page.goto('/reports');
    const reportsOrEmpty = page.getByText(/report|no.*report/i);
    await expect(reportsOrEmpty.first()).toBeVisible();
  });

  test('status filter tabs exist', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.getByRole('button', { name: /pending/i })).toBeVisible();
  });
});