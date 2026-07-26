package retrieval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
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

func mirrorChainWeightFetcher(searchResults []map[string]any) ChainWeightFetcher {
	weightsByCID := make(map[string]map[string]string, len(searchResults))
	for _, result := range searchResults {
		payload, _ := result["payload"].(map[string]any)
		cid, _ := payload["cid"].(string)
		payloadWeights, _ := payload["keyword_weights"].(map[string]float64)
		if cid == "" {
			continue
		}
		weights := make(map[string]string, len(payloadWeights))
		for keyword, weight := range payloadWeights {
			weights[keyword] = strconv.FormatFloat(weight, 'f', -1, 64)
		}
		weightsByCID[cid] = weights
	}

	return func(ctx context.Context, contentHashes [][]byte) ([]ChainWeightRecord, error) {
		records := make([]ChainWeightRecord, 0, len(contentHashes))
		for _, hash := range contentHashes {
			cid := fmt.Sprintf("%x", hash)
			weights, ok := weightsByCID[cid]
			if !ok {
				continue
			}
			records = append(records, ChainWeightRecord{ContentHashHex: cid, Weights: weights})
		}
		return records, nil
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
		mockSearchResult("aaaaaaaa", 0.95, map[string]float64{"alpha": 1, "beta": 1, "gamma": 1}),
	}
	client, cleanup := newMockQueryClient(t, searchResults)
	defer cleanup()

	results, _, _, err := QueryByKeywords(
		context.Background(),
		client,
		mirrorChainWeightFetcher(searchResults),
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
		mockSearchResult("bbbbbbbb", 0.93, map[string]float64{"alpha": 1, "beta": 1}),
	}
	client, cleanup := newMockQueryClient(t, searchResults)
	defer cleanup()

	results, _, _, err := QueryByKeywords(
		context.Background(),
		client,
		mirrorChainWeightFetcher(searchResults),
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
		mockSearchResult("cccccccc", 0.92, map[string]float64{"alpha": 1}),
	}
	client, cleanup := newMockQueryClient(t, searchResults)
	defer cleanup()

	results, _, _, err := QueryByKeywords(
		context.Background(),
		client,
		mirrorChainWeightFetcher(searchResults),
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

func TestQueryByKeywords_UsesChainWeightsOverPayload(t *testing.T) {
	searchResults := []map[string]any{
		mockSearchResult("dddddddd", 0.95, map[string]float64{"alpha": 1, "beta": 1}),
	}
	client, cleanup := newMockQueryClient(t, searchResults)
	defer cleanup()

	fetcher := func(ctx context.Context, contentHashes [][]byte) ([]ChainWeightRecord, error) {
		return []ChainWeightRecord{{
			ContentHashHex: "dddddddd",
			Weights: map[string]string{
				"beta": "2.0",
			},
		}}, nil
	}

	results, _, _, err := QueryByKeywords(
		context.Background(),
		client,
		fetcher,
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
	if !reflect.DeepEqual(results[0].MatchedKeywords, []string{"beta"}) {
		t.Fatalf("matched keywords mismatch: got=%v want=%v", results[0].MatchedKeywords, []string{"beta"})
	}
	if results[0].Breakdown == nil {
		t.Fatalf("expected scoring breakdown")
	}
	if results[0].Breakdown.KeywordScore != 2.0 {
		t.Fatalf("expected chain-weight keyword score 2.0, got %f", results[0].Breakdown.KeywordScore)
	}
}

func TestQueryByKeywords_DropsMalformedChainWeightCandidate(t *testing.T) {
	searchResults := []map[string]any{
		mockSearchResult("eeeeeeee", 0.96, map[string]float64{"alpha": 1}),
		mockSearchResult("ffffffff", 0.95, map[string]float64{"alpha": 1}),
	}
	client, cleanup := newMockQueryClient(t, searchResults)
	defer cleanup()

	fetcher := func(ctx context.Context, contentHashes [][]byte) ([]ChainWeightRecord, error) {
		return []ChainWeightRecord{
			{ContentHashHex: "eeeeeeee", Weights: map[string]string{"alpha": "not-a-number"}},
			{ContentHashHex: "ffffffff", Weights: map[string]string{"alpha": "1.0"}},
		}, nil
	}

	results, _, _, err := QueryByKeywords(
		context.Background(),
		client,
		fetcher,
		"org-1",
		[]int32{1},
		[]protocol.KeywordWithWeight{{Keyword: "alpha", Weight: 1}},
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
	if results[0].CID != "ffffffff" {
		t.Fatalf("expected surviving cid ffffffff, got %s", results[0].CID)
	}
}

func TestQueryByKeywords_DropsCandidateMissingFromChainResponse(t *testing.T) {
	searchResults := []map[string]any{
		mockSearchResult("11111111", 0.96, map[string]float64{"alpha": 1}),
		mockSearchResult("22222222", 0.95, map[string]float64{"alpha": 1}),
	}
	client, cleanup := newMockQueryClient(t, searchResults)
	defer cleanup()

	fetcher := func(ctx context.Context, contentHashes [][]byte) ([]ChainWeightRecord, error) {
		return []ChainWeightRecord{{
			ContentHashHex: "22222222",
			Weights:        map[string]string{"alpha": "1.0"},
		}}, nil
	}

	results, _, _, err := QueryByKeywords(
		context.Background(),
		client,
		fetcher,
		"org-1",
		[]int32{1},
		[]protocol.KeywordWithWeight{{Keyword: "alpha", Weight: 1}},
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
	if results[0].CID != "22222222" {
		t.Fatalf("expected surviving cid 22222222, got %s", results[0].CID)
	}
}

func TestQueryByKeywords_NilChainFetcherReturnsChainUnavailable(t *testing.T) {
	searchResults := []map[string]any{mockSearchResult("99999999", 0.9, map[string]float64{"alpha": 1})}
	client, cleanup := newMockQueryClient(t, searchResults)
	defer cleanup()

	_, _, _, err := QueryByKeywords(
		context.Background(),
		client,
		nil,
		"org-1",
		[]int32{1},
		[]protocol.KeywordWithWeight{{Keyword: "alpha", Weight: 1}},
		make([]float32, EMBED_DIM),
		"",
		10,
		false,
		0,
		0,
	)
	if err == nil {
		t.Fatalf("expected error for nil chain fetcher")
	}
	if !errors.Is(err, ErrChainUnavailable) {
		t.Fatalf("expected ErrChainUnavailable, got %v", err)
	}
}
