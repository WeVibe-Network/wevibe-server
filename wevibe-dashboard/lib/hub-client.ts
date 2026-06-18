import { buildAuthHeaders, bytesToHex, deriveIdentityX25519Keypair, getIdentity, signWithIdentity } from './wevibe-auth';
import { banContributorCanonical, denySubmissionCanonical, linkWalletCanonical } from './wevibe-signing';
import type { OrgRole } from './org-role';
import type { MemberOrgEntry } from './org-context';
import { getConfig } from '@/lib/config';
import { HubError } from './hub-error';

function getHubUrl(): string {
  return getConfig().hubUrl;
}

export async function getHubInstanceId(): Promise<string | null> {
  try {
    const response = await fetch(new URL('/health', getHubUrl()).toString());
    if (!response.ok) {
      return null;
    }

    const payload = await response.json().catch(() => null) as { instanceId?: unknown } | null;
    if (!payload || typeof payload.instanceId !== 'string') {
      return null;
    }

    const instanceId = payload.instanceId.trim();
    return instanceId.length > 0 ? instanceId : null;
  } catch {
    return null;
  }
}

async function hubFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const authHeaders = await buildAuthHeaders();
  const resp = await fetch(`${getHubUrl()}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders, ...init?.headers },
    ...init,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText })) as {
      error?: string;
      code?: string;
      detail?: string;
    };
    throw new HubError(err.error ?? `Hub error ${resp.status}`, {
      code: err.code,
      detail: err.detail,
      status: resp.status,
    });
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
  can_contribute?: boolean;
  can_moderate?: boolean;
  join_epoch: number;
  active: boolean;
  membership_active?: boolean;
  is_trial?: boolean;
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

export interface ExtractedSessionRecord {
  session_id: string;
  extracted_at: string;
}

export async function recordExtractedSession(orgId: string, sessionId: string): Promise<ExtractedSessionRecord> {
  return hubFetch<ExtractedSessionRecord>(`/v1/orgs/${orgId}/extracted-sessions`, {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId }),
  });
}

export async function listExtractedSessions(orgId: string): Promise<ExtractedSessionRecord[]> {
  const response = await hubFetch<{ sessions?: ExtractedSessionRecord[] }>(`/v1/orgs/${orgId}/extracted-sessions`);
  return response.sessions ?? [];
}

// updateOrgChainConfig was removed in CO-011a.4. Category B chain config
// (serve_attestation_required, min_contributions_per_epoch, contest_stake_vibe)
// is now broadcast directly via the relay using MsgSetOrgConfig.

export interface OrgSummary {
  org_id: string;
  org_name: string;
  domain: string;
  description?: string;
  tech_stack?: string;
  focus_areas?: string;
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
  created_at: string;
}

export async function getOrg(orgId: string): Promise<OrgSummary> {
  return hubFetch<OrgSummary>(`/v1/orgs/${orgId}`);
}



export interface EscalationVote {
  pubkey: string;
  voted_at: string;
}

export type ReportRecommendationVote = 'uphold' | 'dismiss' | 'dismiss_malicious';

export interface ReportRecommendation {
  moderator_pubkey: string;
  vote: ReportRecommendationVote;
}

export type ReportResolution = 'upheld' | 'dismissed' | 'dismissed_malicious';

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
  moderator_recommendations?: ReportRecommendation[];
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

export async function resolveReport(
  orgId: string,
  reportId: string,
  resolution: ReportResolution,
): Promise<Report> {
  return hubFetch<Report>(`/v1/orgs/${orgId}/reports/${reportId}`, {
    method: 'PATCH',
    body: JSON.stringify({ resolution }),
  });
}

export interface ReportRecommendationResponse {
  vote_count_uphold: number;
  vote_count_dismiss: number;
  vote_count_dismiss_malicious: number;
  status: string;
}

export async function recommendReport(
  orgId: string,
  reportId: string,
  vote: ReportRecommendationVote,
): Promise<ReportRecommendationResponse> {
  return hubFetch<ReportRecommendationResponse>(`/v1/orgs/${orgId}/reports/${reportId}/vote`, {
    method: 'POST',
    body: JSON.stringify({ vote }),
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
  description: string;
  tech_stack: string;
  focus_areas: string;
  fee_model?: Record<string, unknown> | null;
  enc_envelope: string;
  search_envelope: string;
  mod_envelope: string;
  umbral_pk: string;
  pk_mod: string;
  signature: string;
}

export interface CreateOrgResponse extends OrgSummary {
  hub_serving_key_address: string;
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

export interface KeywordCandidate {
  keyword: string;
  distinct_contributors: number;
  distinct_occasions: number;
  commonly_suggested: boolean;
}

export async function listKeywords(orgId: string): Promise<KeywordRecord[]> {
  const result = await hubFetch<KeywordRecord[]>(`/v1/orgs/${orgId}/keywords`);
  return result ?? [];
}

export async function getKeywordCandidates(orgId: string): Promise<KeywordCandidate[]> {
  const result = await hubFetch<KeywordCandidate[]>(`/v1/orgs/${orgId}/keywords/candidates`);
  return result ?? [];
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
  base_weight?: number;
}

export interface KeywordSuggestionPayload {
  keyword: string;
  weight: number;
  base_weight?: number;
  rationale: string;
}

export interface MemoryKeywordResult {
  submission_hash: string;
  classified: KeywordWeight[];
  extraction_feedback?: string;
}

export interface ModeratorKeywordVote {
  keyword: string;
  vote: 'include' | 'exclude';
}

export interface ModeratorRecommendation {
  moderator_pubkey: string;
  submission_vote: 'approve' | 'flag' | null;
  keyword_votes: ModeratorKeywordVote[];
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
  near_dup_matches?: { cid: string; score: number }[] | null;
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
  moderator_recommendations?: ModeratorRecommendation[];
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

export interface VerifyEntry {
  submission_hash: string;
  vector: number[];
  embedding_model_id: string;
  embedding_schema_version: string;
  umbral_capsule: string;
  umbral_ciphertext: string;
}

export interface OrgHealth {
  org_id: string;
  pending_keyword_count: number;
  pending_chain_count: number;
  last_keyword_extraction?: string | null;
  last_chain_submission?: string | null;
  updated_at: string;
}

export interface DuplicateCluster {
  members: string[];
  size: number;
}

export interface DuplicateClustersResponse {
  threshold: number;
  clusters: DuplicateCluster[];
  unclustered: number;
  total: number;
}

export interface CommitStatusEntry {
  submission_hash: string;
  status: string;
  commit_error: string | null;
  commit_attempted_at: string | null;
}

export async function getCommitStatus(orgId: string): Promise<CommitStatusEntry[]> {
  const resp = await hubFetch<{ submissions: CommitStatusEntry[] }>(`/v1/orgs/${orgId}/commit-status`);
  return resp.submissions ?? [];
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

export async function getDuplicateClusters(
  orgId: string,
  status = 'pending_chain',
  threshold?: number,
): Promise<DuplicateClustersResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set('status', status);
  if (threshold !== undefined) {
    searchParams.set('threshold', String(threshold));
  }

  const query = searchParams.toString();
  return hubFetch<DuplicateClustersResponse>(
    `/v1/orgs/${orgId}/submissions/duplicate-clusters?${query}`,
  );
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

export async function verifyKeywords(orgId: string, entries: VerifyEntry[]): Promise<VerificationResult[]> {
  const resp = await hubFetch<{ verified: number; results: VerificationResult[] }>(`/v1/orgs/${orgId}/verify-keywords`, {
    method: 'POST',
    body: JSON.stringify({ entries }),
  });
  return resp.results ?? [];
}

export async function updateKeywords(
  orgId: string,
  hash: string,
  classified: KeywordWeight[],
  suggestions?: KeywordSuggestionPayload[],
): Promise<{ status: string }> {
  const payload: { classified: KeywordWeight[]; suggestions?: KeywordSuggestionPayload[] } = {
    classified,
  };
  if (suggestions) {
    payload.suggestions = suggestions;
  }

  return hubFetch<{ status: string }>(`/v1/orgs/${orgId}/submissions/${encodeURIComponent(hash)}/update-keywords`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function denySubmission(
  orgId: string,
  submissionHash: string,
  reason = 'rejected',
): Promise<{ status: string }> {
  const identity = await getIdentity();
  if (!identity) {
    throw new Error('No dashboard identity');
  }

  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    throw new Error('Deny reason is required');
  }

  const canonical = await denySubmissionCanonical(
    orgId,
    submissionHash,
    normalizedReason,
    identity.pubkeyHex,
  );
  const signature = await signWithIdentity(canonical);

  return hubFetch<{ status: string }>(`/v1/orgs/${orgId}/moderation/${encodeURIComponent(submissionHash)}/deny`, {
    method: 'POST',
    body: JSON.stringify({
      signed_by: identity.pubkeyHex,
      reason: normalizedReason,
      signature,
    }),
  });
}

export async function denyPendingForContributor(
  orgId: string,
  contributorPubkey: string,
  reason = 'banned',
): Promise<{ status: string; denied_count: number }> {
  const identity = await getIdentity();
  if (!identity) {
    throw new Error('No dashboard identity');
  }

  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    throw new Error('Deny reason is required');
  }

  const canonical = await banContributorCanonical(
    orgId,
    contributorPubkey,
    identity.pubkeyHex,
  );
  const signature = await signWithIdentity(canonical);

  return hubFetch<{ status: string; denied_count: number }>(
    `/v1/orgs/${orgId}/contributors/${encodeURIComponent(contributorPubkey)}/deny-pending`,
    {
      method: 'POST',
      body: JSON.stringify({
        reason: normalizedReason,
        signed_by: identity.pubkeyHex,
        signature,
      }),
    },
  );
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
  preference_confidence: number;
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

export async function getRecallRateLimit(orgId: string): Promise<{
  configured: boolean;
  max_requests?: number;
  window_seconds?: number;
}> {
  const authHeaders = await buildAuthHeaders();
  const response = await fetch(`${getHubUrl()}/v1/orgs/${orgId}/recall-rate-limit`, {
    headers: {
      ...authHeaders,
    },
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      code?: string;
      detail?: string;
    };
    throw new HubError(err.error ?? `failed to load rate limit: ${response.status}`, {
      code: err.code,
      detail: err.detail,
      status: response.status,
    });
  }

  return response.json();
}

export async function setRecallRateLimit(orgId: string, maxRequests: number, windowSeconds: number): Promise<void> {
  const authHeaders = await buildAuthHeaders();
  const response = await fetch(`${getHubUrl()}/v1/orgs/${orgId}/recall-rate-limit`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({
      max_requests: maxRequests,
      window_seconds: windowSeconds,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      code?: string;
      detail?: string;
    };
    throw new HubError(err.error ?? `failed to set rate limit: ${response.status}`, {
      code: err.code,
      detail: err.detail,
      status: response.status,
    });
  }
}

export async function enableMemberRecall(orgId: string, pubkey: string, free?: boolean): Promise<void> {
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
        ...(free ? { free: true } : {}),
      }),
    },
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      code?: string;
      detail?: string;
    };
    throw new HubError(err.error ?? `Hub error ${response.status}`, {
      code: err.code,
      detail: err.detail,
      status: response.status,
    });
  }
}

export async function disableMemberRecall(orgId: string, pubkey: string): Promise<void> {
  const identity = await getIdentity();
  if (!identity) {
    throw new Error('No identity');
  }

  const authHeaders = await buildAuthHeaders();
  const response = await fetch(
    `${getHubUrl()}/v1/orgs/${orgId}/members/${encodeURIComponent(pubkey)}/disable-recall`,
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
