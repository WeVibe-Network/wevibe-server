/**
 * Playwright global setup — verifies the WeVibe stack is running
 * before any test executes.
 *
 * Requires: wevibe-meta/start.sh (or manual service startup)
 *   - Hub:              http://localhost:4440
 *   - Dashboard server: http://localhost:4450
 *   - Dashboard UI:     http://localhost:3000
 *
 * Skips health checks when WEVIBE_TEST_MODE=skip-health to allow
 * running tests with mocked APIs.
 */

const SERVICES = [
  { name: 'wevibe-hub',             url: 'http://localhost:4440/health' },
  { name: 'wevibe-dashboard-server', url: 'http://localhost:4450/health' },
  { name: 'wevibe-dashboard-ui',    url: 'http://localhost:3000' },
] as const;

async function checkService(name: string, url: string): Promise<void> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      throw new Error(`${name} returned HTTP ${response.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.WEVIBE_TEST_MODE === 'skip-health') {
      console.warn(`WARNING: ${name} not reachable (${url}): ${message}`);
      console.warn('  Running with mocked APIs — set WEVIBE_TEST_MODE= to enable real services');
      return;
    }
    throw new Error(
      `\n\n` +
      `  ╔══════════════════════════════════════════════════════════╗\n` +
      `  ║  PRE-FLIGHT FAILED: ${name.padEnd(36)}║\n` +
      `  ║  URL: ${url.padEnd(50)}║\n` +
      `  ║  Error: ${message.slice(0, 48).padEnd(48)}║\n` +
      `  ║                                                        ║\n` +
      `  ║  Run: bash ~/Desktop/wevibe-workspace/wevibe-meta/start.sh                ║\n` +
      `  ║  Or: WEVIBE_TEST_MODE=skip-health to run with mocks      ║\n` +
      `  ╚══════════════════════════════════════════════════════════╝\n`
    );
  }
}

export default async function globalSetup(): Promise<void> {
  for (const service of SERVICES) {
    await checkService(service.name, service.url);
  }
}