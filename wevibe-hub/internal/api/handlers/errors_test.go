package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWriteErrorWithDetail(t *testing.T) {
	rec := httptest.NewRecorder()

	WriteError(rec, http.StatusInternalServerError, "query_failed", "query failed", "qdrant: collection missing")

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d", http.StatusInternalServerError, rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("expected Content-Type application/json, got %q", got)
	}

	var got ErrorEnvelope
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("failed decoding response body: %v", err)
	}

	want := ErrorEnvelope{
		Error:  "query failed",
		Code:   "query_failed",
		Detail: "qdrant: collection missing",
	}
	if got != want {
		t.Fatalf("expected %+v, got %+v", want, got)
	}
}

func TestWriteErrorWithoutDetailOmitsField(t *testing.T) {
	rec := httptest.NewRecorder()

	WriteError(rec, http.StatusInternalServerError, "query_failed", "query failed")

	var got map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("failed decoding response body: %v", err)
	}

	if _, ok := got["detail"]; ok {
		t.Fatalf("expected detail field to be omitted, got %+v", got)
	}
}
