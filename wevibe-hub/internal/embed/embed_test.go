package embed

import (
	"context"
	"testing"
)

func TestGetEmbedding_Fallback(t *testing.T) {
	ctx := context.Background()
	vec, err := GetEmbedding(ctx, "http://localhost:9999", "test input")
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if len(vec) != EMBED_DIM {
		t.Errorf("expected vector length %d, got %d", EMBED_DIM, len(vec))
	}
	for _, v := range vec {
		if v != 0 {
			t.Error("expected zero vector on unreachable server")
			break
		}
	}
}

func TestGetEmbedding_Dim(t *testing.T) {
	if EMBED_DIM != 768 {
		t.Errorf("expected EMBED_DIM to be 768, got %d", EMBED_DIM)
	}
}
