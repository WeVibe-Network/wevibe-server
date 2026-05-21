import { test, expect } from './fixtures';

test.describe('Author Memory', () => {
  test('publish a memory and verify notice appears', async ({ connectedPage: page }) => {
    test.skip(process.env.WEVIBE_TEST_MODE === 'skip-health', 'Requires running MCP server for wevibe_author_memory tool');
    const uniqueId = Date.now().toString(36);
    const content = `E2E test memory — playwright run ${uniqueId}. Verifies author pipeline.`;
    const tags = `e2e,playwright,${uniqueId}`;

    // Navigate to memories page via sidebar
    await page.locator('aside').getByText('Memories', { exact: true }).click();
    await expect(page.locator('h1')).toContainText('Memory Browser');

    // Verify connected
    await expect(page.locator('text=No MCP session detected')).not.toBeVisible();

    // Fill author form
    await page.fill('#memory-content', content);
    await page.fill('#memory-tags', tags);

    // Submit
    await page.click('button:has-text("Publish Memory")');

    // Confirm MCP call dispatched
    await expect(page.locator('button:has-text("Publishing…")')).toBeVisible({ timeout: 5_000 });

    // Wait for EITHER success or error notice.
    // Pipeline: encrypt → submit → queue → approve (Ollama + embedding) → sign → POST
    // Success: .border-emerald-200 ("Authored memory ...")
    // Error:   .border-rose-200 (pipeline error message)
    const successNotice = page.locator('.border-emerald-200');
    const errorNotice = page.locator('.border-rose-200');
    await expect(successNotice.or(errorNotice)).toBeVisible({ timeout: 90_000 });

    // If error, fail with actual error text
    if (await errorNotice.isVisible()) {
      const errorText = await errorNotice.textContent();
      throw new Error(`wevibe_author_memory pipeline failed: ${errorText}`);
    }

    // Verify success notice
    await expect(successNotice).toContainText('Authored memory');

    // Verify form cleared
    await expect(page.locator('#memory-content')).toHaveValue('');
    await expect(page.locator('#memory-tags')).toHaveValue('');

    // NOTE: We do NOT verify the memory appears in the list here.
    // The hub binary is stale (predates CO-117) and returns 404 for
    // /v1/orgs/{orgID}/memories, causing wevibe_list_memories to return
    // an empty list. A separate CO will rebuild the hub and add a
    // "verify memory in list" test.
  });
});