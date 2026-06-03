import { getConfig } from './config';

export interface ContributorStats {
  pubkey: string;
  display_name?: string;
  contributions: number;
  serves: number;
  self_serves: number;
  reputation_xp: number;
  serve_xp: number;
  org_breadth: number;
  first_seen_epoch: number;
}

export async function getContributorStats(pubkey: string): Promise<ContributorStats> {
  const base = getConfig().socialGraphUrl;
  const resp = await fetch(`${base}/v1/stats/contributor/${encodeURIComponent(pubkey)}`);
  if (!resp.ok) {
    throw new Error(`social-graph stats failed: ${resp.status}`);
  }
  return resp.json();
}
