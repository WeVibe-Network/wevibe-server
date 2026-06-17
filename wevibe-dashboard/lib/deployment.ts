import { loadSettings } from '@/lib/settings';

export type DeploymentMode = 'local' | 'server';

/**
 * Resolution order: WEVIBE_DEPLOYMENT env → dashboard.json `deployment` → 'local'.
 * 'local'  = dashboard server runs on the leader's machine; org crypto uses the
 *            local MCP (127.0.0.1:4450) + local token file. Org keys stay local.
 * 'server' = containerized/VPS dashboard; its server cannot reach the leader's
 *            local MCP, so org-crypto routes decline (see ORG_LOCAL_ONLY_*).
 */
export function getDeploymentMode(): DeploymentMode {
  const fromEnv = process.env.WEVIBE_DEPLOYMENT?.trim().toLowerCase();
  if (fromEnv === 'local' || fromEnv === 'server') {
    return fromEnv;
  }
  return loadSettings().deployment === 'server' ? 'server' : 'local';
}
