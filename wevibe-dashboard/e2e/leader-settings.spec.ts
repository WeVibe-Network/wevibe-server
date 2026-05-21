import { test, expect } from './fixtures';

test.describe('Settings', () => {
  test.beforeEach(async ({ page, mockHub }) => {
    await mockHub;
  });

  test('displays current settings', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1')).toContainText('Dashboard Settings');
  });

  test('required approvals field exists', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByTestId('required-approvals-input')).toBeVisible();
  });
});