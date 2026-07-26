package handlers_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
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
)

type localActor struct {
	priv      ed25519.PrivateKey
	pubkeyHex string
}

func (a localActor) authHeader(ts time.Time) string {
	timestamp := ts.UTC().Format(time.RFC3339)
	signature := ed25519.Sign(a.priv, []byte(timestamp))
	return fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", a.pubkeyHex, timestamp, hex.EncodeToString(signature))
}

func newLocalActor(t *testing.T) localActor {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	return localActor{priv: priv, pubkeyHex: hex.EncodeToString(pub)}
}

func decisionNotesPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	connStr := os.Getenv("DATABASE_URL")
	if connStr == "" {
		t.Skip("DATABASE_URL not set — skipping decision note handler tests")
	}
	pool, err := db.NewPool(context.Background(), connStr)
	if err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedDecisionNotesEnv(t *testing.T) (*pgxpool.Pool, string, localActor, localActor) {
	t.Helper()
	pool := decisionNotesPool(t)
	handlers.SetPool(pool)

	leader := newLocalActor(t)
	member := newLocalActor(t)
	orgID := fmt.Sprintf("test-org-decision-notes-%d", time.Now().UnixNano())

	_, err := pool.Exec(context.Background(), `
		INSERT INTO orgs (org_id, leader_pubkey, leader_wallet_address, org_name, domain)
		VALUES ($1, $2, $3, $4, $5)
	`, orgID, leader.pubkeyHex, "wevibe1decisionleader", "Decision Notes Test Org", "decision-notes.test")
	if err != nil {
		t.Fatalf("insert org: %v", err)
	}

	_, err = pool.Exec(context.Background(), `
		INSERT INTO members (org_id, pubkey, x25519_pubkey, role, join_epoch, active)
		VALUES
			($1, $2, $2, 'leader', 0, TRUE),
			($1, $3, $3, 'member', 0, TRUE)
	`, orgID, leader.pubkeyHex, member.pubkeyHex)
	if err != nil {
		t.Fatalf("insert members: %v", err)
	}

	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM orgs WHERE org_id = $1", orgID)
	})

	return pool, orgID, leader, member
}

func decisionNoteRouter() chi.Router {
	r := chi.NewRouter()
	r.Route("/api/v1/orgs/{orgID}/decision-notes", func(r chi.Router) {
		r.Post("/", handlers.RecordDecisionNote)
	})
	return r
}

func TestRecordDecisionNote_SuccessAndPersistence(t *testing.T) {
	pool, orgID, _, member := seedDecisionNotesEnv(t)
	router := decisionNoteRouter()

	body := []byte(fmt.Sprintf(`{"memory_hash":%q,"action":"deny"}`, strings.Repeat("a", 64)))
	url := fmt.Sprintf("/api/v1/orgs/%s/decision-notes", orgID)
	req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", member.authHeader(time.Now()))

	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)

	if resp.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", resp.Code, resp.Body.String())
	}

	var apiResp struct {
		Status string `json:"status"`
		ID     int64  `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&apiResp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if apiResp.Status != "recorded" {
		t.Fatalf("expected status=recorded, got %q", apiResp.Status)
	}
	if apiResp.ID == 0 {
		t.Fatal("expected non-zero id")
	}

	var memberPubkey, action string
	var reason sql.NullString
	err := pool.QueryRow(context.Background(), `
		SELECT member_pubkey, action, reason
		FROM decision_notes
		WHERE org_id = $1 AND id = $2
	`, orgID, apiResp.ID).Scan(&memberPubkey, &action, &reason)
	if err != nil {
		t.Fatalf("query decision note: %v", err)
	}
	if memberPubkey != member.pubkeyHex {
		t.Fatalf("expected member_pubkey=%s, got %s", member.pubkeyHex, memberPubkey)
	}
	if action != "deny" {
		t.Fatalf("expected action=deny, got %s", action)
	}
	if reason.Valid {
		t.Fatalf("expected NULL reason when omitted, got %q", reason.String)
	}
}

func TestRecordDecisionNote_Validation(t *testing.T) {
	_, orgID, _, member := seedDecisionNotesEnv(t)
	router := decisionNoteRouter()
	url := fmt.Sprintf("/api/v1/orgs/%s/decision-notes", orgID)

	tests := []struct {
		name string
		body string
	}{
		{name: "action_not_deny", body: fmt.Sprintf(`{"memory_hash":%q,"action":"allow"}`, strings.Repeat("a", 64))},
		{name: "memory_hash_missing", body: `{"action":"deny"}`},
		{name: "memory_hash_invalid", body: `{"memory_hash":"xyz","action":"deny"}`},
		{name: "reason_too_long", body: fmt.Sprintf(`{"memory_hash":%q,"action":"deny","reason":%q}`, strings.Repeat("a", 64), strings.Repeat("r", 2001))},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, url, bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", member.authHeader(time.Now()))
			resp := httptest.NewRecorder()
			router.ServeHTTP(resp, req)
			if resp.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", resp.Code, resp.Body.String())
			}
		})
	}
}

func TestRecordDecisionNote_AuthAndMembership(t *testing.T) {
	pool, orgID, _, member := seedDecisionNotesEnv(t)
	router := decisionNoteRouter()
	body := []byte(fmt.Sprintf(`{"memory_hash":%q,"action":"deny"}`, strings.Repeat("a", 64)))
	url := fmt.Sprintf("/api/v1/orgs/%s/decision-notes", orgID)

	t.Run("unauthorized_missing_header", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		if resp.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", resp.Code)
		}
	})

	t.Run("unauthorized_malformed_header", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer not-wevibe")
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		if resp.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", resp.Code)
		}
	})

	t.Run("forbidden_inactive_member", func(t *testing.T) {
		_, err := pool.Exec(context.Background(), `
			UPDATE members SET active = FALSE WHERE org_id = $1 AND pubkey = $2
		`, orgID, member.pubkeyHex)
		if err != nil {
			t.Fatalf("deactivate member: %v", err)
		}

		req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", member.authHeader(time.Now()))
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		if resp.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d: %s", resp.Code, resp.Body.String())
		}
	})
}
