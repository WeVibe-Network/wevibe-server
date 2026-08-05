package handlers_test

import (
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
)

type callbackActor struct {
	priv      ed25519.PrivateKey
	pubkeyHex string
}

func newCallbackActor(t *testing.T) callbackActor {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	return callbackActor{priv: priv, pubkeyHex: hex.EncodeToString(pub)}
}

func (a callbackActor) authHeader(ts time.Time) string {
	timestamp := ts.UTC().Format(time.RFC3339)
	signature := ed25519.Sign(a.priv, []byte(timestamp))
	return fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", a.pubkeyHex, timestamp, hex.EncodeToString(signature))
}

type pendingCallbacksEnv struct {
	pool   *pgxpool.Pool
	orgID  string
	leader callbackActor
	member callbackActor
}

func pendingCallbacksPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	connStr := os.Getenv("DATABASE_URL")
	if connStr == "" {
		t.Skip("DATABASE_URL not set — skipping pending callbacks handler tests")
	}
	pool, err := db.NewPool(context.Background(), connStr)
	if err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedPendingCallbacksEnv(t *testing.T) pendingCallbacksEnv {
	t.Helper()
	pool := pendingCallbacksPool(t)
	handlers.SetPool(pool)

	leader := newCallbackActor(t)
	member := newCallbackActor(t)
	orgID := fmt.Sprintf("test-org-pending-callbacks-%d", time.Now().UnixNano())

	_, err := pool.Exec(context.Background(), `
		INSERT INTO orgs (org_id, leader_pubkey, leader_wallet_address, org_name, domain)
		VALUES ($1, $2, $3, $4, $5)
	`, orgID, leader.pubkeyHex, "wevibe1pendingcallbacksleader", "Pending Callbacks Test Org", "pending-callbacks.test")
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

	return pendingCallbacksEnv{pool: pool, orgID: orgID, leader: leader, member: member}
}

func pendingCallbacksRouter() chi.Router {
	r := chi.NewRouter()
	r.Route("/api/v1/orgs/{orgID}/pending-callbacks", func(r chi.Router) {
		r.Get("/", handlers.GetPendingCallbacks)
	})
	return r
}

func insertReturnedDelivery(t *testing.T, env pendingCallbacksEnv, memberPubkey, memoryCID string, deliveredAt time.Time) {
	t.Helper()
	queryID := fmt.Sprintf("q-%d-%s", time.Now().UnixNano(), memoryCID[len(memoryCID)-6:])
	_, err := env.pool.Exec(context.Background(), `
		INSERT INTO query_log (query_id, org_id, agent_pubkey, created_at)
		VALUES ($1, $2, $3, $4)
	`, queryID, env.orgID, memberPubkey, deliveredAt)
	if err != nil {
		t.Fatalf("insert query_log: %v", err)
	}

	_, err = env.pool.Exec(context.Background(), `
		INSERT INTO query_candidate_scores (query_id, memory_cid, disposition)
		VALUES ($1, $2, 'returned')
	`, queryID, memoryCID)
	if err != nil {
		t.Fatalf("insert query_candidate_scores: %v", err)
	}
}

type pendingCallbacksResponseJSON struct {
	Buckets struct {
		GT1H  int `json:"gt_1h"`
		GT24H int `json:"gt_24h"`
		GT7D  int `json:"gt_7d"`
	} `json:"buckets"`
	Items []struct {
		MemberPubkey      string `json:"member_pubkey"`
		MemoryContentHash string `json:"memory_content_hash"`
		DeliveredAt       string `json:"delivered_at"`
		AgeSeconds        int64  `json:"age_seconds"`
	} `json:"items"`
}

func getPendingCallbacks(t *testing.T, router chi.Router, orgID, authHeader string) (int, pendingCallbacksResponseJSON) {
	t.Helper()
	url := fmt.Sprintf("/api/v1/orgs/%s/pending-callbacks", orgID)
	req := httptest.NewRequest(http.MethodGet, url, nil)
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)

	var body pendingCallbacksResponseJSON
	if resp.Code == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatalf("decode response: %v", err)
		}
	}
	return resp.Code, body
}

func TestGetPendingCallbacks_PendingAndBuckets(t *testing.T) {
	env := seedPendingCallbacksEnv(t)
	router := pendingCallbacksRouter()

	insertReturnedDelivery(t, env, env.member.pubkeyHex, strings.Repeat("a", 64), time.Now().Add(-2*time.Hour))
	insertReturnedDelivery(t, env, env.member.pubkeyHex, strings.Repeat("b", 64), time.Now().Add(-25*time.Hour))
	insertReturnedDelivery(t, env, env.member.pubkeyHex, strings.Repeat("c", 64), time.Now().Add(-8*24*time.Hour))

	code, got := getPendingCallbacks(t, router, env.orgID, env.leader.authHeader(time.Now()))
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d", code)
	}

	if got.Buckets.GT1H != 3 || got.Buckets.GT24H != 2 || got.Buckets.GT7D != 1 {
		t.Fatalf("bucket mismatch: got gt_1h=%d gt_24h=%d gt_7d=%d", got.Buckets.GT1H, got.Buckets.GT24H, got.Buckets.GT7D)
	}

	seen := map[string]bool{}
	for _, item := range got.Items {
		if item.MemberPubkey != env.member.pubkeyHex {
			t.Fatalf("unexpected member pubkey %s", item.MemberPubkey)
		}
		seen[item.MemoryContentHash] = true
	}
	for _, memory := range []string{strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)} {
		if !seen[memory] {
			t.Fatalf("expected pending memory %s not found in items: %+v", memory, got.Items)
		}
	}
}

func TestGetPendingCallbacks_ClosedByDecisions(t *testing.T) {
	router := pendingCallbacksRouter()

	t.Run("closed_by_serve_event", func(t *testing.T) {
		env := seedPendingCallbacksEnv(t)
		memory := strings.Repeat("d", 64)
		deliveredAt := time.Now().Add(-2 * time.Hour)
		insertReturnedDelivery(t, env, env.member.pubkeyHex, memory, deliveredAt)

		_, err := env.pool.Exec(context.Background(), `
			INSERT INTO serve_events (
				org_id, epoch_id, memory_content_hash, serve_key_pubkey, serve_sig, nonce,
				serve_fingerprint, contributor_id, matched_keywords, reporter_pubkey, reason, event_type, status, created_at
			) VALUES ($1, 0, $2, $3, $4, 'n-pc-serve', $8, $5, ARRAY['x'], $6, 'incorrect', 'serve', 'pending', $7)
		`, env.orgID, memory, strings.Repeat("1", 64), strings.Repeat("2", 128), env.member.pubkeyHex, env.member.pubkeyHex, deliveredAt.Add(5*time.Minute),
			fmt.Sprintf("fp-pc-serve-%d", time.Now().UnixNano()))
		if err != nil {
			t.Fatalf("insert serve_event closure: %v", err)
		}

		code, got := getPendingCallbacks(t, router, env.orgID, env.leader.authHeader(time.Now()))
		if code != http.StatusOK {
			t.Fatalf("expected 200, got %d", code)
		}
		for _, item := range got.Items {
			if item.MemoryContentHash == memory {
				t.Fatalf("memory %s should have been closed by serve_event", memory)
			}
		}
	})

	t.Run("closed_by_decision_note", func(t *testing.T) {
		env := seedPendingCallbacksEnv(t)
		memory := strings.Repeat("e", 64)
		deliveredAt := time.Now().Add(-2 * time.Hour)
		insertReturnedDelivery(t, env, env.member.pubkeyHex, memory, deliveredAt)

		_, err := env.pool.Exec(context.Background(), `
			INSERT INTO decision_notes (org_id, member_pubkey, memory_content_hash, action, reason, created_at)
			VALUES ($1, $2, $3, 'deny', 'note', $4)
		`, env.orgID, env.member.pubkeyHex, memory, deliveredAt.Add(5*time.Minute))
		if err != nil {
			t.Fatalf("insert decision_note closure: %v", err)
		}

		code, got := getPendingCallbacks(t, router, env.orgID, env.leader.authHeader(time.Now()))
		if code != http.StatusOK {
			t.Fatalf("expected 200, got %d", code)
		}
		for _, item := range got.Items {
			if item.MemoryContentHash == memory {
				t.Fatalf("memory %s should have been closed by decision_note", memory)
			}
		}
	})

	t.Run("closed_by_report", func(t *testing.T) {
		env := seedPendingCallbacksEnv(t)
		memory := strings.Repeat("f", 64)
		deliveredAt := time.Now().Add(-2 * time.Hour)
		insertReturnedDelivery(t, env, env.member.pubkeyHex, memory, deliveredAt)

		_, err := env.pool.Exec(context.Background(), `
			INSERT INTO reports (org_id, memory_cid, reporter_pubkey, reason, created_at)
			VALUES ($1, $2, $3, 'incorrect', $4)
		`, env.orgID, memory, env.member.pubkeyHex, deliveredAt.Add(5*time.Minute))
		if err != nil {
			t.Fatalf("insert report closure: %v", err)
		}

		code, got := getPendingCallbacks(t, router, env.orgID, env.leader.authHeader(time.Now()))
		if code != http.StatusOK {
			t.Fatalf("expected 200, got %d", code)
		}
		for _, item := range got.Items {
			if item.MemoryContentHash == memory {
				t.Fatalf("memory %s should have been closed by report", memory)
			}
		}
	})

	t.Run("older_decision_does_not_close_latest_delivery", func(t *testing.T) {
		env := seedPendingCallbacksEnv(t)
		memory := strings.Repeat("9", 64)
		now := time.Now()
		insertReturnedDelivery(t, env, env.member.pubkeyHex, memory, now)

		_, err := env.pool.Exec(context.Background(), `
			INSERT INTO decision_notes (org_id, member_pubkey, memory_content_hash, action, reason, created_at)
			VALUES ($1, $2, $3, 'deny', 'old-note', $4)
		`, env.orgID, env.member.pubkeyHex, memory, now.Add(-1*time.Hour))
		if err != nil {
			t.Fatalf("insert older decision note: %v", err)
		}

		code, got := getPendingCallbacks(t, router, env.orgID, env.leader.authHeader(time.Now()))
		if code != http.StatusOK {
			t.Fatalf("expected 200, got %d", code)
		}
		found := false
		for _, item := range got.Items {
			if item.MemoryContentHash == memory {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("memory %s should still be pending with older decision", memory)
		}
	})
}

func TestGetPendingCallbacks_LeaderGate(t *testing.T) {
	env := seedPendingCallbacksEnv(t)
	router := pendingCallbacksRouter()

	code, _ := getPendingCallbacks(t, router, env.orgID, env.member.authHeader(time.Now()))
	if code != http.StatusForbidden {
		t.Fatalf("expected 403 for non-leader, got %d", code)
	}

	code, _ = getPendingCallbacks(t, router, env.orgID, "")
	if code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without auth, got %d", code)
	}
}

func TestEnqueueEligibleRelays_NoPanicWithNilDeps(t *testing.T) {
	handlers.SetPool(nil)
	handlers.SetChainClient(nil)
	handlers.SetRelayHoldConfig(24, nil)

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("EnqueueEligibleRelays panicked with nil deps: %v", r)
		}
	}()

	handlers.EnqueueEligibleRelays(context.Background())
}
