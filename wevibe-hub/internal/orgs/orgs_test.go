package orgs

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/db"
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

func TestCreateOrg_GetOrg(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())

	req := protocol.CreateOrgRequest{
		LeaderPubkey:       strings.Repeat("a", 64),
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		LeaderWallet:       "wevibe1orgstest1",
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("c", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}

	org, err := CreateOrg(ctx, pool, orgID, req)
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
		LeaderPubkey:       strings.Repeat("a", 64),
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		LeaderWallet:       "wevibe1orgstest2",
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

	_, err = CreateOrg(ctx, pool, orgID, req)
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
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestGetLeaderPubkey(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := strings.Repeat("a", 64)

	req := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		LeaderWallet:       "wevibe1orgstest3",
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("c", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}

	_, err := CreateOrg(ctx, pool, orgID, req)
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
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

func TestFullOrgLifecycle(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())

	req := protocol.CreateOrgRequest{
		LeaderPubkey:       strings.Repeat("a", 64),
		LeaderX25519Pubkey: strings.Repeat("b", 64),
		LeaderWallet:       "wevibe1orgstest5",
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("c", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
		PkMod:              "test-pk-mod",
		UmbralPK:           strings.Repeat("ab", 33),
	}

	org, err := CreateOrg(ctx, pool, orgID, req)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}
	if org.OrgID != orgID {
		t.Errorf("expected org_id %s, got %s", orgID, org.OrgID)
	}

	manifest, err := GetEpochManifest(ctx, pool, orgID, -1)
	if err != nil {
		t.Fatalf("GetEpochManifest failed: %v", err)
	}
	if manifest.PkMod != "test-pk-mod" {
		t.Errorf("expected manifest pk_mod 'test-pk-mod', got %q", manifest.PkMod)
	}
	if manifest.UmbralPK != strings.Repeat("ab", 33) {
		t.Errorf("expected manifest umbral_pk to round-trip, got %q", manifest.UmbralPK)
	}
	if manifest.SignedBy != req.LeaderPubkey {
		t.Errorf("expected manifest signed_by %s, got %s", req.LeaderPubkey, manifest.SignedBy)
	}
	if manifest.Signature != req.Signature {
		t.Errorf("expected manifest signature %s, got %s", req.Signature, manifest.Signature)
	}

	manifest, err = GetEpochManifest(ctx, pool, orgID, 0)
	if err != nil {
		t.Fatalf("GetEpochManifest(epoch 0) failed: %v", err)
	}
	if manifest.PkMod != "test-pk-mod" {
		t.Errorf("expected same static manifest for any epoch param, got pk_mod %q", manifest.PkMod)
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}
