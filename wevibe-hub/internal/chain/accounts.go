package chain

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/cosmos/cosmos-sdk/crypto/hd"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// OrgKeyRole identifies which of an org's two hub-held, faucet-funded chain
// keys is in play. The serving key signs serves/denials (registered on-chain as
// HubServingAddress); the leader key signs commit/approve/report/register
// (registered on-chain as the LeaderWallet). The two authorities are kept
// distinct and independently revocable per D-S32-CO044-KEY-SEPARATION.
type OrgKeyRole string

const (
	OrgKeyServing OrgKeyRole = "serving"
	OrgKeyLeader  OrgKeyRole = "leader"
)

func (r OrgKeyRole) valid() bool {
	return r == OrgKeyServing || r == OrgKeyLeader
}

func (c *GrpcClient) DeriveOrgAccount(orgID string, accountIndex int64, role OrgKeyRole) (uid string, addr string, err error) {
	trimmedOrgID := strings.TrimSpace(orgID)
	if trimmedOrgID == "" {
		return "", "", errors.New("orgID is required")
	}
	if !role.valid() {
		return "", "", fmt.Errorf("invalid org key role %q", role)
	}
	if accountIndex < 0 {
		return "", "", fmt.Errorf("invalid account index %d", accountIndex)
	}
	if c.mnemonic == "" {
		return "", "", errors.New("hub mnemonic not configured")
	}

	uid = fmt.Sprintf("org-%s-%s", role, trimmedOrgID)

	info, keyErr := c.kr.Key(uid)
	if keyErr != nil {
		hdPath := fmt.Sprintf("m/44'/118'/0'/0/%d", accountIndex)
		info, err = c.kr.NewAccount(uid, c.mnemonic, "", hdPath, hd.Secp256k1)
		if err != nil {
			return "", "", fmt.Errorf("derive org key %s: %w", uid, err)
		}
	}

	address, err := info.GetAddress()
	if err != nil {
		return "", "", fmt.Errorf("resolve org key address %s: %w", uid, err)
	}

	return uid, address.String(), nil
}

func (c *GrpcClient) EnsureOrgAccount(ctx context.Context, db *pgxpool.Pool, orgID string, role OrgKeyRole) (address string, keyringUID string, err error) {
	trimmedOrgID := strings.TrimSpace(orgID)
	if trimmedOrgID == "" {
		return "", "", errors.New("orgID is required")
	}
	if !role.valid() {
		return "", "", fmt.Errorf("invalid org key role %q", role)
	}
	if db == nil {
		return "", "", fmt.Errorf("db is required")
	}

	const selectSQL = `
		SELECT account_index, chain_address
		FROM org_chain_accounts
		WHERE org_id = $1 AND key_role = $2
	`

	var (
		accountIndex int64
		chainAddress string
	)

	err = db.QueryRow(ctx, selectSQL, trimmedOrgID, string(role)).Scan(&accountIndex, &chainAddress)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", "", fmt.Errorf("query org chain account %s/%s: %w", trimmedOrgID, role, err)
		}

		// Account index must come from the DB sequence, never from app hashing.
		err = db.QueryRow(ctx, `SELECT nextval('org_account_index_seq')`).Scan(&accountIndex)
		if err != nil {
			return "", "", fmt.Errorf("reserve org account index %s/%s: %w", trimmedOrgID, role, err)
		}

		uid, derivedAddr, err := c.DeriveOrgAccount(trimmedOrgID, accountIndex, role)
		if err != nil {
			return "", "", err
		}

		const insertSQL = `
			INSERT INTO org_chain_accounts (org_id, key_role, account_index, chain_address)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (org_id, key_role) DO NOTHING
		`

		_, err = db.Exec(ctx, insertSQL, trimmedOrgID, string(role), accountIndex, derivedAddr)
		if err != nil {
			return "", "", fmt.Errorf("insert org chain account %s/%s: %w", trimmedOrgID, role, err)
		}

		err = db.QueryRow(ctx, selectSQL, trimmedOrgID, string(role)).Scan(&accountIndex, &chainAddress)
		if err != nil {
			return "", "", fmt.Errorf("query org chain account after insert %s/%s: %w", trimmedOrgID, role, err)
		}

		if chainAddress != derivedAddr {
			return "", "", fmt.Errorf("org chain account address mismatch for %s/%s", trimmedOrgID, role)
		}

		return derivedAddr, uid, nil
	}

	uid, derivedAddr, err := c.DeriveOrgAccount(trimmedOrgID, accountIndex, role)
	if err != nil {
		return "", "", err
	}

	if chainAddress != derivedAddr {
		return "", "", fmt.Errorf("org chain account address mismatch for %s/%s", trimmedOrgID, role)
	}

	return derivedAddr, uid, nil
}

// MarkOrgAccountFunded flags an org's role-keyed chain account as faucet-funded.
// Called after a successful FundAddressFromFaucet so org_chain_accounts.funded
// reflects reality.
func (c *GrpcClient) MarkOrgAccountFunded(ctx context.Context, db *pgxpool.Pool, orgID string, role OrgKeyRole) error {
	if db == nil {
		return fmt.Errorf("db is required")
	}
	if !role.valid() {
		return fmt.Errorf("invalid org key role %q", role)
	}
	tag, err := db.Exec(ctx, `
		UPDATE org_chain_accounts SET funded = TRUE
		WHERE org_id = $1 AND key_role = $2
	`, strings.TrimSpace(orgID), string(role))
	if err != nil {
		return fmt.Errorf("mark org account funded %s/%s: %w", orgID, role, err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("org chain account %s/%s not found to mark funded", orgID, role)
	}
	return nil
}
