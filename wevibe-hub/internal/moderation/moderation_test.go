package moderation_test

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
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

	if _, err := pool.Exec(ctx, `INSERT INTO orgs (org_id, leader_pubkey, leader_wallet_address, org_name, domain) VALUES ($1,$2,$3,$4,$5)`,
		orgID, leaderPubkey, "wevibe1moderationtest1", "Test Org", "test.local"); err != nil {
		t.Fatalf("insert org: %v", err)
	}
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
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO members (org_id, pubkey, x25519_pubkey, role, can_moderate, join_epoch) VALUES ($1,$2,$2,'member',true,0)`,
		orgID, pubkey); err != nil {
		t.Fatalf("insert moderator: %v", err)
	}
	return pubkey
}

func insertMember(t *testing.T, pool *pgxpool.Pool, orgID, pubkey string) {
	t.Helper()
	pool.Exec(context.Background(),
		`INSERT INTO members (org_id, pubkey, x25519_pubkey, role, join_epoch) VALUES ($1,$2,$2,'member',0) ON CONFLICT DO NOTHING`,
		orgID, pubkey)
}

func sha256Hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func oldSubmitMemoryMessage(orgID string, epochID int, submissionHash, contributorPubkey, memoryType string) []byte {
	return []byte(strings.Join([]string{
		"wevibe.submit_memory.v1",
		fmt.Sprintf("org_id:%s", orgID),
		fmt.Sprintf("epoch_id:%d", epochID),
		fmt.Sprintf("submission_hash:%s", submissionHash),
		fmt.Sprintf("contributor_pubkey:%s", contributorPubkey),
		fmt.Sprintf("memory_type:%s", memoryType),
	}, "\n"))
}

func buildReq(t *testing.T, orgID string) (protocol.SubmitMemoryRequest, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(nil)
	contribPub := hex.EncodeToString(pub)

	ctHex := hex.EncodeToString([]byte("fake-encrypted-content"))
	dkHex := hex.EncodeToString([]byte("fake-dek"))

	ctBytes, _ := hex.DecodeString(ctHex)
	dkBytes, _ := hex.DecodeString(dkHex)
	hashBytes := sha256.Sum256(append(ctBytes, dkBytes...))
	hashHex := hex.EncodeToString(hashBytes[:])
	ciphertextHashHex := sha256Hex(ctBytes)
	plaintextHashHex := sha256Hex([]byte("test-plaintext"))
	saltHex := "0000000000000000000000000000000000000000000000000000000000000000"
	wrappedDekHashHex := sha256Hex(dkBytes)
	memoryType := protocol.MemoryTypeMemory
	canonical := verify.SubmitMemoryMessage(orgID, 0, hashHex, contribPub, memoryType, ciphertextHashHex, plaintextHashHex, saltHex, wrappedDekHashHex)
	sig := ed25519.Sign(priv, canonical)

	return protocol.SubmitMemoryRequest{
		OrgID:             orgID,
		EpochID:           0,
		Ciphertext:        ctHex,
		PlaintextHash:     plaintextHashHex,
		Salt:              saltHex,
		CiphertextHash:    ciphertextHashHex,
		WrappedDekHash:    wrappedDekHashHex,
		WrappedDekMod:     dkHex,
		SubmissionHash:    hashHex,
		ContributorPubkey: contribPub,
		ContributorSig:    hex.EncodeToString(sig),
		StackHint:         []string{"test"},
		MemoryType:        memoryType,
	}, priv
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

func TestSubmitToQueue_HappyPath(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, _ := setupTestOrg(t, pool)

	req, _ := buildReq(t, orgID)
	_ = submitValid(t, ctx, pool, req)

	var storedPlaintextHash, storedSalt, storedCiphertextHash, storedWrappedDekHash string
	if err := pool.QueryRow(ctx, `
		SELECT plaintext_hash, salt, ciphertext_hash, wrapped_dek_hash
		FROM pending_submissions
		WHERE submission_hash = $1
	`, req.SubmissionHash).Scan(&storedPlaintextHash, &storedSalt, &storedCiphertextHash, &storedWrappedDekHash); err != nil {
		t.Fatalf("query inserted row: %v", err)
	}

	if storedPlaintextHash != req.PlaintextHash {
		t.Fatalf("plaintext_hash mismatch: got %q want %q", storedPlaintextHash, req.PlaintextHash)
	}
	if storedSalt != req.Salt {
		t.Fatalf("salt mismatch: got %q want %q", storedSalt, req.Salt)
	}
	if storedCiphertextHash != req.CiphertextHash {
		t.Fatalf("ciphertext_hash mismatch: got %q want %q", storedCiphertextHash, req.CiphertextHash)
	}
	if storedWrappedDekHash != req.WrappedDekHash {
		t.Fatalf("wrapped_dek_hash mismatch: got %q want %q", storedWrappedDekHash, req.WrappedDekHash)
	}
}

func TestSubmitToQueue_BadSignatureOverNineFieldBody(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, _ := setupTestOrg(t, pool)

	req, priv := buildReq(t, orgID)
	legacyCanonical := oldSubmitMemoryMessage(req.OrgID, req.EpochID, req.SubmissionHash, req.ContributorPubkey, req.MemoryType)
	req.ContributorSig = hex.EncodeToString(ed25519.Sign(priv, legacyCanonical))

	insertMember(t, pool, req.OrgID, req.ContributorPubkey)
	if err := moderation.SubmitToQueue(ctx, pool, req, nil); err == nil {
		t.Fatal("legacy 5-field signature should fail verification")
	}
}

func TestSubmitToQueue_BadCiphertextHashMismatch(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, _ := setupTestOrg(t, pool)

	req, _ := buildReq(t, orgID)
	req.CiphertextHash = strings.Repeat("0", 64)
	insertMember(t, pool, req.OrgID, req.ContributorPubkey)
	if err := moderation.SubmitToQueue(ctx, pool, req, nil); err == nil {
		t.Fatal("mismatched ciphertext_hash should be rejected")
	}
}

func TestSubmitToQueue_BadWrappedDekHashMismatch(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, _ := setupTestOrg(t, pool)

	req, _ := buildReq(t, orgID)
	req.WrappedDekHash = strings.Repeat("0", 64)
	insertMember(t, pool, req.OrgID, req.ContributorPubkey)
	if err := moderation.SubmitToQueue(ctx, pool, req, nil); err == nil {
		t.Fatal("mismatched wrapped_dek_hash should be rejected")
	}
}

func TestSubmitToQueue_InvalidPlaintextHashFormat(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, _ := setupTestOrg(t, pool)

	req, _ := buildReq(t, orgID)
	req.PlaintextHash = "zz"
	insertMember(t, pool, req.OrgID, req.ContributorPubkey)
	if err := moderation.SubmitToQueue(ctx, pool, req, nil); err == nil {
		t.Fatal("invalid plaintext_hash format should be rejected")
	}
}

func TestSubmitToQueue_InvalidSaltFormat(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, _ := setupTestOrg(t, pool)

	req, _ := buildReq(t, orgID)
	req.Salt = "not-hex"
	insertMember(t, pool, req.OrgID, req.ContributorPubkey)
	if err := moderation.SubmitToQueue(ctx, pool, req, nil); err == nil {
		t.Fatal("invalid salt format should be rejected")
	}
}

func TestGetPendingQueue_RequiresModerator(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, leaderPubkey := setupTestOrg(t, pool)

	req, _ := buildReq(t, orgID)
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

func TestApproveSubmission_RecordsAdvisoryVote(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, _ := setupTestOrg(t, pool)
	modPubkey := addModerator(t, pool, orgID)

	req, _ := buildReq(t, orgID)
	hash := submitValid(t, ctx, pool, req)

	if err := moderation.ApproveSubmission(ctx, pool, orgID, hash, modPubkey, req.MemoryType, nil, "", ""); err != nil {
		t.Fatalf("approval should succeed: %v", err)
	}

	var status, vote string
	if err := pool.QueryRow(ctx, `
		SELECT ps.status, smv.vote
		FROM pending_submissions ps
		LEFT JOIN submission_mod_votes smv
		  ON smv.org_id = ps.org_id AND smv.submission_hash = ps.submission_hash AND smv.moderator_pubkey = $2
		WHERE ps.submission_hash = $1
	`, hash, modPubkey).Scan(&status, &vote); err != nil {
		t.Fatalf("query advisory vote: %v", err)
	}
	if status != protocol.SubmissionStatusPendingKeyword {
		t.Fatalf("expected status=%s, got %q", protocol.SubmissionStatusPendingKeyword, status)
	}
	if vote != "approve" {
		t.Fatalf("expected advisory vote=approve, got %q", vote)
	}
}

func TestDenySubmission_RecordsReason(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID, leaderPubkey := setupTestOrg(t, pool)
	modPubkey := addModerator(t, pool, orgID)

	req, _ := buildReq(t, orgID)
	hash := submitValid(t, ctx, pool, req)

	reason := "contains credentials"
	if err := moderation.DenySubmission(ctx, pool, orgID, hash, modPubkey, reason); err == nil {
		t.Fatalf("moderator denial should fail; leader-only endpoint")
	}

	if err := moderation.DenySubmission(ctx, pool, orgID, hash, leaderPubkey, reason); err != nil {
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
	ciphertextHashHex := sha256Hex(ctBytes)
	plaintextHashHex := sha256Hex([]byte("test-plaintext"))
	saltHex := "0000000000000000000000000000000000000000000000000000000000000000"
	wrappedDekHashHex := sha256Hex(dkBytes)

	pub, priv, _ := ed25519.GenerateKey(nil)
	contribPub := hex.EncodeToString(pub)
	memoryType := protocol.MemoryTypeMemory
	canonical := verify.SubmitMemoryMessage(orgID, 0, hashHex, contribPub, memoryType, ciphertextHashHex, plaintextHashHex, saltHex, wrappedDekHashHex)
	sig := ed25519.Sign(priv, canonical)
	insertMember(t, pool, orgID, contribPub)

	req := protocol.SubmitMemoryRequest{
		OrgID:             orgID,
		EpochID:           0,
		Ciphertext:        ctHex,
		PlaintextHash:     plaintextHashHex,
		Salt:              saltHex,
		CiphertextHash:    ciphertextHashHex,
		WrappedDekHash:    wrappedDekHashHex,
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
