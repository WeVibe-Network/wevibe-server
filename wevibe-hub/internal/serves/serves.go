package serves

import (
	"context"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	servetypes "github.com/wevibe-network/wevibe-chain/x/serve/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/memories"
)

const (
	EventTypeServe   = "serve"
	EventTypeDenial  = "denial"
	EventTypeOutcome = "outcome"
)

type RecordServeRequest struct {
	OrgID             string `json:"org_id"`
	EpochID           int    `json:"epoch_id"`
	MemoryContentHash string `json:"memory_content_hash"`
	ServeKeyPubkey    string `json:"serve_key_pubkey"`
	ServeSig          string `json:"serve_sig"`
	Nonce             string `json:"nonce"`
	EpisodeRef        string `json:"episode_ref"`
	ContributorID     string `json:"contributor_id"`
	ModelID           string `json:"model_id"`
	TurnCount         int    `json:"turn_count"`
	SessionID         string `json:"session_id,omitempty"`
	// MatchedKeywords is optional descriptive metadata: the intersection of the
	// served memory's keywords and the query's keyword set, computed at retrieval
	// time when available. Empty / absent input is accepted and persists as '{}'.
	MatchedKeywords []string `json:"matched_keywords"`
}

type RecordOutcomeRequest struct {
	OrgID             string `json:"org_id"`
	EpochID           int    `json:"epoch"`
	EventType         string `json:"event_type"`
	MemoryContentHash string `json:"memory_hash"`
	SignerPubkey      string `json:"signer_pubkey"`
	Nonce             string `json:"nonce"`
	Signature         string `json:"signature"`
	EpisodeRef        string `json:"episode_ref"`
	ServeRef          string `json:"serve_ref"`
	Resolution        string `json:"resolution"`
	Source            string `json:"source"`
	EvidenceRef       string `json:"evidence_ref"`
	Fingerprint       string `json:"fingerprint"`
	SessionID         string `json:"session_id,omitempty"`
}

type RecordDenialRequest struct {
	OrgID             string `json:"org_id"`
	EpochID           int    `json:"epoch_id"`
	MemoryContentHash string `json:"memory_content_hash"`
	ServeKeyPubkey    string `json:"serve_key_pubkey"`
	ServeSig          string `json:"serve_sig"`
	Nonce             string `json:"nonce"`
	ServeFingerprint  string `json:"serve_fingerprint"`
	Reason            string `json:"reason"`
}

type ServeEventRecord struct {
	ID                int64      `json:"id"`
	OrgID             string     `json:"org_id"`
	EpochID           int        `json:"epoch_id"`
	MemoryContentHash string     `json:"memory_content_hash"`
	ServeKeyPubkey    string     `json:"serve_key_pubkey"`
	ServeSig          string     `json:"serve_sig"`
	Nonce             string     `json:"nonce"`
	EpisodeRef        string     `json:"episode_ref"`
	ServeFingerprint  string     `json:"serve_fingerprint"`
	ContributorID     string     `json:"contributor_id"`
	ContributorWallet string     `json:"contributor_wallet"`
	ModelID           string     `json:"model_id"`
	TurnCount         int        `json:"turn_count"`
	MatchedKeywords   []string   `json:"matched_keywords"`
	ReporterPubkey    string     `json:"reporter_pubkey"`
	Reason            string     `json:"reason"`
	EventType         string     `json:"event_type"`
	Status            string     `json:"status"`
	TxHash            *string    `json:"tx_hash,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	SubmittedAt       *time.Time `json:"submitted_at,omitempty"`
}

type OutcomeEventRecord struct {
	ID                int64      `json:"id"`
	OrgID             string     `json:"org_id"`
	EpochID           int        `json:"epoch_id"`
	MemoryContentHash string     `json:"memory_content_hash"`
	SignerPubkey      string     `json:"signer_pubkey"`
	Nonce             string     `json:"nonce"`
	Signature         string     `json:"signature"`
	EpisodeRef        string     `json:"episode_ref"`
	ServeRef          string     `json:"serve_ref"`
	Resolution        string     `json:"resolution"`
	Source            string     `json:"source"`
	EvidenceRef       string     `json:"evidence_ref"`
	Fingerprint       string     `json:"fingerprint"`
	SessionID         string     `json:"session_id,omitempty"`
	ReporterPubkey    string     `json:"reporter_pubkey"`
	Status            string     `json:"status"`
	TxHash            *string    `json:"tx_hash,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	SubmittedAt       *time.Time `json:"submitted_at,omitempty"`
}

// normalizeMatchedKeywords canonicalises the optional matched-keyword set
// supplied by the serve reporter. Behaviour:
//   - empty / missing input → []string{} accepted.
//   - each entry is lowercased and trimmed; entries that collapse to "" are
//     dropped (keywords are optional descriptive metadata, so a whitespace-only
//     entry must not reject the serve).
//   - duplicates (post-normalization) are dropped, preserving first-seen order.
//
// Returns the canonical slice, never nil.
func normalizeMatchedKeywords(raw []string) []string {
	if len(raw) == 0 {
		return []string{}
	}

	normalized := make([]string, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for _, keyword := range raw {
		cleaned := strings.ToLower(strings.TrimSpace(keyword))
		if cleaned == "" {
			continue
		}
		if _, exists := seen[cleaned]; exists {
			continue
		}
		seen[cleaned] = struct{}{}
		normalized = append(normalized, cleaned)
	}

	return normalized
}

func RecordServe(ctx context.Context, pool *pgxpool.Pool, chainClient *chain.GrpcClient, req RecordServeRequest, reporterPubkey string) (*ServeEventRecord, error) {
	if req.MemoryContentHash == "" {
		return nil, fmt.Errorf("memory_content_hash is required")
	}
	if len(req.MemoryContentHash) != 64 {
		return nil, fmt.Errorf("memory_content_hash must be 64 hex characters (32 bytes)")
	}
	memoryHash, err := hex.DecodeString(req.MemoryContentHash)
	if err != nil {
		return nil, fmt.Errorf("memory_content_hash must be valid hex")
	}

	if req.ServeKeyPubkey == "" {
		return nil, fmt.Errorf("serve_key_pubkey is required")
	}
	serveKeyPubkey, err := hex.DecodeString(req.ServeKeyPubkey)
	if err != nil {
		return nil, fmt.Errorf("serve_key_pubkey must be valid hex")
	}
	if len(serveKeyPubkey) != 32 {
		return nil, fmt.Errorf("serve_key_pubkey must be 64 hex characters (32 bytes)")
	}
	if req.ServeSig == "" {
		return nil, fmt.Errorf("serve_sig is required")
	}
	serveSig, err := hex.DecodeString(req.ServeSig)
	if err != nil {
		return nil, fmt.Errorf("serve_sig must be valid hex")
	}
	if len(serveSig) != 64 {
		return nil, fmt.Errorf("serve_sig must be 128 hex characters (64 bytes)")
	}
	if req.Nonce == "" {
		return nil, fmt.Errorf("nonce is required")
	}
	nonce, err := hex.DecodeString(req.Nonce)
	if err != nil {
		return nil, fmt.Errorf("nonce must be valid hex")
	}
	if len(nonce) == 0 {
		return nil, fmt.Errorf("nonce must decode to at least 1 byte")
	}
	if err := validateEpisodeRef(req.EpisodeRef); err != nil {
		return nil, err
	}
	if req.ContributorID == "" {
		return nil, fmt.Errorf("contributor_id is required")
	}
	if req.EpochID < 0 {
		return nil, fmt.Errorf("epoch_id must be non-negative")
	}
	if err := memories.EnsureApproved(ctx, pool, chainClient, req.OrgID, req.MemoryContentHash); err != nil {
		return nil, err
	}

	matchedKeywords := normalizeMatchedKeywords(req.MatchedKeywords)
	serveFingerprint := hex.EncodeToString(servetypes.ComputeServeFingerprint(memoryHash, serveKeyPubkey, uint64(req.EpochID)))

	var id int64
	var createdAt time.Time
	err = pool.QueryRow(ctx, `
			INSERT INTO serve_events (org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce, episode_ref, serve_fingerprint, contributor_id, model_id, turn_count, matched_keywords, reporter_pubkey, reason, event_type, status)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '', $13, 'pending')
			ON CONFLICT (org_id, event_type, serve_key_pubkey, memory_content_hash, epoch_id) DO UPDATE SET
				serve_sig = EXCLUDED.serve_sig,
				nonce = EXCLUDED.nonce,
				episode_ref = EXCLUDED.episode_ref,
				serve_fingerprint = EXCLUDED.serve_fingerprint,
				contributor_id = EXCLUDED.contributor_id,
			model_id = EXCLUDED.model_id,
			turn_count = EXCLUDED.turn_count,
			matched_keywords = EXCLUDED.matched_keywords,
			reporter_pubkey = EXCLUDED.reporter_pubkey,
			reason = EXCLUDED.reason,
				created_at = EXCLUDED.created_at
			RETURNING id, created_at
		`, req.OrgID, req.EpochID, req.MemoryContentHash, req.ServeKeyPubkey, req.ServeSig, req.Nonce, req.EpisodeRef, serveFingerprint, req.ContributorID, req.ModelID, req.TurnCount, matchedKeywords, reporterPubkey, EventTypeServe).Scan(&id, &createdAt)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "unique") {
			return nil, fmt.Errorf("duplicate serve event: already recorded for this org/epoch/key/memory")
		}
		return nil, fmt.Errorf("insert serve event: %w", err)
	}

	if req.SessionID != "" {
		_, _ = pool.Exec(ctx, `
			INSERT INTO session_served_memories (org_id, session_id, memory_cid)
			VALUES ($1, $2, $3)
			ON CONFLICT (org_id, session_id, memory_cid) DO NOTHING
		`, req.OrgID, req.SessionID, req.MemoryContentHash)
		_, _ = pool.Exec(ctx, `DELETE FROM session_served_memories WHERE served_at < NOW() - INTERVAL '24 hours'`)
	}

	var record ServeEventRecord
	err = pool.QueryRow(ctx, `
		SELECT id, org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce, episode_ref, serve_fingerprint, contributor_id, model_id, turn_count, matched_keywords, reporter_pubkey, reason, event_type, status, tx_hash, created_at, submitted_at
		FROM serve_events WHERE id = $1
	`, id).Scan(
		&record.ID, &record.OrgID, &record.EpochID, &record.MemoryContentHash,
		&record.ServeKeyPubkey, &record.ServeSig, &record.Nonce, &record.EpisodeRef, &record.ServeFingerprint, &record.ContributorID, &record.ModelID,
		&record.TurnCount, &record.MatchedKeywords, &record.ReporterPubkey, &record.Reason, &record.EventType, &record.Status, &record.TxHash,
		&record.CreatedAt, &record.SubmittedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("fetch serve event: %w", err)
	}

	return &record, nil
}

func RecordDenial(ctx context.Context, pool *pgxpool.Pool, req RecordDenialRequest, reporterPubkey string) (*ServeEventRecord, error) {
	if req.MemoryContentHash == "" {
		return nil, fmt.Errorf("memory_content_hash is required")
	}
	if len(req.MemoryContentHash) != 64 {
		return nil, fmt.Errorf("memory_content_hash must be 64 hex characters (32 bytes)")
	}
	if _, err := hex.DecodeString(req.MemoryContentHash); err != nil {
		return nil, fmt.Errorf("memory_content_hash must be valid hex")
	}
	if req.ServeKeyPubkey == "" {
		return nil, fmt.Errorf("serve_key_pubkey is required")
	}
	serveKeyPubkey, err := hex.DecodeString(req.ServeKeyPubkey)
	if err != nil {
		return nil, fmt.Errorf("serve_key_pubkey must be valid hex")
	}
	if len(serveKeyPubkey) != 32 {
		return nil, fmt.Errorf("serve_key_pubkey must be 64 hex characters (32 bytes)")
	}
	if req.ServeSig == "" {
		return nil, fmt.Errorf("serve_sig is required")
	}
	serveSig, err := hex.DecodeString(req.ServeSig)
	if err != nil {
		return nil, fmt.Errorf("serve_sig must be valid hex")
	}
	if len(serveSig) != 64 {
		return nil, fmt.Errorf("serve_sig must be 128 hex characters (64 bytes)")
	}
	if req.Nonce == "" {
		return nil, fmt.Errorf("nonce is required")
	}
	nonce, err := hex.DecodeString(req.Nonce)
	if err != nil {
		return nil, fmt.Errorf("nonce must be valid hex")
	}
	if len(nonce) == 0 {
		return nil, fmt.Errorf("nonce must decode to at least 1 byte")
	}
	if req.ServeFingerprint == "" {
		return nil, fmt.Errorf("serve_fingerprint is required")
	}
	serveFingerprint, err := hex.DecodeString(req.ServeFingerprint)
	if err != nil {
		return nil, fmt.Errorf("serve_fingerprint must be valid hex")
	}
	if len(serveFingerprint) != 32 {
		return nil, fmt.Errorf("serve_fingerprint must be 64 hex characters (32 bytes)")
	}
	if req.Reason == "" {
		return nil, fmt.Errorf("reason is required")
	}
	if req.EpochID < 0 {
		return nil, fmt.Errorf("epoch_id must be non-negative")
	}

	var id int64
	var createdAt time.Time
	// matched_keywords supplied as empty TEXT[] for denial events: column is
	// NOT NULL but denial-side matched_keywords is out of CO-033a scope (Q2=(a),
	// DenialEntry proto has no matched_keywords field at chain commit 533d18b).
	// CO-033b may add denial matched_keywords if a chain proto change lands.
	err = pool.QueryRow(ctx, `
		INSERT INTO serve_events (org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce, serve_fingerprint, contributor_id, model_id, turn_count, matched_keywords, reporter_pubkey, reason, event_type, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '', 0, '{}'::TEXT[], $9, $10, $11, 'pending')
		ON CONFLICT (org_id, event_type, serve_key_pubkey, memory_content_hash, epoch_id) DO UPDATE SET
			serve_sig = EXCLUDED.serve_sig,
			nonce = EXCLUDED.nonce,
			serve_fingerprint = EXCLUDED.serve_fingerprint,
			contributor_id = EXCLUDED.contributor_id,
			reporter_pubkey = EXCLUDED.reporter_pubkey,
			reason = EXCLUDED.reason,
			created_at = EXCLUDED.created_at
		RETURNING id, created_at
	`, req.OrgID, req.EpochID, req.MemoryContentHash, req.ServeKeyPubkey, req.ServeSig, req.Nonce, req.ServeFingerprint, reporterPubkey, reporterPubkey, req.Reason, EventTypeDenial).Scan(&id, &createdAt)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "unique") {
			return nil, fmt.Errorf("duplicate denial event: already recorded for this org/epoch/key/memory")
		}
		return nil, fmt.Errorf("insert denial event: %w", err)
	}

	var record ServeEventRecord
	err = pool.QueryRow(ctx, `
		SELECT id, org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce, serve_fingerprint, contributor_id, model_id, turn_count, matched_keywords, reporter_pubkey, reason, event_type, status, tx_hash, created_at, submitted_at
		FROM serve_events WHERE id = $1
	`, id).Scan(
		&record.ID, &record.OrgID, &record.EpochID, &record.MemoryContentHash,
		&record.ServeKeyPubkey, &record.ServeSig, &record.Nonce, &record.ServeFingerprint, &record.ContributorID, &record.ModelID,
		&record.TurnCount, &record.MatchedKeywords, &record.ReporterPubkey, &record.Reason, &record.EventType, &record.Status, &record.TxHash,
		&record.CreatedAt, &record.SubmittedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("fetch denial event: %w", err)
	}

	return &record, nil
}

func validateHexField(name, value string, bytes int) error {
	if value == "" {
		return fmt.Errorf("%s is required", name)
	}
	decoded, err := hex.DecodeString(value)
	if err != nil {
		return fmt.Errorf("%s must be valid hex", name)
	}
	if len(decoded) != bytes {
		return fmt.Errorf("%s must be %d hex characters (%d bytes)", name, bytes*2, bytes)
	}
	return nil
}

func validateRequiredString(name, value string) error {
	if value == "" {
		return fmt.Errorf("%s is required", name)
	}
	return nil
}

// episodeRefRe matches lowercase hex only. episode_ref is a content-free hex
// reference (never plaintext), consistent with outcome_events.episode_ref.
var episodeRefRe = regexp.MustCompile(`^[0-9a-f]+$`)

// validateEpisodeRef fail-closes at the intake boundary: the field must be
// non-empty, at most 128 characters, and lowercase hex of even length (odd
// length would not hex-decode, breaking the serve relay).
func validateEpisodeRef(value string) error {
	if value == "" {
		return fmt.Errorf("episode_ref is required")
	}
	if len(value) > 128 {
		return fmt.Errorf("episode_ref must be at most 128 characters")
	}
	if len(value)%2 != 0 {
		return fmt.Errorf("episode_ref must have even length (hex byte-aligned)")
	}
	if !episodeRefRe.MatchString(value) {
		return fmt.Errorf("episode_ref must be lowercase hex ([0-9a-f]+)")
	}
	return nil
}

func validateOutcomeRequest(req RecordOutcomeRequest, reporterPubkey string) error {
	if err := validateRequiredString("org_id", req.OrgID); err != nil {
		return err
	}
	if req.EpochID < 0 {
		return fmt.Errorf("epoch must be non-negative")
	}
	if req.EventType != EventTypeOutcome {
		return fmt.Errorf("event_type must be %q", EventTypeOutcome)
	}
	if err := validateHexField("memory_hash", req.MemoryContentHash, 32); err != nil {
		return err
	}
	if err := validateHexField("signer_pubkey", req.SignerPubkey, 32); err != nil {
		return err
	}
	if err := validateRequiredString("nonce", req.Nonce); err != nil {
		return err
	}
	if _, err := hex.DecodeString(req.Nonce); err != nil {
		return fmt.Errorf("nonce must be valid hex")
	}
	if err := validateHexField("signature", req.Signature, 64); err != nil {
		return err
	}
	if err := validateRequiredString("episode_ref", req.EpisodeRef); err != nil {
		return err
	}
	if err := validateHexField("serve_ref", req.ServeRef, 32); err != nil {
		return err
	}
	switch req.Resolution {
	case "worked", "didnt_work", "unobserved":
	default:
		return fmt.Errorf("resolution must be one of worked, didnt_work, unobserved")
	}
	switch req.Source {
	case "harvested", "user":
	default:
		return fmt.Errorf("source must be one of harvested, user")
	}
	if err := validateRequiredString("evidence_ref", req.EvidenceRef); err != nil {
		return err
	}
	if err := validateHexField("fingerprint", req.Fingerprint, 32); err != nil {
		return err
	}
	if err := validateRequiredString("reporter_pubkey", reporterPubkey); err != nil {
		return err
	}
	return nil
}

func RecordOutcome(ctx context.Context, pool *pgxpool.Pool, req RecordOutcomeRequest, reporterPubkey string) (bool, error) {
	if err := validateOutcomeRequest(req, reporterPubkey); err != nil {
		return false, err
	}

	tag, err := pool.Exec(ctx, `
			INSERT INTO outcome_events (org_id, epoch_id, memory_content_hash, signer_pubkey, nonce, signature, episode_ref, serve_ref, resolution, source, evidence_ref, fingerprint, session_id, reporter_pubkey, status)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULLIF($13, ''), $14, 'pending')
			ON CONFLICT (fingerprint) DO NOTHING
		`, req.OrgID, req.EpochID, req.MemoryContentHash, req.SignerPubkey, req.Nonce, req.Signature, req.EpisodeRef, req.ServeRef, req.Resolution, req.Source, req.EvidenceRef, req.Fingerprint, req.SessionID, reporterPubkey)
	if err != nil {
		return false, fmt.Errorf("insert outcome event: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

func PendingOutcomeEvents(ctx context.Context, pool *pgxpool.Pool, orgID string, limit int) ([]OutcomeEventRecord, error) {
	rows, err := pool.Query(ctx, `
			SELECT id, org_id, epoch_id, memory_content_hash, signer_pubkey, nonce, signature, episode_ref, serve_ref, resolution, source, evidence_ref, fingerprint, COALESCE(session_id, ''), reporter_pubkey, status, tx_hash, created_at, submitted_at
		FROM outcome_events
		WHERE org_id = $1 AND status = 'pending'
		ORDER BY created_at ASC
		LIMIT $2
	`, orgID, limit)
	if err != nil {
		return nil, fmt.Errorf("query pending outcome events: %w", err)
	}
	defer rows.Close()

	return scanOutcomeEvents(rows)
}

func scanOutcomeEvents(rows pgx.Rows) ([]OutcomeEventRecord, error) {
	records := make([]OutcomeEventRecord, 0)
	for rows.Next() {
		var r OutcomeEventRecord
		err := rows.Scan(
			&r.ID, &r.OrgID, &r.EpochID, &r.MemoryContentHash,
			&r.SignerPubkey, &r.Nonce, &r.Signature, &r.EpisodeRef, &r.ServeRef,
			&r.Resolution, &r.Source, &r.EvidenceRef, &r.Fingerprint, &r.SessionID,
			&r.ReporterPubkey, &r.Status, &r.TxHash, &r.CreatedAt, &r.SubmittedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan outcome event: %w", err)
		}
		records = append(records, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows error: %w", err)
	}
	return records, nil
}

func MarkOutcomeEvents(ctx context.Context, pool *pgxpool.Pool, ids []int64, status, txHash string) error {
	if len(ids) == 0 {
		return nil
	}
	if status != "submitted" && status != "failed" {
		return fmt.Errorf("outcome status must be submitted or failed")
	}
	_, err := pool.Exec(ctx, `
		UPDATE outcome_events
		SET status = $1, tx_hash = $2, submitted_at = CASE WHEN $1 = 'submitted' THEN NOW() ELSE submitted_at END
		WHERE id = ANY($3)
	`, status, txHash, ids)
	if err != nil {
		return fmt.Errorf("mark outcome events: %w", err)
	}
	return nil
}

func GetPendingServes(ctx context.Context, pool *pgxpool.Pool, orgID string, limit int, holdHours int) ([]ServeEventRecord, error) {
	rows, err := pool.Query(ctx, `
		SELECT se.id, se.org_id, se.epoch_id, se.memory_content_hash, se.serve_key_pubkey, se.serve_sig, se.nonce, se.episode_ref, se.serve_fingerprint, se.contributor_id, se.model_id, se.turn_count, se.matched_keywords, se.reporter_pubkey, se.reason, se.event_type, se.status, se.tx_hash, se.created_at, se.submitted_at, COALESCE(m.wallet_address, '')
		FROM serve_events se
		JOIN members m ON m.org_id = se.org_id AND m.pubkey = se.contributor_id
		WHERE se.org_id = $1 AND se.status = 'pending' AND se.event_type = 'serve'
			AND ($3::int <= 0 OR se.created_at <= NOW() - make_interval(hours => $3))
		ORDER BY se.created_at ASC
		LIMIT $2
	`, orgID, limit, holdHours)
	if err != nil {
		return nil, fmt.Errorf("query pending serves: %w", err)
	}
	defer rows.Close()

	var records []ServeEventRecord
	for rows.Next() {
		var r ServeEventRecord
		err := rows.Scan(
			&r.ID, &r.OrgID, &r.EpochID, &r.MemoryContentHash,
			&r.ServeKeyPubkey, &r.ServeSig, &r.Nonce, &r.EpisodeRef, &r.ServeFingerprint, &r.ContributorID, &r.ModelID,
			&r.TurnCount, &r.MatchedKeywords, &r.ReporterPubkey, &r.Reason, &r.EventType, &r.Status, &r.TxHash,
			&r.CreatedAt, &r.SubmittedAt, &r.ContributorWallet,
		)
		if err != nil {
			return nil, fmt.Errorf("scan serve event: %w", err)
		}
		records = append(records, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows error: %w", err)
	}

	return records, nil
}

func GetPendingDenials(ctx context.Context, pool *pgxpool.Pool, orgID string, limit int, holdHours int) ([]ServeEventRecord, error) {
	rows, err := pool.Query(ctx, `
		SELECT id, org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce, serve_fingerprint, contributor_id, model_id, turn_count, matched_keywords, reporter_pubkey, reason, event_type, status, tx_hash, created_at, submitted_at
		FROM serve_events
		WHERE org_id = $1 AND status = 'pending' AND event_type = 'denial'
			AND ($3::int <= 0 OR created_at <= NOW() - make_interval(hours => $3))
		ORDER BY created_at ASC
		LIMIT $2
	`, orgID, limit, holdHours)
	if err != nil {
		return nil, fmt.Errorf("query pending denials: %w", err)
	}
	defer rows.Close()

	var records []ServeEventRecord
	for rows.Next() {
		var r ServeEventRecord
		err := rows.Scan(
			&r.ID, &r.OrgID, &r.EpochID, &r.MemoryContentHash,
			&r.ServeKeyPubkey, &r.ServeSig, &r.Nonce, &r.ServeFingerprint, &r.ContributorID, &r.ModelID,
			&r.TurnCount, &r.MatchedKeywords, &r.ReporterPubkey, &r.Reason, &r.EventType, &r.Status, &r.TxHash,
			&r.CreatedAt, &r.SubmittedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan denial event: %w", err)
		}
		records = append(records, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows error: %w", err)
	}

	return records, nil
}

// GetServeEventsByEpisode returns all serve_events rows for a given org and
// episode_ref (optionally narrowed by memory_content_hash), ordered by creation
// time. It is the read-only source for the funnel's confirmed-on-chain check:
// the caller derives confirmed from Status=='submitted' AND TxHash != nil.
func GetServeEventsByEpisode(ctx context.Context, pool *pgxpool.Pool, orgID, episodeRef, memoryHash string) ([]ServeEventRecord, error) {
	query := `
		SELECT id, org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce,
			episode_ref, serve_fingerprint, contributor_id, model_id, turn_count, matched_keywords,
			reporter_pubkey, reason, event_type, status, tx_hash, created_at, submitted_at
		FROM serve_events
		WHERE org_id = $1 AND episode_ref = $2`
	args := []any{orgID, episodeRef}
	if memoryHash != "" {
		query += ` AND memory_content_hash = $3`
		args = append(args, memoryHash)
	}
	query += ` ORDER BY created_at ASC`

	rows, err := pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query serve events by episode: %w", err)
	}
	defer rows.Close()

	var records []ServeEventRecord
	for rows.Next() {
		var r ServeEventRecord
		var reason *string
		err := rows.Scan(
			&r.ID, &r.OrgID, &r.EpochID, &r.MemoryContentHash,
			&r.ServeKeyPubkey, &r.ServeSig, &r.Nonce, &r.EpisodeRef, &r.ServeFingerprint, &r.ContributorID, &r.ModelID,
			&r.TurnCount, &r.MatchedKeywords, &r.ReporterPubkey, &reason, &r.EventType, &r.Status, &r.TxHash,
			&r.CreatedAt, &r.SubmittedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan serve event: %w", err)
		}
		if reason != nil {
			r.Reason = *reason
		}
		records = append(records, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows error: %w", err)
	}

	return records, nil
}

// MarkServesSubmitted updates the given serve_events rows to status='submitted'
// after a successful chain broadcast, scoped to event_type='serve' to prevent
// accidental cross-type updates from a misuse of the API.
func MarkServesSubmitted(ctx context.Context, pool *pgxpool.Pool, ids []int64, txHash string) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := pool.Exec(ctx, `
		UPDATE serve_events
		SET status = 'submitted', tx_hash = $1, submitted_at = NOW()
		WHERE id = ANY($2) AND event_type = 'serve'
	`, txHash, ids)
	if err != nil {
		return fmt.Errorf("mark serves submitted: %w", err)
	}
	return nil
}

// MarkDenialsSubmitted updates the given serve_events rows to status='submitted'
// after a successful chain broadcast, scoped to event_type='denial'.
func MarkDenialsSubmitted(ctx context.Context, pool *pgxpool.Pool, ids []int64, txHash string) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := pool.Exec(ctx, `
		UPDATE serve_events
		SET status = 'submitted', tx_hash = $1, submitted_at = NOW()
		WHERE id = ANY($2) AND event_type = 'denial'
	`, txHash, ids)
	if err != nil {
		return fmt.Errorf("mark denials submitted: %w", err)
	}
	return nil
}

func HasPendingEvents(ctx context.Context, pool *pgxpool.Pool, orgID string, holdHours int) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM serve_events
			WHERE org_id = $1 AND status = 'pending'
				AND ($2::int <= 0 OR created_at <= NOW() - make_interval(hours => $2))
		)
	`, orgID, holdHours).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check pending serve events: %w", err)
	}
	return exists, nil
}

func ListOrgsWithEligiblePending(ctx context.Context, pool *pgxpool.Pool, holdHours int, exemptOrgs []string) ([]string, error) {
	if exemptOrgs == nil {
		exemptOrgs = []string{}
	}

	rows, err := pool.Query(ctx, `
		SELECT DISTINCT org_id
		FROM serve_events
		WHERE status = 'pending'
			AND (org_id = ANY($2) OR created_at <= NOW() - make_interval(hours => $1))
		ORDER BY org_id
	`, holdHours, exemptOrgs)
	if err != nil {
		return nil, fmt.Errorf("list orgs with eligible pending events: %w", err)
	}
	defer rows.Close()

	orgs := make([]string, 0)
	for rows.Next() {
		var orgID string
		if err := rows.Scan(&orgID); err != nil {
			return nil, fmt.Errorf("scan eligible org id: %w", err)
		}
		orgs = append(orgs, orgID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate eligible org ids: %w", err)
	}

	return orgs, nil
}
