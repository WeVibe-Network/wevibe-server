package handlers_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
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
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/db"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
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
	orgID, contributor := setupOrgForModerationWithActor(t, pool)
	return orgID, contributor.pubHex
}

func setupOrgForModerationWithActor(t *testing.T, pool *pgxpool.Pool) (orgID string, contributor voteActor) {
	ctx := context.Background()
	orgID = "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := strings.Repeat("a", 64)
	contributor = newVoteActor(t)

	orgReq := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: strings.Repeat("c", 64),
		LeaderWallet:       "wevibe1handlersmodtest1",
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

	_, err = pool.Exec(ctx, `
		INSERT INTO members (org_id, pubkey, x25519_pubkey, role, can_contribute)
		VALUES ($1, $2, $3, 'member', true)
	`, orgID, contributor.pubHex, randHex(t, 32))
	if err != nil {
		t.Fatalf("insert contributor member: %v", err)
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM pending_submissions WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})

	return orgID, contributor
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

func TestSubmitMemory_AcceptsValidEpochZeroSubmission(t *testing.T) {
	pool := testPoolMod(t)
	handlers.SetPool(pool)

	orgID, contributor := setupOrgForModerationWithActor(t, pool)

	ciphertext := randHex(t, 32)
	wrapped := randHex(t, 32)
	plaintextHash := randHex(t, 32)
	salt := randHex(t, 32)

	ciphertextBytes, err := hex.DecodeString(ciphertext)
	if err != nil {
		t.Fatalf("decode ciphertext: %v", err)
	}
	wrappedBytes, err := hex.DecodeString(wrapped)
	if err != nil {
		t.Fatalf("decode wrapped dek: %v", err)
	}

	combined := append(ciphertextBytes, wrappedBytes...)
	submissionHashBytes := sha256.Sum256(combined)
	submissionHash := hex.EncodeToString(submissionHashBytes[:])

	ciphertextHashBytes := sha256.Sum256(ciphertextBytes)
	ciphertextHash := hex.EncodeToString(ciphertextHashBytes[:])

	wrappedDekHashBytes := sha256.Sum256(wrappedBytes)
	wrappedDekHash := hex.EncodeToString(wrappedDekHashBytes[:])

	canonical := verify.SubmitMemoryMessage(
		orgID,
		0,
		submissionHash,
		contributor.pubHex,
		protocol.MemoryTypeMemory,
		ciphertextHash,
		plaintextHash,
		salt,
		wrappedDekHash,
	)
	sig := hex.EncodeToString(ed25519.Sign(contributor.priv, canonical))

	reqBody := protocol.SubmitMemoryRequest{
		OrgID:             orgID,
		EpochID:           0,
		Ciphertext:        ciphertext,
		PlaintextHash:     plaintextHash,
		Salt:              salt,
		CiphertextHash:    ciphertextHash,
		WrappedDekHash:    wrappedDekHash,
		WrappedDekMod:     wrapped,
		StackHint:         []string{},
		SubmissionHash:    submissionHash,
		ContributorPubkey: contributor.pubHex,
		ContributorSig:    sig,
		MemoryType:        protocol.MemoryTypeMemory,
	}
	body, _ := json.Marshal(reqBody)

	r := chi.NewRouter()
	r.Route("/v1/orgs/{orgID}", func(r chi.Router) {
		r.Use(auth.RequireVerifiedMembership(pool))
		r.Post("/submit", handlers.SubmitMemory)
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/orgs/"+orgID+"/submit", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", contributor.authHeader(time.Now()))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"pending"`) {
		t.Fatalf("expected response status pending, got: %s", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), submissionHash) {
		t.Fatalf("expected response to include submission hash %s, got: %s", submissionHash, w.Body.String())
	}
}

// Epoch rotation is retired: the only admissible epoch is the constant 0.
// A single gate rejects every nonzero epoch_id (negative or positive).
func TestSubmitMemory_RejectsNonzeroEpoch(t *testing.T) {
	pool := testPoolMod(t)
	handlers.SetPool(pool)

	orgID, contributor := setupOrgForModerationWithActor(t, pool)

	reqBody := protocol.SubmitMemoryRequest{
		OrgID:             orgID,
		EpochID:           999,
		Ciphertext:        strings.Repeat("a", 64),
		WrappedDekMod:     strings.Repeat("b", 64),
		SubmissionHash:    strings.Repeat("c", 64),
		PlaintextHash:     strings.Repeat("e", 64),
		Salt:              strings.Repeat("1", 64),
		CiphertextHash:    strings.Repeat("2", 64),
		WrappedDekHash:    strings.Repeat("3", 64),
		ContributorPubkey: contributor.pubHex,
		ContributorSig:    strings.Repeat("d", 128),
		MemoryType:        protocol.MemoryTypeMemory,
	}
	body, _ := json.Marshal(reqBody)

	r := chi.NewRouter()
	r.Route("/v1/orgs/{orgID}", func(r chi.Router) {
		r.Use(auth.RequireVerifiedMembership(pool))
		r.Post("/submit", handlers.SubmitMemory)
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/orgs/"+orgID+"/submit", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", contributor.authHeader(time.Now()))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "epoch_id must be 0") {
		t.Errorf("expected epoch_id must be 0 error, got: %s", w.Body.String())
	}
}

func TestVoteOnSubmission_AdvisoryTallies(t *testing.T) {
	pool := testPoolMod(t)
	handlers.SetPool(pool)

	orgID, contributor := setupOrgForModerationWithActor(t, pool)
	ctx := context.Background()

	mod1 := newVoteActor(t)
	mod2 := newVoteActor(t)

	_, err := pool.Exec(ctx, `
	        INSERT INTO members (org_id, pubkey, x25519_pubkey, role, can_moderate)
	        VALUES ($1, $2, $3, 'member', true)
	    `, orgID, mod1.pubHex, randHex(t, 32))
	if err != nil {
		t.Fatalf("insert moderator 1: %v", err)
	}
	_, err = pool.Exec(ctx, `
	        INSERT INTO members (org_id, pubkey, x25519_pubkey, role, can_moderate)
	        VALUES ($1, $2, $3, 'member', true)
	    `, orgID, mod2.pubHex, randHex(t, 32))
	if err != nil {
		t.Fatalf("insert moderator 2: %v", err)
	}

	submissionHash := randHex(t, 32)
	ciphertext := randHex(t, 32)
	wrapped := randHex(t, 32)

	_, err = pool.Exec(ctx, `
	        INSERT INTO pending_submissions
				(submission_hash, org_id, epoch_id, contributor_pubkey, ciphertext_hex, plaintext_hash, salt, ciphertext_hash, wrapped_dek_hash, wrapped_dek_mod, contributor_sig, stack_hint, memory_type, status)
			VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8, $9, $10, ARRAY[]::TEXT[], $11, $12)
		`, submissionHash, orgID, contributor.pubHex, ciphertext, randHex(t, 32), randHex(t, 32), randHex(t, 32), randHex(t, 32), wrapped, strings.Repeat("f", 128), protocol.MemoryTypeMemory, protocol.SubmissionStatusPendingKeyword)
	if err != nil {
		t.Fatalf("insert pending submission: %v", err)
	}

	router := chi.NewRouter()
	router.Post("/v1/orgs/{orgID}/moderation/{submissionHash}/vote", handlers.VoteOnSubmission)

	voteURL := fmt.Sprintf("/v1/orgs/%s/moderation/%s/vote", orgID, submissionHash)
	voteBody := func(v string) *bytes.Reader {
		payload, marshalErr := json.Marshal(map[string]string{"vote": v})
		if marshalErr != nil {
			t.Fatalf("marshal vote payload: %v", marshalErr)
		}
		return bytes.NewReader(payload)
	}

	req1 := httptest.NewRequest(http.MethodPost, voteURL, voteBody("approve"))
	req1.Header.Set("Content-Type", "application/json")
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
	if payload["approve"].(float64) != 1 {
		t.Fatalf("expected approve=1, got %v", payload["approve"])
	}
	if payload["flag"].(float64) != 0 {
		t.Fatalf("expected flag=0, got %v", payload["flag"])
	}

	req2 := httptest.NewRequest(http.MethodPost, voteURL, voteBody("flag"))
	req2.Header.Set("Content-Type", "application/json")
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
	if payload["approve"].(float64) != 1 {
		t.Fatalf("expected approve=1 after second vote, got %v", payload["approve"])
	}
	if payload["flag"].(float64) != 1 {
		t.Fatalf("expected flag=1 after second vote, got %v", payload["flag"])
	}

	reqDup := httptest.NewRequest(http.MethodPost, voteURL, voteBody("flag"))
	reqDup.Header.Set("Content-Type", "application/json")
	reqDup.Header.Set("Authorization", mod1.authHeader(time.Now()))
	respDup := httptest.NewRecorder()
	router.ServeHTTP(respDup, reqDup)
	if respDup.Code != http.StatusOK {
		t.Fatalf("expected 200 on repeated vote update, got %d: %s", respDup.Code, respDup.Body.String())
	}

	payload = map[string]any{}
	if err := json.NewDecoder(respDup.Body).Decode(&payload); err != nil {
		t.Fatalf("decode repeated vote response: %v", err)
	}
	if payload["approve"].(float64) != 0 {
		t.Fatalf("expected approve=0 after update, got %v", payload["approve"])
	}
	if payload["flag"].(float64) != 2 {
		t.Fatalf("expected flag=2 after update, got %v", payload["flag"])
	}

	var dbStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM pending_submissions WHERE org_id = $1 AND submission_hash = $2`, orgID, submissionHash).Scan(&dbStatus); err != nil {
		t.Fatalf("query submission status: %v", err)
	}
	if dbStatus != protocol.SubmissionStatusPendingKeyword {
		t.Fatalf("expected DB status %s, got %s", protocol.SubmissionStatusPendingKeyword, dbStatus)
	}
}
