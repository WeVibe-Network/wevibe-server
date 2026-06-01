package members

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalidPrePubkey = errors.New("invalid pre_pubkey")

func InviteMember(ctx context.Context, pool *pgxpool.Pool, orgID string, currentEpoch int, req protocol.InviteMemberRequest) (*protocol.MemberRecord, error) {
	var prePubkey []byte
	if req.PrePubkey != "" {
		decoded, err := hex.DecodeString(req.PrePubkey)
		if err != nil {
			return nil, fmt.Errorf("%w: must be valid hex", ErrInvalidPrePubkey)
		}
		if len(decoded) != 33 {
			return nil, fmt.Errorf("%w: must be exactly 33 bytes", ErrInvalidPrePubkey)
		}
		prePubkey = decoded
	}

	_, err := pool.Exec(ctx, `
		INSERT INTO members (org_id, pubkey, x25519_pubkey, pre_pubkey, role, join_epoch)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, orgID, req.Pubkey, req.X25519Pubkey, prePubkey, req.Role, currentEpoch)
	if err != nil {
		return nil, fmt.Errorf("insert member: %w", err)
	}
	return GetMember(ctx, pool, orgID, req.Pubkey)
}

func SetPrePubkey(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string, prePubkey []byte) error {
	tag, err := pool.Exec(ctx, `
		UPDATE members
		SET pre_pubkey = $1, updated_at = NOW()
		WHERE org_id = $2 AND pubkey = $3 AND active = true
	`, prePubkey, orgID, pubkey)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func GetPrePubkey(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string) ([]byte, error) {
	var prePubkey []byte
	err := pool.QueryRow(ctx, `
		SELECT pre_pubkey
		FROM members
		WHERE org_id = $1 AND pubkey = $2 AND active = true
	`, orgID, pubkey).Scan(&prePubkey)
	if err != nil {
		return nil, err
	}
	if prePubkey == nil {
		return nil, pgx.ErrNoRows
	}
	return prePubkey, nil
}

func GetMember(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string) (*protocol.MemberRecord, error) {
	var m protocol.MemberRecord
	err := pool.QueryRow(ctx, `
		SELECT org_id, pubkey, x25519_pubkey, role, join_epoch,
			   history_access_from_epoch, authorized_until_epoch, active, membership_active, joined_at, wallet_address
		FROM members WHERE org_id = $1 AND pubkey = $2
	`, orgID, pubkey).Scan(
		&m.OrgID, &m.Pubkey, &m.X25519Pubkey, &m.Role, &m.JoinEpoch,
		&m.HistoryAccessFromEpoch, &m.AuthorizedUntilEpoch, &m.Active, &m.MembershipActive, &m.JoinedAt, &m.WalletAddress,
	)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func RemoveMember(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string, currentEpoch int) error {
	_, err := pool.Exec(ctx, `
		UPDATE members
		SET active = false, authorized_until_epoch = $1, updated_at = NOW()
		WHERE org_id = $2 AND pubkey = $3
	`, currentEpoch, orgID, pubkey)
	return err
}

func LinkWallet(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey, walletAddress string) error {
	tag, err := pool.Exec(ctx,
		`UPDATE members SET wallet_address = $1 WHERE org_id = $2 AND pubkey = $3 AND active = true`,
		walletAddress, orgID, pubkey)
	if err != nil {
		return fmt.Errorf("update wallet address: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("member not found or inactive")
	}
	return nil
}

func GetWalletAddress(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string) (*string, error) {
	var wallet *string
	err := pool.QueryRow(ctx,
		`SELECT wallet_address FROM members WHERE org_id = $1 AND pubkey = $2`,
		orgID, pubkey).Scan(&wallet)
	if err != nil {
		return nil, err
	}
	return wallet, nil
}

func ListMembers(ctx context.Context, pool *pgxpool.Pool, orgID string) ([]protocol.MemberRecord, error) {
	rows, err := pool.Query(ctx, `
		SELECT org_id, pubkey, x25519_pubkey, role, join_epoch,
			   history_access_from_epoch, authorized_until_epoch, active, joined_at, wallet_address,
			   dismissed_reports_count
		FROM members WHERE org_id = $1 ORDER BY joined_at
	`, orgID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[protocol.MemberRecord])
}

func VerifyMemberAccess(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string, requestedEpoch int) (bool, error) {
	var m protocol.MemberRecord
	err := pool.QueryRow(ctx, `
		SELECT history_access_from_epoch, authorized_until_epoch, active
		FROM members WHERE org_id = $1 AND pubkey = $2
	`, orgID, pubkey).Scan(&m.HistoryAccessFromEpoch, &m.AuthorizedUntilEpoch, &m.Active)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if requestedEpoch < m.HistoryAccessFromEpoch {
		return false, nil
	}
	if m.Active {
		return true, nil
	}
	if m.AuthorizedUntilEpoch != nil && requestedEpoch <= *m.AuthorizedUntilEpoch {
		return true, nil
	}
	return false, nil
}

func GetMemberRole(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string) (string, error) {
	var role string
	err := pool.QueryRow(ctx, `
		SELECT role FROM members WHERE org_id = $1 AND pubkey = $2 AND active = true
	`, orgID, pubkey).Scan(&role)
	if err == pgx.ErrNoRows {
		return "", fmt.Errorf("member not found or inactive")
	}
	if err != nil {
		return "", err
	}
	return role, nil
}

func GetTrialStatus(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string) (bool, *time.Time, error) {
	var isTrial bool
	var trialExpiresAt *time.Time
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(is_trial, false), trial_expires_at
		FROM members
		WHERE org_id = $1 AND pubkey = $2 AND active = true
	`, orgID, pubkey).Scan(&isTrial, &trialExpiresAt)
	if err != nil {
		return false, nil, err
	}
	return isTrial, trialExpiresAt, nil
}

func IsLeader(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string) (bool, error) {
	role, err := GetMemberRole(ctx, pool, orgID, pubkey)
	if err != nil {
		return false, nil
	}
	return role == "leader", nil
}

func ListOrgsForMember(ctx context.Context, pool *pgxpool.Pool, pubkey string) ([]protocol.MemberOrgEntry, error) {
	rows, err := pool.Query(ctx, `
		SELECT m.org_id, o.org_name, m.role, o.current_epoch,
			   m.history_access_from_epoch, o.egress_mode, o.allowed_providers, m.wallet_address
		FROM members m
		JOIN orgs o ON o.org_id = m.org_id
		WHERE m.pubkey = $1 AND m.active = true
	`, pubkey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []protocol.MemberOrgEntry
	for rows.Next() {
		var e protocol.MemberOrgEntry
		var allowedProviders []string
		if err := rows.Scan(
			&e.OrgID, &e.OrgName, &e.Role, &e.CurrentEpoch,
			&e.HistoryAccessFromEpoch, &e.EgressMode, &allowedProviders, &e.WalletAddress,
		); err != nil {
			return nil, err
		}
		e.AllowedProviders = allowedProviders

		var modPubkey *string
		err := pool.QueryRow(ctx, `
			SELECT em.pk_mod
			FROM epoch_manifests em
			JOIN orgs o ON o.org_id = em.org_id AND o.current_epoch = em.epoch_id
			WHERE em.org_id = $1
		`, e.OrgID).Scan(&modPubkey)
		if err != nil && err != pgx.ErrNoRows {
			return nil, err
		}
		e.ModPubkey = modPubkey

		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return entries, nil
}

func RegisterDelegateKey(ctx context.Context, pool *pgxpool.Pool, req *protocol.RegisterDelegateKeyRequest) error {
	var grantExp *time.Time
	if req.GrantExpiration != "" {
		t, err := time.Parse(time.RFC3339, req.GrantExpiration)
		if err != nil {
			return fmt.Errorf("invalid grant_expiration format: %w", err)
		}
		grantExp = &t
	}

	_, err := pool.Exec(ctx, `
		INSERT INTO delegate_keys (wallet_address, delegate_address, delegate_pubkey, grant_tx_hash, grant_expiration)
		VALUES ($1, $2, $3, $4, $5)
	`, req.WalletAddress, req.DelegateAddress, req.DelegatePubkey, req.GrantTxHash, grantExp)
	return err
}

func GetDelegateKey(ctx context.Context, pool *pgxpool.Pool, delegateAddress string) (*protocol.DelegateKeyRecord, error) {
	var r protocol.DelegateKeyRecord
	var grantExp *time.Time
	err := pool.QueryRow(ctx, `
		SELECT wallet_address, delegate_address, delegate_pubkey, grant_tx_hash, grant_expiration, active, created_at
		FROM delegate_keys WHERE delegate_address = $1
	`, delegateAddress).Scan(
		&r.WalletAddress, &r.DelegateAddress, &r.DelegatePubkey,
		&r.GrantTxHash, &grantExp, &r.Active, &r.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if grantExp != nil {
		t := grantExp.Format(time.RFC3339)
		r.GrantExpiration = &t
	}
	return &r, nil
}

func ResolveDelegateToWallet(ctx context.Context, pool *pgxpool.Pool, delegateAddress string) (string, error) {
	var walletAddress string
	err := pool.QueryRow(ctx, `
		SELECT wallet_address FROM delegate_keys
		WHERE delegate_address = $1 AND active = true
	`, delegateAddress).Scan(&walletAddress)
	if err != nil {
		return "", err
	}
	return walletAddress, nil
}

func RevokeDelegateKey(ctx context.Context, pool *pgxpool.Pool, walletAddress string) error {
	_, err := pool.Exec(ctx, `
		UPDATE delegate_keys SET active = false
		WHERE wallet_address = $1 AND active = true
	`, walletAddress)
	return err
}

func UpdateMemberRole(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey, newRole string) error {
	validRoles := map[string]bool{"moderator": true, "member": true}
	if !validRoles[newRole] {
		return fmt.Errorf("invalid role: %s (must be 'moderator' or 'member')", newRole)
	}

	tag, err := pool.Exec(ctx, `
		UPDATE members
		SET role = $1,
			member_tier = 'member',
			is_trial = false,
			trial_expires_at = NULL,
			updated_at = NOW()
		WHERE org_id = $2 AND pubkey = $3 AND active = true
	`, newRole, orgID, pubkey)
	if err != nil {
		return fmt.Errorf("update member role: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("member not found or inactive")
	}
	return nil
}
