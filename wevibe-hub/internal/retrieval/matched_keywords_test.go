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

func mockSearchResult(cid string, score float64, keywords []string) map[string]any {
	return map[string]any{
		"id":    cid,
		"score": score,
		"payload": map[string]any{
			"cid":               cid,
			"epoch_id":          float64(1),
			"content_flags":     []any{},
			"keywords":          keywords,
			"standing_bps":      float64(10000),
			"standing_archived": false,
			"lifecycle_state":   "ACTIVE",
			"memory_type":       "memory",
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
	searchResults := []map[string]any{
		mockSearchResult("aaaaaaaa", 0.95, []string{"alpha", "beta", "gamma"}),
	}
	client, cleanup := newMockQueryClient(t, searchResults)
	defer cleanup()

	results, _, _, err := QueryByKeywords(
		context.Background(),
		client,
		"org-1",
		[]int32{1},
		[]protocol.KeywordWithWeight{{Keyword: "beta", Weight: 1}, {Keyword: "delta", Weight: 1}},
		make([]float32, EMBED_DIM),
		"",
		10,
		false,
		0,
		0,
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
	searchResults := []map[string]any{
		mockSearchResult("bbbbbbbb", 0.93, []string{"alpha", "beta"}),
	}
	client, cleanup := newMockQueryClient(t, searchResults)
	defer cleanup()

	results, _, _, err := QueryByKeywords(
		context.Background(),
		client,
		"org-1",
		[]int32{1},
		[]protocol.KeywordWithWeight{{Keyword: "alpha", Weight: 1}, {Keyword: "beta", Weight: 1}},
		make([]float32, EMBED_DIM),
		"",
		10,
		false,
		0,
		0,
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

// TestQueryByKeywords_MatchedKeywords_NoOverlap_NotFiltered verifies that
// with keyword gating disabled, candidates without keyword overlap remain
// eligible and simply report an empty matched-keyword set.
//
// Memory keywords: {alpha}. Query keywords: {beta}. Expected: one result,
// matched keywords empty.
func TestQueryByKeywords_MatchedKeywords_NoOverlap_NotFiltered(t *testing.T) {
	searchResults := []map[string]any{
		mockSearchResult("cccccccc", 0.92, []string{"alpha"}),
	}
	client, cleanup := newMockQueryClient(t, searchResults)
	defer cleanup()

	results, _, _, err := QueryByKeywords(
		context.Background(),
		client,
		"org-1",
		[]int32{1},
		[]protocol.KeywordWithWeight{{Keyword: "beta", Weight: 1}},
		make([]float32, EMBED_DIM),
		"",
		10,
		false,
		0,
		0,
	)
	if err != nil {
		t.Fatalf("QueryByKeywords failed: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if len(results[0].MatchedKeywords) != 0 {
		t.Fatalf("expected empty matched keywords, got %v", results[0].MatchedKeywords)
	}
}

func TestQueryByKeywords_BelowStandingDropped(t *testing.T) {
	searchResults := []map[string]any{
		mockSearchResult("dddddddd", 0.95, []string{"alpha"}),
	}
	searchResults[0]["payload"].(map[string]any)["standing_bps"] = float64(1500)
	client, cleanup := newMockQueryClient(t, searchResults)
	defer cleanup()

	results, _, scores, err := QueryByKeywords(context.Background(), client, "org-1", []int32{1}, []protocol.KeywordWithWeight{{Keyword: "alpha", Weight: 1}}, make([]float32, EMBED_DIM), "", 10, false, 0, 0)
	if err != nil {
		t.Fatalf("QueryByKeywords failed: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("expected no visible results below standing, got %d", len(results))
	}
	if len(scores) == 0 || scores[0].Disposition != "below_standing" {
		t.Fatalf("expected below_standing score, got %#v", scores)
	}
}
