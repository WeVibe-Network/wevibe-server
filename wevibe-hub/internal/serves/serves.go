package serves

import (
	"context"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	EventTypeServe  = "serve"
	EventTypeDenial = "denial"
)

type RecordServeRequest struct {
	OrgID             string `json:"org_id"`
	EpochID           int    `json:"epoch_id"`
	MemoryContentHash string `json:"memory_content_hash"`
	ServeKeyPubkey    string `json:"serve_key_pubkey"`
	ServeSig          string `json:"serve_sig"`
	Nonce             string `json:"nonce"`
	ContributorID     string `json:"contributor_id"`
	ModelID           string `json:"model_id"`
	TurnCount         int    `json:"turn_count"`
	SessionID         string `json:"session_id,omitempty"`
	// MatchedKeywords is the intersection of the served memory's keywords and
	// the query's keyword set, computed at retrieval time. Required, non-empty.
	// Per DECISIONS.md D-4.2 Implementation Clarifications (DMO-007).
	// Chain x/serve rejects empty sets per CO-031 Rev 2 (chain commit 533d18b);
	// hub enforces the same constraint to avoid producing un-broadcastable rows.
	MatchedKeywords []string `json:"matched_keywords"`
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

// normalizeMatchedKeywords validates and canonicalises the matched-keyword
// set supplied by the serve reporter. Behaviour:
//   - empty / missing input → error (chain x/serve rejects empty sets per
//     CO-031 Rev 2; hub enforces the same contract before persistence).
//   - each entry is lowercased and trimmed; entries that collapse to "" error.
//   - duplicates (post-normalization) are dropped, preserving first-seen order.
//
// Returns the canonical slice on success. Never returns nil + nil err.
func normalizeMatchedKeywords(raw []string) ([]string, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("matched_keywords is required")
	}

	normalized := make([]string, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for _, keyword := range raw {
		cleaned := strings.ToLower(strings.TrimSpace(keyword))
		if cleaned == "" {
			return nil, fmt.Errorf("matched_keywords entries must be non-empty strings")
		}
		if _, exists := seen[cleaned]; exists {
			continue
		}
		seen[cleaned] = struct{}{}
		normalized = append(normalized, cleaned)
	}

	if len(normalized) == 0 {
		return nil, fmt.Errorf("matched_keywords is required")
	}

	return normalized, nil
}

func RecordServe(ctx context.Context, pool *pgxpool.Pool, req RecordServeRequest, reporterPubkey string) (*ServeEventRecord, error) {
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
	if req.ContributorID == "" {
		return nil, fmt.Errorf("contributor_id is required")
	}
	if req.EpochID < 0 {
		return nil, fmt.Errorf("epoch_id must be non-negative")
	}

	matchedKeywords, err := normalizeMatchedKeywords(req.MatchedKeywords)
	if err != nil {
		return nil, err
	}

	var id int64
	var createdAt time.Time
	err = pool.QueryRow(ctx, `
		INSERT INTO serve_events (org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce, serve_fingerprint, contributor_id, model_id, turn_count, matched_keywords, reporter_pubkey, reason, event_type, status)
		VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11, '', $12, 'pending')
		ON CONFLICT (org_id, event_type, serve_key_pubkey, memory_content_hash, epoch_id) DO UPDATE SET
			serve_sig = EXCLUDED.serve_sig,
			nonce = EXCLUDED.nonce,
			contributor_id = EXCLUDED.contributor_id,
			model_id = EXCLUDED.model_id,
			turn_count = EXCLUDED.turn_count,
			matched_keywords = EXCLUDED.matched_keywords,
			reporter_pubkey = EXCLUDED.reporter_pubkey,
			reason = EXCLUDED.reason,
			created_at = EXCLUDED.created_at
		RETURNING id, created_at
	`, req.OrgID, req.EpochID, req.MemoryContentHash, req.ServeKeyPubkey, req.ServeSig, req.Nonce, req.ContributorID, req.ModelID, req.TurnCount, matchedKeywords, reporterPubkey, EventTypeServe).Scan(&id, &createdAt)
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
		SELECT id, org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce, COALESCE(serve_fingerprint, ''), contributor_id, model_id, turn_count, matched_keywords, reporter_pubkey, reason, event_type, status, tx_hash, created_at, submitted_at
		FROM serve_events WHERE id = $1
	`, id).Scan(
		&record.ID, &record.OrgID, &record.EpochID, &record.MemoryContentHash,
		&record.ServeKeyPubkey, &record.ServeSig, &record.Nonce, &record.ServeFingerprint, &record.ContributorID, &record.ModelID,
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
		SELECT id, org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce, COALESCE(serve_fingerprint, ''), contributor_id, model_id, turn_count, matched_keywords, reporter_pubkey, reason, event_type, status, tx_hash, created_at, submitted_at
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

func GetPendingServes(ctx context.Context, pool *pgxpool.Pool, orgID string, limit int) ([]ServeEventRecord, error) {
	rows, err := pool.Query(ctx, `
		SELECT se.id, se.org_id, se.epoch_id, se.memory_content_hash, se.serve_key_pubkey, se.serve_sig, se.nonce, COALESCE(se.serve_fingerprint, ''), se.contributor_id, se.model_id, se.turn_count, se.matched_keywords, se.reporter_pubkey, se.reason, se.event_type, se.status, se.tx_hash, se.created_at, se.submitted_at, COALESCE(m.wallet_address, '')
		FROM serve_events se
		JOIN members m ON m.org_id = se.org_id AND m.pubkey = se.contributor_id
		WHERE se.org_id = $1 AND se.status = 'pending' AND se.event_type = 'serve'
		ORDER BY se.created_at ASC
		LIMIT $2
	`, orgID, limit)
	if err != nil {
		return nil, fmt.Errorf("query pending serves: %w", err)
	}
	defer rows.Close()

	var records []ServeEventRecord
	for rows.Next() {
		var r ServeEventRecord
		err := rows.Scan(
			&r.ID, &r.OrgID, &r.EpochID, &r.MemoryContentHash,
			&r.ServeKeyPubkey, &r.ServeSig, &r.Nonce, &r.ServeFingerprint, &r.ContributorID, &r.ModelID,
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

func GetPendingDenials(ctx context.Context, pool *pgxpool.Pool, orgID string, limit int) ([]ServeEventRecord, error) {
	rows, err := pool.Query(ctx, `
		SELECT id, org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce, COALESCE(serve_fingerprint, ''), contributor_id, model_id, turn_count, matched_keywords, reporter_pubkey, reason, event_type, status, tx_hash, created_at, submitted_at
		FROM serve_events
		WHERE org_id = $1 AND status = 'pending' AND event_type = 'denial'
		ORDER BY created_at ASC
		LIMIT $2
	`, orgID, limit)
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

func HasPendingEvents(ctx context.Context, pool *pgxpool.Pool, orgID string) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM serve_events
			WHERE org_id = $1 AND status = 'pending'
		)
	`, orgID).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check pending serve events: %w", err)
	}
	return exists, nil
}
