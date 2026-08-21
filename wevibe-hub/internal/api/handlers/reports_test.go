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
		Reason:    "incorrect",
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
	if rec.Reason != "incorrect" {
		t.Fatalf("expected reason incorrect, got %s", rec.Reason)
	}
}

func TestCreateReport_Validation(t *testing.T) {
	env := setupReportTestEnv(t)
	router := reportRouter()

	t.Run("missing memory", func(t *testing.T) {
		payload := map[string]string{
			"reason": "incorrect",
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
			Reason:    "incorrect",
		}, env.member.pubkeyHex, "member")
		if err != nil {
			t.Fatalf("create report: %v", err)
		}
		ids = append(ids, rec.ID)
	}

	if _, err := reports.Update(ctx, env.pool, env.orgID, ids[1], env.leader.pubkeyHex, "leader", protocol.UpdateReportRequest{Resolution: "dismissed"}); err != nil {
		t.Fatalf("resolve report: %v", err)
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

func TestUpdateReport_AdvisoryVote(t *testing.T) {
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

	body, _ := json.Marshal(map[string]string{"vote": "uphold"})
	url := fmt.Sprintf("/api/v1/orgs/%s/reports/%s", env.orgID, rec.ID)

	req := httptest.NewRequest(http.MethodPatch, url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", env.moderator.authHeader(time.Now()))
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.Code, resp.Body.String())
	}
	var firstVoteResp protocol.ReportRecord
	if err := json.NewDecoder(resp.Body).Decode(&firstVoteResp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if firstVoteResp.VoteCount != 1 {
		t.Fatalf("expected vote_count 1, got %d", firstVoteResp.VoteCount)
	}
	if firstVoteResp.Status != "pending" {
		t.Fatalf("expected pending status, got %s", firstVoteResp.Status)
	}

	// duplicate vote should not add another count
	req2 := httptest.NewRequest(http.MethodPatch, url, bytes.NewReader(body))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("Authorization", env.moderator.authHeader(time.Now()))
	resp2 := httptest.NewRecorder()
	router.ServeHTTP(resp2, req2)
	if resp2.Code != http.StatusOK {
		t.Fatalf("expected 200 on second vote, got %d", resp2.Code)
	}
	var secondVoteResp protocol.ReportRecord
	if err := json.NewDecoder(resp2.Body).Decode(&secondVoteResp); err != nil {
		t.Fatalf("decode second response: %v", err)
	}
	if secondVoteResp.VoteCount != 1 {
		t.Fatalf("expected single vote_count after duplicate, got %d", secondVoteResp.VoteCount)
	}
	if secondVoteResp.Status != "pending" {
		t.Fatalf("expected pending status on duplicate vote, got %s", secondVoteResp.Status)
	}

	dbRec, err := reports.Get(ctx, env.pool, env.orgID, rec.ID)
	if err != nil {
		t.Fatalf("fetch report: %v", err)
	}
	if dbRec.VoteCount != 1 {
		t.Fatalf("expected db vote_count 1, got %d", dbRec.VoteCount)
	}
	if dbRec.Status != "pending" {
		t.Fatalf("expected db status pending, got %s", dbRec.Status)
	}
}

func TestUpdateReport_ResolveActions(t *testing.T) {
	env := setupReportTestEnv(t)
	router := reportRouter()
	ctx := context.Background()

	type resolveCase struct {
		action             string
		expectedResolution string
		expectedDismissed  int
	}

	cases := []resolveCase{
		{action: "dismiss", expectedResolution: "dismissed", expectedDismissed: 1},
		{action: "dismiss_malicious", expectedResolution: "dismissed_malicious", expectedDismissed: 2},
		{action: "upheld", expectedResolution: "upheld", expectedDismissed: 2},
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

			if _, err := reports.Update(ctx, env.pool, env.orgID, rec.ID, env.moderator.pubkeyHex, "member", protocol.UpdateReportRequest{Vote: "uphold"}); err != nil {
				t.Fatalf("seed vote before %s: %v", tc.action, err)
			}

			body, _ := json.Marshal(map[string]string{"resolution": tc.expectedResolution})
			url := fmt.Sprintf("/api/v1/orgs/%s/reports/%s", env.orgID, rec.ID)
			req := httptest.NewRequest(http.MethodPatch, url, bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", env.moderator.authHeader(time.Now()))
			resp := httptest.NewRecorder()
			router.ServeHTTP(resp, req)
			if resp.Code != http.StatusForbidden {
				t.Fatalf("expected 403, got %d: %s", resp.Code, resp.Body.String())
			}

			dbRec, err := reports.Get(ctx, env.pool, env.orgID, rec.ID)
			if err != nil {
				t.Fatalf("fetch report: %v", err)
			}

			if dbRec.Status != "pending" {
				t.Fatalf("expected pending status after moderator resolution attempt, got %s", dbRec.Status)
			}
			if dbRec.Resolution != nil {
				t.Fatalf("expected nil resolution after moderator resolution attempt, got %v", dbRec.Resolution)
			}

			leaderBody, _ := json.Marshal(map[string]string{"resolution": tc.expectedResolution})
			leaderReq := httptest.NewRequest(http.MethodPatch, url, bytes.NewReader(leaderBody))
			leaderReq.Header.Set("Content-Type", "application/json")
			leaderReq.Header.Set("Authorization", env.leader.authHeader(time.Now()))
			leaderResp := httptest.NewRecorder()
			router.ServeHTTP(leaderResp, leaderReq)
			if leaderResp.Code != http.StatusOK {
				t.Fatalf("leader resolve %s: expected 200, got %d: %s", tc.action, leaderResp.Code, leaderResp.Body.String())
			}

			var leaderUpdated protocol.ReportRecord
			if err := json.NewDecoder(leaderResp.Body).Decode(&leaderUpdated); err != nil {
				t.Fatalf("decode leader response: %v", err)
			}

			if tc.expectedResolution == "upheld" {
				if leaderUpdated.Status != "upheld_pending_tx" {
					t.Fatalf("expected status upheld_pending_tx, got %s", leaderUpdated.Status)
				}
			} else {
				if leaderUpdated.Status != tc.expectedResolution {
					t.Fatalf("expected status %s, got %s", tc.expectedResolution, leaderUpdated.Status)
				}
			}
			if leaderUpdated.Resolution == nil || *leaderUpdated.Resolution != tc.expectedResolution {
				t.Fatalf("expected resolution %s, got %v", tc.expectedResolution, leaderUpdated.Resolution)
			}
			if leaderUpdated.ResolvedBy == nil || *leaderUpdated.ResolvedBy != env.leader.pubkeyHex {
				t.Fatalf("expected resolved_by %s, got %v", env.leader.pubkeyHex, leaderUpdated.ResolvedBy)
			}
			if leaderUpdated.ResolvedAt == nil {
				t.Fatalf("expected resolved_at to be set")
			}

			if tc.expectedResolution == "upheld" {
				if _, err := reports.Get(ctx, env.pool, env.orgID, rec.ID); err != nil {
					t.Fatalf("expected upheld report to still exist: %v", err)
				}
			}

			var dismissedCount int
			if err := env.pool.QueryRow(ctx, `
				SELECT dismissed_reports_count
				FROM members
				WHERE org_id = $1 AND pubkey = $2
			`, env.orgID, env.member.pubkeyHex).Scan(&dismissedCount); err != nil {
				t.Fatalf("query dismissed_reports_count: %v", err)
			}
			if dismissedCount != tc.expectedDismissed {
				t.Fatalf("expected dismissed_reports_count %d, got %d", tc.expectedDismissed, dismissedCount)
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
			Reason:    "incorrect",
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
		body, _ := json.Marshal(map[string]string{"resolution": "dismissed"})
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

	invite := func(actor testActor, role string, canModerate bool) {
		_, err := members.InviteMember(ctx, pool, orgID, protocol.InviteMemberRequest{
			Pubkey:         actor.pubkeyHex,
			X25519Pubkey:   randomHex(32),
			Role:           role,
			CanModerate:    canModerate,
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

	invite(moderator, "member", true)
	invite(member, "member", false)

	t.Cleanup(func() {
		ctx := context.Background()
		pool.Exec(ctx, "DELETE FROM reports WHERE org_id = $1", orgID)
		pool.Exec(ctx, "DELETE FROM members WHERE org_id = $1", orgID)
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
