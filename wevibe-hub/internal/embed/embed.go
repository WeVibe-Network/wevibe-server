package embed

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const EMBED_DIM = 768

const (
	maxEmbeddingAttempts = 4
	maxRetryAfterBackoff = 10 * time.Second
	embeddingBackoffBase = 500 * time.Millisecond
)

var retryBackoff = func(attempt int) time.Duration {
	if attempt <= 0 {
		attempt = 1
	}
	return embeddingBackoffBase << (attempt - 1)
}

type EmbeddingConfig struct {
	BaseURL string
	APIKey  string
	Model   string
}

type dashboardEmbeddingSettings struct {
	EmbeddingProvider      any `json:"embedding_provider"`
	EmbeddingOpenRouterMod any `json:"embedding_openrouter_model"`
	OpenRouterAPIKey       any `json:"embedding_api_key"`
	EmbeddingOllamaModel   any `json:"embedding_ollama_model"`
	OllamaURL              any `json:"ollama_url"`
	EmbeddingLMStudioModel any `json:"embedding_lmstudio_model"`
	LMStudioURL            any `json:"lmstudio_url"`
}

func asStringOrEmpty(value any) string {
	str, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(str)
}

func asString(value any) string {
	str, ok := value.(string)
	if !ok {
		return ""
	}
	return str
}

func resolveDashboardConfigPath() (string, error) {
	if envPath := strings.TrimSpace(os.Getenv("WEVIBE_DASHBOARD_CONFIG")); envPath != "" {
		return envPath, nil
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve user home dir: %w", err)
	}

	return filepath.Join(homeDir, ".config", "wevibe", "dashboard.json"), nil
}

func ResolveEmbeddingConfig() (EmbeddingConfig, error) {
	configPath, err := resolveDashboardConfigPath()
	if err != nil {
		return EmbeddingConfig{}, err
	}

	rawConfig, err := os.ReadFile(configPath)
	if err != nil {
		return EmbeddingConfig{}, fmt.Errorf("read dashboard config %q: %w", configPath, err)
	}

	var parsed dashboardEmbeddingSettings
	if err := json.Unmarshal(rawConfig, &parsed); err != nil {
		return EmbeddingConfig{}, fmt.Errorf("parse dashboard config %q: %w", configPath, err)
	}

	provider := asStringOrEmpty(parsed.EmbeddingProvider)
	resolved := EmbeddingConfig{}

	switch provider {
	case "openrouter":
		resolved.BaseURL = "https://openrouter.ai/api/v1"
		resolved.APIKey = strings.TrimSpace(asString(parsed.OpenRouterAPIKey))
		if resolved.APIKey == "" {
			return EmbeddingConfig{}, fmt.Errorf("embedding api key is empty for provider %q", provider)
		}
		resolved.Model = asStringOrEmpty(parsed.EmbeddingOpenRouterMod)
	case "lm_studio":
		resolved.BaseURL = asStringOrEmpty(parsed.LMStudioURL)
		if resolved.BaseURL == "" {
			resolved.BaseURL = "http://127.0.0.1:1234/v1"
		}
		resolved.APIKey = "lm-studio"
		resolved.Model = asStringOrEmpty(parsed.EmbeddingLMStudioModel)
	case "ollama":
		ollamaURL := asStringOrEmpty(parsed.OllamaURL)
		if ollamaURL == "" {
			ollamaURL = "http://localhost:11434"
		}
		resolved.BaseURL = fmt.Sprintf("%s/v1", strings.TrimSuffix(ollamaURL, "/"))
		resolved.APIKey = "ollama"
		resolved.Model = asStringOrEmpty(parsed.EmbeddingOllamaModel)
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
	for attempt := 1; attempt <= maxEmbeddingAttempts; attempt++ {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, "", ctxErr
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, "", fmt.Errorf("create embeddings request: %w", err)
		}
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", config.APIKey))
		req.Header.Set("Content-Type", "application/json")

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, "", ctxErr
			}
			return nil, "", fmt.Errorf("send embeddings request: %w", err)
		}

		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			responseBody, readErr := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if readErr != nil {
				return nil, "", fmt.Errorf("embeddings request failed with status %d and unreadable body: %w", resp.StatusCode, readErr)
			}

			responseText := strings.TrimSpace(string(responseBody))
			isRetryableStatus := resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable
			if isRetryableStatus {
				if attempt == maxEmbeddingAttempts {
					return nil, "", fmt.Errorf("embeddings request failed after %d attempts: status %d: %s", attempt, resp.StatusCode, responseText)
				}

				backoff := retryBackoff(attempt)
				if retryAfter, ok := parseRetryAfterSeconds(resp.Header.Get("Retry-After")); ok {
					backoff = retryAfter
				}

				if err := sleepWithContext(ctx, backoff); err != nil {
					return nil, "", err
				}
				continue
			}

			return nil, "", fmt.Errorf("embeddings request failed with status %d: %s", resp.StatusCode, responseText)
		}

		var response struct {
			Data []struct {
				Embedding []float32 `json:"embedding"`
			} `json:"data"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
			_ = resp.Body.Close()
			return nil, "", fmt.Errorf("decode embeddings response: %w", err)
		}
		_ = resp.Body.Close()

		if len(response.Data) == 0 {
			return nil, "", fmt.Errorf("embeddings response missing data entries")
		}

		if len(response.Data[0].Embedding) == 0 {
			return nil, "", fmt.Errorf("embeddings response missing data[0].embedding values")
		}

		if len(response.Data[0].Embedding) != EMBED_DIM {
			return nil, "", fmt.Errorf("embeddings response dimension mismatch: got %d, want %d", len(response.Data[0].Embedding), EMBED_DIM)
		}

		return response.Data[0].Embedding, config.Model, nil
	}

	return nil, "", fmt.Errorf("embeddings request failed after %d attempts", maxEmbeddingAttempts)
}

func parseRetryAfterSeconds(raw string) (time.Duration, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, false
	}

	seconds, err := strconv.Atoi(trimmed)
	if err != nil || seconds < 0 {
		return 0, false
	}

	delay := time.Duration(seconds) * time.Second
	if delay > maxRetryAfterBackoff {
		delay = maxRetryAfterBackoff
	}

	return delay, true
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return nil
	}

	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
