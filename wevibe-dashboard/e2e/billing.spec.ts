import { test, expect } from './fixtures';

test.describe('Billing Page', () => {
  test.beforeEach(async ({ page, mockHub }) => {
    await mockHub;
  });

  test('displays credit balance', async ({ page }) => {
    await page.goto('/billing');
    await expect(page.getByText(/credit|balance/i).first()).toBeVisible();
  });

  test('displays transaction history', async ({ page }) => {
    await page.goto('/billing');
    await expect(page.getByText(/transaction|history/i).first()).toBeVisible();
  });

  test('top up button exists', async ({ page }) => {
    await page.goto('/billing');
    await expect(page.getByRole('button', { name: /top up/i })).toBeVisible();
  });
});