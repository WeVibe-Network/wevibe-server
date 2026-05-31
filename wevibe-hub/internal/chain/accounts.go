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

func (c *GrpcClient) DeriveOrgAccount(orgID string, accountIndex int64) (uid string, addr string, err error) {
	trimmedOrgID := strings.TrimSpace(orgID)
	if trimmedOrgID == "" {
		return "", "", errors.New("orgID is required")
	}
	if accountIndex < 0 {
		return "", "", fmt.Errorf("invalid account index %d", accountIndex)
	}
	if c.mnemonic == "" {
		return "", "", errors.New("hub mnemonic not configured")
	}

	uid = fmt.Sprintf("org-serving-%s", trimmedOrgID)

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

func (c *GrpcClient) EnsureOrgAccount(ctx context.Context, db *pgxpool.Pool, orgID string) (address string, keyringUID string, err error) {
	trimmedOrgID := strings.TrimSpace(orgID)
	if trimmedOrgID == "" {
		return "", "", errors.New("orgID is required")
	}
	if db == nil {
		return "", "", fmt.Errorf("db is required")
	}

	const selectSQL = `
		SELECT account_index, chain_address
		FROM org_chain_accounts
		WHERE org_id = $1
	`

	var (
		accountIndex int64
		chainAddress string
	)

	err = db.QueryRow(ctx, selectSQL, trimmedOrgID).Scan(&accountIndex, &chainAddress)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", "", fmt.Errorf("query org chain account %s: %w", trimmedOrgID, err)
		}

		// Account index must come from the DB sequence, never from app hashing.
		err = db.QueryRow(ctx, `SELECT nextval('org_account_index_seq')`).Scan(&accountIndex)
		if err != nil {
			return "", "", fmt.Errorf("reserve org account index %s: %w", trimmedOrgID, err)
		}

		uid, derivedAddr, err := c.DeriveOrgAccount(trimmedOrgID, accountIndex)
		if err != nil {
			return "", "", err
		}

		const insertSQL = `
			INSERT INTO org_chain_accounts (org_id, account_index, chain_address)
			VALUES ($1, $2, $3)
			ON CONFLICT (org_id) DO NOTHING
		`

		_, err = db.Exec(ctx, insertSQL, trimmedOrgID, accountIndex, derivedAddr)
		if err != nil {
			return "", "", fmt.Errorf("insert org chain account %s: %w", trimmedOrgID, err)
		}

		err = db.QueryRow(ctx, selectSQL, trimmedOrgID).Scan(&accountIndex, &chainAddress)
		if err != nil {
			return "", "", fmt.Errorf("query org chain account after insert %s: %w", trimmedOrgID, err)
		}

		if chainAddress != derivedAddr {
			return "", "", fmt.Errorf("org chain account address mismatch for %s", trimmedOrgID)
		}

		return derivedAddr, uid, nil
	}

	uid, derivedAddr, err := c.DeriveOrgAccount(trimmedOrgID, accountIndex)
	if err != nil {
		return "", "", err
	}

	if chainAddress != derivedAddr {
		return "", "", fmt.Errorf("org chain account address mismatch for %s", trimmedOrgID)
	}

	return derivedAddr, uid, nil
}
