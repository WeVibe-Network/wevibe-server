import { test, expect } from './fixtures';

test.describe('Org Management', () => {
  test('org creation form validates input', async ({ page, mockHub }) => {
    await page.goto('/create-org');
    await page.getByTestId('submit-button').click();
    await expect(page.getByText(/required|empty/i)).toBeVisible({ timeout: 5000 });
  });

  test('org creation shows warning about wevibe-mcp', async ({ page, mockHub }) => {
    await page.goto('/create-org');
    await expect(page.getByText(/wevibe-mcp|setup_org/i)).toBeVisible({ timeout: 5000 });
  });
});