package billing_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/billing"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/db"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	connStr := os.Getenv("DATABASE_URL")
	if connStr == "" {
		t.Skip("DATABASE_URL not set — skipping DB test")
	}
	pool, err := db.NewPool(context.Background(), connStr)
	if err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func setupTestOrg(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	orgID := fmt.Sprintf("billing-test-%d", time.Now().UnixNano())
	pool.Exec(context.Background(),
		"INSERT INTO orgs (org_id, leader_pubkey, org_name, domain) VALUES ($1,'aa','Test','test.local')",
		orgID)
	t.Cleanup(func() {
		pool.Exec(context.Background(), "DELETE FROM credit_transactions WHERE org_id=$1", orgID)
		pool.Exec(context.Background(), "DELETE FROM org_credits WHERE org_id=$1", orgID)
		pool.Exec(context.Background(), "DELETE FROM members WHERE org_id=$1", orgID)
		pool.Exec(context.Background(), "DELETE FROM epoch_manifests WHERE org_id=$1", orgID)
		pool.Exec(context.Background(), "DELETE FROM orgs WHERE org_id=$1", orgID)
	})
	return orgID
}

func TestEnsureOrgLedger(t *testing.T) {
	pool := testPool(t)
	orgID := setupTestOrg(t, pool)
	if err := billing.EnsureOrgLedger(context.Background(), pool, orgID); err != nil {
		t.Fatalf("ensure ledger: %v", err)
	}
	bal, err := billing.GetBalance(context.Background(), pool, orgID)
	if err != nil {
		t.Fatalf("get balance: %v", err)
	}
	if bal != 0 {
		t.Fatalf("expected 0, got %d", bal)
	}
}

func TestTopUp(t *testing.T) {
	pool := testPool(t)
	orgID := setupTestOrg(t, pool)
	billing.EnsureOrgLedger(context.Background(), pool, orgID)

	if err := billing.TopUp(context.Background(), pool, orgID, "leader-key", 100); err != nil {
		t.Fatalf("top up: %v", err)
	}
	bal, _ := billing.GetBalance(context.Background(), pool, orgID)
	if bal != 100 {
		t.Fatalf("expected 100, got %d", bal)
	}
}

func TestDeductQueryCredit(t *testing.T) {
	pool := testPool(t)
	orgID := setupTestOrg(t, pool)
	billing.EnsureOrgLedger(context.Background(), pool, orgID)
	billing.TopUp(context.Background(), pool, orgID, "leader", 5)

	if err := billing.DeductQueryCredit(context.Background(), pool, orgID, "receipt-1"); err != nil {
		t.Fatalf("deduct: %v", err)
	}
	bal, _ := billing.GetBalance(context.Background(), pool, orgID)
	if bal != 4 {
		t.Fatalf("expected 4, got %d", bal)
	}
}

func TestDeductQueryCredit_InsufficientBalance(t *testing.T) {
	pool := testPool(t)
	orgID := setupTestOrg(t, pool)
	billing.EnsureOrgLedger(context.Background(), pool, orgID)

	err := billing.DeductQueryCredit(context.Background(), pool, orgID, "receipt-x")
	if err == nil {
		t.Fatal("expected insufficient credits error, got nil")
	}
	bal, _ := billing.GetBalance(context.Background(), pool, orgID)
	if bal != 0 {
		t.Fatalf("balance should still be 0, got %d", bal)
	}
}

func TestGetTransactions(t *testing.T) {
	pool := testPool(t)
	orgID := setupTestOrg(t, pool)
	billing.EnsureOrgLedger(context.Background(), pool, orgID)
	billing.TopUp(context.Background(), pool, orgID, "leader", 10)
	billing.DeductQueryCredit(context.Background(), pool, orgID, "r1")

	txns, err := billing.GetTransactions(context.Background(), pool, orgID, 10)
	if err != nil {
		t.Fatalf("get txns: %v", err)
	}
	if len(txns) != 2 {
		t.Fatalf("expected 2 transactions, got %d", len(txns))
	}
}
