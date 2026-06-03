import { buildAuthHeaders, getIdentity, signEd25519WithSeed } from './wevibe-auth';
import { linkWalletCanonical, registerDelegateKeyCanonical, transferLeadershipCanonical, closeOrgCanonical } from './wevibe-signing';
import type { OrgRole } from './org-role';
import type { MemberOrgEntry } from './org-context';

let _hubUrl: string | null = null;
function getHubUrl(): string {
  if (_hubUrl) return _hubUrl;
  if (typeof window === 'undefined') {
    _hubUrl = process.env.WEVIBE_HUB_URL ?? 'http://localhost:4440';
  } else {
    _hubUrl = `${window.location.protocol}//${window.location.hostname}:4440`;
  }
  return _hubUrl;
}

async function hubFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const authHeaders = await buildAuthHeaders();
  const resp = await fetch(`${getHubUrl()}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders, ...init?.headers },
    ...init,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error ?? `Hub error ${resp.status}`);
  }
  return resp.json();
}

export async function listMembers(orgId: string) {
  return hubFetch<MemberRecord[]>(`/v1/orgs/${orgId}/members`);
}

export async function getMemberOrgs(pubkey: string): Promise<MemberOrgEntry[]> {
  const res = await hubFetch<{ orgs: MemberOrgEntry[] }>(`/v1/members/${pubkey}/orgs`);
  return res.orgs;
}

export interface MemberRecord {
  org_id: string;
  pubkey: string;
  display_name?: string;
  role: OrgRole;
  join_epoch: number;
  active: boolean;
  joined_at: string;
  wallet_address?: string;
  dismissed_reports_count?: number;
}

export interface Transaction {
  txn_id: number;
  org_id: string;
  delta: number;
  reason: string;
  receipt_id: string | null;
  actor: string;
  created_at: string;
}

export interface CreditBalance {
  org_id: string;
  balance: number;
  transactions: Transaction[];
}

export interface TopUpRequest {
  org_id: string;
  amount: number;
  signed_by: string;
}

export interface TopUpResponse {
  org_id: string;
  balance: number;
}

export interface OrgFinances {
  org_id: string;
  hub_credits: number;
  chain_treasury: number;
}

export async function getOrgCredits(orgId: string): Promise<CreditBalance> {
  return hubFetch<CreditBalance>(`/v1/orgs/${orgId}/credits`);
}

export async function topUpCredits(body: TopUpRequest): Promise<TopUpResponse> {
  return hubFetch<TopUpResponse>('/v1/billing/topup', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getOrgFinances(orgId: string): Promise<OrgFinances> {
  return hubFetch<OrgFinances>(`/v1/orgs/${orgId}/finances`);
}

export interface RepTier {
  min_reputation: number;
  max_reputation: number;
  max_contributions_per_epoch: number;
  payout_per_memory: string;
}

export interface OrgChainConfig {
  org_id: string;
  serve_attestation_required: boolean;
  min_contributions_per_epoch: number;
  contest_stake_uvibe: number;
  rep_tiers: RepTier[];
}

export async function getOrgChainConfig(orgId: string): Promise<OrgChainConfig> {
  return hubFetch<OrgChainConfig>(`/v1/orgs/${orgId}/chain-config`);
}

// updateOrgChainConfig was removed in CO-011a.4. Category B chain config
// (serve_attestation_required, min_contributions_per_epoch, contest_stake_vibe,
// rep_tiers) is now broadcast directly via the relay using MsgSetOrgConfig /
// MsgSetRepTiers. See lib/relay-client.ts.

export interface OrgSummary {
  org_id: string;
  org_name: string;
  leader_pubkey: string;
  current_epoch: number;
  egress_mode: string;
  allowed_providers: string[];
  status: string;
  rotation_status: string;
  required_approvals: number;
  report_vote_threshold: number;
  created_at: string;
}

export async function getOrg(orgId: string): Promise<OrgSummary> {
  return hubFetch<OrgSummary>(`/v1/orgs/${orgId}`);
}

export async function updateOrgConfig(orgId: string, payload: { required_approvals?: number; report_vote_threshold?: number; wallet_pubkey?: Uint8Array; wallet_signature?: Uint8Array }): Promise<{ required_approvals: number; report_vote_threshold?: number }> {
  const body: Record<string, unknown> = { ...payload };
  if (payload.wallet_pubkey) {
    body.wallet_pubkey = Array.from(payload.wallet_pubkey);
  }
  if (payload.wallet_signature) {
    body.wallet_signature = Array.from(payload.wallet_signature);
  }
  return hubFetch<{ required_approvals: number; report_vote_threshold?: number }>(`/v1/orgs/${orgId}/config`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}



export interface EscalationVote {
  pubkey: string;
  voted_at: string;
}

export interface Report {
  id: string;
  org_id: string;
  memory_cid: string;
  reporter_pubkey: string;
  reporter_wallet?: string | null;
  reporter_role: string;
  reason: string;
  note?: string | null;
  status: string;
  resolution?: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
  escalation_votes: EscalationVote[];
  vote_count: number;
  report_vote_threshold: number;
  reporter_dismissed_count: number;
  created_at: string;
  updated_at: string;
}

export interface ReportsListResponse {
  reports: Report[];
  total: number;
  limit?: number;
  offset?: number;
}

export async function listReports(
  orgId: string,
  status?: string,
  limit?: number,
  offset?: number,
): Promise<ReportsListResponse> {
  const params = new URLSearchParams();
  if (status) {
    params.set('status', status);
  }
  if (typeof limit === 'number') {
    params.set('limit', String(limit));
  }
  if (typeof offset === 'number' && offset > 0) {
    params.set('offset', String(offset));
  }
  const query = params.toString();
  return hubFetch<ReportsListResponse>(
    `/v1/orgs/${orgId}/reports${query ? `?${query}` : ''}`,
  );
}

export async function getReport(orgId: string, reportId: string): Promise<Report> {
  return hubFetch<Report>(`/v1/orgs/${orgId}/reports/${reportId}`);
}

export type ReportAction = 'uphold' | 'dismiss' | 'dismiss_malicious';

export async function updateReport(
  orgId: string,
  reportId: string,
  action: ReportAction,
): Promise<Report> {
  return hubFetch<Report>(`/v1/orgs/${orgId}/reports/${reportId}`, {
    method: 'PATCH',
    body: JSON.stringify({ vote: action }),
  });
}

export interface LinkWalletResponse {
  status: string;
  wallet_address: string;
  pubkey: string;
}

export async function linkWallet(orgId: string, walletAddress: string): Promise<LinkWalletResponse> {
  const identity = await getIdentity();
  if (!identity) {
    throw new Error('No dashboard identity');
  }

  const canonical = await linkWalletCanonical(orgId, walletAddress, identity.pubkeyHex);
  const signature = await signEd25519WithSeed(identity.seedHex, canonical);

  return hubFetch<LinkWalletResponse>(`/v1/orgs/${orgId}/members/wallet`, {
    method: 'POST',
    body: JSON.stringify({
      wallet_address: walletAddress,
      signed_by: identity.pubkeyHex,
      signature,
    }),
  });
}

export async function registerDelegateKey(
  orgId: string,
  walletAddress: string,
  delegateAddress: string,
  grantTxHash: string,
): Promise<{ status: string }> {
  const identity = await getIdentity();
  if (!identity) {
    throw new Error('No dashboard identity');
  }

  const canonical = await registerDelegateKeyCanonical(orgId, walletAddress, delegateAddress, identity.pubkeyHex);
  const signature = await signEd25519WithSeed(identity.seedHex, canonical);

  return hubFetch<{ status: string }>(`/v1/orgs/${orgId}/members/delegate-key`, {
    method: 'POST',
    body: JSON.stringify({
      wallet_address: walletAddress,
      delegate_address: delegateAddress,
      delegate_pubkey: identity.pubkeyHex,
      grant_tx_hash: grantTxHash,
      signed_by: identity.pubkeyHex,
      signature,
    }),
  });
}

// === CO-215 Task B additions ===

export interface CreateOrgRequest {
  org_id: string;
  leader_pubkey: string;
  leader_x25519_pubkey: string;
  leader_wallet: string;
  org_name: string;
  domain: string;
  enc_envelope: string;
  search_envelope: string;
  mod_envelope: string;
  pk_mod: string;
  signature: string;
}

export interface CreateOrgResponse extends OrgSummary {
  hub_serving_key_address: string;
  epoch_sk?: string;
  epoch_pk?: string;
}

export async function createOrg(body: CreateOrgRequest): Promise<CreateOrgResponse> {
  return hubFetch<CreateOrgResponse>('/v1/orgs', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// === CO-215 Task C additions ===







export async function transferLeadership(orgId: string, newLeaderPubkey: string): Promise<void> {
  const identity = await getIdentity();
  if (!identity) {
    throw new Error('No dashboard identity');
  }

  const canonical = await transferLeadershipCanonical(orgId, newLeaderPubkey, identity.pubkeyHex);
  const signature = await signEd25519WithSeed(identity.seedHex, canonical);

  await hubFetch<{ status: string }>(`/v1/orgs/${orgId}/transfer-leadership`, {
    method: 'POST',
    body: JSON.stringify({
      new_leader_pubkey: newLeaderPubkey,
      signed_by: identity.pubkeyHex,
      signature,
    }),
  });
}

export async function closeOrg(orgId: string): Promise<void> {
  const identity = await getIdentity();
  if (!identity) {
    throw new Error('No dashboard identity');
  }

  const canonical = await closeOrgCanonical(orgId, identity.pubkeyHex);
  const signature = await signEd25519WithSeed(identity.seedHex, canonical);

  await hubFetch<{ status: string }>(`/v1/orgs/${orgId}/close`, {
    method: 'POST',
    body: JSON.stringify({
      signed_by: identity.pubkeyHex,
      signature,
    }),
  });
}

// === CO-215 Task D additions ===

export interface KeywordRecord {
  keyword: string;
  created_at: string;
  deprecated: boolean;
  usage_count: number;
}

export async function listKeywords(orgId: string): Promise<KeywordRecord[]> {
  return hubFetch<KeywordRecord[]>(`/v1/orgs/${orgId}/keywords`);
}

export async function addKeyword(orgId: string, keyword: string): Promise<{ status: string; keyword: string }> {
  return hubFetch<{ status: string; keyword: string }>(`/v1/orgs/${orgId}/keywords`, {
    method: 'POST',
    body: JSON.stringify({ keyword }),
  });
}

export async function mergeKeywords(orgId: string, source: string, target: string): Promise<{ status: string; source: string; target: string }> {
  return hubFetch<{ status: string; source: string; target: string }>(`/v1/orgs/${orgId}/keywords/merge`, {
    method: 'PUT',
    body: JSON.stringify({ source, target }),
  });
}

export async function renameKeyword(orgId: string, oldName: string, newName: string): Promise<{ status: string; old_name: string; new_name: string }> {
  return hubFetch<{ status: string; old_name: string; new_name: string }>(`/v1/orgs/${orgId}/keywords/${encodeURIComponent(oldName)}/rename`, {
    method: 'PUT',
    body: JSON.stringify({ new_name: newName }),
  });
}

export async function deprecateKeyword(orgId: string, keyword: string): Promise<{ status: string; keyword: string }> {
  return hubFetch<{ status: string; keyword: string }>(`/v1/orgs/${orgId}/keywords/${encodeURIComponent(keyword)}`, {
    method: 'DELETE',
  });
}

export interface RecoveryShareEntry {
  share_index: number;
  holder_pubkey: string;
  sealed_share: string;
}

export interface RecoveryShare {
  org_id: string;
  share_index: number;
  sealed_share: string;
}

export async function storeRecoveryShares(orgId: string, shares: RecoveryShareEntry[]): Promise<{ status: string }> {
  const identity = await getIdentity();
  if (!identity) {
    throw new Error('No dashboard identity');
  }
  return hubFetch<{ status: string }>(`/v1/orgs/${orgId}/recovery/shares`, {
    method: 'POST',
    body: JSON.stringify({ shares }),
  });
}

export async function getRecoveryShare(orgId: string): Promise<RecoveryShare | null> {
  try {
    return await hubFetch<RecoveryShare>(`/v1/orgs/${orgId}/recovery/shares`);
  } catch {
    return null;
  }
}

export interface EpochManifest {
  org_id: string;
  epoch_id: number;
  pk_mod: string;
  signed_by: string;
  signature: string;
  created_at: string;
}

export async function getEpochManifest(orgId: string, epochId: string): Promise<EpochManifest> {
  return hubFetch<EpochManifest>(`/v1/orgs/${orgId}/epoch/${epochId}/manifest`);
}

export async function rotateEpoch(orgId: string): Promise<{ status: string; buffered_moved: number }> {
  return hubFetch<{ status: string; buffered_moved: number }>(`/v1/orgs/${orgId}/epoch/rotate`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// === CO-238 Task F: Batch Keyword Extraction Pipeline ===

export type MemoryType = 'memory';

export type SubmissionStatus =
  | 'pending_moderation'
  | 'pending_keyword'
  | 'pending_chain'
  | 'on_chain'
  | 'rejected';

export interface KeywordWeight {
  keyword: string;
  weight: number;
}

export interface MemoryKeywordResult {
  submission_hash: string;
  classified: KeywordWeight[];
  extraction_feedback?: string;
}

export interface Submission {
  submission_hash: string;
  org_id: string;
  contributor_pubkey: string;
  epoch_id: number;
  memory_type: MemoryType;
  status: SubmissionStatus;
  matched_keywords?: string[];
  plaintext?: string | null;
  memory_cid?: string | null;
  encrypted_envelope?: string | null;
  extraction_result?: KeywordWeight[] | null;
  extraction_feedback?: string | null;
  moderation_approved_by?: string | null;
  moderation_approved_at?: string | null;
  verified_by?: string | null;
  verified_at?: string | null;
  chain_tx_hash?: string | null;
  created_at: string;
  updated_at: string;
  sanitization_findings?: SanitizationFinding[] | null;
  preference_confidence?: number;
}

export interface SanitizationFinding {
  category: string;
  description: string;
  position: number;
  codepoint: string;
  severity: 'warning' | 'critical';
}

export interface VerificationResult {
  submission_hash: string;
  passed: boolean;
  error?: string;
}

export interface OrgHealth {
  org_id: string;
  pending_keyword_count: number;
  pending_chain_count: number;
  last_keyword_extraction?: string | null;
  last_chain_submission?: string | null;
  updated_at: string;
}

export async function getSubmissionsByStatus(orgId: string, status: string): Promise<Submission[]> {
  const response = await hubFetch<Submission[] | { submissions?: Submission[] }>(
    `/v1/orgs/${orgId}/submissions?status=${encodeURIComponent(status)}`,
  );
  if (Array.isArray(response)) {
    return response;
  }
  return response.submissions ?? [];
}

export async function submitKeywordResults(orgId: string, memories: MemoryKeywordResult[]): Promise<{ status: string; processed_count: number }> {
  return hubFetch<{ status: string; processed_count: number }>(`/v1/orgs/${orgId}/submit-keyword-results`, {
    method: 'POST',
    body: JSON.stringify({ memories }),
  });
}

export async function verifyKeywords(orgId: string, hashes: string[]): Promise<VerificationResult[]> {
  return hubFetch<VerificationResult[]>(`/v1/orgs/${orgId}/verify-keywords`, {
    method: 'POST',
    body: JSON.stringify({ hashes }),
  });
}

export async function rerunKeywords(orgId: string, hash: string, feedback: string): Promise<{ status: string }> {
  return hubFetch<{ status: string }>(`/v1/orgs/${orgId}/rerun-keywords`, {
    method: 'POST',
    body: JSON.stringify({ hash, feedback }),
  });
}

export async function updateKeywords(orgId: string, hash: string, classified: KeywordWeight[]): Promise<{ status: string }> {
  return hubFetch<{ status: string }>(`/v1/orgs/${orgId}/update-keywords`, {
    method: 'PUT',
    body: JSON.stringify({ hash, classified }),
  });
}

export async function removeSubmission(orgId: string, hash: string): Promise<{ status: string }> {
  return hubFetch<{ status: string }>(`/v1/orgs/${orgId}/remove-submission`, {
    method: 'DELETE',
    body: JSON.stringify({ hash }),
  });
}



export async function getOrgHealth(orgId: string): Promise<OrgHealth> {
  return hubFetch<OrgHealth>(`/v1/orgs/${orgId}/health`);
}

export interface PreparedBatchMemory {
  submission_hash: string;
  contributor_pubkey: string;
  contributor_wallet: string;
  committing_leader: string;
  keywords: string[];
  memory_type: MemoryType;
  plaintext_hash: string;
  salt: string;
  ciphertext_hash: string;
  contributor_sig: string;
  encrypted_blob: string;
  wrapped_dek_enc: string;
}

export interface PreparedBatchSubmitResponse {
  batch: PreparedBatchMemory[];
  verification: 'passed';
}

export async function prepareBatchSubmit(orgId: string): Promise<PreparedBatchSubmitResponse> {
  return hubFetch<PreparedBatchSubmitResponse>(`/v1/orgs/${orgId}/moderation/batch-submit`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export interface ProfileChainStats {
  total_approved_memories: number;
  total_serves: number;
  first_seen_epoch: number;
  reputation_tier: string | null;
}

export interface ProfileModeratorStats {
  total_approvals: number;
  total_upheld_reports: number;
}

export interface ProfileLeaderStats {
  total_chain_commits: number;
  total_epoch_rotations: number;
}

export interface ProfileMembership {
  org_id: string;
  org_name: string;
  role: OrgRole;
  joined_at: string;
}

export interface ProfileResponse {
  wallet: string;
  display_name?: string;
  pubkey: string | null;
  memberships: ProfileMembership[];
  chain_stats: ProfileChainStats | null;
  moderator_stats: ProfileModeratorStats | null;
  leader_stats: ProfileLeaderStats | null;
}

export async function getProfile(wallet: string): Promise<ProfileResponse> {
  return hubFetch<ProfileResponse>(`/v1/profile/${wallet}`);
}

// === CO-248: Activity Feed ===

export interface Notification {
  id: number;
  category: string;
  title: string;
  body: string;
  event_ref: string;
  org_id: string;
  org_name: string;
  read: boolean;
  created_at: string;
}

export interface ListNotificationsResponse {
  notifications: Notification[];
  has_more: boolean;
}

export interface NotificationPreferences {
  email_address: string;
  email_enabled: boolean;
  email_categories: string[];
  webhook_url: string;
  webhook_enabled: boolean;
  webhook_categories: string[];
  supported_categories: string[];
  test_sent?: boolean;
}

export interface UpdateNotificationPreferencesRequest {
  email_address?: string;
  email_enabled?: boolean;
  email_categories?: string[];
  webhook_url?: string;
  webhook_enabled?: boolean;
  webhook_categories?: string[];
  send_test?: boolean;
}

export async function listNotifications(params?: {
  limit?: number;
  before?: number;
  unread_only?: boolean;
}): Promise<ListNotificationsResponse> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.before) searchParams.set('before', String(params.before));
  if (params?.unread_only) searchParams.set('unread_only', 'true');
  const query = searchParams.toString();
  return hubFetch<ListNotificationsResponse>(`/v1/notifications${query ? `?${query}` : ''}`);
}

export async function getUnreadCount(): Promise<{ count: number }> {
  return hubFetch<{ count: number }>('/v1/notifications/unread-count');
}

export async function markNotificationsRead(ids: number[]): Promise<{ marked: number }> {
  return hubFetch<{ marked: number }>('/v1/notifications/mark-read', {
    method: 'POST',
    body: JSON.stringify({ notification_ids: ids }),
  });
}

export async function markAllNotificationsRead(): Promise<{ marked: number }> {
  return hubFetch<{ marked: number }>('/v1/notifications/mark-read', {
    method: 'POST',
    body: JSON.stringify({ all: true }),
  });
}

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  return hubFetch<NotificationPreferences>('/v1/profile/notifications');
}

export async function updateNotificationPreferences(
  payload: UpdateNotificationPreferencesRequest,
): Promise<NotificationPreferences> {
  return hubFetch<NotificationPreferences>('/v1/profile/notifications', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

// === CO-249: Org Discovery & Join ===

export interface DiscoverOrg {
  org_id: string;
  org_name: string;
  leader_pubkey: string;
  member_count: number;
  created_at: string;
  current_epoch: number;
  last_activity_at: string | null;
}

export interface DiscoverResponse {
  orgs: DiscoverOrg[];
  total: number;
  has_more: boolean;
}

export async function discoverOrgs(params?: {
  limit?: number;
  offset?: number;
  search?: string;
}): Promise<DiscoverResponse> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.offset) searchParams.set('offset', String(params.offset));
  if (params?.search) searchParams.set('search', params.search);
  const query = searchParams.toString();
  return hubFetch<DiscoverResponse>(`/v1/orgs/discover${query ? `?${query}` : ''}`);
}

export interface JoinRequest {
  request_id: string;
  requester_pubkey: string;
  status: 'pending' | 'approved' | 'denied';
  requested_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  denial_reason: string | null;
  cooldown_until: string | null;
}

export interface SubmitJoinRequestResponse {
  request_id: string;
  status: string;
  requested_at: string;
}

export async function submitJoinRequest(orgId: string, prePubkey?: string): Promise<SubmitJoinRequestResponse> {
  const identity = await getIdentity();
  if (!identity) {
    throw new Error('No identity');
  }
  return hubFetch<SubmitJoinRequestResponse>(`/v1/orgs/${orgId}/join`, {
    method: 'POST',
    body: JSON.stringify({
      requester_pubkey: identity.pubkeyHex,
      pre_pubkey: prePubkey,
    }),
  });
}

export interface ListJoinRequestsResponse {
  requests: JoinRequest[];
}

export async function listJoinRequests(orgId: string, status?: string): Promise<ListJoinRequestsResponse> {
  const query = status ? `?status=${status}` : '';
  return hubFetch<ListJoinRequestsResponse>(`/v1/orgs/${orgId}/join-requests${query}`);
}

export async function approveJoinRequest(orgId: string, requestId: string, trial = false): Promise<void> {
  const identity = await getIdentity();
  if (!identity) {
    throw new Error('No identity');
  }
  await hubFetch<{ status: string }>(`/v1/orgs/${orgId}/join-requests/${requestId}/approve`, {
    method: 'POST',
    body: JSON.stringify({
      signed_by: identity.pubkeyHex,
      trial,
    }),
  });
}

export async function denyJoinRequest(orgId: string, requestId: string, reason?: string): Promise<void> {
  const identity = await getIdentity();
  if (!identity) {
    throw new Error('No identity');
  }
  await hubFetch<{ status: string }>(`/v1/orgs/${orgId}/join-requests/${requestId}/deny`, {
    method: 'POST',
    body: JSON.stringify({
      reason: reason || '',
      signed_by: identity.pubkeyHex,
    }),
  });
}

export interface MySubmission {
  submission_hash: string;
  org_id: string;
  epoch_id: number;
  contributor_pubkey: string;
  status: string;
  memory_type: string;
  extraction_result?: KeywordWeight[] | null;
  extraction_feedback?: string | null;
  moderator_pubkey?: string | null;
  approved_at?: string | null;
  verified_at?: string | null;
  denial_reason?: string | null;
  updated_at?: string;
  created_at: string;
}

export interface MySubmissionsResponse {
  submissions: MySubmission[];
  total: number;
}

export async function getMySubmissions(orgId: string): Promise<MySubmissionsResponse> {
  return hubFetch<MySubmissionsResponse>(`/v1/orgs/${orgId}/my-submissions`);
}
