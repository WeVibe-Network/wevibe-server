package billing

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const QueryCost = int64(1)

func EnsureOrgLedger(ctx context.Context, pool *pgxpool.Pool, orgID string) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO org_credits (org_id, balance)
		VALUES ($1, 0)
		ON CONFLICT DO NOTHING
	`, orgID)
	return err
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

func DeductQueryCredit(ctx context.Context, pool *pgxpool.Pool, orgID, receiptID string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	result, err := tx.Exec(ctx, `
		UPDATE org_credits
		SET balance = balance - $1,
			lifetime_used = lifetime_used + $1,
			updated_at = NOW()
		WHERE org_id = $2
	`, QueryCost, orgID)
	if err != nil {
		return fmt.Errorf("insufficient credits: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("org credit ledger not found for %s", orgID)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO credit_transactions (org_id, delta, reason, receipt_id, actor)
		VALUES ($1, $2, 'query', $3, 'system')
	`, orgID, -QueryCost, receiptID)
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
