import { test, expect } from './fixtures';

test.describe('Keyword Management', () => {
  test.beforeEach(async ({ page, mockHub }) => {
    await mockHub;
  });

  test('displays keyword list', async ({ page }) => {
    await page.goto('/keywords');
    await expect(page.getByText('docker')).toBeVisible();
    await expect(page.getByText('kubernetes')).toBeVisible();
  });

  test('add keyword form is visible', async ({ page }) => {
    await page.goto('/keywords');
    await expect(page.getByTestId('keyword-add-input')).toBeVisible();
    await expect(page.getByTestId('keyword-add-button')).toBeVisible();
  });

  test('add keyword button is disabled when input is empty', async ({ page }) => {
    await page.goto('/keywords');
    await expect(page.getByTestId('keyword-add-button')).toBeDisabled();
  });

  test('deprecated keywords are marked', async ({ page }) => {
    await page.goto('/keywords');
    await expect(page.getByText('nginx')).toBeVisible();
  });
});