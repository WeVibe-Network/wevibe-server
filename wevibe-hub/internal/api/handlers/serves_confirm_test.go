package handlers_test

import (
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
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/serves"
)

func insertServeEvent(t *testing.T, pool *pgxpool.Pool, orgID, episodeRef, memoryHash, status string, txHash *string) int64 {
	t.Helper()
	ctx := context.Background()
	var id int64
	// Unique serve_key_pubkey per row: the relay dedup key includes it, so two
	// rows for the same (org, memory_hash, epoch) must differ here.
	serveKey := fmt.Sprintf("%s-%d", strings.Repeat("b", 56), time.Now().UnixNano())
	err := pool.QueryRow(ctx, `
		INSERT INTO serve_events
			(org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce,
			 episode_ref, serve_fingerprint, contributor_id, reporter_pubkey, event_type, status, tx_hash)
		VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, 'serve', $10, $11)
		RETURNING id
	`, orgID, memoryHash,
		serveKey, strings.Repeat("c", 128), strings.Repeat("d", 16),
		episodeRef, strings.Repeat("e", 64), strings.Repeat("f", 64), strings.Repeat("f", 64),
		status, txHash,
	).Scan(&id)
	if err != nil {
		t.Fatalf("insert serve_event: %v", err)
	}
	return id
}

func TestConfirmServeEvent_ReturnsReceiptsWithStatusAndTxHash(t *testing.T) {
	pool := testPool(t)
	handlers.SetPool(pool)

	orgID, memberPubkey, priv := setupOrgWithMember(t, pool)
	episodeRef := strings.Repeat("ab", 8) // lowercase hex episode ref
	memoryHash := strings.Repeat("11", 32)

	submittedTx := "0xsubmitted-tx-hash"
	insertServeEvent(t, pool, orgID, episodeRef, memoryHash, "submitted", &submittedTx)
	insertServeEvent(t, pool, orgID, episodeRef, memoryHash, "pending", nil)

	timestamp := time.Now().Format(time.RFC3339)
	sig := signTimestamp(priv, timestamp)

	r := chi.NewRouter()
	r.Get("/v1/orgs/{orgID}/serves/confirm", handlers.ConfirmServeEvent)

	url := fmt.Sprintf("/v1/orgs/%s/serves/confirm?episode_ref=%s", orgID, episodeRef)
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", memberPubkey, timestamp, sig))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Serves []serves.ServeEventRecord `json:"serves"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if len(resp.Serves) != 2 {
		t.Fatalf("expected 2 receipts, got %d: %+v", len(resp.Serves), resp.Serves)
	}

	byStatus := map[string]serves.ServeEventRecord{}
	for _, s := range resp.Serves {
		byStatus[s.Status] = s
	}

	sub := byStatus["submitted"]
	if sub.TxHash == nil || *sub.TxHash != submittedTx {
		t.Errorf("submitted receipt: expected tx_hash %q, got %v", submittedTx, sub.TxHash)
	}
	if sub.EpisodeRef != episodeRef {
		t.Errorf("submitted receipt: expected episode_ref %q, got %q", episodeRef, sub.EpisodeRef)
	}

	pending := byStatus["pending"]
	if pending.TxHash != nil {
		t.Errorf("pending receipt: expected nil tx_hash, got %v", *pending.TxHash)
	}
}

func TestConfirmServeEvent_MemoryHashNarrow(t *testing.T) {
	pool := testPool(t)
	handlers.SetPool(pool)

	orgID, memberPubkey, priv := setupOrgWithMember(t, pool)
	episodeRef := strings.Repeat("cd", 8)

	// Same episode, two different memory hashes.
	insertServeEvent(t, pool, orgID, episodeRef, strings.Repeat("11", 32), "submitted", ptr("tx-a"))
	insertServeEvent(t, pool, orgID, episodeRef, strings.Repeat("22", 32), "submitted", ptr("tx-b"))

	timestamp := time.Now().Format(time.RFC3339)
	sig := signTimestamp(priv, timestamp)

	r := chi.NewRouter()
	r.Get("/v1/orgs/{orgID}/serves/confirm", handlers.ConfirmServeEvent)

	url := fmt.Sprintf("/v1/orgs/%s/serves/confirm?episode_ref=%s&memory_hash=%s", orgID, episodeRef, strings.Repeat("22", 32))
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", memberPubkey, timestamp, sig))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Serves []serves.ServeEventRecord `json:"serves"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if len(resp.Serves) != 1 {
		t.Fatalf("expected 1 narrowed receipt, got %d: %+v", len(resp.Serves), resp.Serves)
	}
	if resp.Serves[0].MemoryContentHash != strings.Repeat("22", 32) {
		t.Errorf("expected memory_hash %q, got %q", strings.Repeat("22", 32), resp.Serves[0].MemoryContentHash)
	}
}

func TestConfirmServeEvent_IsReadOnly(t *testing.T) {
	pool := testPool(t)
	handlers.SetPool(pool)

	orgID, memberPubkey, priv := setupOrgWithMember(t, pool)
	episodeRef := strings.Repeat("ef", 8)
	memoryHash := strings.Repeat("33", 32)
	submittedTx := "0xread-only-tx"
	id := insertServeEvent(t, pool, orgID, episodeRef, memoryHash, "submitted", &submittedTx)

	timestamp := time.Now().Format(time.RFC3339)
	sig := signTimestamp(priv, timestamp)

	r := chi.NewRouter()
	r.Get("/v1/orgs/{orgID}/serves/confirm", handlers.ConfirmServeEvent)

	url := fmt.Sprintf("/v1/orgs/%s/serves/confirm?episode_ref=%s", orgID, episodeRef)
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", memberPubkey, timestamp, sig))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Row must be unchanged after the GET.
	var status string
	var txHash *string
	err := pool.QueryRow(context.Background(), `
		SELECT status, tx_hash FROM serve_events WHERE id = $1
	`, id).Scan(&status, &txHash)
	if err != nil {
		t.Fatalf("re-read serve_event: %v", err)
	}
	if status != "submitted" || txHash == nil || *txHash != submittedTx {
		t.Errorf("GET mutated the row: got status=%q tx_hash=%v, want status=submitted tx_hash=%q", status, txHash, submittedTx)
	}
}

func TestConfirmServeEvent_MissingEpisodeRef_Returns400(t *testing.T) {
	pool := testPool(t)
	handlers.SetPool(pool)

	orgID, memberPubkey, priv := setupOrgWithMember(t, pool)

	timestamp := time.Now().Format(time.RFC3339)
	sig := signTimestamp(priv, timestamp)

	r := chi.NewRouter()
	r.Get("/v1/orgs/{orgID}/serves/confirm", handlers.ConfirmServeEvent)

	url := fmt.Sprintf("/v1/orgs/%s/serves/confirm", orgID)
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", memberPubkey, timestamp, sig))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "episode_ref") {
		t.Errorf("expected error message to mention episode_ref, got %s", w.Body.String())
	}
}

func TestConfirmServeEvent_WrongMethod_PostReturns405(t *testing.T) {
	pool := testPool(t)
	handlers.SetPool(pool)

	orgID, memberPubkey, priv := setupOrgWithMember(t, pool)
	episodeRef := strings.Repeat("ab", 8)

	timestamp := time.Now().Format(time.RFC3339)
	sig := signTimestamp(priv, timestamp)

	r := chi.NewRouter()
	r.Get("/v1/orgs/{orgID}/serves/confirm", handlers.ConfirmServeEvent)

	url := fmt.Sprintf("/v1/orgs/%s/serves/confirm?episode_ref=%s", orgID, episodeRef)
	req := httptest.NewRequest(http.MethodPost, url, strings.NewReader("{}"))
	req.Header.Set("Authorization", fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", memberPubkey, timestamp, sig))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func ptr(s string) *string {
	return &s
}
