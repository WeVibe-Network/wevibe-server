import { test, expect } from './fixtures';

test.describe('Dashboard Navigation', () => {
  test.beforeEach(async ({ page, mockHub }) => {
    await mockHub;
  });

  test('sidebar renders all navigation links', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.locator('aside');
    await expect(sidebar.getByTestId('nav-sessions')).toBeVisible();
    await expect(sidebar.getByTestId('nav-members')).toBeVisible();
    await expect(sidebar.getByTestId('nav-moderation')).toBeVisible();
    await expect(sidebar.getByTestId('nav-reports')).toBeVisible();
    await expect(sidebar.getByTestId('nav-billing')).toBeVisible();
    await expect(sidebar.getByTestId('nav-settings')).toBeVisible();
    await expect(sidebar.getByTestId('nav-recovery')).toBeVisible();
    await expect(sidebar.getByTestId('nav-epoch')).toBeVisible();
  });

  test('each nav link navigates to correct page', async ({ page }) => {
    const pages = [
      { testId: 'nav-members', url: '/members', heading: /member/i },
      { testId: 'nav-moderation', url: '/moderation/new', heading: /moderation/i },
      { testId: 'nav-reports', url: '/moderation/reported', heading: /report/i },
      { testId: 'nav-billing', url: '/billing', heading: /billing|credit/i },
      { testId: 'nav-settings', url: '/settings', heading: /settings/i },
      { testId: 'nav-recovery', url: '/recovery', heading: /recovery/i },
      { testId: 'nav-epoch', url: '/epoch', heading: /epoch/i },
    ];

    for (const p of pages) {
      await page.goto('/');
      await page.getByTestId(p.testId).click();
      await expect(page).toHaveURL(new RegExp(p.url));
      await expect(page.locator('h1')).toContainText(p.heading);
    }
  });
});
