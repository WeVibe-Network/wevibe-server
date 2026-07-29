package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetCurrentChainEpochNilChainClientReturns503(t *testing.T) {
	SetChainClient(nil)

	req := httptest.NewRequest(http.MethodGet, "/v1/orgs/org-1/epoch/current/chain", nil)
	w := httptest.NewRecorder()

	GetCurrentChainEpoch(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", w.Code)
	}
	if got := w.Body.String(); got != "{\"error\":\"chain unavailable\"}\n" {
		t.Fatalf("unexpected body: %q", got)
	}
}
