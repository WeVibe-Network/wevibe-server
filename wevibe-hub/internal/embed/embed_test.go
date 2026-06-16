package embed

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
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
		"embedding_openrouter_model": "text-embedding-3-large",
		"openrouter_api_key":         "openrouter-test-key",
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
	if config.Model != "text-embedding-3-large" {
		t.Fatalf("expected openrouter model, got %q", config.Model)
	}
}

func TestResolveEmbeddingConfig_LMStudio(t *testing.T) {
	configPath := writeDashboardConfigJSON(t, map[string]any{
		"embedding_provider":       "lm_studio",
		"embedding_lmstudio_model": "text-embedding-3-large",
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
	if config.Model != "text-embedding-3-large" {
		t.Fatalf("expected lm_studio model, got %q", config.Model)
	}
}

func TestResolveEmbeddingConfig_Ollama(t *testing.T) {
	configPath := writeDashboardConfigJSON(t, map[string]any{
		"embedding_provider":     "ollama",
		"embedding_ollama_model": "nomic-embed-text",
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
	if config.Model != "nomic-embed-text" {
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
		"embedding_openrouter_model": "text-embedding-3-large",
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
		"openrouter_api_key":         "openrouter-test-key",
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
	if EMBED_DIM != 3072 {
		t.Errorf("expected EMBED_DIM to be 3072, got %d", EMBED_DIM)
	}
}

func TestGetEmbedding_Live(t *testing.T) {
	if os.Getenv("OPENROUTER_API_KEY") == "" && os.Getenv("WEVIBE_DASHBOARD_CONFIG") == "" {
		t.Skip("set OPENROUTER_API_KEY or WEVIBE_DASHBOARD_CONFIG to run live embedding test")
	}

	if os.Getenv("WEVIBE_DASHBOARD_CONFIG") == "" {
		configPath := writeDashboardConfigJSON(t, map[string]any{
			"embedding_provider":         "openrouter",
			"embedding_openrouter_model": "text-embedding-3-large",
			"openrouter_api_key":         os.Getenv("OPENROUTER_API_KEY"),
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
