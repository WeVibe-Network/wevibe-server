package handlers_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/api/handlers"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/db"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

func testPoolMod(t *testing.T) *pgxpool.Pool {
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

func setupOrgForModeration(t *testing.T, pool *pgxpool.Pool) (orgID, contributorPubkey string) {
	ctx := context.Background()
	orgID = "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := strings.Repeat("a", 64)
	contributorPubkey = strings.Repeat("b", 64)

	orgReq := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: strings.Repeat("c", 64),
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("d", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}
	_, err := orgs.CreateOrg(ctx, pool, orgID, orgReq)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM pending_submissions WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})

	return orgID, contributorPubkey
}

type voteActor struct {
	priv   ed25519.PrivateKey
	pub    ed25519.PublicKey
	pubHex string
}

func newVoteActor(t *testing.T) voteActor {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519 key: %v", err)
	}
	return voteActor{
		priv:   priv,
		pub:    pub,
		pubHex: hex.EncodeToString(pub),
	}
}

func (a voteActor) authHeader(ts time.Time) string {
	timestamp := ts.UTC().Format(time.RFC3339)
	sig := ed25519.Sign(a.priv, []byte(timestamp))
	return fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", a.pubHex, timestamp, hex.EncodeToString(sig))
}

func randHex(t *testing.T, n int) string {
	t.Helper()
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("rand.Read failed: %v", err)
	}
	return hex.EncodeToString(buf)
}

func TestSubmitMemory_RejectsZeroEpoch(t *testing.T) {
	pool := testPoolMod(t)
	handlers.SetPool(pool)

	orgID, contributorPubkey := setupOrgForModeration(t, pool)

	reqBody := protocol.SubmitMemoryRequest{
		OrgID:             orgID,
		EpochID:           0,
		Ciphertext:        strings.Repeat("a", 64),
		WrappedDekMod:     strings.Repeat("b", 64),
		SubmissionHash:    strings.Repeat("c", 64),
		ContributorPubkey: contributorPubkey,
		ContributorSig:    strings.Repeat("d", 128),
		MemoryType:        protocol.MemoryTypeMemory,
	}
	body, _ := json.Marshal(reqBody)

	r := chi.NewRouter()
	r.Post("/v1/orgs/{orgID}/submit", handlers.SubmitMemory)

	req := httptest.NewRequest(http.MethodPost, "/v1/orgs/"+orgID+"/submit", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "epoch_id") {
		t.Errorf("expected error message to mention epoch_id, got: %s", w.Body.String())
	}
}

func TestSubmitMemory_RejectsNegativeEpoch(t *testing.T) {
	pool := testPoolMod(t)
	handlers.SetPool(pool)

	orgID, contributorPubkey := setupOrgForModeration(t, pool)

	reqBody := protocol.SubmitMemoryRequest{
		OrgID:             orgID,
		EpochID:           -1,
		Ciphertext:        strings.Repeat("a", 64),
		WrappedDekMod:     strings.Repeat("b", 64),
		SubmissionHash:    strings.Repeat("c", 64),
		ContributorPubkey: contributorPubkey,
		ContributorSig:    strings.Repeat("d", 128),
		MemoryType:        protocol.MemoryTypeMemory,
	}
	body, _ := json.Marshal(reqBody)

	r := chi.NewRouter()
	r.Post("/v1/orgs/{orgID}/submit", handlers.SubmitMemory)

	req := httptest.NewRequest(http.MethodPost, "/v1/orgs/"+orgID+"/submit", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestSubmitMemory_RejectsNonexistentEpoch(t *testing.T) {
	pool := testPoolMod(t)
	handlers.SetPool(pool)

	orgID, contributorPubkey := setupOrgForModeration(t, pool)

	reqBody := protocol.SubmitMemoryRequest{
		OrgID:             orgID,
		EpochID:           999,
		Ciphertext:        strings.Repeat("a", 64),
		WrappedDekMod:     strings.Repeat("b", 64),
		SubmissionHash:    strings.Repeat("c", 64),
		ContributorPubkey: contributorPubkey,
		ContributorSig:    strings.Repeat("d", 128),
		MemoryType:        protocol.MemoryTypeMemory,
	}
	body, _ := json.Marshal(reqBody)

	r := chi.NewRouter()
	r.Post("/v1/orgs/{orgID}/submit", handlers.SubmitMemory)

	req := httptest.NewRequest(http.MethodPost, "/v1/orgs/"+orgID+"/submit", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "epoch_id does not exist") {
		t.Errorf("expected error about nonexistent epoch, got: %s", w.Body.String())
	}
}

func TestVoteOnSubmission_Quorum(t *testing.T) {
	pool := testPoolMod(t)
	handlers.SetPool(pool)

	orgID, contributorPubkey := setupOrgForModeration(t, pool)
	ctx := context.Background()

	if err := orgs.UpdateRequiredApprovals(ctx, pool, orgID, 2); err != nil {
		t.Fatalf("update required approvals: %v", err)
	}

	mod1 := newVoteActor(t)
	mod2 := newVoteActor(t)

	_, err := pool.Exec(ctx, `
        INSERT INTO members (org_id, pubkey, x25519_pubkey, role, join_epoch)
        VALUES ($1, $2, $3, 'moderator', 0)
    `, orgID, mod1.pubHex, randHex(t, 32))
	if err != nil {
		t.Fatalf("insert moderator 1: %v", err)
	}
	_, err = pool.Exec(ctx, `
        INSERT INTO members (org_id, pubkey, x25519_pubkey, role, join_epoch)
        VALUES ($1, $2, $3, 'moderator', 0)
    `, orgID, mod2.pubHex, randHex(t, 32))
	if err != nil {
		t.Fatalf("insert moderator 2: %v", err)
	}

	submissionHash := randHex(t, 32)
	ciphertext := randHex(t, 32)
	wrapped := randHex(t, 32)

	_, err = pool.Exec(ctx, `
        INSERT INTO pending_submissions
			(submission_hash, org_id, epoch_id, contributor_pubkey, ciphertext_hex, wrapped_dek_mod, contributor_sig, stack_hint, memory_type)
		VALUES ($1, $2, 0, $3, $4, $5, $6, ARRAY[]::TEXT[], $7)
	`, submissionHash, orgID, contributorPubkey, ciphertext, wrapped, strings.Repeat("f", 128), protocol.MemoryTypeMemory)
	if err != nil {
		t.Fatalf("insert pending submission: %v", err)
	}

	router := chi.NewRouter()
	router.Post("/v1/orgs/{orgID}/moderation/{submissionHash}/vote", handlers.VoteOnSubmission)

	voteURL := fmt.Sprintf("/v1/orgs/%s/moderation/%s/vote", orgID, submissionHash)

	req1 := httptest.NewRequest(http.MethodPost, voteURL, nil)
	req1.Header.Set("Authorization", mod1.authHeader(time.Now()))
	resp1 := httptest.NewRecorder()
	router.ServeHTTP(resp1, req1)
	if resp1.Code != http.StatusOK {
		t.Fatalf("expected 200 for first vote, got %d: %s", resp1.Code, resp1.Body.String())
	}

	var payload map[string]any
	if err := json.NewDecoder(resp1.Body).Decode(&payload); err != nil {
		t.Fatalf("decode first vote response: %v", err)
	}
	if payload["votes"].(float64) != 1 {
		t.Fatalf("expected 1 vote, got %v", payload["votes"])
	}
	if payload["ready"].(bool) {
		t.Fatalf("expected ready=false after first vote")
	}

	req2 := httptest.NewRequest(http.MethodPost, voteURL, nil)
	req2.Header.Set("Authorization", mod2.authHeader(time.Now()))
	resp2 := httptest.NewRecorder()
	router.ServeHTTP(resp2, req2)
	if resp2.Code != http.StatusOK {
		t.Fatalf("expected 200 for second vote, got %d: %s", resp2.Code, resp2.Body.String())
	}

	payload = map[string]any{}
	if err := json.NewDecoder(resp2.Body).Decode(&payload); err != nil {
		t.Fatalf("decode second vote response: %v", err)
	}
	if payload["votes"].(float64) != 2 {
		t.Fatalf("expected 2 votes after quorum, got %v", payload["votes"])
	}
	if !payload["ready"].(bool) {
		t.Fatalf("expected ready=true after quorum")
	}
	if status := payload["status"].(string); status != "ready" {
		t.Fatalf("expected status ready, got %s", status)
	}

	var dbStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM pending_submissions WHERE org_id = $1 AND submission_hash = $2`, orgID, submissionHash).Scan(&dbStatus); err != nil {
		t.Fatalf("query submission status: %v", err)
	}
	if dbStatus != "ready" {
		t.Fatalf("expected DB status ready, got %s", dbStatus)
	}

	reqDup := httptest.NewRequest(http.MethodPost, voteURL, nil)
	reqDup.Header.Set("Authorization", mod1.authHeader(time.Now()))
	respDup := httptest.NewRecorder()
	router.ServeHTTP(respDup, reqDup)
	if respDup.Code != http.StatusConflict {
		t.Fatalf("expected 409 on duplicate vote, got %d", respDup.Code)
	}
}
