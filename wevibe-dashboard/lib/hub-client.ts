import { buildAuthHeaders, bytesToHex, deriveIdentityX25519Keypair, getIdentity, signWithIdentity } from './wevibe-auth';
import { linkWalletCanonical } from './wevibe-signing';
import type { OrgRole } from './org-role';
import type { MemberOrgEntry } from './org-context';
import { getConfig } from '@/lib/config';

function getHubUrl(): string {
  return getConfig().hubUrl;
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

export async function uploadIdentityBlob(blob: {
  credential_id: string;
  hkdf_salt: string;
  iv: string;
  ciphertext: string;
}): Promise<void> {
  await hubFetch<{ status?: string }>('/v1/identity/blob', {
    method: 'POST',
    body: JSON.stringify(blob),
  });
}

export async function uploadPairingBlob(blob: {
  pairing_id: string;
  hkdf_salt: string;
  iv: string;
  ciphertext: string;
}): Promise<void> {
  await hubFetch<{ status?: string }>('/v1/pair', {
    method: 'POST',
    body: JSON.stringify(blob),
  });
}

export async function fetchIdentityBlob(credentialId: string): Promise<{
  pubkey: string;
  hkdf_salt: string;
  iv: string;
  ciphertext: string;
} | null> {
  const resp = await fetch(`${getHubUrl()}/v1/identity/blob/${encodeURIComponent(credentialId)}`);

  if (resp.status === 404) {
    return null;
  }

  if (!resp.ok) {
    throw new Error(`Hub error ${resp.status}`);
  }

  return resp.json();
}

export async function fetchPairingBlob(pairingId: string): Promise<{
  hkdf_salt: string;
  iv: string;
  ciphertext: string;
} | null> {
  const resp = await fetch(`${getHubUrl()}/v1/pair/${encodeURIComponent(pairingId)}`);

  if (resp.status === 404) {
    return null;
  }

  if (!resp.ok) {
    throw new Error(`Hub error ${resp.status}`);
  }

  return resp.json();
}

export interface FaucetFundResponse {
  address: string;
  amount: number;
  status: string;
}

export interface BalanceResponse {
  address: string;
  denom: string;
  amount: string;
}

export async function fundFromFaucet(address: string, amount?: number): Promise<FaucetFundResponse> {
  return hubFetch<FaucetFundResponse>('/v1/faucet/fund', {
    method: 'POST',
    body: JSON.stringify(amount != null ? { address, amount } : { address }),
  });
}

export async function getBalance(address: string): Promise<BalanceResponse> {
  const resp = await fetch(`${getHubUrl()}/v1/balance/${encodeURIComponent(address)}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error ?? `Hub error ${resp.status}`);
  }
  return resp.json();
}

export async function listMembers(orgId: string) {
  const result = await hubFetch<MemberRecord[]>(`/v1/orgs/${orgId}/members`);
  return result ?? [];
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
  membership_active?: boolean;
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

export interface OrgChainConfig {
  org_id: string;
  serve_attestation_required: boolean;
  min_contributions_per_epoch: number;
  contest_stake_uvibe: number;
}

export async function getOrgChainConfig(orgId: string): Promise<OrgChainConfig> {
  return hubFetch<OrgChainConfig>(`/v1/orgs/${orgId}/chain-config`);
}

export interface ExtractionProfile {
  found: boolean;
  system_prompt: string;
  num_ctx: number;
  model: string;
  preset_id: string;
  updated_at: string;
}

export interface ExtractionPreset {
  id: string;
  label: string;
  goal: string;
  recommended: boolean;
  system_prompt: string;
}

export interface ExtractionPresetsResponse {
  presets: ExtractionPreset[];
  recommended_id: string;
  default_num_ctx: number;
  default_model: string;
}

export async function getExtractionProfile(orgId: string): Promise<ExtractionProfile> {
  return hubFetch<ExtractionProfile>(`/v1/orgs/${orgId}/extraction-profile`);
}

export async function updateExtractionProfile(
  orgId: string,
  profile: {
    system_prompt: string;
    num_ctx: number;
    model: string;
    preset_id: string;
  },
): Promise<ExtractionProfile> {
  return hubFetch<ExtractionProfile>(`/v1/orgs/${orgId}/extraction-profile`, {
    method: 'PUT',
    body: JSON.stringify(profile),
  });
}

export async function getExtractionPresets(): Promise<ExtractionPresetsResponse> {
  return hubFetch<ExtractionPresetsResponse>('/v1/extraction-presets');
}

// updateOrgChainConfig was removed in CO-011a.4. Category B chain config
// (serve_attestation_required, min_contributions_per_epoch, contest_stake_vibe)
// is now broadcast directly via the relay using MsgSetOrgConfig.

export interface OrgSummary {
  org_id: string;
  org_name: string;
  domain: string;
  leader_pubkey: string;
  leader_wallet_address?: string;
  hub_serving_address?: string;
  hub_serving_key_address?: string;
  hub_endpoints?: string[];
  hub_response_pubkey?: string;
  current_epoch: number;
  egress_mode: string;
  allowed_providers: string[];
  status: string;
  rotation_status: string;
  required_approvals: number;
  report_vote_threshold: number;
  moderation_required?: boolean;
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

export async function setModerationRequired(orgId: string, value: boolean): Promise<{ moderation_required: boolean }> {
  return hubFetch<{ moderation_required: boolean }>(`/v1/orgs/${orgId}/config`, {
    method: 'PATCH',
    body: JSON.stringify({ moderation_required: value }),
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
  const signature = await signWithIdentity(canonical);

  return hubFetch<LinkWalletResponse>(`/v1/orgs/${orgId}/members/wallet`, {
    method: 'POST',
    body: JSON.stringify({
      wallet_address: walletAddress,
      signed_by: identity.pubkeyHex,
      signature,
    }),
  });
}

// === CO-215 Task B additions ===

export interface CreateOrgRequest {
  leader_pubkey: string;
  leader_x25519_pubkey: string;
  leader_wallet: string;
  org_name: string;
  domain: string;
  fee_model?: Record<string, unknown> | null;
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

export interface HubServingAddressResponse {
  serving_address: string;
  response_pubkey?: string;
}

export interface RecordOrgRequest extends CreateOrgRequest {
  org_id: string;
  tx_hash: string;
  hub_serving_key: string;
}

async function fetchHubServingAddressResponse(): Promise<HubServingAddressResponse> {
  return hubFetch<HubServingAddressResponse>('/v1/hub/serving-address');
}

export async function getHubServingAddress(): Promise<string> {
  const response = await fetchHubServingAddressResponse();
  const servingAddress = response.serving_address?.trim();
  if (!servingAddress) {
    throw new Error('Hub serving address missing from /v1/hub/serving-address response');
  }
  return servingAddress;
}

export async function getHubResponsePubkey(): Promise<string> {
  const response = await fetchHubServingAddressResponse();
  return response.response_pubkey?.trim() ?? '';
}

export async function recordOrg(body: RecordOrgRequest): Promise<CreateOrgResponse> {
  return hubFetch<CreateOrgResponse>('/v1/orgs', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// === CO-215 Task C additions ===







// === CO-215 Task D additions ===

export interface KeywordRecord {
  keyword: string;
  created_at: string;
  deprecated: boolean;
  usage_count: number;
}

export async function listKeywords(orgId: string): Promise<KeywordRecord[]> {
  const result = await hubFetch<KeywordRecord[]>(`/v1/orgs/${orgId}/keywords`);
  return result ?? [];
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
  stack_hint?: string[] | null;
  matched_keywords?: string[];
  plaintext?: string | null;
  ciphertext_hex?: string | null;
  wrapped_dek_mod?: string | null;
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
  derivation?: 'verbatim' | 'edited-after-extraction' | null;
  mod_votes?: { approve: number; flag: number };
  keyword_votes?: Record<string, { include: number; exclude: number }>;
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

export async function voteSubmission(
  orgId: string,
  submissionHash: string,
  vote: 'approve' | 'flag',
): Promise<{ approve: number; flag: number }> {
  return hubFetch<{ approve: number; flag: number }>(
    `/v1/orgs/${orgId}/moderation/${encodeURIComponent(submissionHash)}/vote`,
    {
      method: 'POST',
      body: JSON.stringify({ vote }),
    },
  );
}

export async function voteKeyword(
  orgId: string,
  submissionHash: string,
  keyword: string,
  vote: 'include' | 'exclude',
): Promise<{ include: number; exclude: number }> {
  return hubFetch<{ include: number; exclude: number }>(
    `/v1/orgs/${orgId}/submissions/${encodeURIComponent(submissionHash)}/keyword-vote`,
    {
      method: 'POST',
      body: JSON.stringify({ keyword, vote }),
    },
  );
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

export async function updateKeywords(
  orgId: string,
  hash: string,
  classified: KeywordWeight[],
  suggestions?: KeywordWeight[],
): Promise<{ status: string }> {
  const payload: { hash: string; classified: KeywordWeight[]; suggestions?: KeywordWeight[] } = {
    hash,
    classified,
  };
  if (suggestions) {
    payload.suggestions = suggestions;
  }

  return hubFetch<{ status: string }>(`/v1/orgs/${orgId}/update-keywords`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function removeSubmission(orgId: string, hash: string): Promise<{ status: string }> {
  return hubFetch<{ status: string }>(`/v1/orgs/${orgId}/remove-submission`, {
    method: 'DELETE',
    body: JSON.stringify({ hash }),
  });
}

export async function denySubmission(orgId: string, submissionHash: string): Promise<{ status: string }> {
  return hubFetch<{ status: string }>(`/v1/orgs/${orgId}/moderation/${encodeURIComponent(submissionHash)}/deny`, {
    method: 'POST',
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
  route: string;
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
  const resp = await hubFetch<ListNotificationsResponse>(`/v1/notifications${query ? `?${query}` : ''}`);
  return { ...resp, notifications: resp.notifications ?? [] };
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
  domain: string;
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
  const resp = await hubFetch<DiscoverResponse>(`/v1/orgs/discover${query ? `?${query}` : ''}`);
  return { ...resp, orgs: resp.orgs ?? [] };
}

export interface JoinRequest {
  request_id: string;
  requester_pubkey: string;
  x25519_pubkey: string;
  status: 'pending' | 'confirming' | 'approved' | 'denied';
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
  const x25519 = await deriveIdentityX25519Keypair();
  const x25519Hex = bytesToHex(x25519.pub);
  return hubFetch<SubmitJoinRequestResponse>(`/v1/orgs/${orgId}/join`, {
    method: 'POST',
    body: JSON.stringify({
      requester_pubkey: identity.pubkeyHex,
      pre_pubkey: prePubkey,
      x25519_pubkey: x25519Hex,
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

export async function cancelJoinApproval(orgId: string, requestId: string): Promise<void> {
  const identity = await getIdentity();
  if (!identity) {
    throw new Error('No identity');
  }
  await hubFetch<{ status: string }>(`/v1/orgs/${orgId}/join-requests/${requestId}/cancel-approval`, {
    method: 'POST',
    body: JSON.stringify({
      signed_by: identity.pubkeyHex,
    }),
  });
}

export async function enableMemberRecall(orgId: string, pubkey: string): Promise<void> {
  const identity = await getIdentity();
  if (!identity) {
    throw new Error('No identity');
  }

  const authHeaders = await buildAuthHeaders();
  const response = await fetch(
    `${getHubUrl()}/v1/orgs/${orgId}/members/${encodeURIComponent(pubkey)}/enable-recall`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        signed_by: identity.pubkeyHex,
      }),
    },
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    const error = new Error(err.error ?? `Hub error ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
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
