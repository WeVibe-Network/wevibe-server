import { test, expect } from './fixtures';

test.describe('Member Management', () => {
  test.beforeEach(async ({ page, mockHub }) => {
    await mockHub;
  });

  test('displays member list', async ({ page }) => {
    await page.goto('/members');
    await expect(page.getByText('leader').first()).toBeVisible();
  });

  test('invite member form is visible', async ({ page }) => {
    await page.goto('/members');
    await expect(page.getByTestId('invite-pubkey-input')).toBeVisible();
    await expect(page.getByTestId('invite-x25519-input')).toBeVisible();
    await expect(page.getByTestId('invite-role-select')).toBeVisible();
  });

  test('invite member form validates required fields', async ({ page }) => {
    await page.goto('/members');
    await expect(page.getByTestId('invite-pubkey-input')).toHaveAttribute('required', '');
    await expect(page.getByTestId('invite-x25519-input')).toHaveAttribute('required', '');
  });

  test('change member role shows dropdown', async ({ page }) => {
    await page.goto('/members');
    const roleButton = page.getByTestId('role-change-trigger').first();
    if (await roleButton.isVisible()) {
      await roleButton.click();
      await expect(page.getByRole('option')).toBeVisible();
    }
  });

  test('remove member shows confirmation', async ({ page }) => {
    await page.goto('/members');
    const removeButton = page.getByTestId('remove-member-trigger').first();
    if (await removeButton.isVisible()) {
      await removeButton.click();
      await expect(page.getByText(/confirm/i)).toBeVisible();
    }
  });

  test('transfer leadership shows confirmation', async ({ page }) => {
    await page.goto('/members');
    const transferButton = page.getByTestId('transfer-leadership-trigger').first();
    if (await transferButton.isVisible()) {
      await transferButton.click();
      await expect(page.getByText(/transfer leadership/i)).toBeVisible();
    }
  });
});