package billing

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SubscriptionCost is the number of credits debited from an org's prepaid pool
// each time a member is subscribed (admitted with query access). Pre-MVP
// placeholder; the org pool is seeded from fee_model.monthly_credits at org
// creation.
const SubscriptionCost = int64(10)

// ErrInsufficientCredits is returned when an org's credit pool cannot cover a
// member subscription. The membership is left inactive (membership_active=FALSE).
var ErrInsufficientCredits = errors.New("insufficient org credits for subscription")

// ProvisionOrgLedger seeds an org's prepaid credit pool from the subscription
// grant (fee_model.monthly_credits) and records an auditable transaction. A
// grant of 0 is valid — the ledger row is created with a zero balance and no
// grant transaction is recorded.
func ProvisionOrgLedger(ctx context.Context, pool *pgxpool.Pool, orgID string, initialBalance int64, actor string) error {
	if initialBalance < 0 {
		return fmt.Errorf("initial balance must be non-negative")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `
		INSERT INTO org_credits (org_id, balance)
		VALUES ($1, $2)
		ON CONFLICT (org_id) DO UPDATE
		SET balance = $2, updated_at = NOW()
	`, orgID, initialBalance)
	if err != nil {
		return fmt.Errorf("provision org credits: %w", err)
	}

	if initialBalance > 0 {
		_, err = tx.Exec(ctx, `
			INSERT INTO credit_transactions (org_id, delta, reason, actor)
			VALUES ($1, $2, 'subscription_grant', $3)
		`, orgID, initialBalance, actor)
		if err != nil {
			return fmt.Errorf("record subscription grant: %w", err)
		}
	}

	return tx.Commit(ctx)
}

// Subscribe debits SubscriptionCost from the org's credit pool and activates the
// member's subscription (members.membership_active = TRUE) in a single atomic
// transaction. The org credit pool must exist and hold at least SubscriptionCost
// credits, and the member row must already exist; otherwise the transaction is
// rolled back and an error is returned.
func Subscribe(ctx context.Context, pool *pgxpool.Pool, orgID, memberPubkey, actor string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var balance int64
	err = tx.QueryRow(ctx, `
		SELECT balance FROM org_credits WHERE org_id = $1 FOR UPDATE
	`, orgID).Scan(&balance)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("org credit ledger not found for %s", orgID)
	}
	if err != nil {
		return fmt.Errorf("lock org credits: %w", err)
	}

	if balance < SubscriptionCost {
		return ErrInsufficientCredits
	}

	_, err = tx.Exec(ctx, `
		UPDATE org_credits
		SET balance = balance - $1,
			lifetime_used = lifetime_used + $1,
			updated_at = NOW()
		WHERE org_id = $2
	`, SubscriptionCost, orgID)
	if err != nil {
		return fmt.Errorf("debit org credits: %w", err)
	}

	tag, err := tx.Exec(ctx, `
		UPDATE members
		SET membership_active = TRUE, updated_at = NOW()
		WHERE org_id = $1 AND pubkey = $2
	`, orgID, memberPubkey)
	if err != nil {
		return fmt.Errorf("activate membership: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("member %s not found in org %s", memberPubkey, orgID)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO credit_transactions (org_id, delta, reason, actor)
		VALUES ($1, $2, 'subscription', $3)
	`, orgID, -SubscriptionCost, actor)
	if err != nil {
		return fmt.Errorf("record subscription transaction: %w", err)
	}

	return tx.Commit(ctx)
}

// GrantFreeRecall activates a member's recall entitlement without debiting org
// credits and records an auditable zero-delta comp transaction.
func GrantFreeRecall(ctx context.Context, pool *pgxpool.Pool, orgID, memberPubkey, actor string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx, `
		UPDATE members
		SET membership_active = TRUE, updated_at = NOW()
		WHERE org_id = $1 AND pubkey = $2
	`, orgID, memberPubkey)
	if err != nil {
		return fmt.Errorf("activate membership: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("member %s not found in org %s", memberPubkey, orgID)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO credit_transactions (org_id, delta, reason, actor)
		VALUES ($1, 0, 'comp', $2)
	`, orgID, actor)
	if err != nil {
		return fmt.Errorf("record comp transaction: %w", err)
	}

	return tx.Commit(ctx)
}

// RevokeRecall deactivates a member's recall entitlement without credit impact
// and records an auditable zero-delta revoke transaction.
func RevokeRecall(ctx context.Context, pool *pgxpool.Pool, orgID, memberPubkey, actor string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx, `
		UPDATE members
		SET membership_active = FALSE, updated_at = NOW()
		WHERE org_id = $1 AND pubkey = $2
	`, orgID, memberPubkey)
	if err != nil {
		return fmt.Errorf("revoke membership: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("member %s not found in org %s", memberPubkey, orgID)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO credit_transactions (org_id, delta, reason, actor)
		VALUES ($1, 0, 'revoked', $2)
	`, orgID, actor)
	if err != nil {
		return fmt.Errorf("record revoke transaction: %w", err)
	}

	return tx.Commit(ctx)
}

func GetBalance(ctx context.Context, pool *pgxpool.Pool, orgID string) (int64, error) {
	var balance int64
	err := pool.QueryRow(ctx,
		"SELECT balance FROM org_credits WHERE org_id = $1", orgID,
	).Scan(&balance)
	if err != nil {
		return 0, fmt.Errorf("org credits not found — org may not have a ledger: %w", err)
	}
	return balance, nil
}

func TopUp(ctx context.Context, pool *pgxpool.Pool, orgID, actor string, amount int64) error {
	if amount <= 0 {
		return fmt.Errorf("top-up amount must be positive")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `
		INSERT INTO org_credits (org_id, balance)
		VALUES ($1, $2)
		ON CONFLICT (org_id) DO UPDATE
		SET balance = org_credits.balance + $2, updated_at = NOW()
	`, orgID, amount)
	if err != nil {
		return fmt.Errorf("update balance: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO credit_transactions (org_id, delta, reason, actor)
		VALUES ($1, $2, 'topup', $3)
	`, orgID, amount, actor)
	if err != nil {
		return fmt.Errorf("record transaction: %w", err)
	}

	return tx.Commit(ctx)
}

func GetTransactions(ctx context.Context, pool *pgxpool.Pool, orgID string, limit int) ([]Transaction, error) {
	rows, err := pool.Query(ctx, `
		SELECT txn_id, org_id, delta, reason, receipt_id, actor, created_at
		FROM credit_transactions
		WHERE org_id = $1
		ORDER BY created_at DESC
		LIMIT $2
	`, orgID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var txns []Transaction
	for rows.Next() {
		var t Transaction
		if err := rows.Scan(&t.TxnID, &t.OrgID, &t.Delta, &t.Reason,
			&t.ReceiptID, &t.Actor, &t.CreatedAt); err != nil {
			return nil, err
		}
		txns = append(txns, t)
	}
	return txns, rows.Err()
}

type Transaction struct {
	TxnID     int64
	OrgID     string
	Delta     int64
	Reason    string
	ReceiptID *string
	Actor     string
	CreatedAt time.Time
}
