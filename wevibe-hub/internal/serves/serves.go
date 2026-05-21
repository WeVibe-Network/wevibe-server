package serves

import (
	"context"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
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
	ServeKey          string `json:"serve_key"`
	ContributorID     string `json:"contributor_id"`
	Nullifier         string `json:"nullifier"`
	ModelID           string `json:"model_id"`
	TurnCount         int    `json:"turn_count"`
}

type RecordDenialRequest struct {
	OrgID             string `json:"org_id"`
	EpochID           int    `json:"epoch_id"`
	MemoryContentHash string `json:"memory_content_hash"`
	Nullifier         string `json:"nullifier"`
	Reason            string `json:"reason"`
}

type ServeEventRecord struct {
	ID                int64      `json:"id"`
	OrgID             string     `json:"org_id"`
	EpochID           int        `json:"epoch_id"`
	MemoryContentHash string     `json:"memory_content_hash"`
	ServeKey          string     `json:"serve_key"`
	ContributorID     string     `json:"contributor_id"`
	ContributorWallet string     `json:"contributor_wallet"`
	Nullifier         string     `json:"nullifier"`
	ModelID           string     `json:"model_id"`
	TurnCount         int        `json:"turn_count"`
	ReporterPubkey    string     `json:"reporter_pubkey"`
	Reason            string     `json:"reason"`
	EventType         string     `json:"event_type"`
	Status            string     `json:"status"`
	TxHash            *string    `json:"tx_hash,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	SubmittedAt       *time.Time `json:"submitted_at,omitempty"`
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

	if req.ServeKey == "" {
		return nil, fmt.Errorf("serve_key is required")
	}
	if req.ContributorID == "" {
		return nil, fmt.Errorf("contributor_id is required")
	}
	if req.Nullifier == "" {
		return nil, fmt.Errorf("nullifier is required")
	}
	if len(req.Nullifier) != 64 {
		return nil, fmt.Errorf("nullifier must be 64 hex characters (32 bytes)")
	}
	if _, err := hex.DecodeString(req.Nullifier); err != nil {
		return nil, fmt.Errorf("nullifier must be valid hex")
	}
	if req.EpochID < 0 {
		return nil, fmt.Errorf("epoch_id must be non-negative")
	}

	var id int64
	var createdAt time.Time
	err := pool.QueryRow(ctx, `
		INSERT INTO serve_events (org_id, epoch_id, memory_content_hash, serve_key, contributor_id, nullifier, model_id, turn_count, reporter_pubkey, reason, event_type, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, 'pending')
		ON CONFLICT (org_id, nullifier) DO UPDATE SET
			reporter_pubkey = EXCLUDED.reporter_pubkey,
			reason = EXCLUDED.reason,
			event_type = EXCLUDED.event_type,
			created_at = EXCLUDED.created_at
		RETURNING id, created_at
	`, req.OrgID, req.EpochID, req.MemoryContentHash, req.ServeKey, req.ContributorID, req.Nullifier, req.ModelID, req.TurnCount, reporterPubkey, EventTypeServe).Scan(&id, &createdAt)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "unique") {
			return nil, fmt.Errorf("duplicate serve event: nullifier already recorded for this org")
		}
		return nil, fmt.Errorf("insert serve event: %w", err)
	}

	var record ServeEventRecord
	err = pool.QueryRow(ctx, `
		SELECT id, org_id, epoch_id, memory_content_hash, serve_key, contributor_id, nullifier, model_id, turn_count, reporter_pubkey, reason, event_type, status, tx_hash, created_at, submitted_at
		FROM serve_events WHERE id = $1
	`, id).Scan(
		&record.ID, &record.OrgID, &record.EpochID, &record.MemoryContentHash,
		&record.ServeKey, &record.ContributorID, &record.Nullifier, &record.ModelID,
		&record.TurnCount, &record.ReporterPubkey, &record.Reason, &record.EventType, &record.Status, &record.TxHash,
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
	if req.Nullifier == "" {
		return nil, fmt.Errorf("nullifier is required")
	}
	if len(req.Nullifier) != 64 {
		return nil, fmt.Errorf("nullifier must be 64 hex characters (32 bytes)")
	}
	if _, err := hex.DecodeString(req.Nullifier); err != nil {
		return nil, fmt.Errorf("nullifier must be valid hex")
	}
	if req.Reason == "" {
		return nil, fmt.Errorf("reason is required")
	}
	if req.EpochID < 0 {
		return nil, fmt.Errorf("epoch_id must be non-negative")
	}

	var id int64
	var createdAt time.Time
	err := pool.QueryRow(ctx, `
		INSERT INTO serve_events (org_id, epoch_id, memory_content_hash, serve_key, contributor_id, nullifier, model_id, turn_count, reporter_pubkey, reason, event_type, status)
		VALUES ($1, $2, $3, $4, $5, $6, '', 0, $7, $8, $9, 'pending')
		ON CONFLICT (org_id, nullifier) DO UPDATE SET
			reporter_pubkey = EXCLUDED.reporter_pubkey,
			reason = EXCLUDED.reason,
			event_type = EXCLUDED.event_type,
			created_at = EXCLUDED.created_at
		RETURNING id, created_at
	`, req.OrgID, req.EpochID, req.MemoryContentHash, reporterPubkey, reporterPubkey, req.Nullifier, reporterPubkey, req.Reason, EventTypeDenial).Scan(&id, &createdAt)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "unique") {
			return nil, fmt.Errorf("duplicate denial event: nullifier already recorded for this org")
		}
		return nil, fmt.Errorf("insert denial event: %w", err)
	}

	var record ServeEventRecord
	err = pool.QueryRow(ctx, `
		SELECT id, org_id, epoch_id, memory_content_hash, serve_key, contributor_id, nullifier, model_id, turn_count, reporter_pubkey, reason, event_type, status, tx_hash, created_at, submitted_at
		FROM serve_events WHERE id = $1
	`, id).Scan(
		&record.ID, &record.OrgID, &record.EpochID, &record.MemoryContentHash,
		&record.ServeKey, &record.ContributorID, &record.Nullifier, &record.ModelID,
		&record.TurnCount, &record.ReporterPubkey, &record.Reason, &record.EventType, &record.Status, &record.TxHash,
		&record.CreatedAt, &record.SubmittedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("fetch denial event: %w", err)
	}

	return &record, nil
}

func GetPendingServes(ctx context.Context, pool *pgxpool.Pool, orgID string, limit int) ([]ServeEventRecord, error) {
	rows, err := pool.Query(ctx, `
		SELECT se.id, se.org_id, se.epoch_id, se.memory_content_hash, se.serve_key, se.contributor_id, se.nullifier, se.model_id, se.turn_count, se.reporter_pubkey, se.reason, se.event_type, se.status, se.tx_hash, se.created_at, se.submitted_at, m.wallet_address
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
			&r.ServeKey, &r.ContributorID, &r.Nullifier, &r.ModelID,
			&r.TurnCount, &r.ReporterPubkey, &r.Reason, &r.EventType, &r.Status, &r.TxHash,
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
		SELECT id, org_id, epoch_id, memory_content_hash, serve_key, contributor_id, nullifier, model_id, turn_count, reporter_pubkey, reason, event_type, status, tx_hash, created_at, submitted_at
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
			&r.ServeKey, &r.ContributorID, &r.Nullifier, &r.ModelID,
			&r.TurnCount, &r.ReporterPubkey, &r.Reason, &r.EventType, &r.Status, &r.TxHash,
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

func MarkSubmitted(ctx context.Context, pool *pgxpool.Pool, ids []int64, txHash string) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := pool.Exec(ctx, `
		UPDATE serve_events
		SET status = 'submitted', tx_hash = $1, submitted_at = NOW()
		WHERE id = ANY($2)
	`, txHash, ids)
	if err != nil {
		return fmt.Errorf("mark submitted: %w", err)
	}
	return nil
}

func MarkFailed(ctx context.Context, pool *pgxpool.Pool, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := pool.Exec(ctx, `
		UPDATE serve_events
		SET status = 'failed'
		WHERE id = ANY($1)
	`, ids)
	if err != nil {
		return fmt.Errorf("mark failed: %w", err)
	}
	return nil
}

func CountPending(ctx context.Context, pool *pgxpool.Pool, orgID string) (int64, error) {
	var count int64
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM serve_events WHERE org_id = $1 AND status = 'pending' AND event_type = 'serve'
	`, orgID).Scan(&count)
	if err != nil && err != pgx.ErrNoRows {
		return 0, fmt.Errorf("count pending: %w", err)
	}
	return count, nil
}

func GetServeEventByNullifier(ctx context.Context, pool *pgxpool.Pool, orgID, nullifier string) (*ServeEventRecord, error) {
	var r ServeEventRecord
	err := pool.QueryRow(ctx, `
		SELECT id, org_id, epoch_id, memory_content_hash, serve_key, contributor_id, nullifier, model_id, turn_count, reporter_pubkey, reason, event_type, status, tx_hash, created_at, submitted_at
		FROM serve_events
		WHERE org_id = $1 AND nullifier = $2
	`, orgID, nullifier).Scan(
		&r.ID, &r.OrgID, &r.EpochID, &r.MemoryContentHash,
		&r.ServeKey, &r.ContributorID, &r.Nullifier, &r.ModelID,
		&r.TurnCount, &r.ReporterPubkey, &r.Reason, &r.EventType, &r.Status, &r.TxHash,
		&r.CreatedAt, &r.SubmittedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get serve event: %w", err)
	}
	return &r, nil
}
