package orgs

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/db"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
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

func TestCreateOrg_GetOrg(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())

	req := protocol.CreateOrgRequest{
		OrgID:              orgID,
		LeaderPubkey:       strings.Repeat("a", 64),
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("c", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}

	org, err := CreateOrg(ctx, pool, req)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}
	if org.OrgID != orgID {
		t.Errorf("expected org_id %s, got %s", orgID, org.OrgID)
	}

	got, err := GetOrg(ctx, pool, orgID)
	if err != nil {
		t.Fatalf("GetOrg failed: %v", err)
	}
	if got.OrgName != "Test Org" {
		t.Errorf("expected org_name 'Test Org', got %s", got.OrgName)
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestGetOrg_NotFound(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	_, err := GetOrg(ctx, pool, "nonexistent-org")
	if err == nil {
		t.Fatal("expected error for nonexistent org")
	}
}

func TestOrgExists(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())

	req := protocol.CreateOrgRequest{
		OrgID:              orgID,
		LeaderPubkey:       strings.Repeat("a", 64),
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("c", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}

	exists, err := OrgExists(ctx, pool, orgID)
	if err != nil {
		t.Fatalf("OrgExists failed: %v", err)
	}
	if exists {
		t.Error("expected exists=false before creation")
	}

	_, err = CreateOrg(ctx, pool, req)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	exists, err = OrgExists(ctx, pool, orgID)
	if err != nil {
		t.Fatalf("OrgExists failed: %v", err)
	}
	if !exists {
		t.Error("expected exists=true after creation")
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestGetLeaderPubkey(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := strings.Repeat("a", 64)

	req := protocol.CreateOrgRequest{
		OrgID:              orgID,
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("c", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}

	_, err := CreateOrg(ctx, pool, req)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	got, err := GetLeaderPubkey(ctx, pool, orgID)
	if err != nil {
		t.Fatalf("GetLeaderPubkey failed: %v", err)
	}
	if got != leaderPubkey {
		t.Errorf("expected %s, got %s", leaderPubkey, got)
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestGetCurrentEpoch(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())

	req := protocol.CreateOrgRequest{
		OrgID:              orgID,
		LeaderPubkey:       strings.Repeat("a", 64),
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("c", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}

	_, err := CreateOrg(ctx, pool, req)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	epoch, err := GetCurrentEpoch(ctx, pool, orgID)
	if err != nil {
		t.Fatalf("GetCurrentEpoch failed: %v", err)
	}
	if epoch != 0 {
		t.Errorf("expected epoch 0, got %d", epoch)
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestFullOrgLifecycle(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())

	req := protocol.CreateOrgRequest{
		OrgID:              orgID,
		LeaderPubkey:       strings.Repeat("a", 64),
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("c", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}

	org, err := CreateOrg(ctx, pool, req)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}
	if org.CurrentEpoch != 0 {
		t.Errorf("expected epoch 0, got %d", org.CurrentEpoch)
	}

	rotateReq := protocol.RotateEpochRequest{
		NewPkMod:  strings.Repeat("d", 64),
		SignedBy:  strings.Repeat("a", 64),
		Signature: strings.Repeat("e", 128),
	}
	err = RotateEpoch(ctx, pool, orgID, rotateReq)
	if err != nil {
		t.Fatalf("RotateEpoch failed: %v", err)
	}

	epoch, err := GetCurrentEpoch(ctx, pool, orgID)
	if err != nil {
		t.Fatalf("GetCurrentEpoch failed: %v", err)
	}
	if epoch != 1 {
		t.Errorf("expected epoch 1, got %d", epoch)
	}

	manifest, err := GetEpochManifest(ctx, pool, orgID, -1)
	if err != nil {
		t.Fatalf("GetEpochManifest failed: %v", err)
	}
	if manifest.EpochID != 1 {
		t.Errorf("expected manifest epoch 1, got %d", manifest.EpochID)
	}

	manifest, err = GetEpochManifest(ctx, pool, orgID, 0)
	if err != nil {
		t.Fatalf("GetEpochManifest(epoch 0) failed: %v", err)
	}
	if manifest.EpochID != 0 {
		t.Errorf("expected manifest epoch 0, got %d", manifest.EpochID)
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestEpochExists_CurrentEpoch(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())

	req := protocol.CreateOrgRequest{
		OrgID:              orgID,
		LeaderPubkey:       strings.Repeat("a", 64),
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("c", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}

	_, err := CreateOrg(ctx, pool, req)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	exists, err := EpochExists(ctx, pool, orgID, 0)
	if err != nil {
		t.Fatalf("EpochExists failed: %v", err)
	}
	if !exists {
		t.Error("expected epoch 0 to exist for new org")
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestEpochExists_NonexistentEpoch(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())

	req := protocol.CreateOrgRequest{
		OrgID:              orgID,
		LeaderPubkey:       strings.Repeat("a", 64),
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("c", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}

	_, err := CreateOrg(ctx, pool, req)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	exists, err := EpochExists(ctx, pool, orgID, 999)
	if err != nil {
		t.Fatalf("EpochExists failed: %v", err)
	}
	if exists {
		t.Error("expected epoch 999 to not exist")
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestEpochExists_NonexistentOrg(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	exists, err := EpochExists(ctx, pool, "fake-org", 0)
	if err != nil {
		t.Fatalf("EpochExists failed: %v", err)
	}
	if exists {
		t.Error("expected epoch 0 to not exist for fake org")
	}
}
