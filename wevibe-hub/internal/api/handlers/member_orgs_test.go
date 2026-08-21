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
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

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

func setupOrgWithMember(t *testing.T, pool *pgxpool.Pool) (orgID, memberPubkey string, priv ed25519.PrivateKey) {
	ctx := context.Background()
	orgID = "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	leaderPubkey := strings.Repeat("a", 64)

	pub, privKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519 key: %v", err)
	}
	priv = privKey
	memberPubkey = hex.EncodeToString(pub)

	orgReq := protocol.CreateOrgRequest{
		LeaderPubkey:       leaderPubkey,
		LeaderX25519Pubkey: strings.Repeat("c", 64),
		LeaderWallet:       "wevibe1memberorgstest1",
		OrgName:            "Test Org",
		Domain:             "test.example.com",
		FeeModel:           protocol.FeeModel{},
		Signature:          strings.Repeat("d", 128),
		ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
	}
	_, err = orgs.CreateOrg(ctx, pool, orgID, orgReq)
	if err != nil {
		t.Fatalf("CreateOrg failed: %v", err)
	}

	inviteReq := protocol.InviteMemberRequest{
		Pubkey:       memberPubkey,
		X25519Pubkey: strings.Repeat("e", 64),
		Role:         "member",
		SignedBy:     leaderPubkey,
		Signature:    strings.Repeat("f", 128),
	}
	_, err = members.InviteMember(ctx, pool, orgID, inviteReq)
	if err != nil {
		t.Fatalf("InviteMember failed: %v", err)
	}

	t.Cleanup(func() {
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})

	return orgID, memberPubkey, priv
}

func signTimestamp(priv ed25519.PrivateKey, timestamp string) string {
	sig := ed25519.Sign(priv, []byte(timestamp))
	return hex.EncodeToString(sig)
}

func TestGetMemberOrgs_ValidSignature(t *testing.T) {
	pool := testPool(t)
	handlers.SetPool(pool)

	orgID, memberPubkey, priv := setupOrgWithMember(t, pool)

	timestamp := time.Now().Format(time.RFC3339)
	sig := signTimestamp(priv, timestamp)

	r := chi.NewRouter()
	r.Get("/v1/members/{pubkey}/orgs", handlers.GetMemberOrgs)

	url := fmt.Sprintf("/v1/members/%s/orgs", memberPubkey)
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", memberPubkey, timestamp, sig))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp protocol.MemberOrgsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if len(resp.Orgs) != 1 {
		t.Fatalf("expected 1 org, got %d", len(resp.Orgs))
	}
	if resp.Orgs[0].OrgID != orgID {
		t.Errorf("expected org_id %s, got %s", orgID, resp.Orgs[0].OrgID)
	}
	if resp.Orgs[0].Role != "member" {
		t.Errorf("expected role 'member', got %s", resp.Orgs[0].Role)
	}
}

func TestGetMemberOrgs_InvalidSignature(t *testing.T) {
	pool := testPool(t)
	handlers.SetPool(pool)

	_, memberPubkey, _ := setupOrgWithMember(t, pool)

	timestamp := time.Now().Format(time.RFC3339)
	wrongSig := strings.Repeat("a", 128)

	r := chi.NewRouter()
	r.Get("/v1/members/{pubkey}/orgs", handlers.GetMemberOrgs)

	url := fmt.Sprintf("/v1/members/%s/orgs", memberPubkey)
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", memberPubkey, timestamp, wrongSig))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestGetMemberOrgs_ExpiredTimestamp(t *testing.T) {
	pool := testPool(t)
	handlers.SetPool(pool)

	_, memberPubkey, priv := setupOrgWithMember(t, pool)

	oldTimestamp := time.Now().Add(-10 * time.Minute).Format(time.RFC3339)
	sig := signTimestamp(priv, oldTimestamp)

	r := chi.NewRouter()
	r.Get("/v1/members/{pubkey}/orgs", handlers.GetMemberOrgs)

	url := fmt.Sprintf("/v1/members/%s/orgs", memberPubkey)
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", memberPubkey, oldTimestamp, sig))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestGetMemberOrgs_NoMemberships(t *testing.T) {
	pool := testPool(t)
	handlers.SetPool(pool)

	priv := ed25519.NewKeyFromSeed(make([]byte, 32))
	neverMemberPubkey := hex.EncodeToString(priv.Public().(ed25519.PublicKey))

	timestamp := time.Now().Format(time.RFC3339)
	sig := signTimestamp(priv, timestamp)

	r := chi.NewRouter()
	r.Get("/v1/members/{pubkey}/orgs", handlers.GetMemberOrgs)

	url := fmt.Sprintf("/v1/members/%s/orgs", neverMemberPubkey)
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", neverMemberPubkey, timestamp, sig))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp protocol.MemberOrgsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if len(resp.Orgs) != 0 {
		t.Errorf("expected 0 orgs, got %d", len(resp.Orgs))
	}
}

func TestGetMemberOrgs_InactiveMemberExcluded(t *testing.T) {
	pool := testPool(t)
	handlers.SetPool(pool)
	ctx := context.Background()

	orgID, memberPubkey, priv := setupOrgWithMember(t, pool)

	members.RemoveMember(ctx, pool, orgID, memberPubkey)

	timestamp := time.Now().Format(time.RFC3339)
	sig := signTimestamp(priv, timestamp)

	r := chi.NewRouter()
	r.Get("/v1/members/{pubkey}/orgs", handlers.GetMemberOrgs)

	url := fmt.Sprintf("/v1/members/%s/orgs", memberPubkey)
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", memberPubkey, timestamp, sig))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp protocol.MemberOrgsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if len(resp.Orgs) != 0 {
		t.Errorf("expected 0 orgs for inactive member, got %d", len(resp.Orgs))
	}
}

func TestGetMemberOrgs_MultipleOrgs(t *testing.T) {
	pool := testPool(t)
	handlers.SetPool(pool)
	ctx := context.Background()

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519 key: %v", err)
	}
	memberPubkey := hex.EncodeToString(pub)
	leaderPubkey1 := strings.Repeat("a", 64)
	leaderPubkey2 := strings.Repeat("c", 64)
	orgID1 := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano())
	orgID2 := "test-org-" + fmt.Sprintf("%d", time.Now().UnixNano()+1)

	orgsData := []struct {
		orgID  string
		leader string
		x25519 string
	}{{orgID1, leaderPubkey1, strings.Repeat("x", 64)}, {orgID2, leaderPubkey2, strings.Repeat("y", 64)}}

	for i, data := range orgsData {
		orgReq := protocol.CreateOrgRequest{
			LeaderPubkey:       data.leader,
			LeaderX25519Pubkey: data.x25519,
			LeaderWallet:       "wevibe1memberorgstest2",
			OrgName:            fmt.Sprintf("Test Org %d", i),
			Domain:             "test.example.com",
			FeeModel:           protocol.FeeModel{},
			Signature:          strings.Repeat("d", 128),
			ModEnvelope:        "dGVzdC1tb2QtZW52ZWxvcGU=",
		}
		_, err := orgs.CreateOrg(ctx, pool, data.orgID, orgReq)
		if err != nil {
			t.Fatalf("CreateOrg failed: %v", err)
		}

		inviteReq := protocol.InviteMemberRequest{
			Pubkey:       memberPubkey,
			X25519Pubkey: strings.Repeat("e", 64),
			Role:         "member",
			SignedBy:     data.leader,
			Signature:    strings.Repeat("f", 128),
		}
		_, err = members.InviteMember(ctx, pool, data.orgID, inviteReq)
		if err != nil {
			t.Fatalf("InviteMember failed: %v", err)
		}
	}

	t.Cleanup(func() {
		for _, data := range orgsData {
			pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", data.orgID)
			pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", data.orgID)
		}
	})

	timestamp := time.Now().Format(time.RFC3339)
	sig := signTimestamp(priv, timestamp)

	r := chi.NewRouter()
	r.Get("/v1/members/{pubkey}/orgs", handlers.GetMemberOrgs)

	url := fmt.Sprintf("/v1/members/%s/orgs", memberPubkey)
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", memberPubkey, timestamp, sig))
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp protocol.MemberOrgsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if len(resp.Orgs) != 2 {
		t.Errorf("expected 2 orgs, got %d", len(resp.Orgs))
	}
}
