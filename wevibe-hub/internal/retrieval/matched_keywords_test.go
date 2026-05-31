package retrieval

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

// newMockQueryClient wires QdrantClient against an httptest server that
// returns the supplied search results. Used by the matched-keywords tests
// to drive QueryByKeywords end-to-end through scoring/ranking without
// needing a real Qdrant instance.
func newMockQueryClient(t *testing.T, searchResults []map[string]any) (*QdrantClient, func()) {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"result": searchResults})
	}))

	client := &QdrantClient{
		restURL: server.URL,
		apiKey:  "test-api-key",
	}
	client.SetPendingDenialDB(emptyPendingDenialDB{})

	return client, server.Close
}

func mockSearchResult(cid string, score float64, keywordWeights map[string]float64) map[string]any {
	return map[string]any{
		"id":    cid,
		"score": score,
		"payload": map[string]any{
			"cid":             cid,
			"epoch_id":        float64(1),
			"content_flags":   []any{},
			"keyword_weights": keywordWeights,
			"lifecycle_state": "ACTIVE",
			"memory_type":     "memory",
		},
	}
}

// TestQueryByKeywords_MatchedKeywordsPerResult verifies that the matched-keyword
// set returned per result is the intersection of memory keywords and query
// keywords (sim source semantics: wevibe-sim/ranking-fix.js:184).
//
// Memory keywords: {alpha, beta, gamma}. Query keywords: {beta, delta}.
// Expected matched set: {beta}.
func TestQueryByKeywords_MatchedKeywordsPerResult(t *testing.T) {
	client, cleanup := newMockQueryClient(t, []map[string]any{
		mockSearchResult("cid-1", 0.95, map[string]float64{"alpha": 1, "beta": 1, "gamma": 1}),
	})
	defer cleanup()

	results, _, err := QueryByKeywords(
		context.Background(),
		client,
		"org-1",
		[]int32{1},
		[]protocol.KeywordWithWeight{{Keyword: "beta", Weight: 1}, {Keyword: "delta", Weight: 1}},
		make([]float32, EMBED_DIM),
		"",
		10,
		false,
	)
	if err != nil {
		t.Fatalf("QueryByKeywords failed: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	expected := []string{"beta"}
	if !reflect.DeepEqual(results[0].MatchedKeywords, expected) {
		t.Fatalf("matched keywords mismatch: got=%v want=%v", results[0].MatchedKeywords, expected)
	}
}

// TestQueryByKeywords_MatchedKeywords_FullOverlap verifies that when all
// memory keywords are present in the query, the matched set equals the
// memory's keyword set.
func TestQueryByKeywords_MatchedKeywords_FullOverlap(t *testing.T) {
	client, cleanup := newMockQueryClient(t, []map[string]any{
		mockSearchResult("cid-2", 0.93, map[string]float64{"alpha": 1, "beta": 1}),
	})
	defer cleanup()

	results, _, err := QueryByKeywords(
		context.Background(),
		client,
		"org-1",
		[]int32{1},
		[]protocol.KeywordWithWeight{{Keyword: "alpha", Weight: 1}, {Keyword: "beta", Weight: 1}},
		make([]float32, EMBED_DIM),
		"",
		10,
		false,
	)
	if err != nil {
		t.Fatalf("QueryByKeywords failed: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	expected := []string{"alpha", "beta"}
	if !reflect.DeepEqual(results[0].MatchedKeywords, expected) {
		t.Fatalf("matched keywords mismatch: got=%v want=%v", results[0].MatchedKeywords, expected)
	}
}

// TestQueryByKeywords_MatchedKeywords_NoOverlap_FilteredOut verifies that
// when the query supplies keywords that do not appear in any candidate, the
// candidate is dropped from results (consistent with applyNewMemoryBoost's
// base==0 short-circuit).
//
// Memory keywords: {alpha}. Query keywords: {beta}. Expected: zero results.
func TestQueryByKeywords_MatchedKeywords_NoOverlap_FilteredOut(t *testing.T) {
	client, cleanup := newMockQueryClient(t, []map[string]any{
		mockSearchResult("cid-3", 0.92, map[string]float64{"alpha": 1}),
	})
	defer cleanup()

	results, _, err := QueryByKeywords(
		context.Background(),
		client,
		"org-1",
		[]int32{1},
		[]protocol.KeywordWithWeight{{Keyword: "beta", Weight: 1}},
		make([]float32, EMBED_DIM),
		"",
		10,
		false,
	)
	if err != nil {
		t.Fatalf("QueryByKeywords failed: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("expected 0 results, got %d", len(results))
	}
}
