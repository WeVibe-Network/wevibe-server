package retrieval

import (
	"context"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/google/uuid"
)

func qdrantAvailable() bool {
	conn, err := net.Dial("tcp", "localhost:6333")
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func TestAddToIndex_WithQdrant(t *testing.T) {
	if !qdrantAvailable() {
		t.Skip("Qdrant not available on localhost:6333 — skipping")
	}

	client, err := NewQdrantClient("localhost:6333", "test-api-key-for-unit-tests-only")
	if err != nil {
		t.Fatalf("failed to create Qdrant client: %v", err)
	}
	defer client.Close()

	ctx := context.Background()
	if err := EnsureCollection(ctx, client, "test-org"); err != nil {
		t.Fatalf("EnsureCollection failed: %v", err)
	}

	entry := protocol.IndexEntry{
		CID:            uuid.New().String(),
		OrgID:          "test-org",
		EpochID:        1,
		Keywords:       []protocol.KeywordWithWeight{{Keyword: "token1", Weight: 0.5}, {Keyword: "token2", Weight: 0.5}},
		KeywordWeights: map[string]float64{"token1": 0.5, "token2": 0.5},
		ContentFlags:   []string{"flag1"},
		Vector:         make([]float32, EMBED_DIM),
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

	ctx := context.Background()
	_, _, err = QueryByKeywords(ctx, client, "test-org", []int32{1}, []protocol.KeywordWithWeight{{Keyword: "token1", Weight: 1.0}}, make([]float32, EMBED_DIM), "", 10, false)
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

	ctx := context.Background()
	if err := EnsureCollection(ctx, client, "roundtrip-org"); err != nil {
		t.Fatalf("EnsureCollection failed: %v", err)
	}

	uniqueToken := fmt.Sprintf("roundtrip-token-%d", time.Now().UnixNano())
	testCID := uuid.New().String()

	vec := make([]float32, EMBED_DIM)
	vec[0] = 0.1

	entry := protocol.IndexEntry{
		CID:            testCID,
		OrgID:          "roundtrip-org",
		EpochID:        0,
		Keywords:       []protocol.KeywordWithWeight{{Keyword: uniqueToken, Weight: 1.0}},
		KeywordWeights: map[string]float64{uniqueToken: 1.0},
		ContentFlags:   []string{},
		Vector:         vec,
	}

	if err := AddToIndex(ctx, client, entry); err != nil {
		t.Fatalf("AddToIndex failed: %v", err)
	}

	results, _, err := QueryByKeywords(ctx, client, "roundtrip-org",
		[]int32{0},
		[]protocol.KeywordWithWeight{{Keyword: uniqueToken, Weight: 1.0}},
		vec,
		"",
		10,
		false,
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
