package embed

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
)

const EMBED_DIM = 768

func GetEmbedding(ctx context.Context, ollamaURL, text string) ([]float32, error) {
	payload := map[string]string{"model": "nomic-embed-text", "prompt": text}
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequestWithContext(ctx, "POST", ollamaURL+"/api/embeddings", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return make([]float32, EMBED_DIM), nil
	}
	defer resp.Body.Close()
	var result struct {
		Embedding []float32 `json:"embedding"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return make([]float32, EMBED_DIM), nil
	}
	return result.Embedding, nil
}
