import { test, expect } from './fixtures';

test.describe('Sessions Page', () => {
  test.beforeEach(async ({ page, mockHub }) => {
    await mockHub;
  });

  test('displays sessions list or empty state', async ({ page }) => {
    await page.goto('/');
    const sessionsOrEmpty = page.getByText(/session|no sessions/i);
    await expect(sessionsOrEmpty.first()).toBeVisible();
  });
});