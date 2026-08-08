package serves

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"sort"
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
// t.Cleanup and deletes child rows in FK-safe order first: pending_submissions
// and members reference orgs WITHOUT ON DELETE CASCADE, so a bare org delete
// fails silently and poisons later runs against a shared dogfood database.
func seedOrg(t *testing.T, pool *pgxpool.Pool, orgID string) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO orgs (org_id, leader_pubkey, leader_wallet_address, org_name, domain)
		VALUES ($1, $2, $3, $4, $5)
	`, orgID, strings.Repeat("a", 64), "wevibe1testleaderwallet", "Test Org", "test.example.com")
	if err != nil {
		t.Fatalf("seed org: %v", err)
	}
	t.Cleanup(func() {
		for _, stmt := range []string{
			"DELETE FROM serve_events WHERE org_id = $1",
			"DELETE FROM outcome_events WHERE org_id = $1",
			"DELETE FROM pending_submissions WHERE org_id = $1",
			"DELETE FROM members WHERE org_id = $1",
		} {
			if _, err := pool.Exec(ctx, stmt, orgID); err != nil {
				t.Logf("cleanup %q failed: %v", stmt, err)
			}
		}
		if _, err := pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID); err != nil {
			t.Logf("cleanup delete org failed: %v", err)
		}
	})
}

// TestRecordServe_PersistsMatchedKeywords drives the POST /v1/serves
// persistence contract end-to-end: the matched_keywords array supplied by
// the client must round-trip through serve_events and reappear on the read
// path (GetPendingServes). Normalisation (lowercase / trim / dedupe)
// runs before persistence per the validator contract.
func TestRecordServe_PersistsMatchedKeywords(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := fmt.Sprintf("test-org-co033a-%d", time.Now().UnixNano())
	seedOrg(t, pool, orgID)

	contentHash := fmt.Sprintf("%064x", time.Now().UnixNano())
	serveKeyPubkey := strings.Repeat("b", 64)
	serveSig := strings.Repeat("c", 128)
	seedCommittedSubmission(t, pool, orgID, contentHash)

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

	reporterPubkey := strings.Repeat("d", 64)
	seedMember(t, pool, orgID, req.ContributorID, "member")
	seedMember(t, pool, orgID, reporterPubkey, "member")

	record, err := RecordServe(ctx, pool, nil, req, reporterPubkey)
	if err != nil {
		t.Fatalf("RecordServe failed: %v", err)
	}

	expectedCanonical := []string{"alpha", "beta"}
	if !reflect.DeepEqual(record.MatchedKeywords, expectedCanonical) {
		t.Fatalf("matched keywords on returned record: got=%v want=%v", record.MatchedKeywords, expectedCanonical)
	}

	// Round-trip via the read path to confirm persistence, not just the
	// return value from the post-INSERT SELECT inside RecordServe.
	pending, err := GetPendingServes(ctx, pool, orgID, 10, 0)
	if err != nil {
		t.Fatalf("GetPendingServes failed: %v", err)
	}

	var got *ServeEventRecord
	for i := range pending {
		if pending[i].ID == record.ID {
			got = &pending[i]
			break
		}
	}
	if got == nil {
		t.Fatal("expected to find persisted serve_events row in pending serves, got nil")
	}
	if !reflect.DeepEqual(got.MatchedKeywords, expectedCanonical) {
		t.Fatalf("matched keywords from DB: got=%v want=%v", got.MatchedKeywords, expectedCanonical)
	}
}

// TestRecordServe_AcceptsEmptyMatchedKeywords verifies the recall-pivot
// contract: matched_keywords is optional descriptive metadata, so empty or
// absent payloads persist as an empty Postgres TEXT[] instead of rejecting the
// serve.
func TestRecordServe_AcceptsEmptyMatchedKeywords(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := fmt.Sprintf("test-org-pivot-empty-kw-%d", time.Now().UnixNano())
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
	seedMember(t, pool, orgID, baseReq.ContributorID, "member")
	reporterPubkey := strings.Repeat("d", 64)
	seedMember(t, pool, orgID, reporterPubkey, "member")

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
			req.MemoryContentHash = fmt.Sprintf("%064x", time.Now().UnixNano())
			req.MatchedKeywords = c.in
			seedCommittedSubmission(t, pool, orgID, req.MemoryContentHash)

			record, err := RecordServe(ctx, pool, nil, req, reporterPubkey)
			if err != nil {
				t.Fatalf("RecordServe failed: %v", err)
			}
			if len(record.MatchedKeywords) != 0 {
				t.Fatalf("matched keywords: got=%v want empty", record.MatchedKeywords)
			}
		})
	}
}

func TestRecordOutcome_DedupsAndPendingRelay(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := fmt.Sprintf("test-org-outcome-%d", time.Now().UnixNano())
	seedOrg(t, pool, orgID)

	req := RecordOutcomeRequest{
		OrgID:             orgID,
		EpochID:           7,
		EventType:         EventTypeOutcome,
		MemoryContentHash: strings.Repeat("a", 64),
		SignerPubkey:      strings.Repeat("b", 64),
		Nonce:             "01",
		Signature:         strings.Repeat("c", 128),
		EpisodeRef:        "episode:test",
		ServeRef:          strings.Repeat("5", 64),
		Resolution:        "worked",
		Source:            "harvested",
		EvidenceRef:       "evidence:test",
		Fingerprint:       fmt.Sprintf("%064x", time.Now().UnixNano()),
		SessionID:         "session-test",
	}
	reporterPubkey := strings.Repeat("e", 64)

	inserted, err := RecordOutcome(ctx, pool, req, reporterPubkey)
	if err != nil {
		t.Fatalf("RecordOutcome failed: %v", err)
	}
	if !inserted {
		t.Fatal("first RecordOutcome insert reported duplicate")
	}

	inserted, err = RecordOutcome(ctx, pool, req, reporterPubkey)
	if err != nil {
		t.Fatalf("RecordOutcome duplicate failed: %v", err)
	}
	if inserted {
		t.Fatal("duplicate RecordOutcome insert was not deduped")
	}

	pending, err := PendingOutcomeEvents(ctx, pool, orgID, 10)
	if err != nil {
		t.Fatalf("PendingOutcomeEvents failed: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("pending outcome count: got=%d want=1", len(pending))
	}
	if pending[0].Fingerprint != req.Fingerprint || pending[0].ReporterPubkey != reporterPubkey {
		t.Fatalf("pending outcome mismatch: got=%+v", pending[0])
	}

	if err := MarkOutcomeEvents(ctx, pool, []int64{pending[0].ID}, "submitted", "tx-outcome"); err != nil {
		t.Fatalf("MarkOutcomeEvents failed: %v", err)
	}
	pending, err = PendingOutcomeEvents(ctx, pool, orgID, 10)
	if err != nil {
		t.Fatalf("PendingOutcomeEvents after mark failed: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("pending after mark: got=%d want=0", len(pending))
	}
}

func TestRecordOutcome_RejectsInvalidEventType(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := fmt.Sprintf("test-org-outcome-invalid-%d", time.Now().UnixNano())
	seedOrg(t, pool, orgID)

	req := RecordOutcomeRequest{
		OrgID:             orgID,
		EpochID:           1,
		EventType:         "serve",
		MemoryContentHash: strings.Repeat("a", 64),
		SignerPubkey:      strings.Repeat("b", 64),
		Nonce:             "01",
		Signature:         strings.Repeat("c", 128),
		EpisodeRef:        "episode:test",
		Resolution:        "didnt_work",
		Source:            "harvested",
		EvidenceRef:       "evidence:test",
		Fingerprint:       strings.Repeat("d", 64),
	}

	_, err := RecordOutcome(ctx, pool, req, strings.Repeat("e", 64))
	if err == nil {
		t.Fatal("expected invalid event_type error, got nil")
	}
	if !strings.Contains(err.Error(), "event_type") {
		t.Fatalf("expected event_type error, got: %v", err)
	}
}

func seedMember(t *testing.T, pool *pgxpool.Pool, orgID, pubkey, role string) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO members (org_id, pubkey, x25519_pubkey, role, join_epoch, active)
		VALUES ($1, $2, $3, $4, 0, TRUE)
	`, orgID, pubkey, strings.Repeat("1", 64), role)
	if err != nil {
		t.Fatalf("seed member: %v", err)
	}
}

func seedCommittedSubmission(t *testing.T, pool *pgxpool.Pool, orgID, memoryHash string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO pending_submissions (submission_hash, org_id, epoch_id, contributor_pubkey, ciphertext_hex, plaintext_hash, salt, ciphertext_hash, wrapped_dek_hash, wrapped_dek_mod, contributor_sig, status)
		VALUES ($1, $2, 1, $3, 'aa', $4, '01', $5, $6, 'mod', $7, 'committed')
	`, memoryHash, orgID, strings.Repeat("b", 64), strings.Repeat("c", 64), strings.Repeat("d", 64), strings.Repeat("e", 64), strings.Repeat("f", 128))
	if err != nil {
		t.Fatalf("seed committed submission: %v", err)
	}
}

func TestPendingRelayHoldEligibility(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := fmt.Sprintf("test-org-hold-%d", time.Now().UnixNano())
	seedOrg(t, pool, orgID)

	contributor := strings.Repeat("2", 64)
	reporter := strings.Repeat("3", 64)
	seedMember(t, pool, orgID, contributor, "member")
	seedMember(t, pool, orgID, reporter, "member")

	_, err := pool.Exec(ctx, `
		INSERT INTO serve_events (
			org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce,
			serve_fingerprint, contributor_id, matched_keywords, reporter_pubkey, reason, event_type, status, created_at
		) VALUES
			($1, 0, $2, $3, $4, 'n-serve-fresh', $16, $5, ARRAY['alpha'], $6, 'incorrect', 'serve', 'pending', NOW()),
			($1, 0, $7, $8, $9, 'n-serve-old',   $17, $5, ARRAY['beta'],  $6, 'incorrect', 'serve', 'pending', NOW() - interval '25 hours'),
			($1, 0, $10, $11, $12, 'n-deny-fresh', $18, $5, ARRAY['gamma'], $6, 'incorrect', 'denial', 'pending', NOW()),
			($1, 0, $13, $14, $15, 'n-deny-old',   $19, $5, ARRAY['delta'], $6, 'incorrect', 'denial', 'pending', NOW() - interval '25 hours')
	`, orgID,
		fmt.Sprintf("%064x", 101), fmt.Sprintf("%064x", 201), strings.Repeat("a", 128), contributor, reporter,
		fmt.Sprintf("%064x", 102), fmt.Sprintf("%064x", 202), strings.Repeat("b", 128),
		fmt.Sprintf("%064x", 103), fmt.Sprintf("%064x", 203), strings.Repeat("c", 128),
		fmt.Sprintf("%064x", 104), fmt.Sprintf("%064x", 204), strings.Repeat("d", 128),
		fmt.Sprintf("%064x", 301), fmt.Sprintf("%064x", 302), fmt.Sprintf("%064x", 303), fmt.Sprintf("%064x", 304),
	)
	if err != nil {
		t.Fatalf("seed serve_events: %v", err)
	}

	servesHeld, err := GetPendingServes(ctx, pool, orgID, 20, 24)
	if err != nil {
		t.Fatalf("GetPendingServes(24): %v", err)
	}
	if len(servesHeld) != 1 || servesHeld[0].MemoryContentHash != fmt.Sprintf("%064x", 102) {
		t.Fatalf("expected only aged serve at hold=24, got %+v", servesHeld)
	}

	servesNoHold, err := GetPendingServes(ctx, pool, orgID, 20, 0)
	if err != nil {
		t.Fatalf("GetPendingServes(0): %v", err)
	}
	if len(servesNoHold) != 2 {
		t.Fatalf("expected 2 serves at hold=0, got %d", len(servesNoHold))
	}

	denialsHeld, err := GetPendingDenials(ctx, pool, orgID, 20, 24)
	if err != nil {
		t.Fatalf("GetPendingDenials(24): %v", err)
	}
	if len(denialsHeld) != 1 || denialsHeld[0].MemoryContentHash != fmt.Sprintf("%064x", 104) {
		t.Fatalf("expected only aged denial at hold=24, got %+v", denialsHeld)
	}

	denialsNoHold, err := GetPendingDenials(ctx, pool, orgID, 20, 0)
	if err != nil {
		t.Fatalf("GetPendingDenials(0): %v", err)
	}
	if len(denialsNoHold) != 2 {
		t.Fatalf("expected 2 denials at hold=0, got %d", len(denialsNoHold))
	}
}

func TestHasPendingEventsRespectsHoldWindow(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := fmt.Sprintf("test-org-has-pending-%d", time.Now().UnixNano())
	seedOrg(t, pool, orgID)

	contributor := strings.Repeat("4", 64)
	reporter := strings.Repeat("5", 64)
	seedMember(t, pool, orgID, contributor, "member")
	seedMember(t, pool, orgID, reporter, "member")

	memoryHash := fmt.Sprintf("%064x", 301)
	_, err := pool.Exec(ctx, `
		INSERT INTO serve_events (
			org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce,
			serve_fingerprint, contributor_id, matched_keywords, reporter_pubkey, reason, event_type, status, created_at
		) VALUES ($1, 0, $2, $3, $4, 'n-hold', $7, $5, ARRAY['hold'], $6, 'incorrect', 'serve', 'pending', NOW())
	`, orgID, memoryHash, fmt.Sprintf("%064x", 302), strings.Repeat("e", 128), contributor, reporter, fmt.Sprintf("%064x", 305))
	if err != nil {
		t.Fatalf("insert pending row: %v", err)
	}

	hasHeld, err := HasPendingEvents(ctx, pool, orgID, 24)
	if err != nil {
		t.Fatalf("HasPendingEvents(24): %v", err)
	}
	if hasHeld {
		t.Fatal("expected false at hold=24 with only fresh row")
	}

	hasNoHold, err := HasPendingEvents(ctx, pool, orgID, 0)
	if err != nil {
		t.Fatalf("HasPendingEvents(0): %v", err)
	}
	if !hasNoHold {
		t.Fatal("expected true at hold=0 with fresh row")
	}

	_, err = pool.Exec(ctx, `
		UPDATE serve_events
		SET created_at = NOW() - interval '25 hours'
		WHERE org_id = $1 AND memory_content_hash = $2
	`, orgID, memoryHash)
	if err != nil {
		t.Fatalf("age pending row: %v", err)
	}

	hasAfterAge, err := HasPendingEvents(ctx, pool, orgID, 24)
	if err != nil {
		t.Fatalf("HasPendingEvents(24) after age: %v", err)
	}
	if !hasAfterAge {
		t.Fatal("expected true at hold=24 after aging row")
	}
}

func TestListOrgsWithEligiblePendingRespectsHoldAndExemptions(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgA := fmt.Sprintf("test-org-a-%d", time.Now().UnixNano())
	orgB := fmt.Sprintf("test-org-b-%d", time.Now().UnixNano())
	orgC := fmt.Sprintf("test-org-c-%d", time.Now().UnixNano())
	seedOrg(t, pool, orgA)
	seedOrg(t, pool, orgB)
	seedOrg(t, pool, orgC)

	sharedContributor := strings.Repeat("6", 64)
	sharedReporter := strings.Repeat("7", 64)
	seedMember(t, pool, orgA, sharedContributor, "member")
	seedMember(t, pool, orgA, sharedReporter, "member")
	seedMember(t, pool, orgB, sharedContributor, "member")
	seedMember(t, pool, orgB, sharedReporter, "member")
	seedMember(t, pool, orgC, sharedContributor, "member")
	seedMember(t, pool, orgC, sharedReporter, "member")

	_, err := pool.Exec(ctx, `
		INSERT INTO serve_events (
			org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce,
			serve_fingerprint, contributor_id, matched_keywords, reporter_pubkey, reason, event_type, status, created_at
		) VALUES
			($1, 0, $4, $5, $6, 'a-fresh', $15, $7, ARRAY['a'], $8, 'incorrect', 'serve', 'pending', NOW()),
			($2, 0, $9, $10, $11, 'b-old',  $16, $7, ARRAY['b'], $8, 'incorrect', 'serve', 'pending', NOW() - interval '25 hours'),
			($3, 0, $12, $13, $14, 'c-fresh', $17, $7, ARRAY['c'], $8, 'incorrect', 'serve', 'pending', NOW())
	`,
		orgA,
		orgB,
		orgC,
		fmt.Sprintf("%064x", 401), fmt.Sprintf("%064x", 402), strings.Repeat("f", 128), strings.Repeat("6", 64), strings.Repeat("7", 64),
		fmt.Sprintf("%064x", 403), fmt.Sprintf("%064x", 404), strings.Repeat("8", 128),
		fmt.Sprintf("%064x", 405), fmt.Sprintf("%064x", 406), strings.Repeat("9", 128),
		fmt.Sprintf("%064x", 501), fmt.Sprintf("%064x", 502), fmt.Sprintf("%064x", 503),
	)
	if err != nil {
		t.Fatalf("seed pending rows: %v", err)
	}

	orgs, err := ListOrgsWithEligiblePending(ctx, pool, 24, []string{orgC})
	if err != nil {
		t.Fatalf("ListOrgsWithEligiblePending: %v", err)
	}
	sort.Strings(orgs)
	expected := []string{orgB, orgC}
	if !reflect.DeepEqual(orgs, expected) {
		t.Fatalf("eligible orgs mismatch: got=%v want=%v", orgs, expected)
	}
}
