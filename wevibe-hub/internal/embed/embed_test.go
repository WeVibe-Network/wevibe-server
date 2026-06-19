package embed

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func writeDashboardConfigRaw(t *testing.T, raw string) string {
	t.Helper()

	configPath := filepath.Join(t.TempDir(), "dashboard.json")
	if err := os.WriteFile(configPath, []byte(raw), 0o600); err != nil {
		t.Fatalf("write dashboard config: %v", err)
	}

	return configPath
}

func writeDashboardConfigJSON(t *testing.T, settings map[string]any) string {
	t.Helper()

	raw, err := json.Marshal(settings)
	if err != nil {
		t.Fatalf("marshal dashboard config: %v", err)
	}

	return writeDashboardConfigRaw(t, string(raw))
}

func TestResolveEmbeddingConfig_OpenRouter(t *testing.T) {
	configPath := writeDashboardConfigJSON(t, map[string]any{
		"embedding_provider":         "openrouter",
		"embedding_openrouter_model": "nomic-embed-text:v1.5",
		"embedding_api_key":          "openrouter-test-key",
	})
	t.Setenv("WEVIBE_DASHBOARD_CONFIG", configPath)

	config, err := ResolveEmbeddingConfig()
	if err != nil {
		t.Fatalf("ResolveEmbeddingConfig returned error: %v", err)
	}

	if config.BaseURL != "https://openrouter.ai/api/v1" {
		t.Fatalf("expected openrouter base URL, got %q", config.BaseURL)
	}
	if config.APIKey != "openrouter-test-key" {
		t.Fatalf("expected openrouter API key, got %q", config.APIKey)
	}
	if config.Model != "nomic-embed-text:v1.5" {
		t.Fatalf("expected openrouter model, got %q", config.Model)
	}
}

func TestResolveEmbeddingConfig_LMStudio(t *testing.T) {
	configPath := writeDashboardConfigJSON(t, map[string]any{
		"embedding_provider":       "lm_studio",
		"embedding_lmstudio_model": "nomic-embed-text:v1.5",
		"lmstudio_url":             "http://127.0.0.1:1234/v1",
	})
	t.Setenv("WEVIBE_DASHBOARD_CONFIG", configPath)

	config, err := ResolveEmbeddingConfig()
	if err != nil {
		t.Fatalf("ResolveEmbeddingConfig returned error: %v", err)
	}

	if config.BaseURL != "http://127.0.0.1:1234/v1" {
		t.Fatalf("expected lm_studio base URL, got %q", config.BaseURL)
	}
	if config.APIKey != "lm-studio" {
		t.Fatalf("expected lm_studio API key, got %q", config.APIKey)
	}
	if config.Model != "nomic-embed-text:v1.5" {
		t.Fatalf("expected lm_studio model, got %q", config.Model)
	}
}

func TestResolveEmbeddingConfig_Ollama(t *testing.T) {
	configPath := writeDashboardConfigJSON(t, map[string]any{
		"embedding_provider":     "ollama",
		"embedding_ollama_model": "nomic-embed-text:v1.5",
		"ollama_url":             "http://localhost:11434/",
	})
	t.Setenv("WEVIBE_DASHBOARD_CONFIG", configPath)

	config, err := ResolveEmbeddingConfig()
	if err != nil {
		t.Fatalf("ResolveEmbeddingConfig returned error: %v", err)
	}

	if config.BaseURL != "http://localhost:11434/v1" {
		t.Fatalf("expected ollama base URL, got %q", config.BaseURL)
	}
	if config.APIKey != "ollama" {
		t.Fatalf("expected ollama API key, got %q", config.APIKey)
	}
	if config.Model != "nomic-embed-text:v1.5" {
		t.Fatalf("expected ollama model, got %q", config.Model)
	}
}

func TestResolveEmbeddingConfig_MissingFileFails(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "missing-dashboard.json")
	t.Setenv("WEVIBE_DASHBOARD_CONFIG", configPath)

	if _, err := ResolveEmbeddingConfig(); err == nil {
		t.Fatal("expected ResolveEmbeddingConfig to fail for missing file")
	}
}

func TestResolveEmbeddingConfig_UnknownProviderFails(t *testing.T) {
	configPath := writeDashboardConfigJSON(t, map[string]any{
		"embedding_provider":         "unknown_provider",
		"embedding_openrouter_model": "nomic-embed-text:v1.5",
	})
	t.Setenv("WEVIBE_DASHBOARD_CONFIG", configPath)

	if _, err := ResolveEmbeddingConfig(); err == nil {
		t.Fatal("expected ResolveEmbeddingConfig to fail for unknown provider")
	}
}

func TestResolveEmbeddingConfig_EmptyModelFails(t *testing.T) {
	configPath := writeDashboardConfigJSON(t, map[string]any{
		"embedding_provider":         "openrouter",
		"embedding_openrouter_model": "",
		"embedding_api_key":          "openrouter-test-key",
	})
	t.Setenv("WEVIBE_DASHBOARD_CONFIG", configPath)

	if _, err := ResolveEmbeddingConfig(); err == nil {
		t.Fatal("expected ResolveEmbeddingConfig to fail when model is empty")
	}
}

func TestResolveEmbeddingConfig_BadJSONFails(t *testing.T) {
	configPath := writeDashboardConfigRaw(t, `{`)
	t.Setenv("WEVIBE_DASHBOARD_CONFIG", configPath)

	if _, err := ResolveEmbeddingConfig(); err == nil {
		t.Fatal("expected ResolveEmbeddingConfig to fail for invalid JSON")
	}
}

func TestGetEmbedding_Dim(t *testing.T) {
	if EMBED_DIM != 768 {
		t.Errorf("expected EMBED_DIM to be 768, got %d", EMBED_DIM)
	}
}

func TestGetEmbedding_Live(t *testing.T) {
	if os.Getenv("OPENROUTER_API_KEY") == "" && os.Getenv("WEVIBE_DASHBOARD_CONFIG") == "" {
		t.Skip("set OPENROUTER_API_KEY or WEVIBE_DASHBOARD_CONFIG to run live embedding test")
	}

	if os.Getenv("WEVIBE_DASHBOARD_CONFIG") == "" {
		configPath := writeDashboardConfigJSON(t, map[string]any{
			"embedding_provider":         "openrouter",
			"embedding_openrouter_model": "nomic-embed-text:v1.5",
			"embedding_api_key":          os.Getenv("OPENROUTER_API_KEY"),
		})
		t.Setenv("WEVIBE_DASHBOARD_CONFIG", configPath)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	vec, modelID, err := GetEmbedding(ctx, "wevibe embedding test")
	if err != nil {
		t.Fatalf("GetEmbedding returned error: %v", err)
	}
	if modelID == "" {
		t.Fatal("expected non-empty model ID")
	}
	if len(vec) == 0 {
		t.Fatal("expected non-empty embedding vector")
	}
}

func TestGetEmbedding_Retry429ThenSuccess(t *testing.T) {
	originalRetryBackoff := retryBackoff
	retryBackoff = func(int) time.Duration { return 0 }
	t.Cleanup(func() {
		retryBackoff = originalRetryBackoff
	})

	expected := make([]float32, EMBED_DIM)
	for i := range expected {
		expected[i] = float32(i)
	}

	var callCount int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/embeddings" {
			http.Error(w, "unexpected path", http.StatusNotFound)
			return
		}

		attempt := atomic.AddInt32(&callCount, 1)
		if attempt <= 2 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte("rate limited"))
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{
				"embedding": expected,
			}},
		})
	}))
	defer server.Close()

	configPath := writeDashboardConfigJSON(t, map[string]any{
		"embedding_provider":       "lm_studio",
		"embedding_lmstudio_model": "nomic-embed-text:v1.5",
		"lmstudio_url":             server.URL,
	})
	t.Setenv("WEVIBE_DASHBOARD_CONFIG", configPath)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	vec, modelID, err := GetEmbedding(ctx, "wevibe embedding retry test")
	if err != nil {
		t.Fatalf("GetEmbedding returned error: %v", err)
	}
	if modelID != "nomic-embed-text:v1.5" {
		t.Fatalf("expected model ID nomic-embed-text:v1.5, got %q", modelID)
	}
	if len(vec) != EMBED_DIM {
		t.Fatalf("expected embedding length %d, got %d", EMBED_DIM, len(vec))
	}
	if vec[0] != expected[0] || vec[EMBED_DIM-1] != expected[EMBED_DIM-1] {
		t.Fatal("expected returned embedding values to match server response")
	}
	if got := atomic.LoadInt32(&callCount); got != 3 {
		t.Fatalf("expected 3 requests (2 retries + success), got %d", got)
	}
}

func TestGetEmbedding_Retry429ExhaustedFails(t *testing.T) {
	originalRetryBackoff := retryBackoff
	retryBackoff = func(int) time.Duration { return 0 }
	t.Cleanup(func() {
		retryBackoff = originalRetryBackoff
	})

	var callCount int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/embeddings" {
			http.Error(w, "unexpected path", http.StatusNotFound)
			return
		}

		atomic.AddInt32(&callCount, 1)
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte("still rate limited"))
	}))
	defer server.Close()

	configPath := writeDashboardConfigJSON(t, map[string]any{
		"embedding_provider":       "lm_studio",
		"embedding_lmstudio_model": "nomic-embed-text:v1.5",
		"lmstudio_url":             server.URL,
	})
	t.Setenv("WEVIBE_DASHBOARD_CONFIG", configPath)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, _, err := GetEmbedding(ctx, "wevibe embedding persistent retry test")
	if err == nil {
		t.Fatal("expected GetEmbedding to fail after retry exhaustion")
	}
	if !strings.Contains(err.Error(), "embeddings request failed after 4 attempts: status 429") {
		t.Fatalf("expected retry exhaustion error with final status, got: %v", err)
	}
	if got := atomic.LoadInt32(&callCount); got != 4 {
		t.Fatalf("expected 4 requests (max attempts), got %d", got)
	}
}
