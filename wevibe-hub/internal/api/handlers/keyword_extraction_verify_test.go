package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/api/handlers"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/embed"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

type verifyKeywordsResponse struct {
	Verified int                    `json:"verified"`
	Results  []verifyKeywordOutcome `json:"results"`
}

type verifyKeywordOutcome struct {
	SubmissionHash string `json:"submission_hash"`
	Passed         bool   `json:"passed"`
	Error          string `json:"error"`
}

func TestVerifyKeywordsRequest_UnmarshalEntriesVector(t *testing.T) {
	input := []byte(`{"entries":[{"submission_hash":"hash-1","vector":[0.1,0.2],"embedding_model_id":"model-a","embedding_schema_version":"schema-1"}]}`)

	var req handlers.VerifyKeywordsRequest
	if err := json.Unmarshal(input, &req); err != nil {
		t.Fatalf("unmarshal request: %v", err)
	}

	if len(req.Entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(req.Entries))
	}
	if req.Entries[0].SubmissionHash != "hash-1" {
		t.Fatalf("unexpected submission hash: %q", req.Entries[0].SubmissionHash)
	}
	if len(req.Entries[0].Vector) != 2 {
		t.Fatalf("expected vector length 2, got %d", len(req.Entries[0].Vector))
	}
}

func TestVerifyKeywords_RejectsEmptyEntries(t *testing.T) {
	pool := testPoolMod(t)
	handlers.SetPool(pool)

	orgID, _ := setupOrgForModeration(t, pool)
	leader := newVoteActor(t)
	insertLeaderForVerify(t, pool, orgID, leader.pubHex)

	router := chi.NewRouter()
	router.Post("/v1/orgs/{orgID}/verify-keywords", handlers.VerifyKeywords)

	resp := performVerifyKeywordsRequest(t, router, orgID, leader, handlers.VerifyKeywordsRequest{Entries: []handlers.VerifyEntry{}})
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", resp.Code, resp.Body.String())
	}
	if !strings.Contains(resp.Body.String(), "entries required") {
		t.Fatalf("expected entries required error, got: %s", resp.Body.String())
	}
}

func TestVerifyKeywords_FailClosedOnWrongVectorDimension(t *testing.T) {
	pool := testPoolMod(t)
	handlers.SetPool(pool)

	orgID, contributorPubkey := setupOrgForModeration(t, pool)
	leader := newVoteActor(t)
	insertLeaderForVerify(t, pool, orgID, leader.pubHex)

	submissionHash := insertPendingSubmissionWithStoredExtraction(t, pool, orgID, contributorPubkey)

	router := chi.NewRouter()
	router.Post("/v1/orgs/{orgID}/verify-keywords", handlers.VerifyKeywords)

	badVector := make([]float32, embed.EMBED_DIM-1)
	resp := performVerifyKeywordsRequest(t, router, orgID, leader, handlers.VerifyKeywordsRequest{
		Entries: []handlers.VerifyEntry{{
			SubmissionHash:         submissionHash,
			Vector:                 badVector,
			EmbeddingModelID:       "leader-card-model",
			EmbeddingSchemaVersion: "schema-v1",
		}},
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.Code, resp.Body.String())
	}

	var payload verifyKeywordsResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Verified != 0 {
		t.Fatalf("expected verified=0, got %d", payload.Verified)
	}
	if len(payload.Results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(payload.Results))
	}
	if payload.Results[0].Passed {
		t.Fatalf("expected passed=false for wrong vector dimension")
	}
	expectedError := fmt.Sprintf("missing or wrong-dimension embedding vector (got %d, expected %d)", len(badVector), embed.EMBED_DIM)
	if payload.Results[0].Error != expectedError {
		t.Fatalf("unexpected error: got %q want %q", payload.Results[0].Error, expectedError)
	}

	var status string
	var embeddingVector []byte
	err := pool.QueryRow(context.Background(), `
		SELECT status, embedding_vector
		FROM pending_submissions
		WHERE org_id = $1 AND submission_hash = $2
	`, orgID, submissionHash).Scan(&status, &embeddingVector)
	if err != nil {
		t.Fatalf("query pending submission: %v", err)
	}
	if status != protocol.SubmissionStatusPendingKeyword {
		t.Fatalf("status changed unexpectedly: got %q want %q", status, protocol.SubmissionStatusPendingKeyword)
	}
	if len(embeddingVector) != 0 {
		t.Fatalf("expected no embedding vector persisted on failure, got %s", string(embeddingVector))
	}
}

func TestVerifyKeywords_TransitionsToPendingChainAndPersistsEmbedding(t *testing.T) {
	pool := testPoolMod(t)
	handlers.SetPool(pool)

	orgID, contributorPubkey := setupOrgForModeration(t, pool)
	leader := newVoteActor(t)
	insertLeaderForVerify(t, pool, orgID, leader.pubHex)

	submissionHash := insertPendingSubmissionWithStoredExtraction(t, pool, orgID, contributorPubkey)

	router := chi.NewRouter()
	router.Post("/v1/orgs/{orgID}/verify-keywords", handlers.VerifyKeywords)

	goodVector := make([]float32, embed.EMBED_DIM)
	goodVector[0] = 0.125
	goodVector[embed.EMBED_DIM-1] = 0.875
	resp := performVerifyKeywordsRequest(t, router, orgID, leader, handlers.VerifyKeywordsRequest{
		Entries: []handlers.VerifyEntry{{
			SubmissionHash:         submissionHash,
			Vector:                 goodVector,
			EmbeddingModelID:       "leader-card-model",
			EmbeddingSchemaVersion: "schema-v1",
		}},
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.Code, resp.Body.String())
	}

	var payload verifyKeywordsResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Verified != 1 {
		t.Fatalf("expected verified=1, got %d", payload.Verified)
	}
	if len(payload.Results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(payload.Results))
	}
	if !payload.Results[0].Passed {
		t.Fatalf("expected passed=true for valid vector, got false with error: %s", payload.Results[0].Error)
	}

	var status string
	var embeddingVector []byte
	var modelID string
	var schemaVersion string
	err := pool.QueryRow(context.Background(), `
		SELECT status, embedding_vector, embedding_model_id, embedding_schema_version
		FROM pending_submissions
		WHERE org_id = $1 AND submission_hash = $2
	`, orgID, submissionHash).Scan(&status, &embeddingVector, &modelID, &schemaVersion)
	if err != nil {
		t.Fatalf("query updated submission: %v", err)
	}
	if status != protocol.SubmissionStatusPendingChain {
		t.Fatalf("expected status %q, got %q", protocol.SubmissionStatusPendingChain, status)
	}
	if modelID != "leader-card-model" {
		t.Fatalf("unexpected embedding_model_id: %q", modelID)
	}
	if schemaVersion != "schema-v1" {
		t.Fatalf("unexpected embedding_schema_version: %q", schemaVersion)
	}

	var storedVector []float32
	if err := json.Unmarshal(embeddingVector, &storedVector); err != nil {
		t.Fatalf("unmarshal embedding_vector: %v", err)
	}
	if len(storedVector) != embed.EMBED_DIM {
		t.Fatalf("expected stored vector dim %d, got %d", embed.EMBED_DIM, len(storedVector))
	}
	if storedVector[0] != goodVector[0] || storedVector[embed.EMBED_DIM-1] != goodVector[embed.EMBED_DIM-1] {
		t.Fatalf("stored vector mismatch at endpoints")
	}
}

func insertLeaderForVerify(t *testing.T, pool *pgxpool.Pool, orgID, pubkey string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO members (org_id, pubkey, x25519_pubkey, role, join_epoch)
		VALUES ($1, $2, $3, 'leader', 0)
		ON CONFLICT (org_id, pubkey) DO UPDATE SET role = EXCLUDED.role
	`, orgID, pubkey, randHex(t, 32))
	if err != nil {
		t.Fatalf("insert leader member: %v", err)
	}
}

func insertPendingSubmissionWithStoredExtraction(t *testing.T, pool *pgxpool.Pool, orgID, contributorPubkey string) string {
	t.Helper()

	_, err := pool.Exec(context.Background(), `
		INSERT INTO org_keywords (org_id, keyword)
		VALUES ($1, $2)
		ON CONFLICT (org_id, keyword) DO UPDATE SET deprecated = false
	`, orgID, "alpha")
	if err != nil {
		t.Fatalf("insert org keyword: %v", err)
	}

	extractionData, err := json.Marshal(map[string]any{
		"classified":  []handlers.KeywordWeight{{Keyword: "alpha", Weight: 1.0}},
		"suggestions": []handlers.KeywordSuggestion{},
	})
	if err != nil {
		t.Fatalf("marshal extraction data: %v", err)
	}

	submissionHash := randHex(t, 32)
	_, err = pool.Exec(context.Background(), `
		INSERT INTO pending_submissions
			(submission_hash, org_id, epoch_id, contributor_pubkey, ciphertext_hex, wrapped_dek_mod, contributor_sig, stack_hint, memory_type, status, extraction_result)
		VALUES
			($1, $2, 0, $3, $4, $5, $6, ARRAY[]::TEXT[], $7, $8, $9)
	`, submissionHash, orgID, contributorPubkey, randHex(t, 32), randHex(t, 32), strings.Repeat("f", 128), protocol.MemoryTypeMemory, protocol.SubmissionStatusPendingKeyword, extractionData)
	if err != nil {
		t.Fatalf("insert pending submission: %v", err)
	}

	return submissionHash
}

func performVerifyKeywordsRequest(t *testing.T, router *chi.Mux, orgID string, leader voteActor, body handlers.VerifyKeywordsRequest) *httptest.ResponseRecorder {
	t.Helper()

	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal verify request: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/v1/orgs/%s/verify-keywords", orgID), bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", leader.authHeader(time.Now()))

	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)

	return resp
}
