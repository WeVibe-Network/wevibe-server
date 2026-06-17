package orgs

import (
	"context"
	"encoding/hex"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/billing"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

func CreateOrg(ctx context.Context, pool *pgxpool.Pool, orgID string, req protocol.CreateOrgRequest) (*protocol.OrgInfo, error) {
	// FeeModel is a value-type struct; zero value is valid (all fields empty/zero → "{}")
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	orgID = strings.TrimSpace(orgID)
	if orgID == "" {
		return nil, fmt.Errorf("org_id is required")
	}

	leaderWallet := strings.TrimSpace(req.LeaderWallet)
	if leaderWallet == "" {
		return nil, fmt.Errorf("leader_wallet is required")
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO orgs (org_id, leader_pubkey, leader_wallet_address, org_name, domain, description, tech_stack, focus_areas, fee_model)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, orgID, req.LeaderPubkey, leaderWallet, req.OrgName, req.Domain, req.Description, req.TechStack, req.FocusAreas, req.FeeModel)
	if err != nil {
		return nil, fmt.Errorf("insert org: %w", err)
	}

	umbralPKBytes, err := hex.DecodeString(req.UmbralPK)
	if err != nil {
		return nil, fmt.Errorf("invalid umbral_pk hex: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO epoch_manifests (org_id, epoch_id, pk_mod, umbral_pk, signed_by, signature)
		VALUES ($1, 0, $2, $3, $4, $5)
	`, orgID, req.PkMod, umbralPKBytes, req.LeaderPubkey, req.Signature)
	if err != nil {
		return nil, fmt.Errorf("insert epoch manifest: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO members (org_id, pubkey, x25519_pubkey, role, join_epoch, wallet_address, membership_active, chain_confirmed)
		VALUES ($1, $2, $3, 'leader', 0, $4, TRUE, TRUE)
	`, orgID, req.LeaderPubkey, req.LeaderX25519Pubkey, leaderWallet)
	if err != nil {
		return nil, fmt.Errorf("insert leader member: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}

	if err := billing.ProvisionOrgLedger(ctx, pool, orgID, req.FeeModel.MonthlyCredits, req.LeaderPubkey); err != nil {
		return nil, fmt.Errorf("provision billing ledger: %w", err)
	}

	return GetOrg(ctx, pool, orgID)
}

func GetOrg(ctx context.Context, pool *pgxpool.Pool, orgID string) (*protocol.OrgInfo, error) {
	var org protocol.OrgInfo
	err := pool.QueryRow(ctx, `
		SELECT org_id, org_name, domain, description, tech_stack, focus_areas, leader_pubkey, current_epoch,
		       egress_mode, allowed_providers, status, rotation_status,
		       created_at
		FROM orgs WHERE org_id = $1
	`, orgID).Scan(
		&org.OrgID, &org.OrgName, &org.Domain, &org.Description, &org.TechStack, &org.FocusAreas, &org.LeaderPubkey,
		&org.CurrentEpoch, &org.EgressMode, &org.AllowedProviders,
		&org.Status, &org.RotationStatus, &org.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &org, nil
}

func GetOrgIDByLeader(ctx context.Context, pool *pgxpool.Pool, leaderPubkey string) (string, error) {
	var orgID string
	err := pool.QueryRow(ctx, `
		SELECT org_id
		FROM orgs
		WHERE leader_pubkey = $1 AND status = 'active'
		LIMIT 1
	`, leaderPubkey).Scan(&orgID)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return orgID, nil
}

func SetChainRegistered(ctx context.Context, pool *pgxpool.Pool, orgID string, registered bool) error {
	_, err := pool.Exec(ctx, `
		UPDATE orgs
		SET chain_registered = $2, updated_at = NOW()
		WHERE org_id = $1
	`, orgID, registered)
	return err
}

func SetRotationPending(ctx context.Context, pool *pgxpool.Pool, orgID string) error {
	_, err := pool.Exec(ctx, `
		UPDATE orgs 
		SET rotation_status = 'rotation_pending', rotation_pending_since = NOW(), updated_at = NOW()
		WHERE org_id = $1
	`, orgID)
	return err
}

func ClearRotationPending(ctx context.Context, pool *pgxpool.Pool, orgID string) error {
	_, err := pool.Exec(ctx, `
		UPDATE orgs 
		SET rotation_status = 'active', rotation_pending_since = NULL, updated_at = NOW()
		WHERE org_id = $1
	`, orgID)
	return err
}

func IsRotationPending(ctx context.Context, pool *pgxpool.Pool, orgID string) (bool, error) {
	var status string
	err := pool.QueryRow(ctx, `
		SELECT rotation_status FROM orgs WHERE org_id = $1
	`, orgID).Scan(&status)
	if err != nil {
		return false, err
	}
	return status == "rotation_pending", nil
}

func GetRotationPendingSince(ctx context.Context, pool *pgxpool.Pool, orgID string) (*time.Time, error) {
	var since *time.Time
	err := pool.QueryRow(ctx, `
		SELECT rotation_pending_since FROM orgs WHERE org_id = $1
	`, orgID).Scan(&since)
	if err != nil {
		return nil, err
	}
	return since, nil
}

func BufferSubmission(ctx context.Context, pool *pgxpool.Pool, orgID string, req protocol.SubmitMemoryRequest) error {
	memoryType := strings.TrimSpace(req.MemoryType)
	if !protocol.IsValidMemoryType(memoryType) {
		return fmt.Errorf("invalid memory_type: %s", req.MemoryType)
	}

	canonical := verify.SubmitMemoryMessage(
		req.OrgID,
		req.EpochID,
		req.SubmissionHash,
		req.ContributorPubkey,
		memoryType,
		req.CiphertextHash,
		req.PlaintextHash,
		req.Salt,
		req.WrappedDekHash,
	)
	if err := verify.RequestSignature(req.ContributorPubkey, req.ContributorSig, canonical); err != nil {
		return fmt.Errorf("rotation buffer signature verification failed: %w", err)
	}

	_, err := pool.Exec(ctx, `
		INSERT INTO rotation_buffer (org_id, epoch_id, contributor_pubkey, ciphertext_hex, wrapped_dek_mod, contributor_sig, submission_hash, stack_hint, memory_type, plaintext_hash, salt, ciphertext_hash, wrapped_dek_hash)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
	`, orgID, req.EpochID, req.ContributorPubkey, req.Ciphertext, req.WrappedDekMod, req.ContributorSig, req.SubmissionHash, req.StackHint, memoryType, req.PlaintextHash, req.Salt, req.CiphertextHash, req.WrappedDekHash)
	return err
}

func FinalizeRotationBuffer(ctx context.Context, pool *pgxpool.Pool, orgID string, newEpochID int) (int, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `
		SELECT buffer_id, org_id, epoch_id, contributor_pubkey, ciphertext_hex, wrapped_dek_mod, contributor_sig, submission_hash, stack_hint, memory_type, plaintext_hash, salt, ciphertext_hash, wrapped_dek_hash
		FROM rotation_buffer
		WHERE org_id = $1
		ORDER BY created_at
	`, orgID)
	if err != nil {
		return 0, fmt.Errorf("query buffer: %w", err)
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var bufID, bOrgID, pubkey, ct, dek, sig, hash, memoryType string
		var epochID int
		var plaintextHash, salt, ciphertextHash, wrappedDekHash string
		var stackHint []string
		if err := rows.Scan(&bufID, &bOrgID, &epochID, &pubkey, &ct, &dek, &sig, &hash, &stackHint, &memoryType, &plaintextHash, &salt, &ciphertextHash, &wrappedDekHash); err != nil {
			return 0, fmt.Errorf("scan buffer row: %w", err)
		}

		canonical := verify.SubmitMemoryMessage(
			bOrgID,
			epochID,
			hash,
			pubkey,
			memoryType,
			ciphertextHash,
			plaintextHash,
			salt,
			wrappedDekHash,
		)
		if err := verify.RequestSignature(pubkey, sig, canonical); err != nil {
			log.Printf("warning: skipping rotation buffer row with invalid signature: org_id=%s buffer_id=%s submission_hash=%s error=%v", bOrgID, bufID, hash, err)
			continue
		}

		_, err := tx.Exec(ctx, `
			INSERT INTO pending_submissions (submission_hash, org_id, epoch_id, contributor_pubkey, ciphertext_hex, plaintext_hash, salt, ciphertext_hash, wrapped_dek_hash, wrapped_dek_mod, contributor_sig, stack_hint, memory_type)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
			ON CONFLICT (submission_hash) DO NOTHING
		`, hash, orgID, newEpochID, pubkey, ct, plaintextHash, salt, ciphertextHash, wrappedDekHash, dek, sig, stackHint, memoryType)
		if err != nil {
			return 0, fmt.Errorf("insert pending from buffer: %w", err)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("rows error: %w", err)
	}

	_, err = tx.Exec(ctx, `DELETE FROM rotation_buffer WHERE org_id = $1`, orgID)
	if err != nil {
		return 0, fmt.Errorf("clear buffer: %w", err)
	}

	return count, tx.Commit(ctx)
}

func RotateEpoch(ctx context.Context, pool *pgxpool.Pool, orgID string, req protocol.RotateEpochRequest) error {
	org, err := GetOrg(ctx, pool, orgID)
	if err != nil {
		return fmt.Errorf("get org: %w", err)
	}

	newEpoch := org.CurrentEpoch + 1

	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `
		UPDATE orgs SET current_epoch = $1, updated_at = NOW() WHERE org_id = $2
	`, newEpoch, orgID)
	if err != nil {
		return fmt.Errorf("update epoch: %w", err)
	}

	umbralPKBytes, err := hex.DecodeString(req.UmbralPK)
	if err != nil {
		return fmt.Errorf("invalid umbral_pk hex: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO epoch_manifests (org_id, epoch_id, pk_mod, umbral_pk, signed_by, signature)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, orgID, newEpoch, req.NewPkMod, umbralPKBytes, req.SignedBy, req.Signature)
	if err != nil {
		return fmt.Errorf("insert manifest: %w", err)
	}

	return tx.Commit(ctx)
}

func GetEpochManifest(ctx context.Context, pool *pgxpool.Pool, orgID string, epochID int) (*protocol.EpochManifestResponse, error) {
	var m protocol.EpochManifestResponse
	var umbralPK []byte
	var err error

	if epochID == -1 {
		err = pool.QueryRow(ctx, `
			SELECT em.org_id, em.epoch_id, em.pk_mod, em.umbral_pk, em.signed_by, em.signature, em.created_at
			FROM epoch_manifests em
			JOIN orgs o ON o.org_id = em.org_id AND o.current_epoch = em.epoch_id
			WHERE em.org_id = $1
		`, orgID).Scan(
			&m.OrgID, &m.EpochID, &m.PkMod, &umbralPK, &m.SignedBy, &m.Signature, &m.CreatedAt,
		)
	} else {
		err = pool.QueryRow(ctx, `
			SELECT em.org_id, em.epoch_id, em.pk_mod, em.umbral_pk, em.signed_by, em.signature, em.created_at
			FROM epoch_manifests em
			WHERE em.org_id = $1 AND em.epoch_id = $2
		`, orgID, epochID).Scan(
			&m.OrgID, &m.EpochID, &m.PkMod, &umbralPK, &m.SignedBy, &m.Signature, &m.CreatedAt,
		)
	}
	if err != nil {
		return nil, err
	}
	if len(umbralPK) > 0 {
		m.UmbralPK = hex.EncodeToString(umbralPK)
	}
	return &m, nil
}

func GetLeaderPubkey(ctx context.Context, pool *pgxpool.Pool, orgID string) (string, error) {
	var leaderPubkey string
	err := pool.QueryRow(ctx, `
		SELECT leader_pubkey FROM orgs WHERE org_id = $1
	`, orgID).Scan(&leaderPubkey)
	if err != nil {
		return "", err
	}
	return leaderPubkey, nil
}

func GetCurrentEpoch(ctx context.Context, pool *pgxpool.Pool, orgID string) (int, error) {
	var epoch int
	err := pool.QueryRow(ctx, `
		SELECT current_epoch FROM orgs WHERE org_id = $1
	`, orgID).Scan(&epoch)
	if err != nil {
		return 0, err
	}
	return epoch, nil
}

func OrgExists(ctx context.Context, pool *pgxpool.Pool, orgID string) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx, `
        SELECT EXISTS(SELECT 1 FROM orgs WHERE org_id = $1)
    `, orgID).Scan(&exists)
	if err != nil && err != pgx.ErrNoRows {
		return false, err
	}
	return exists, nil
}

func EpochExists(ctx context.Context, pool *pgxpool.Pool, orgID string, epochID int) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM epoch_manifests WHERE org_id = $1 AND epoch_id = $2)
	`, orgID, epochID).Scan(&exists)
	if err != nil && err != pgx.ErrNoRows {
		return false, err
	}
	return exists, nil
}

func GetOrgStatus(ctx context.Context, pool *pgxpool.Pool, orgID string) (string, error) {
	var status string
	err := pool.QueryRow(ctx, `
		SELECT status FROM orgs WHERE org_id = $1
	`, orgID).Scan(&status)
	if err != nil {
		return "", err
	}
	return status, nil
}
