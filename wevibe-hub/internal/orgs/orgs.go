package orgs

import (
	"context"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/billing"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
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

	umbralPKBytes, err := hex.DecodeString(req.UmbralPK)
	if err != nil {
		return nil, fmt.Errorf("invalid umbral_pk hex: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO orgs (org_id, leader_pubkey, leader_wallet_address, org_name, domain, description, tech_stack, focus_areas, fee_model,
		                  pk_mod, umbral_pk, manifest_signed_by, manifest_signature)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
	`, orgID, req.LeaderPubkey, leaderWallet, req.OrgName, req.Domain, req.Description, req.TechStack, req.FocusAreas, req.FeeModel,
		req.PkMod, umbralPKBytes, req.LeaderPubkey, req.Signature)
	if err != nil {
		return nil, fmt.Errorf("insert org: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO members (org_id, pubkey, x25519_pubkey, role, wallet_address, membership_active, chain_confirmed)
		VALUES ($1, $2, $3, 'leader', $4, TRUE, TRUE)
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
		SELECT org_id, org_name, domain, description, tech_stack, focus_areas, leader_pubkey,
		       egress_mode, allowed_providers, status,
		       created_at
		FROM orgs WHERE org_id = $1
	`, orgID).Scan(
		&org.OrgID, &org.OrgName, &org.Domain, &org.Description, &org.TechStack, &org.FocusAreas, &org.LeaderPubkey,
		&org.EgressMode, &org.AllowedProviders,
		&org.Status, &org.CreatedAt,
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

// GetEpochManifest serves the org's single static crypto manifest (re-homed
// into the orgs row). The epochID parameter is intentionally ignored — epoch
// rotation is retired and the manifest is constant for the org's lifetime.
func GetEpochManifest(ctx context.Context, pool *pgxpool.Pool, orgID string, epochID int) (*protocol.EpochManifestResponse, error) {
	var m protocol.EpochManifestResponse
	var umbralPK []byte
	err := pool.QueryRow(ctx, `
		SELECT org_id, pk_mod, umbral_pk, manifest_signed_by, manifest_signature, created_at
		FROM orgs WHERE org_id = $1
	`, orgID).Scan(
		&m.OrgID, &m.PkMod, &umbralPK, &m.SignedBy, &m.Signature, &m.CreatedAt,
	)
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
