package embed

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

const EMBED_DIM = 3072

type EmbeddingConfig struct {
	BaseURL string
	APIKey  string
	Model   string
}

func ResolveEmbeddingConfig() (EmbeddingConfig, error) {
	provider := strings.TrimSpace(os.Getenv("WEVIBE_EMBEDDING_PROVIDER"))
	if provider == "" {
		provider = "openrouter"
	}

	rawModel := os.Getenv("WEVIBE_EMBEDDING_MODEL")
	model := strings.TrimSpace(rawModel)
	if rawModel == "" {
		model = "openai/text-embedding-3-large"
	}

	resolved := EmbeddingConfig{Model: model}

	switch provider {
	case "openrouter":
		resolved.BaseURL = "https://openrouter.ai/api/v1"
		resolved.APIKey = strings.TrimSpace(os.Getenv("OPENROUTER_API_KEY"))
		if resolved.APIKey == "" {
			return EmbeddingConfig{}, fmt.Errorf("OPENROUTER_API_KEY is required for provider %q", provider)
		}
	case "lm_studio":
		resolved.BaseURL = strings.TrimSpace(os.Getenv("WEVIBE_LMSTUDIO_URL"))
		if resolved.BaseURL == "" {
			resolved.BaseURL = "http://127.0.0.1:1234/v1"
		}
		resolved.APIKey = "lm-studio"
	case "ollama":
		ollamaURL := strings.TrimSpace(os.Getenv("WEVIBE_OLLAMA_URL"))
		if ollamaURL == "" {
			ollamaURL = "http://localhost:11434"
		}
		resolved.BaseURL = fmt.Sprintf("%s/v1", strings.TrimSuffix(ollamaURL, "/"))
		resolved.APIKey = "ollama"
	default:
		return EmbeddingConfig{}, fmt.Errorf("unsupported embedding provider %q", provider)
	}

	if resolved.Model == "" {
		return EmbeddingConfig{}, fmt.Errorf("embedding model is empty for provider %q", provider)
	}

	return resolved, nil
}

func GetEmbedding(ctx context.Context, text string) (vector []float32, modelID string, err error) {
	config, err := ResolveEmbeddingConfig()
	if err != nil {
		return nil, "", fmt.Errorf("resolve embedding config: %w", err)
	}

	payload := map[string]string{
		"model": config.Model,
		"input": text,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, "", fmt.Errorf("marshal embeddings request: %w", err)
	}

	endpoint := fmt.Sprintf("%s/embeddings", strings.TrimSuffix(config.BaseURL, "/"))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, "", fmt.Errorf("create embeddings request: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", config.APIKey))
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("send embeddings request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		responseBody, readErr := io.ReadAll(resp.Body)
		if readErr != nil {
			return nil, "", fmt.Errorf("embeddings request failed with status %d and unreadable body: %w", resp.StatusCode, readErr)
		}
		return nil, "", fmt.Errorf("embeddings request failed with status %d: %s", resp.StatusCode, strings.TrimSpace(string(responseBody)))
	}

	var response struct {
		Data []struct {
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, "", fmt.Errorf("decode embeddings response: %w", err)
	}

	if len(response.Data) == 0 {
		return nil, "", fmt.Errorf("embeddings response missing data entries")
	}

	if len(response.Data[0].Embedding) == 0 {
		return nil, "", fmt.Errorf("embeddings response missing data[0].embedding values")
	}

	return response.Data[0].Embedding, config.Model, nil
}
