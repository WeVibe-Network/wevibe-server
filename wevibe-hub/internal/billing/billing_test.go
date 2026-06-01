package billing_test

import (
	"context"
	"errors"
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
		"INSERT INTO orgs (org_id, leader_pubkey, leader_wallet_address, org_name, domain) VALUES ($1,'aa','wallet-aa','Test','test.local')",
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

func insertTestMember(t *testing.T, pool *pgxpool.Pool, orgID, pubkey string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO members (org_id, pubkey, x25519_pubkey, role, join_epoch)
		VALUES ($1, $2, 'x25519', 'member', 0)
	`, orgID, pubkey)
	if err != nil {
		t.Fatalf("insert test member: %v", err)
	}
}

func memberActive(t *testing.T, pool *pgxpool.Pool, orgID, pubkey string) bool {
	t.Helper()
	var active bool
	err := pool.QueryRow(context.Background(),
		"SELECT membership_active FROM members WHERE org_id=$1 AND pubkey=$2", orgID, pubkey).Scan(&active)
	if err != nil {
		t.Fatalf("read membership_active: %v", err)
	}
	return active
}

func TestProvisionOrgLedger(t *testing.T) {
	pool := testPool(t)
	orgID := setupTestOrg(t, pool)

	if err := billing.ProvisionOrgLedger(context.Background(), pool, orgID, 1000, "leader"); err != nil {
		t.Fatalf("provision ledger: %v", err)
	}
	bal, err := billing.GetBalance(context.Background(), pool, orgID)
	if err != nil {
		t.Fatalf("get balance: %v", err)
	}
	if bal != 1000 {
		t.Fatalf("expected 1000, got %d", bal)
	}

	txns, err := billing.GetTransactions(context.Background(), pool, orgID, 10)
	if err != nil {
		t.Fatalf("get txns: %v", err)
	}
	if len(txns) != 1 || txns[0].Reason != "subscription_grant" || txns[0].Delta != 1000 {
		t.Fatalf("expected one subscription_grant txn of 1000, got %+v", txns)
	}
}

func TestProvisionOrgLedger_ZeroGrant(t *testing.T) {
	pool := testPool(t)
	orgID := setupTestOrg(t, pool)

	if err := billing.ProvisionOrgLedger(context.Background(), pool, orgID, 0, "leader"); err != nil {
		t.Fatalf("provision ledger: %v", err)
	}
	bal, err := billing.GetBalance(context.Background(), pool, orgID)
	if err != nil {
		t.Fatalf("get balance: %v", err)
	}
	if bal != 0 {
		t.Fatalf("expected 0, got %d", bal)
	}
	txns, _ := billing.GetTransactions(context.Background(), pool, orgID, 10)
	if len(txns) != 0 {
		t.Fatalf("expected no grant txn for zero grant, got %d", len(txns))
	}
}

func TestSubscribe_DebitsAndActivates(t *testing.T) {
	pool := testPool(t)
	orgID := setupTestOrg(t, pool)
	insertTestMember(t, pool, orgID, "member-1")

	if err := billing.ProvisionOrgLedger(context.Background(), pool, orgID, 100, "leader"); err != nil {
		t.Fatalf("provision ledger: %v", err)
	}

	if memberActive(t, pool, orgID, "member-1") {
		t.Fatal("member should start inactive")
	}

	if err := billing.Subscribe(context.Background(), pool, orgID, "member-1", "leader"); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	bal, _ := billing.GetBalance(context.Background(), pool, orgID)
	expected := int64(100) - billing.SubscriptionCost
	if bal != expected {
		t.Fatalf("expected balance %d, got %d", expected, bal)
	}
	if !memberActive(t, pool, orgID, "member-1") {
		t.Fatal("member should be active after subscribe")
	}

	txns, _ := billing.GetTransactions(context.Background(), pool, orgID, 10)
	foundSub := false
	for _, tx := range txns {
		if tx.Reason == "subscription" && tx.Delta == -billing.SubscriptionCost {
			foundSub = true
		}
	}
	if !foundSub {
		t.Fatalf("expected subscription txn of %d, got %+v", -billing.SubscriptionCost, txns)
	}
}

func TestSubscribe_InsufficientCredits(t *testing.T) {
	pool := testPool(t)
	orgID := setupTestOrg(t, pool)
	insertTestMember(t, pool, orgID, "member-1")

	if err := billing.ProvisionOrgLedger(context.Background(), pool, orgID, 5, "leader"); err != nil {
		t.Fatalf("provision ledger: %v", err)
	}

	err := billing.Subscribe(context.Background(), pool, orgID, "member-1", "leader")
	if !errors.Is(err, billing.ErrInsufficientCredits) {
		t.Fatalf("expected ErrInsufficientCredits, got %v", err)
	}

	bal, _ := billing.GetBalance(context.Background(), pool, orgID)
	if bal != 5 {
		t.Fatalf("balance should remain 5, got %d", bal)
	}
	if memberActive(t, pool, orgID, "member-1") {
		t.Fatal("member should remain inactive after failed subscribe")
	}
}

func TestTopUp(t *testing.T) {
	pool := testPool(t)
	orgID := setupTestOrg(t, pool)
	if err := billing.ProvisionOrgLedger(context.Background(), pool, orgID, 0, "leader"); err != nil {
		t.Fatalf("provision ledger: %v", err)
	}

	if err := billing.TopUp(context.Background(), pool, orgID, "leader-key", 100); err != nil {
		t.Fatalf("top up: %v", err)
	}
	bal, _ := billing.GetBalance(context.Background(), pool, orgID)
	if bal != 100 {
		t.Fatalf("expected 100, got %d", bal)
	}
}

func TestGetTransactions(t *testing.T) {
	pool := testPool(t)
	orgID := setupTestOrg(t, pool)
	insertTestMember(t, pool, orgID, "member-1")
	if err := billing.ProvisionOrgLedger(context.Background(), pool, orgID, 100, "leader"); err != nil {
		t.Fatalf("provision ledger: %v", err)
	}
	if err := billing.Subscribe(context.Background(), pool, orgID, "member-1", "leader"); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	txns, err := billing.GetTransactions(context.Background(), pool, orgID, 10)
	if err != nil {
		t.Fatalf("get txns: %v", err)
	}
	// subscription_grant + subscription
	if len(txns) != 2 {
		t.Fatalf("expected 2 transactions, got %d", len(txns))
	}
}
