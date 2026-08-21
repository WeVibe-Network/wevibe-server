package receipts

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/db"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
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
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := fmt.Sprintf("%064d", 1)

	orgReq := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: fmt.Sprintf("%064d", 2),
		LeaderWallet:       "wevibe1receiptstest1",
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          fmt.Sprintf("%0128d", 1),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}
	_, err := orgs.CreateOrg(ctx, pool, orgID, orgReq)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}
	return orgID
}

func TestReceiptCreation(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := setupTestOrg(t, pool)

	receipt, err := CreateReceipt(
		ctx, pool, "0000000000000000000000000000000000000000000000000000000000000000",
		orgID, 0, []int32{0, 1},
		"agentpubkey",
		map[string]any{"query": "test"},
		[]string{"cid1", "cid2"},
		"agentsig123",
	)
	if err != nil {
		t.Fatalf("CreateReceipt failed: %v", err)
	}
	if receipt.OrgID != orgID {
		t.Errorf("expected org_id %s, got %s", orgID, receipt.OrgID)
	}
	if receipt.QueryCommitment == "" {
		t.Error("expected non-empty query commitment")
	}
	if receipt.ResultCommitment == "" {
		t.Error("expected non-empty result commitment")
	}

	var count int
	err = pool.QueryRow(ctx, "SELECT COUNT(*) FROM usage_receipts WHERE receipt_id = $1", receipt.ReceiptID).Scan(&count)
	if err != nil {
		t.Fatalf("query failed: %v", err)
	}
	if count != 1 {
		t.Errorf("expected 1 receipt, got %d", count)
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM usage_receipts WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}
