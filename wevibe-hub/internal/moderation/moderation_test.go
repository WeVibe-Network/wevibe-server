package moderation_test

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/db"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/moderation"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	connStr := os.Getenv("DATABASE_URL")
	if connStr == "" {
		t.Skip("DATABASE_URL not set")
	}
	pool, err := db.NewPool(context.Background(), connStr)
	if err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func setupTestOrg(t *testing.T, pool *pgxpool.Pool) (orgID, leaderPubkey string) {
	t.Helper()
	ctx := context.Background()
	orgID = fmt.Sprintf("test-org-%d", time.Now().UnixNano())

	pub, _, _ := ed25519.GenerateKey(nil)
	leaderPubkey = hex.EncodeToString(pub)

	pool.Exec(ctx, `INSERT INTO orgs (org_id, leader_pubkey, org_name, domain) VALUES ($1,$2,$3,$4)`,
		orgID, leaderPubkey, "Test Org", "test.local")
	pool.Exec(ctx, `INSERT INTO epoch_manifests (org_id, epoch_id, pk_mod, signed_by, signature) VALUES ($1,0,$2,$2,'sig')`,
		orgID, leaderPubkey)
	pool.Exec(ctx, `INSERT INTO members (org_id, pubkey, x25519_pubkey, role, join_epoch) VALUES ($1,$2,$2,'leader',0)`,
		orgID, leaderPubkey)

	t.Cleanup(func() {
		ctx2 := context.Background()
		pool.Exec(ctx2, "DELETE FROM audit_log WHERE org_id=$1", orgID)
		pool.Exec(ctx2, "DELETE FROM pending_submissions WHERE org_id=$1", orgID)
		pool.Exec(ctx2, "DELETE FROM members WHERE org_id=$1", orgID)
		pool.Exec(ctx2, "DELETE FROM epoch_manifests WHERE org_id=$1", orgID)
		pool.Exec(ctx2, "DELETE FROM orgs WHERE org_id=$1", orgID)
	})
	return orgID, leaderPubkey
}

func addModerator(t *testing.T, pool *pgxpool.Pool, orgID string) string {
	t.Helper()
	pub, _, _ := ed25519.GenerateKey(nil)
	pubkey := hex.EncodeToString(pub)
	pool.Exec(context.Background(),
		`INSERT INTO members (org_id, pubkey, x25519_pubkey, role, join_epoch) VALUES ($1,$2,$2,'moderator',0)`,
		orgID, pubkey)
	return pubkey
}

func insertMember(t *testing.T, pool *pgxpool.Pool, orgID, pubkey string) {
	t.Helper()
	pool.Exec(context.Background(),
		`INSERT INTO members (org_id, pubkey, x25519_pubkey, role, join_epoch) VALUES ($1,$2,$2,'member',0) ON CONFLICT DO NOTHING`,
		orgID, pubkey)
}

// buildReq returns a correctly signed SubmitMemoryRequest.
// The Ed25519 signature is over the raw SHA-256 hash bytes, not the hex string.
func buildReq(t *testing.T, orgID string) protocol.SubmitMemoryRequest {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(nil)
	contribPub := hex.EncodeToString(pub)

	ctHex := hex.EncodeToString([]byte("fake-encrypted-content"))
	dkHex := hex.EncodeToString([]byte("fake-dek"))

	ctBytes, _ := hex.DecodeString(ctHex)
	dkBytes, _ := hex.DecodeString(dkHex)
	hashBytes := sha256.Sum256(append(ctBytes, dkBytes...))
	hashHex := hex.EncodeToString(hashBytes[:])
	memoryType := protocol.MemoryTypeCorrectImplementation
	canonical := verify.SubmitMemoryMessage(orgID, 0, hashHex, contribPub, memoryType)
	sig := ed25519.Sign(priv, canonical)

	return protocol.SubmitMemoryRequest{
		OrgID:             orgID,
		EpochID:           0,
		Ciphertext:        ctHex,
		WrappedDekMod:     dkHex,
		SubmissionHash:    hashHex,
		ContributorPubkey: contribPub,
		ContributorSig:    hex.EncodeToString(sig),
		StackHint:         []string{"test"},
		MemoryType:        memoryType,
	}
}

// submitValid inserts the contributor as a member and submits the request.
// Returns the submission hash.
func submitValid(t *testing.T, ctx context.Context, pool *pgxpool.Pool, req protocol.SubmitMemoryRequest) string {
	t.Helper()
	insertMember(t, pool, req.OrgID, req.ContributorPubkey)
	if err := moderation.SubmitToQueue(ctx, pool, req, nil); err != nil {
		t.Fatalf("submit failed: %v", err)
	}
	return req.SubmissionHash
}

func TestSubmitToQueue_VerifiesSignature(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, _ := setupTestOrg(t, pool)

	req := buildReq(t, orgID)
	_ = submitValid(t, ctx, pool, req)

	// Tampered hash must fail — sig no longer matches
	badReq := buildReq(t, orgID)
	badReq.SubmissionHash = "0000000000000000000000000000000000000000000000000000000000000000"
	insertMember(t, pool, badReq.OrgID, badReq.ContributorPubkey)
	if err := moderation.SubmitToQueue(ctx, pool, badReq, nil); err == nil {
		t.Fatal("tampered hash should fail signature verification")
	}
}

func TestSubmitToQueue_VerifiesHash(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, _ := setupTestOrg(t, pool)

	req := buildReq(t, orgID)
	insertMember(t, pool, req.OrgID, req.ContributorPubkey)

	// Tamper ciphertext after signing — computed hash will differ from stored hash
	badReq := req
	badReq.Ciphertext = hex.EncodeToString([]byte("tampered-ciphertext"))
	if err := moderation.SubmitToQueue(ctx, pool, badReq, nil); err == nil {
		t.Fatal("mismatched hash should be rejected")
	}
}

func TestGetPendingQueue_RequiresModerator(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, leaderPubkey := setupTestOrg(t, pool)

	req := buildReq(t, orgID)
	_ = submitValid(t, ctx, pool, req)

	// Leader can view queue
	items, err := moderation.GetPendingQueue(ctx, pool, orgID, leaderPubkey)
	if err != nil {
		t.Fatalf("leader should see queue: %v", err)
	}
	if len(items) == 0 {
		t.Fatal("expected at least one pending item")
	}

	// Random non-member cannot view queue
	pub, _, _ := ed25519.GenerateKey(nil)
	_, err = moderation.GetPendingQueue(ctx, pool, orgID, hex.EncodeToString(pub))
	if err == nil {
		t.Fatal("non-member should be denied access to queue")
	}
}

func TestApproveSubmission_UpdatesStatus(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, _ := setupTestOrg(t, pool)
	modPubkey := addModerator(t, pool, orgID)

	req := buildReq(t, orgID)
	hash := submitValid(t, ctx, pool, req)

	if err := moderation.ApproveSubmission(ctx, pool, orgID, hash, modPubkey, req.MemoryType); err != nil {
		t.Fatalf("approval should succeed: %v", err)
	}

	var status string
	pool.QueryRow(ctx, "SELECT status FROM pending_submissions WHERE submission_hash=$1", hash).Scan(&status)
	if status != "pending_keyword" {
		t.Fatalf("expected status=pending_keyword, got %q", status)
	}
}

func TestDenySubmission_RecordsReason(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, _ := setupTestOrg(t, pool)
	modPubkey := addModerator(t, pool, orgID)

	req := buildReq(t, orgID)
	hash := submitValid(t, ctx, pool, req)

	reason := "contains credentials"
	if err := moderation.DenySubmission(ctx, pool, orgID, hash, modPubkey, reason); err != nil {
		t.Fatalf("denial should succeed: %v", err)
	}

	var status, storedReason string
	pool.QueryRow(ctx, "SELECT status, denial_reason FROM pending_submissions WHERE submission_hash=$1", hash).Scan(&status, &storedReason)
	if status != "denied" {
		t.Fatalf("expected status=denied, got %q", status)
	}
	if storedReason != reason {
		t.Fatalf("expected denial_reason=%q, got %q", reason, storedReason)
	}
}

func TestHubNeverStoresPlaintext(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, _ := setupTestOrg(t, pool)

	sentinel := fmt.Sprintf("WEVIBE_SENTINEL_%d", time.Now().UnixNano())
	ctHex := hex.EncodeToString([]byte("ENCRYPTED_" + sentinel))
	dkHex := hex.EncodeToString([]byte("fake-dek"))

	ctBytes, _ := hex.DecodeString(ctHex)
	dkBytes, _ := hex.DecodeString(dkHex)
	hashBytes := sha256.Sum256(append(ctBytes, dkBytes...))
	hashHex := hex.EncodeToString(hashBytes[:])

	pub, priv, _ := ed25519.GenerateKey(nil)
	contribPub := hex.EncodeToString(pub)
	memoryType := protocol.MemoryTypeCorrectImplementation
	canonical := verify.SubmitMemoryMessage(orgID, 0, hashHex, contribPub, memoryType)
	sig := ed25519.Sign(priv, canonical)
	insertMember(t, pool, orgID, contribPub)

	req := protocol.SubmitMemoryRequest{
		OrgID:             orgID,
		EpochID:           0,
		Ciphertext:        ctHex,
		WrappedDekMod:     dkHex,
		SubmissionHash:    hashHex,
		ContributorPubkey: contribPub,
		ContributorSig:    hex.EncodeToString(sig),
		StackHint:         []string{"test"},
		MemoryType:        memoryType,
	}
	if err := moderation.SubmitToQueue(ctx, pool, req, nil); err != nil {
		t.Fatalf("submit failed: %v", err)
	}

	// Sentinel is embedded inside the ciphertext blob (ciphertext_hex column) — that's expected.
	// It must NOT appear in any other column.
	for _, col := range []string{"submission_hash", "wrapped_dek_mod", "contributor_sig"} {
		var count int
		pool.QueryRow(ctx, fmt.Sprintf(
			"SELECT count(*) FROM pending_submissions WHERE %s::text LIKE $1", col),
			"%"+sentinel+"%").Scan(&count)
		if count > 0 {
			t.Errorf("SECURITY VIOLATION: sentinel found in pending_submissions.%s", col)
		}
	}
	t.Log("Hub plaintext isolation verified")
}
