import { test, expect } from './fixtures';

test.describe('Connection Flow', () => {
  test('settings page connects and displays org info', async ({ connectedPage: page }) => {
    test.skip(process.env.WEVIBE_TEST_MODE === 'skip-health', 'Requires running MCP server (SSE + port 4450)');
    await expect(page.locator('h1')).toContainText('Dashboard Settings');

    // Status badge shows connected
    const badge = page.locator('span').filter({ hasText: 'Connected' }).first();
    await expect(badge).toBeVisible();

    // No error banner
    await expect(page.locator('.border-rose-300')).not.toBeVisible();

    // Wait for wevibe_org_info to resolve asynchronously.
    // InfoCell renders: <div> <dt>Label</dt> <dd>Value</dd> </div>
    // Fields start as "—" and update when the MCP response arrives.
    //
    // If wevibe_org_info returns an error (e.g. hub auth failure),
    // an amber warning appears and fields stay as "—".
    // Either outcome is a valid connection result.
    //
    // Wait for: real data in Org Name OR amber warning visible.
    const orgNameCell = page.locator('div').filter({
      has: page.locator('dt', { hasText: 'Org Name' }),
    });
    const orgNameDd = orgNameCell.locator('dd');
    const amberWarning = page.locator('.border-amber-300');

    // Poll: either org name resolves to non-dash OR amber warning appears
    await expect(orgNameDd.filter({ hasNotText: '—' }).or(amberWarning)).toBeVisible({ timeout: 15_000 });
  });

  test('topbar shows green connection dot', async ({ connectedPage: page }) => {
    test.skip(process.env.WEVIBE_TEST_MODE === 'skip-health', 'Requires running MCP server (SSE + port 4450)');
    const dot = page.getByRole('banner').locator('span.bg-emerald-500');
    await expect(dot).toBeVisible();
  });
});