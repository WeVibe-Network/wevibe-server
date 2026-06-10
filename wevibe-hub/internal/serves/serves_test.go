package serves

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/db"
)

// testPool follows the convention from internal/orgs/orgs_test.go: tests
// skip cleanly when DATABASE_URL is unset or unreachable. In dogfood and CI
// the env var is set and these tests exercise the live serve_events flow.
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

// seedOrg inserts a minimal orgs row satisfying serve_events.org_id FK without
// pulling in the full CreateOrg dependency tree. Cleanup is registered via
// t.Cleanup; CASCADE on serve_events.org_id propagates row deletion.
func seedOrg(t *testing.T, pool *pgxpool.Pool, orgID string) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO orgs (org_id, leader_pubkey, org_name, domain)
		VALUES ($1, $2, $3, $4)
	`, orgID, strings.Repeat("a", 64), "Test Org", "test.example.com")
	if err != nil {
		t.Fatalf("seed org: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})
}

// TestRecordServe_PersistsMatchedKeywords drives the POST /v1/serves
// persistence contract end-to-end: the matched_keywords array supplied by
// the client must round-trip through serve_events and reappear on the read
// path (GetServeEventByIdentity). Normalisation (lowercase / trim / dedupe)
// runs before persistence per the validator contract.
func TestRecordServe_PersistsMatchedKeywords(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := fmt.Sprintf("test-org-co033a-%d", time.Now().UnixNano())
	seedOrg(t, pool, orgID)

	contentHash := strings.Repeat("a", 64)
	serveKeyPubkey := strings.Repeat("b", 64)
	serveSig := strings.Repeat("c", 128)

	req := RecordServeRequest{
		OrgID:             orgID,
		EpochID:           0,
		MemoryContentHash: contentHash,
		ServeKeyPubkey:    serveKeyPubkey,
		ServeSig:          serveSig,
		Nonce:             "01",
		ContributorID:     strings.Repeat("c", 64),
		ModelID:           "test-model",
		TurnCount:         3,
		// Mixed-case + duplicate input exercises the normaliser. Expected
		// canonical form: ["alpha", "beta"].
		MatchedKeywords: []string{"Alpha", " beta ", "alpha"},
	}

	record, err := RecordServe(ctx, pool, req, strings.Repeat("d", 64))
	if err != nil {
		t.Fatalf("RecordServe failed: %v", err)
	}

	expectedCanonical := []string{"alpha", "beta"}
	if !reflect.DeepEqual(record.MatchedKeywords, expectedCanonical) {
		t.Fatalf("matched keywords on returned record: got=%v want=%v", record.MatchedKeywords, expectedCanonical)
	}

	// Round-trip via the read path to confirm persistence, not just the
	// return value from the post-INSERT SELECT inside RecordServe.
	got, err := GetServeEventByIdentity(ctx, pool, orgID, EventTypeServe, serveKeyPubkey, contentHash, 0)
	if err != nil {
		t.Fatalf("GetServeEventByIdentity failed: %v", err)
	}
	if got == nil {
		t.Fatal("expected to find persisted serve_events row, got nil")
	}
	if !reflect.DeepEqual(got.MatchedKeywords, expectedCanonical) {
		t.Fatalf("matched keywords from DB: got=%v want=%v", got.MatchedKeywords, expectedCanonical)
	}
}

// TestRecordServe_RejectsEmptyMatchedKeywords verifies the strict validator
// contract: an empty or absent matched_keywords payload yields a validation
// error that the HTTP handler surfaces as 400 (the handler catches the
// "matched_keywords" substring in the error message). Chain x/serve rejects
// empty sets per CO-031 Rev 2 — the hub mirrors that constraint at ingress.
func TestRecordServe_RejectsEmptyMatchedKeywords(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := fmt.Sprintf("test-org-co033a-reject-%d", time.Now().UnixNano())
	seedOrg(t, pool, orgID)

	baseReq := RecordServeRequest{
		OrgID:             orgID,
		EpochID:           0,
		MemoryContentHash: strings.Repeat("e", 64),
		ServeKeyPubkey:    strings.Repeat("f", 64),
		ServeSig:          strings.Repeat("a", 128),
		Nonce:             "0a",
		ContributorID:     strings.Repeat("f", 64),
		ModelID:           "test-model",
		TurnCount:         1,
	}

	cases := []struct {
		name string
		in   []string
	}{
		{"nil_slice", nil},
		{"empty_slice", []string{}},
		{"whitespace_only", []string{"   ", "\t"}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := baseReq
			req.MatchedKeywords = c.in

			_, err := RecordServe(ctx, pool, req, strings.Repeat("d", 64))
			if err == nil {
				t.Fatal("expected validation error, got nil")
			}
			if !strings.Contains(err.Error(), "matched_keywords") {
				t.Fatalf("expected error message to mention matched_keywords, got: %v", err)
			}
		})
	}
}
