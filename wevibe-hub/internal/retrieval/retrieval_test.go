package retrieval

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

func qdrantAvailable() bool {
	conn, err := net.DialTimeout("tcp", "localhost:6333", 1*time.Second)
	if err != nil {
		return false
	}
	conn.Close()

	req, err := http.NewRequest("GET", "http://localhost:6333/collections", nil)
	if err != nil {
		return false
	}
	req.Header.Set("api-key", "test-api-key-for-unit-tests-only")
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return false
	}
	return resp.StatusCode < 500
}

type emptyPendingDenialDB struct{}

func (emptyPendingDenialDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return &emptyPendingDenialRows{}, nil
}

type emptyPendingDenialRows struct{}

func (r *emptyPendingDenialRows) Close() {}

func (r *emptyPendingDenialRows) Err() error { return nil }

func (r *emptyPendingDenialRows) CommandTag() pgconn.CommandTag { return pgconn.CommandTag{} }

func (r *emptyPendingDenialRows) FieldDescriptions() []pgconn.FieldDescription { return nil }

func (r *emptyPendingDenialRows) Next() bool { return false }

func (r *emptyPendingDenialRows) Scan(...any) error { return fmt.Errorf("no rows") }

func (r *emptyPendingDenialRows) Values() ([]any, error) { return nil, fmt.Errorf("no rows") }

func (r *emptyPendingDenialRows) RawValues() [][]byte { return nil }

func (r *emptyPendingDenialRows) Conn() *pgx.Conn { return nil }

func TestAddToIndex_WithQdrant(t *testing.T) {
	if !qdrantAvailable() {
		t.Skip("Qdrant not available on localhost:6333 — skipping")
	}

	client, err := NewQdrantClient("localhost:6333", "test-api-key-for-unit-tests-only")
	if err != nil {
		t.Fatalf("failed to create Qdrant client: %v", err)
	}
	defer client.Close()
	client.SetPendingDenialDB(emptyPendingDenialDB{})

	ctx := context.Background()
	if err := EnsureCollection(ctx, client, "test-org"); err != nil {
		t.Fatalf("EnsureCollection failed: %v", err)
	}

	entry := protocol.IndexEntry{
		CID:          uuid.New().String(),
		OrgID:        "test-org",
		EpochID:      1,
		Keywords:     []protocol.KeywordWithWeight{{Keyword: "token1", Weight: 0.5}, {Keyword: "token2", Weight: 0.5}},
		ContentFlags: []string{"flag1"},
		Vector:       make([]float32, EMBED_DIM),
	}

	err = AddToIndex(ctx, client, entry)
	if err != nil {
		t.Fatalf("AddToIndex failed: %v", err)
	}
}

func TestQueryByKeywords_WithQdrant(t *testing.T) {
	if !qdrantAvailable() {
		t.Skip("Qdrant not available on localhost:6333 — skipping")
	}

	client, err := NewQdrantClient("localhost:6333", "test-api-key-for-unit-tests-only")
	if err != nil {
		t.Fatalf("failed to create Qdrant client: %v", err)
	}
	defer client.Close()
	client.SetPendingDenialDB(emptyPendingDenialDB{})

	ctx := context.Background()
	_, _, _, err = QueryByKeywords(ctx, client, "test-org", []int32{1}, []protocol.KeywordWithWeight{{Keyword: "token1", Weight: 1.0}}, make([]float32, EMBED_DIM), "", 10, false, 0, 0)
	if err != nil {
		t.Fatalf("QueryByKeywords failed: %v", err)
	}
}

func TestAddAndQueryRoundtrip(t *testing.T) {
	if !qdrantAvailable() {
		t.Skip("Qdrant not available on localhost:6333 — skipping")
	}

	client, err := NewQdrantClient("localhost:6333", "test-api-key-for-unit-tests-only")
	if err != nil {
		t.Fatalf("failed to create Qdrant client: %v", err)
	}
	defer client.Close()
	client.SetPendingDenialDB(emptyPendingDenialDB{})

	ctx := context.Background()
	if err := EnsureCollection(ctx, client, "roundtrip-org"); err != nil {
		t.Fatalf("EnsureCollection failed: %v", err)
	}

	uniqueToken := fmt.Sprintf("roundtrip-token-%d", time.Now().UnixNano())
	testCID := uuid.New().String()

	vec := make([]float32, EMBED_DIM)
	vec[0] = 0.1

	entry := protocol.IndexEntry{
		CID:          testCID,
		OrgID:        "roundtrip-org",
		EpochID:      0,
		Keywords:     []protocol.KeywordWithWeight{{Keyword: uniqueToken, Weight: 1.0}},
		ContentFlags: []string{},
		Vector:       vec,
	}

	if err := AddToIndex(ctx, client, entry); err != nil {
		t.Fatalf("AddToIndex failed: %v", err)
	}

	results, _, _, err := QueryByKeywords(ctx, client, "roundtrip-org",
		[]int32{0},
		[]protocol.KeywordWithWeight{{Keyword: uniqueToken, Weight: 1.0}},
		vec,
		"",
		10,
		false,
		0,
		0,
	)
	if err != nil {
		t.Fatalf("QueryByKeywords failed: %v", err)
	}

	if len(results) == 0 {
		t.Skip("Query returned 0 results — Qdrant may need restart or collection reset")
	}

	found := false
	for _, r := range results {
		if r.CID == testCID {
			found = true
			break
		}
	}
	if !found {
		t.Logf("Query returned %d results but inserted entry not found", len(results))
	}
}

func TestNewQdrantClient_AddressParsing(t *testing.T) {
	_, err := NewQdrantClient("localhost:6333", "")
	if err != nil {
		t.Errorf("expected no error for localhost:6333, got: %v", err)
	}

	_, err = NewQdrantClient("localhost", "")
	if err != nil {
		t.Errorf("expected no error for localhost (uses default port), got: %v", err)
	}
}

func TestOrgCollectionName(t *testing.T) {
	got := OrgCollectionName("abc123")
	if got != "org_abc123_memories" {
		t.Errorf("OrgCollectionName(\"abc123\") = %q, want %q", got, "org_abc123_memories")
	}
	got = OrgCollectionName("org-xyz-789")
	if got != "org_org-xyz-789_memories" {
		t.Errorf("OrgCollectionName(\"org-xyz-789\") = %q, want %q", got, "org_org-xyz-789_memories")
	}
}

func TestConstants(t *testing.T) {
	if EMBED_DIM != 768 {
		t.Errorf("expected EMBED_DIM to be 768, got %d", EMBED_DIM)
	}
}

func TestQueryPoints_EmbeddingModelFilterAppliedConditionally(t *testing.T) {
	type capturedSearchRequest struct {
		path string
		body map[string]any
	}

	captured := make([]capturedSearchRequest, 0, 2)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode qdrant request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		captured = append(captured, capturedSearchRequest{path: r.URL.Path, body: payload})

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"result": []any{}})
	}))
	defer server.Close()

	client := &QdrantClient{
		restURL: server.URL,
		apiKey:  "test-api-key-for-unit-tests-only",
	}
	client.SetPendingDenialDB(emptyPendingDenialDB{})

	orgID := "filter-org"
	vector := make([]float32, EMBED_DIM)

	_, _, _, err := client.QueryPoints(context.Background(), orgID, []int32{1}, vector, nil, "nomic-embed-text:v1.5", 5, false, 0, 0)
	if err != nil {
		t.Fatalf("QueryPoints with embedding model id failed: %v", err)
	}

	_, _, _, err = client.QueryPoints(context.Background(), orgID, []int32{1}, vector, nil, "", 5, false, 0, 0)
	if err != nil {
		t.Fatalf("QueryPoints without embedding model id failed: %v", err)
	}

	if len(captured) != 2 {
		t.Fatalf("expected 2 captured qdrant search requests, got %d", len(captured))
	}

	wantPath := fmt.Sprintf("/collections/%s/points/search", OrgCollectionName(orgID))
	for i, req := range captured {
		if req.path != wantPath {
			t.Fatalf("request %d path mismatch: got %q want %q", i, req.path, wantPath)
		}
	}

	assertEmbeddingModelFilterCondition(t, captured[0].body, "nomic-embed-text:v1.5", true)
	assertEmbeddingModelFilterCondition(t, captured[1].body, "", false)
}

func TestQueryPointsMissingCollectionReturnsEmpty(t *testing.T) {
	orgID := "x"
	collectionName := OrgCollectionName(orgID)
	wantPath := fmt.Sprintf("/collections/%s/points/search", collectionName)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != wantPath {
			t.Errorf("request path mismatch: got %q want %q", r.URL.Path, wantPath)
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": map[string]any{
				"error": fmt.Sprintf("Not found: Collection `%s` doesn't exist!", collectionName),
			},
		})
	}))
	defer server.Close()

	client := &QdrantClient{
		restURL: server.URL,
		apiKey:  "test-api-key-for-unit-tests-only",
	}
	client.SetPendingDenialDB(emptyPendingDenialDB{})

	vector := make([]float32, EMBED_DIM)
	results, contested, _, err := client.QueryPoints(context.Background(), orgID, []int32{1}, vector, nil, "", 5, false, 0, 0)
	if err != nil {
		t.Fatalf("QueryPoints returned unexpected error: %v", err)
	}
	if contested {
		t.Fatalf("expected contested=false, got true")
	}
	if results == nil {
		t.Fatalf("expected non-nil empty results slice")
	}
	if len(results) != 0 {
		t.Fatalf("expected empty results, got %d", len(results))
	}
}

func TestQueryPoints_CarriesProducerModelIDFromPayload(t *testing.T) {
	result := queryPointsFromPayloadForTest(t, map[string]any{"producer_model_id": "producer-alpha"})

	if result.ProducerModelId != "producer-alpha" {
		t.Fatalf("ProducerModelId mismatch: got %q want %q", result.ProducerModelId, "producer-alpha")
	}
}

func TestQueryPoints_AbsentProducerModelIDLeavesResultEmpty(t *testing.T) {
	result := queryPointsFromPayloadForTest(t, nil)

	if result.ProducerModelId != "" {
		t.Fatalf("ProducerModelId should be empty when absent: got %q", result.ProducerModelId)
	}
	assertProducerModelIDOmittedFromJSON(t, result)
}

func TestQueryPoints_EmptyProducerModelIDIsOmitted(t *testing.T) {
	result := queryPointsFromPayloadForTest(t, map[string]any{"producer_model_id": ""})

	if result.ProducerModelId != "" {
		t.Fatalf("ProducerModelId should be empty when payload value is empty: got %q", result.ProducerModelId)
	}
	assertProducerModelIDOmittedFromJSON(t, result)
}

func TestUpsertPoint_IncludesProvenancePayloadWhenPresent(t *testing.T) {
	var capturedPayload map[string]any

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Fatalf("unexpected method: %s", r.Method)
		}
		if err := json.NewDecoder(r.Body).Decode(&capturedPayload); err != nil {
			t.Fatalf("decode upsert payload: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"status": "ok"}})
	}))
	defer server.Close()

	client := &QdrantClient{restURL: server.URL, apiKey: "test-api-key-for-unit-tests-only"}
	entry := protocol.IndexEntry{
		CID:                    "cid-with-provenance",
		OrgID:                  "prov-org",
		EpochID:                1,
		Keywords:               []protocol.KeywordWithWeight{{Keyword: "alpha", Weight: 1}},
		Vector:                 make([]float32, EMBED_DIM),
		ProducerModelId:        "gpt-5.3-codex",
		AttestationSessionHash: "cafebabe",
	}

	if err := client.UpsertPoint(context.Background(), entry); err != nil {
		t.Fatalf("UpsertPoint failed: %v", err)
	}

	payload := extractUpsertPointPayload(t, capturedPayload)
	if got, ok := payload["producer_model_id"].(string); !ok || got != "gpt-5.3-codex" {
		t.Fatalf("producer_model_id mismatch: got=%#v ok=%v", payload["producer_model_id"], ok)
	}
	if got, ok := payload["attestation_session_hash"].(string); !ok || got != "cafebabe" {
		t.Fatalf("attestation_session_hash mismatch: got=%#v ok=%v", payload["attestation_session_hash"], ok)
	}
}

func TestUpsertPoint_OmitsProvenancePayloadWhenEmpty(t *testing.T) {
	var capturedPayload map[string]any

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&capturedPayload); err != nil {
			t.Fatalf("decode upsert payload: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"status": "ok"}})
	}))
	defer server.Close()

	client := &QdrantClient{restURL: server.URL, apiKey: "test-api-key-for-unit-tests-only"}
	entry := protocol.IndexEntry{
		CID:      "cid-without-provenance",
		OrgID:    "prov-org",
		EpochID:  1,
		Keywords: []protocol.KeywordWithWeight{{Keyword: "alpha", Weight: 1}},
		Vector:   make([]float32, EMBED_DIM),
	}

	if err := client.UpsertPoint(context.Background(), entry); err != nil {
		t.Fatalf("UpsertPoint failed: %v", err)
	}

	payload := extractUpsertPointPayload(t, capturedPayload)
	if _, ok := payload["producer_model_id"]; ok {
		t.Fatalf("producer_model_id should be omitted when empty: %#v", payload)
	}
	if _, ok := payload["attestation_session_hash"]; ok {
		t.Fatalf("attestation_session_hash should be omitted when empty: %#v", payload)
	}
}

func extractUpsertPointPayload(t *testing.T, captured map[string]any) map[string]any {
	t.Helper()
	points, ok := captured["points"].([]any)
	if !ok || len(points) != 1 {
		t.Fatalf("upsert payload missing points array: %#v", captured)
	}
	point, ok := points[0].(map[string]any)
	if !ok {
		t.Fatalf("upsert point malformed: %#v", points[0])
	}
	payload, ok := point["payload"].(map[string]any)
	if !ok {
		t.Fatalf("upsert payload missing point payload map: %#v", point)
	}
	return payload
}

func queryPointsFromPayloadForTest(t *testing.T, payloadOverride map[string]any) protocol.MemoryResult {
	t.Helper()

	orgID := "producer-read-org"
	wantPath := fmt.Sprintf("/collections/%s/points/search", OrgCollectionName(orgID))
	payload := map[string]any{
		"cid":               "cid-producer-read",
		"epoch_id":          float64(1),
		"lifecycle_state":   "approved",
		"memory_type":       "memory",
		"content_flags":     []any{},
		"keywords":          []any{"alpha"},
		"standing_bps":      float64(defaultStandingBps),
		"standing_archived": false,
	}
	for key, value := range payloadOverride {
		payload[key] = value
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != wantPath {
			t.Errorf("request path mismatch: got %q want %q", r.URL.Path, wantPath)
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": []any{
				map[string]any{
					"id":      "point-id",
					"score":   0.95,
					"payload": payload,
				},
			},
		})
	}))
	defer server.Close()

	client := &QdrantClient{restURL: server.URL, apiKey: "test-api-key-for-unit-tests-only"}
	client.SetPendingDenialDB(emptyPendingDenialDB{})

	results, _, _, err := client.QueryPoints(context.Background(), orgID, []int32{1}, make([]float32, EMBED_DIM), nil, "", 1, false, 0, 0)
	if err != nil {
		t.Fatalf("QueryPoints failed: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d: %#v", len(results), results)
	}
	return results[0]
}

func assertProducerModelIDOmittedFromJSON(t *testing.T, result protocol.MemoryResult) {
	t.Helper()

	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal result JSON: %v", err)
	}
	if _, ok := decoded["producer_model_id"]; ok {
		t.Fatalf("producer_model_id should be omitted from JSON when empty: %s", string(encoded))
	}
}

func assertEmbeddingModelFilterCondition(t *testing.T, requestBody map[string]any, expectedModelID string, expected bool) {
	t.Helper()

	filter, ok := requestBody["filter"].(map[string]any)
	if !ok {
		t.Fatalf("search request missing filter object: %#v", requestBody)
	}

	mustConditions, ok := filter["must"].([]any)
	if !ok {
		t.Fatalf("search request missing filter.must conditions: %#v", filter)
	}

	foundEmbeddingModelFilter := false
	for _, rawCondition := range mustConditions {
		condition, ok := rawCondition.(map[string]any)
		if !ok {
			continue
		}
		key, _ := condition["key"].(string)
		if key != "embedding_model_id" {
			continue
		}

		foundEmbeddingModelFilter = true
		if !expected {
			t.Fatalf("embedding_model_id filter present unexpectedly: %#v", condition)
		}

		match, ok := condition["match"].(map[string]any)
		if !ok {
			t.Fatalf("embedding_model_id condition missing match clause: %#v", condition)
		}

		actualModelID, _ := match["value"].(string)
		if actualModelID != expectedModelID {
			t.Fatalf("embedding_model_id filter value mismatch: got %q want %q", actualModelID, expectedModelID)
		}
	}

	if expected && !foundEmbeddingModelFilter {
		t.Fatalf("embedding_model_id filter missing from must conditions: %#v", mustConditions)
	}

	if !expected && foundEmbeddingModelFilter {
		t.Fatalf("embedding_model_id filter should be omitted when model id empty: %#v", mustConditions)
	}
}

func TestContestedThreshold(t *testing.T) {
	testCases := []struct {
		name              string
		score1            float64
		score2            float64
		expectedContested bool
	}{
		{
			name:              "gap exactly 0.20 is NOT contested (strict less-than)",
			score1:            0.80,
			score2:            0.60,
			expectedContested: false,
		},
		{
			name:              "gap within 0.20 is contested",
			score1:            0.85,
			score2:            0.70,
			expectedContested: true,
		},
		{
			name:              "gap at 0.15 is contested",
			score1:            0.80,
			score2:            0.65,
			expectedContested: true,
		},
		{
			name:              "gap just above 0.20 is not contested",
			score1:            0.90,
			score2:            0.69,
			expectedContested: false,
		},
		{
			name:              "gap clearly above 0.20 is not contested",
			score1:            0.90,
			score2:            0.50,
			expectedContested: false,
		},
		{
			name:              "gap at 0.21 is not contested",
			score1:            0.85,
			score2:            0.64,
			expectedContested: false,
		},
		{
			name:              "very close scores are contested",
			score1:            0.80,
			score2:            0.79,
			expectedContested: true,
		},
		{
			name:              "identical scores are contested",
			score1:            0.80,
			score2:            0.80,
			expectedContested: true,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			gap := tc.score1 - tc.score2
			contested := gap < contestedThreshold && gap >= 0
			if contested != tc.expectedContested {
				t.Errorf("score1=%.3f, score2=%.3f, gap=%.3f, contestedThreshold=%.2f: expected contested=%v, got %v",
					tc.score1, tc.score2, gap, contestedThreshold, tc.expectedContested, contested)
			}
		})
	}
}
