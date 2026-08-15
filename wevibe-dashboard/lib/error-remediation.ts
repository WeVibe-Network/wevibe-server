import { MCP_OFFLINE_REMEDIATION } from './mcp-errors';

export const REMEDIATION: Record<string, string> = {
  mcp_offline: MCP_OFFLINE_REMEDIATION,
  recall_not_provisioned: 'Recall keys are not provisioned for this org yet. Enabling recall / committing will provision them; if this persists, re-run provisioning from the Members tab.',
  kfrag_store_failed: 'The recall key sidecar rejected the kfrag. Check the umbral sidecar is healthy and retry provisioning.',
  query_failed: 'The recall query failed server-side. See detail for the underlying cause.',
};

export function remediationFor(code?: string): string | undefined {
  return code ? REMEDIATION[code] : undefined;
}
