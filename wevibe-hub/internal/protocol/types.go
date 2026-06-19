package protocol

import (
	"encoding/json"
	"time"
)

const (
	MemoryTypeMemory = "memory"
)

const (
	SubmissionStatusPendingKeyword = "pending_keyword"
	SubmissionStatusPendingChain   = "pending_chain"
	SubmissionStatusCommitted      = "committed"
	SubmissionStatusDenied         = "denied"
)

const (
	MaxKeywordsPerMemory   = 20
	MaxMemoryChars         = 2000
	MaxNegativeSignalChars = 1000
	KeywordWeightTolerance = 0.02
	KeywordFormatRegex     = `^[a-z][a-z0-9_]{1,39}$`

	// MaxBatchMemories is the maximum number of memories a leader can include
	// in a single batch chain submission. Computed from chain block size
	// (21MB) with ~4KB per memory message and 20% safety margin. See
	// DECISIONS.md D-6.6.
	MaxBatchMemories = 500
)

func IsValidMemoryType(s string) bool {
	return s == MemoryTypeMemory
}

type OrgInfo struct {
	OrgID            string    `json:"org_id"`
	OrgName          string    `json:"org_name"`
	Domain           string    `json:"domain"`
	Description      string    `json:"description"`
	TechStack        string    `json:"tech_stack"`
	FocusAreas       string    `json:"focus_areas"`
	LeaderPubkey     string    `json:"leader_pubkey"`
	CurrentEpoch     int       `json:"current_epoch"`
	EgressMode       string    `json:"egress_mode"`
	AllowedProviders []string  `json:"allowed_providers"`
	Status           string    `json:"status"`
	RotationStatus   string    `json:"rotation_status"`
	CreatedAt        time.Time `json:"created_at"`
}

type DiscoverOrg struct {
	OrgID          string  `json:"org_id"`
	OrgName        string  `json:"org_name"`
	Domain         string  `json:"domain"`
	LeaderPubkey   string  `json:"leader_pubkey"`
	MemberCount    int     `json:"member_count"`
	CreatedAt      string  `json:"created_at"`
	CurrentEpoch   int     `json:"current_epoch"`
	LastActivityAt *string `json:"last_activity_at"`
}

type CreateOrgRequest struct {
	LeaderPubkey       string   `json:"leader_pubkey"`
	LeaderWallet       string   `json:"leader_wallet"`
	LeaderX25519Pubkey string   `json:"leader_x25519_pubkey"`
	OrgName            string   `json:"org_name"`
	Domain             string   `json:"domain"`
	Description        string   `json:"description"`
	TechStack          string   `json:"tech_stack"`
	FocusAreas         string   `json:"focus_areas"`
	OrgID              string   `json:"org_id"`
	TxHash             string   `json:"tx_hash"`
	HubServingKey      string   `json:"hub_serving_key"`
	FeeModel           FeeModel `json:"fee_model"`
	PkMod              string   `json:"pk_mod"`
	UmbralPK           string   `json:"umbral_pk,omitempty"`
	Signature          string   `json:"signature"`
	EncEnvelope        string   `json:"enc_envelope"`
	SearchEnvelope     string   `json:"search_envelope"`
	ModEnvelope        string   `json:"mod_envelope"`
}

type RotateEpochRequest struct {
	NewPkMod  string               `json:"new_pk_mod"`
	UmbralPK  string               `json:"umbral_pk,omitempty"`
	SignedBy  string               `json:"signed_by"`
	Signature string               `json:"signature"`
	Envelopes []MemberEnvelopePair `json:"envelopes"`
}

type EpochManifestResponse struct {
	OrgID     string    `json:"org_id" db:"org_id"`
	EpochID   int       `json:"epoch_id" db:"epoch_id"`
	PkMod     string    `json:"pk_mod" db:"pk_mod"`
	UmbralPK  string    `json:"umbral_pk,omitempty" db:"umbral_pk"`
	SignedBy  string    `json:"signed_by" db:"signed_by"`
	Signature string    `json:"signature" db:"signature"`
	CreatedAt time.Time `json:"created_at" db:"created_at"`
}

type MemberRecord struct {
	OrgID                  string    `json:"org_id" db:"org_id"`
	Pubkey                 string    `json:"pubkey" db:"pubkey"`
	X25519Pubkey           string    `json:"x25519_pubkey" db:"x25519_pubkey"`
	Role                   string    `json:"role" db:"role"`
	CanContribute          bool      `json:"can_contribute" db:"can_contribute"`
	CanModerate            bool      `json:"can_moderate" db:"can_moderate"`
	JoinEpoch              int       `json:"join_epoch" db:"join_epoch"`
	HistoryAccessFromEpoch int       `json:"history_access_from_epoch" db:"history_access_from_epoch"`
	AuthorizedUntilEpoch   *int      `json:"authorized_until_epoch" db:"authorized_until_epoch"`
	Active                 bool      `json:"active" db:"active"`
	MembershipActive       bool      `json:"membership_active" db:"membership_active"`
	JoinedAt               time.Time `json:"joined_at" db:"joined_at"`
	WalletAddress          *string   `json:"wallet_address,omitempty"`
	DisplayName            *string   `json:"display_name,omitempty" db:"-"`
	DismissedReportsCount  int       `json:"dismissed_reports_count"`
}

type InviteMemberRequest struct {
	Pubkey         string `json:"pubkey"`
	X25519Pubkey   string `json:"x25519_pubkey"`
	PrePubkey      string `json:"pre_pubkey,omitempty"`
	Role           string `json:"role"`
	CanContribute  bool   `json:"can_contribute"`
	CanModerate    bool   `json:"can_moderate"`
	SignedBy       string `json:"signed_by"`
	Signature      string `json:"signature"`
	EncEnvelope    string `json:"enc_envelope"`
	SearchEnvelope string `json:"search_envelope"`
	ModEnvelope    string `json:"mod_envelope"`
}

type KeyEnvelopeResponse struct {
	OrgID          string  `json:"org_id"`
	EpochID        int     `json:"epoch_id"`
	EncEnvelope    string  `json:"enc_envelope"`
	SearchEnvelope string  `json:"search_envelope"`
	ModEnvelope    *string `json:"mod_envelope"`
}

type MemberEnvelopePair struct {
	Pubkey         string  `json:"pubkey"`
	EncEnvelope    string  `json:"enc_envelope"`
	SearchEnvelope string  `json:"search_envelope"`
	ModEnvelope    *string `json:"mod_envelope,omitempty"`
}

type SubmitMemoryRequest struct {
	OrgID                string          `json:"org_id"`
	EpochID              int             `json:"epoch_id"`
	Ciphertext           string          `json:"ciphertext"`
	PlaintextHash        string          `json:"plaintext_hash"`
	Salt                 string          `json:"salt"`
	CiphertextHash       string          `json:"ciphertext_hash"`
	WrappedDekHash       string          `json:"wrapped_dek_hash"`
	WrappedDekMod        string          `json:"wrapped_dek_mod"`
	SubmissionHash       string          `json:"submission_hash"`
	PreferenceConfidence float64         `json:"preference_confidence"`
	Derivation           string          `json:"derivation"`
	ContributorPubkey    string          `json:"contributor_pubkey"`
	ContributorSig       string          `json:"contributor_sig"`
	StackHint            []string        `json:"stack_hint"`
	MemoryType           string          `json:"memory_type"`
	Keywords             json.RawMessage `json:"keywords,omitempty"`
}

type SubmitMemoryBatchRequest struct {
	Submissions []SubmitMemoryRequest `json:"submissions"`
}

type SubmitMemoryResponse struct {
	SubmissionHash       string    `json:"submission_hash"`
	Status               string    `json:"status"`
	SanitizationFindings []Finding `json:"sanitization_findings,omitempty"`
}

type Finding struct {
	Category    string `json:"category"`
	Description string `json:"description"`
	Position    int    `json:"position"`
	Codepoint   string `json:"codepoint"`
	Severity    string `json:"severity"`
}

type PendingQueueItem struct {
	SubmissionHash         string    `json:"submission_hash"`
	OrgID                  string    `json:"org_id"`
	EpochID                int       `json:"epoch_id"`
	ContributorPubkey      string    `json:"contributor_pubkey"`
	ContributorWallet      string    `json:"contributor_wallet,omitempty"`
	ContributorDisplayName string    `json:"contributor_display_name,omitempty"`
	CiphertextHex          string    `json:"ciphertext_hex"`
	WrappedDekMod          string    `json:"wrapped_dek_mod"`
	StackHint              []string  `json:"stack_hint"`
	MemoryType             string    `json:"memory_type"`
	PreferenceConfidence   float64   `json:"preference_confidence"`
	Derivation             string    `json:"derivation"`
	CreatedAt              time.Time `json:"created_at"`
	Status                 string    `json:"status"`
	Votes                  int       `json:"votes"`
	VoterPubkeys           []string  `json:"voter_pubkeys,omitempty"`
}

type KeywordWithWeight struct {
	Keyword    string  `json:"keyword"`
	Weight     float64 `json:"weight"`
	BaseWeight float64 `json:"base_weight"`
}

type KeywordCandidate struct {
	Keyword              string `json:"keyword"`
	DistinctContributors int    `json:"distinct_contributors"`
	DistinctOccasions    int    `json:"distinct_occasions"`
	CommonlySuggested    bool   `json:"commonly_suggested"`
}

type KeywordMatchDetail struct {
	Keyword      string  `json:"keyword"`
	QueryWeight  float64 `json:"query_weight"`
	MemoryWeight float64 `json:"memory_weight"`
	Product      float64 `json:"product"`
}

type ScoringBreakdown struct {
	KeywordScore   float64              `json:"keyword_score"`
	VectorScore    float64              `json:"vector_score"`
	Gamma          float64              `json:"gamma"`
	Delta          float64              `json:"delta"`
	CappedBoost    float64              `json:"capped_boost"`
	CombinedScore  float64              `json:"combined_score"`
	KeywordMatches []KeywordMatchDetail `json:"keyword_matches"`
	UnmatchedQuery []string             `json:"unmatched_query_keywords"`
}

type ApproveRequest struct {
	EpochID                int32               `json:"epoch_id"`
	ApprovedCID            string              `json:"approved_cid"`
	UmbralCapsule          string              `json:"umbral_capsule"`
	UmbralCiphertext       string              `json:"umbral_ciphertext"`
	ContentFlags           []string            `json:"content_flags"`
	Keywords               []KeywordWithWeight `json:"keywords"`
	KeywordWeights         map[string]float64  `json:"keyword_weights"`
	Vector                 []float32           `json:"vector"`
	EmbeddingModelID       string              `json:"embedding_model_id,omitempty"`
	EmbeddingSchemaVersion string              `json:"embedding_schema_version,omitempty"`
	VectorDim              int                 `json:"vector_dim,omitempty"`
	MemoryType             string              `json:"memory_type"`
	ModeratorSig           string              `json:"moderator_sig"`
	SignedBy               string              `json:"signed_by"`
}

type DenyRequest struct {
	Reason    string `json:"reason"`
	SignedBy  string `json:"signed_by"`
	Signature string `json:"signature"`
}

type FeeModel struct {
	Tier              string  `json:"tier,omitempty"`
	MonthlyCredits    int64   `json:"monthly_credits,omitempty"`
	PerQueryCost      int64   `json:"per_query_cost,omitempty"`
	OverageMultiplier float64 `json:"overage_multiplier,omitempty"`
	Currency          string  `json:"currency,omitempty"`
}

type QueryRequest struct {
	OrgID                  string              `json:"org_id"`
	AgentPubkey            string              `json:"agent_pubkey"`
	PrePubkey              string              `json:"pre_pubkey"`
	KeywordWeights         []KeywordWithWeight `json:"keyword_weights"`
	Vector                 []float32           `json:"vector"`
	EmbeddingModelID       string              `json:"embedding_model_id,omitempty"`
	EmbeddingSchemaVersion string              `json:"embedding_schema_version,omitempty"`
	Limit                  int                 `json:"limit"`
	SessionID              string              `json:"session_id,omitempty"`
	IncludeDormant         bool                `json:"include_dormant,omitempty"`
	RelevanceFloor         float64             `json:"relevance_floor,omitempty"`
	SurfaceBudget          int                 `json:"surface_budget,omitempty"`
	AgentSig               string              `json:"agent_sig"`
}

type MemoryResult struct {
	CID              string              `json:"cid"`
	OrgID            string              `json:"org_id"`
	EpochID          int                 `json:"epoch_id"`
	ConfidenceBps    uint64              `json:"confidence_bps,omitempty"`
	LifecycleState   string              `json:"lifecycle_state,omitempty"`
	MemoryType       string              `json:"memory_type"`
	WrappedDekEnc    string              `json:"wrapped_dek_enc"`
	UmbralCiphertext string              `json:"umbral_ciphertext,omitempty"`
	Cfrag            string              `json:"cfrag,omitempty"`
	Capsule          string              `json:"capsule,omitempty"`
	ContentFlags     []string            `json:"content_flags"`
	Keywords         []KeywordWithWeight `json:"keywords,omitempty"`
	MatchedKeywords  []string            `json:"matched_keywords,omitempty"`
	Breakdown        *ScoringBreakdown   `json:"scoring_breakdown,omitempty"`
	ChainAttested    bool                `json:"chain_attested"`
	RetrievalCount   int                 `json:"retrieval_count"`
	AcceptanceCount  int                 `json:"acceptance_count"`
	ContributorStats *ContributorStats   `json:"contributor_stats,omitempty"`
}

type ContributorStats struct {
	AccountAgeDays      int `json:"account_age_days"`
	Contributions       int `json:"contributions"`
	ServeCount          int `json:"serve_count"`
	ReportsUpheld       int `json:"reports_upheld"`
	FalseReportsAgainst int `json:"false_reports_against"`
}

type QueryResponse struct {
	Results              []MemoryResult `json:"results"`
	Contested            bool           `json:"contested"`
	ReceiptID            string         `json:"receipt_id"`
	RequiresReencryption []string       `json:"requires_reencryption,omitempty"`
}

type RejectRequest struct {
	CID         string `json:"cid"`
	OrgID       string `json:"org_id"`
	Reason      string `json:"reason"`
	AgentPubkey string `json:"agent_pubkey"`
	Signature   string `json:"signature"`
}

type RemoveMemberRequest struct {
	SignedBy  string `json:"signed_by"`
	Signature string `json:"signature"`
}

type TransferLeadershipRequest struct {
	NewLeaderPubkey string `json:"new_leader_pubkey"`
	SignedBy        string `json:"signed_by"`
	Signature       string `json:"signature"`
}

type CloseOrgRequest struct {
	SignedBy  string `json:"signed_by"`
	Signature string `json:"signature"`
}

type LinkWalletRequest struct {
	WalletAddress string `json:"wallet_address"`
	SignedBy      string `json:"signed_by"`
	Signature     string `json:"signature"`
}

type EnableMemberRecallRequest struct {
	SignedBy  string `json:"signed_by"`
	Free      bool   `json:"free"`
	PrePubkey string `json:"pre_pubkey,omitempty"`
}

type RegisterPreKeyRequest struct {
	PrePubkey string `json:"pre_pubkey"`
}

type MemberPreKeyResponse struct {
	PrePubkey string `json:"pre_pubkey"`
}

type IndexEntry struct {
	CID                    string              `json:"cid"`
	OrgID                  string              `json:"org_id"`
	EpochID                int32               `json:"epoch_id"`
	Keywords               []KeywordWithWeight `json:"keywords"`
	KeywordWeights         map[string]float64  `json:"keyword_weights"`
	ContentFlags           []string            `json:"content_flags"`
	Vector                 []float32           `json:"vector"`
	ConfidenceBps          uint64              `json:"confidence_bps"`
	LifecycleState         string              `json:"lifecycle_state"`
	MemoryType             string              `json:"memory_type"`
	EmbeddingModelID       string              `json:"embedding_model_id,omitempty"`
	EmbeddingSchemaVersion string              `json:"embedding_schema_version,omitempty"`
	VectorDim              int                 `json:"vector_dim,omitempty"`
}

type MemberOrgEntry struct {
	OrgID                  string   `json:"org_id"`
	OrgName                string   `json:"org_name"`
	Role                   string   `json:"role"`
	CanContribute          bool     `json:"can_contribute"`
	CanModerate            bool     `json:"can_moderate"`
	CurrentEpoch           int      `json:"current_epoch"`
	HistoryAccessFromEpoch int      `json:"history_access_from_epoch"`
	EgressMode             string   `json:"egress_mode"`
	AllowedProviders       []string `json:"allowed_providers"`
	ModPubkey              *string  `json:"mod_pubkey"`
	WalletAddress          *string  `json:"wallet_address,omitempty"`
}

type MemberOrgsResponse struct {
	Orgs []MemberOrgEntry `json:"orgs"`
}

type UsageReceipt struct {
	ReceiptID        string  `json:"receipt_id"`
	OrgID            string  `json:"org_id"`
	BillingEpoch     int     `json:"billing_epoch"`
	AccessEpochs     []int32 `json:"access_epochs"`
	AgentPubkey      string  `json:"agent_pubkey"`
	QueryCommitment  string  `json:"query_commitment"`
	ResultCommitment string  `json:"result_commitment"`
	AgentSignature   string  `json:"agent_signature"`
	NodeSignature    string  `json:"node_signature"`
}

type StoreRecoverySharesRequest struct {
	Shares    []RecoveryShareEntry `json:"shares"`
	SignedBy  string               `json:"signed_by"`
	Signature string               `json:"signature"`
}

type RecoveryShareEntry struct {
	ShareIndex   int    `json:"share_index"`
	HolderPubkey string `json:"holder_pubkey"`
	SealedShare  string `json:"sealed_share"`
}

type RecoveryShareResponse struct {
	OrgID       string `json:"org_id"`
	ShareIndex  int    `json:"share_index"`
	SealedShare string `json:"sealed_share"`
}

type RegisterDashboardKeyRequest struct {
	Pubkey    string `json:"pubkey"`
	Label     string `json:"label"`
	SignedBy  string `json:"signed_by"`
	Signature string `json:"signature"`
}

type DashboardKeyRecord struct {
	OrgID        string    `json:"org_id"`
	Pubkey       string    `json:"pubkey"`
	Label        string    `json:"label"`
	RegisteredBy string    `json:"registered_by"`
	Active       bool      `json:"active"`
	CreatedAt    time.Time `json:"created_at"`
}

type CreateReportRequest struct {
	MemoryCID      string `json:"memory_cid"`
	ReporterPubkey string `json:"reporter_pubkey"`
	ReporterWallet string `json:"reporter_wallet,omitempty"`
	Reason         string `json:"reason"`
	Note           string `json:"note,omitempty"`
	Signature      string `json:"signature,omitempty"`
}

type EscalationVote struct {
	Pubkey  string    `json:"pubkey"`
	VotedAt time.Time `json:"voted_at"`
}

type ReportRecommendation struct {
	ModeratorPubkey string `json:"moderator_pubkey"`
	Vote            string `json:"vote"`
}

type ReportRecord struct {
	ID                       string                 `json:"id"`
	OrgID                    string                 `json:"org_id"`
	MemoryCID                string                 `json:"memory_cid"`
	ReporterPubkey           string                 `json:"reporter_pubkey"`
	ReporterWallet           *string                `json:"reporter_wallet,omitempty"`
	ReporterRole             string                 `json:"reporter_role"`
	Reason                   string                 `json:"reason"`
	Note                     *string                `json:"note,omitempty"`
	Status                   string                 `json:"status"`
	Resolution               *string                `json:"resolution,omitempty"`
	ResolvedBy               *string                `json:"resolved_by,omitempty"`
	ResolvedAt               *time.Time             `json:"resolved_at,omitempty"`
	EscalationVotes          []EscalationVote       `json:"escalation_votes"`
	VoteCount                int                    `json:"vote_count"`
	ModeratorRecommendations []ReportRecommendation `json:"moderator_recommendations"`
	ReporterDismissedCount   int                    `json:"reporter_dismissed_count"`
	CreatedAt                time.Time              `json:"created_at"`
	UpdatedAt                time.Time              `json:"updated_at"`
}

type UpdateReportRequest struct {
	Resolution string `json:"resolution"`
	Vote       string `json:"vote,omitempty"`
	SignedBy   string `json:"signed_by"`
	Signature  string `json:"signature"`
}

type VoteOnReportRequest struct {
	Vote string `json:"vote"`
}

type VoteOnReportResponse struct {
	VoteCountUphold     int    `json:"vote_count_uphold"`
	VoteCountDismiss    int    `json:"vote_count_dismiss"`
	VoteCountDismissMal int    `json:"vote_count_dismiss_malicious"`
	Status              string `json:"status"`
}

type ReportListResponse struct {
	Reports []ReportRecord `json:"reports"`
	Total   int            `json:"total"`
}
