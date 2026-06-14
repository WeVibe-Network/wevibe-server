import { test, expect } from './fixtures';

test.describe('Moderation Page', () => {
  test.beforeEach(async ({ page, mockHub }) => {
    await mockHub;
  });

  test('displays moderation queue or empty state', async ({ page }) => {
    await page.goto('/moderation/new');
    const queueOrEmpty = page.getByText(/moderation|queue|pending|no submissions/i);
    await expect(queueOrEmpty.first()).toBeVisible();
  });
});
