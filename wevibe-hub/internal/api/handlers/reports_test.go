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
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/reports"
)

type testActor struct {
	priv      ed25519.PrivateKey
	pubkey    ed25519.PublicKey
	pubkeyHex string
}

type reportTestEnv struct {
	pool      *pgxpool.Pool
	orgID     string
	leader    testActor
	moderator testActor
	member    testActor
	outsider  testActor
}

func TestCreateReport_Success(t *testing.T) {
	env := setupReportTestEnv(t)
	router := reportRouter()

	payload := protocol.CreateReportRequest{
		MemoryCID: "cid-123",
		Reason:    "spam",
		Note:      "duplicate content",
	}
	body, _ := json.Marshal(payload)

	url := fmt.Sprintf("/api/v1/orgs/%s/reports", env.orgID)
	req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", env.member.authHeader(time.Now()))

	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)

	if resp.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", resp.Code, resp.Body.String())
	}

	var createResp struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&createResp); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if createResp.ID == "" {
		t.Fatalf("expected id in response")
	}
	if createResp.Status != "pending" {
		t.Fatalf("expected status pending, got %s", createResp.Status)
	}

	rec, err := reports.Get(context.Background(), env.pool, env.orgID, createResp.ID)
	if err != nil {
		t.Fatalf("report not persisted: %v", err)
	}
	if rec.Reason != "spam" {
		t.Fatalf("expected reason spam, got %s", rec.Reason)
	}
}

func TestCreateReport_Validation(t *testing.T) {
	env := setupReportTestEnv(t)
	router := reportRouter()

	t.Run("missing memory", func(t *testing.T) {
		payload := map[string]string{
			"reason": "spam",
		}
		body, _ := json.Marshal(payload)
		url := fmt.Sprintf("/api/v1/orgs/%s/reports", env.orgID)
		req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", env.member.authHeader(time.Now()))
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		if resp.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d", resp.Code)
		}
	})

	t.Run("missing reason", func(t *testing.T) {
		payload := map[string]string{
			"memory_cid": "cid-missing-reason",
		}
		body, _ := json.Marshal(payload)
		url := fmt.Sprintf("/api/v1/orgs/%s/reports", env.orgID)
		req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", env.member.authHeader(time.Now()))
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		if resp.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d", resp.Code)
		}
	})

	t.Run("invalid reason", func(t *testing.T) {
		payload := map[string]string{
			"memory_cid": "cid-abc",
			"reason":     "bad",
		}
		body, _ := json.Marshal(payload)
		url := fmt.Sprintf("/api/v1/orgs/%s/reports", env.orgID)
		req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", env.member.authHeader(time.Now()))
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		if resp.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d", resp.Code)
		}
	})
}

func TestListReports_FilterAndPagination(t *testing.T) {
	env := setupReportTestEnv(t)
	router := reportRouter()
	ctx := context.Background()

	ids := make([]string, 0, 3)
	for i := 0; i < 3; i++ {
		rec, err := reports.Create(ctx, env.pool, env.orgID, protocol.CreateReportRequest{
			MemoryCID: fmt.Sprintf("cid-%d", i),
			Reason:    "spam",
		}, env.member.pubkeyHex, "member")
		if err != nil {
			t.Fatalf("create report: %v", err)
		}
		ids = append(ids, rec.ID)
	}

	if _, err := reports.Update(ctx, env.pool, env.orgID, ids[1], env.moderator.pubkeyHex, "moderator", protocol.UpdateReportRequest{Resolution: "dismissed"}); err != nil {
		t.Fatalf("update report: %v", err)
	}

	// Status filter
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/orgs/%s/reports?status=pending", env.orgID), nil)
	req.Header.Set("Authorization", env.moderator.authHeader(time.Now()))
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.Code, resp.Body.String())
	}
	var listResp protocol.ReportListResponse
	if err := json.NewDecoder(resp.Body).Decode(&listResp); err != nil {
		t.Fatalf("list response json: %v", err)
	}
	if listResp.Total != 2 || len(listResp.Reports) != 2 {
		t.Fatalf("expected 2 pending reports, got total=%d len=%d", listResp.Total, len(listResp.Reports))
	}
	for _, rec := range listResp.Reports {
		if rec.Status != "pending" {
			t.Fatalf("expected pending status, got %s", rec.Status)
		}
	}

	// Pagination
	req2 := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/orgs/%s/reports?limit=1&offset=1", env.orgID), nil)
	req2.Header.Set("Authorization", env.moderator.authHeader(time.Now()))
	resp2 := httptest.NewRecorder()
	router.ServeHTTP(resp2, req2)
	if resp2.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp2.Code, resp2.Body.String())
	}
	var pageResp protocol.ReportListResponse
	if err := json.NewDecoder(resp2.Body).Decode(&pageResp); err != nil {
		t.Fatalf("page response json: %v", err)
	}
	if pageResp.Total != 3 {
		t.Fatalf("expected total 3, got %d", pageResp.Total)
	}
	if len(pageResp.Reports) != 1 {
		t.Fatalf("expected 1 report on page, got %d", len(pageResp.Reports))
	}
	expectedID := ids[1]
	if pageResp.Reports[0].ID != expectedID {
		t.Fatalf("expected second-most-recent id %s, got %s", expectedID, pageResp.Reports[0].ID)
	}
}

func TestGetReport_SuccessAndUnauthorized(t *testing.T) {
	env := setupReportTestEnv(t)
	router := reportRouter()
	ctx := context.Background()

	rec, err := reports.Create(ctx, env.pool, env.orgID, protocol.CreateReportRequest{
		MemoryCID: "cid-get",
		Reason:    "incorrect",
	}, env.member.pubkeyHex, "member")
	if err != nil {
		t.Fatalf("create report: %v", err)
	}

	t.Run("moderator can fetch", func(t *testing.T) {
		url := fmt.Sprintf("/api/v1/orgs/%s/reports/%s", env.orgID, rec.ID)
		req := httptest.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Authorization", env.moderator.authHeader(time.Now()))
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		if resp.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", resp.Code, resp.Body.String())
		}
		var fetched protocol.ReportRecord
		if err := json.NewDecoder(resp.Body).Decode(&fetched); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if fetched.ID != rec.ID {
			t.Fatalf("expected id %s, got %s", rec.ID, fetched.ID)
		}
		if fetched.OrgID != env.orgID {
			t.Fatalf("expected org_id %s, got %s", env.orgID, fetched.OrgID)
		}
	})

	t.Run("member cannot fetch", func(t *testing.T) {
		url := fmt.Sprintf("/api/v1/orgs/%s/reports/%s", env.orgID, rec.ID)
		req := httptest.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Authorization", env.member.authHeader(time.Now()))
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		if resp.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d", resp.Code)
		}
	})
}

func TestUpdateReport_Escalate(t *testing.T) {
	env := setupReportTestEnv(t)
	router := reportRouter()
	ctx := context.Background()

	rec, err := reports.Create(ctx, env.pool, env.orgID, protocol.CreateReportRequest{
		MemoryCID: "cid-escalate",
		Reason:    "incorrect",
	}, env.member.pubkeyHex, "member")
	if err != nil {
		t.Fatalf("create report: %v", err)
	}

	body, _ := json.Marshal(map[string]string{"action": "escalate"})
	url := fmt.Sprintf("/api/v1/orgs/%s/reports/%s", env.orgID, rec.ID)

	req := httptest.NewRequest(http.MethodPatch, url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", env.moderator.authHeader(time.Now()))
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.Code, resp.Body.String())
	}
	var updated protocol.ReportRecord
	if err := json.NewDecoder(resp.Body).Decode(&updated); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if updated.Status != "escalated" {
		t.Fatalf("expected escalated status, got %s", updated.Status)
	}
	if len(updated.EscalationVotes) != 1 {
		t.Fatalf("expected 1 vote, got %d", len(updated.EscalationVotes))
	}
	if updated.EscalationVotes[0].Pubkey != env.moderator.pubkeyHex {
		t.Fatalf("expected vote by moderator, got %s", updated.EscalationVotes[0].Pubkey)
	}
	if updated.EscalationVotes[0].VotedAt.IsZero() {
		t.Fatalf("expected voted_at to be set")
	}

	// duplicate vote should not add another entry
	req2 := httptest.NewRequest(http.MethodPatch, url, bytes.NewReader(body))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("Authorization", env.moderator.authHeader(time.Now()))
	resp2 := httptest.NewRecorder()
	router.ServeHTTP(resp2, req2)
	if resp2.Code != http.StatusOK {
		t.Fatalf("expected 200 on second escalate, got %d", resp2.Code)
	}
	var updatedAgain protocol.ReportRecord
	if err := json.NewDecoder(resp2.Body).Decode(&updatedAgain); err != nil {
		t.Fatalf("decode second response: %v", err)
	}
	if len(updatedAgain.EscalationVotes) != 1 {
		t.Fatalf("expected single vote after duplicate, got %d", len(updatedAgain.EscalationVotes))
	}
}

func TestUpdateReport_ResolveActions(t *testing.T) {
	env := setupReportTestEnv(t)
	router := reportRouter()
	ctx := context.Background()

	type resolveCase struct {
		action             string
		expectedResolution string
		expectClearedVotes bool
	}

	cases := []resolveCase{
		{action: "dismiss", expectedResolution: "dismissed", expectClearedVotes: true},
		{action: "archive", expectedResolution: "archived", expectClearedVotes: true},
		{action: "set_validity", expectedResolution: "validity_set", expectClearedVotes: false},
	}

	for _, tc := range cases {
		t.Run(tc.action, func(t *testing.T) {
			rec, err := reports.Create(ctx, env.pool, env.orgID, protocol.CreateReportRequest{
				MemoryCID: fmt.Sprintf("cid-%s", tc.action),
				Reason:    "incorrect",
			}, env.member.pubkeyHex, "member")
			if err != nil {
				t.Fatalf("create report: %v", err)
			}

			if _, err := reports.Update(ctx, env.pool, env.orgID, rec.ID, env.moderator.pubkeyHex, "moderator", protocol.UpdateReportRequest{Resolution: "upheld"}); err != nil {
				t.Fatalf("escalate before %s: %v", tc.action, err)
			}

			body, _ := json.Marshal(map[string]string{"action": tc.action})
			url := fmt.Sprintf("/api/v1/orgs/%s/reports/%s", env.orgID, rec.ID)
			req := httptest.NewRequest(http.MethodPatch, url, bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", env.moderator.authHeader(time.Now()))
			resp := httptest.NewRecorder()
			router.ServeHTTP(resp, req)
			if resp.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", resp.Code, resp.Body.String())
			}

			var updated protocol.ReportRecord
			if err := json.NewDecoder(resp.Body).Decode(&updated); err != nil {
				t.Fatalf("decode response: %v", err)
			}

			if updated.Status != "resolved" {
				t.Fatalf("expected resolved status, got %s", updated.Status)
			}
			if updated.Resolution == nil || *updated.Resolution != tc.expectedResolution {
				t.Fatalf("expected resolution %s, got %v", tc.expectedResolution, updated.Resolution)
			}
			if updated.ResolvedBy == nil || *updated.ResolvedBy != env.moderator.pubkeyHex {
				t.Fatalf("expected resolved_by moderator, got %v", updated.ResolvedBy)
			}
			if updated.ResolvedAt == nil || updated.ResolvedAt.IsZero() {
				t.Fatalf("expected resolved_at timestamp")
			}

			expectedVotes := 1
			if tc.expectClearedVotes {
				expectedVotes = 0
			}
			if len(updated.EscalationVotes) != expectedVotes {
				t.Fatalf("expected %d escalation votes, got %d", expectedVotes, len(updated.EscalationVotes))
			}

			dbRec, err := reports.Get(ctx, env.pool, env.orgID, rec.ID)
			if err != nil {
				t.Fatalf("fetch report: %v", err)
			}
			if len(dbRec.EscalationVotes) != expectedVotes {
				t.Fatalf("db expected %d votes, got %d", expectedVotes, len(dbRec.EscalationVotes))
			}
		})
	}
}

func TestReportAuthEnforcement(t *testing.T) {
	env := setupReportTestEnv(t)
	router := reportRouter()

	t.Run("non-member cannot create", func(t *testing.T) {
		payload := protocol.CreateReportRequest{
			MemoryCID: "cid-auth",
			Reason:    "spam",
		}
		body, _ := json.Marshal(payload)
		url := fmt.Sprintf("/api/v1/orgs/%s/reports", env.orgID)
		req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", env.outsider.authHeader(time.Now()))
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		if resp.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d", resp.Code)
		}
	})

	t.Run("member cannot list", func(t *testing.T) {
		url := fmt.Sprintf("/api/v1/orgs/%s/reports", env.orgID)
		req := httptest.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Authorization", env.member.authHeader(time.Now()))
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		if resp.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d", resp.Code)
		}
	})

	t.Run("member cannot patch", func(t *testing.T) {
		rec, err := reports.Create(context.Background(), env.pool, env.orgID, protocol.CreateReportRequest{
			MemoryCID: "cid-lock",
			Reason:    "incorrect",
		}, env.member.pubkeyHex, "member")
		if err != nil {
			t.Fatalf("create report: %v", err)
		}
		body, _ := json.Marshal(map[string]string{"action": "dismiss"})
		url := fmt.Sprintf("/api/v1/orgs/%s/reports/%s", env.orgID, rec.ID)
		req := httptest.NewRequest(http.MethodPatch, url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", env.member.authHeader(time.Now()))
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		if resp.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d", resp.Code)
		}
	})
}

func (a testActor) authHeader(ts time.Time) string {
	timestamp := ts.UTC().Format(time.RFC3339)
	signature := ed25519.Sign(a.priv, []byte(timestamp))
	return fmt.Sprintf("WeVibe-Signed pubkey=%s,timestamp=%s,signature=%s", a.pubkeyHex, timestamp, hex.EncodeToString(signature))
}

func setupReportTestEnv(t *testing.T) reportTestEnv {
	t.Helper()
	pool := testPoolReports(t)
	handlers.SetPool(pool)

	leader := newTestActor(t)
	moderator := newTestActor(t)
	member := newTestActor(t)
	outsider := newTestActor(t)

	orgID := fmt.Sprintf("test-org-%d", time.Now().UnixNano())
	ctx := context.Background()

	_, err := orgs.CreateOrg(ctx, pool, orgID, protocol.CreateOrgRequest{
		LeaderPubkey:       leader.pubkeyHex,
		LeaderX25519Pubkey: randomHex(32),
		LeaderWallet:       "wevibe1reportstest1",
		OrgName:            "Reports Test Org",
		Domain:             "reports.test",
		FeeModel:           protocol.FeeModel{},
		PkMod:              randomHex(32),
		Signature:          strings.Repeat("a", 128),
		EncEnvelope:        "ZW5j",
		SearchEnvelope:     "c2VhcmNo",
		ModEnvelope:        "bW9k",
	})
	if err != nil {
		t.Fatalf("create org: %v", err)
	}

	epoch, err := orgs.GetCurrentEpoch(ctx, pool, orgID)
	if err != nil {
		t.Fatalf("get epoch: %v", err)
	}

	invite := func(actor testActor, role string) {
		_, err := members.InviteMember(ctx, pool, orgID, epoch, protocol.InviteMemberRequest{
			Pubkey:         actor.pubkeyHex,
			X25519Pubkey:   randomHex(32),
			Role:           role,
			SignedBy:       leader.pubkeyHex,
			Signature:      strings.Repeat("b", 128),
			EncEnvelope:    "ZW5j",
			SearchEnvelope: "c2VhcmNo",
			ModEnvelope:    "bW9k",
		})
		if err != nil {
			t.Fatalf("invite %s: %v", role, err)
		}
	}

	invite(moderator, "moderator")
	invite(member, "member")

	t.Cleanup(func() {
		ctx := context.Background()
		pool.Exec(ctx, "DELETE FROM reports WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM epoch_manifests WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM orgs WHERE org_id = $1", orgID)
	})

	return reportTestEnv{
		pool:      pool,
		orgID:     orgID,
		leader:    leader,
		moderator: moderator,
		member:    member,
		outsider:  outsider,
	}
}

func newTestActor(t *testing.T) testActor {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	return testActor{
		priv:      priv,
		pubkeyHex: hex.EncodeToString(pub),
	}
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buf)
}

func testPoolReports(t *testing.T) *pgxpool.Pool {
	t.Helper()
	connStr := os.Getenv("DATABASE_URL")
	if connStr == "" {
		t.Skip("DATABASE_URL not set — skipping report handler tests")
	}
	pool, err := db.NewPool(context.Background(), connStr)
	if err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func reportRouter() chi.Router {
	r := chi.NewRouter()
	r.Route("/api/v1/orgs/{orgID}/reports", func(r chi.Router) {
		r.Post("/", handlers.CreateReport)
		r.Get("/", handlers.ListReports)
		r.Get("/{reportID}", handlers.GetReport)
		r.Patch("/{reportID}", handlers.UpdateReport)
	})
	return r
}
