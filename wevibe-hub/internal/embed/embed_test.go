package embed

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestResolveEmbeddingConfig_OpenRouter(t *testing.T) {
	t.Setenv("WEVIBE_EMBEDDING_PROVIDER", "")
	t.Setenv("WEVIBE_EMBEDDING_MODEL", "")
	t.Setenv("OPENROUTER_API_KEY", "openrouter-test-key")

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
	if config.Model != "openai/text-embedding-3-large" {
		t.Fatalf("expected openrouter model, got %q", config.Model)
	}
}

func TestResolveEmbeddingConfig_OpenRouterMissingAPIKeyFails(t *testing.T) {
	t.Setenv("WEVIBE_EMBEDDING_PROVIDER", "openrouter")
	t.Setenv("WEVIBE_EMBEDDING_MODEL", "openai/text-embedding-3-large")
	t.Setenv("OPENROUTER_API_KEY", "")

	if _, err := ResolveEmbeddingConfig(); err == nil {
		t.Fatal("expected ResolveEmbeddingConfig to fail when OPENROUTER_API_KEY is empty")
	}
}

func TestResolveEmbeddingConfig_LMStudio(t *testing.T) {
	tests := []struct {
		name        string
		lmStudioURL string
		expectURL   string
	}{
		{
			name:        "uses default base URL",
			lmStudioURL: "",
			expectURL:   "http://127.0.0.1:1234/v1",
		},
		{
			name:        "uses configured base URL",
			lmStudioURL: "http://host.docker.internal:1234/v1",
			expectURL:   "http://host.docker.internal:1234/v1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("WEVIBE_EMBEDDING_PROVIDER", "lm_studio")
			t.Setenv("WEVIBE_EMBEDDING_MODEL", "openai/text-embedding-3-large")
			t.Setenv("WEVIBE_LMSTUDIO_URL", tt.lmStudioURL)

			config, err := ResolveEmbeddingConfig()
			if err != nil {
				t.Fatalf("ResolveEmbeddingConfig returned error: %v", err)
			}

			if config.BaseURL != tt.expectURL {
				t.Fatalf("expected lm_studio base URL %q, got %q", tt.expectURL, config.BaseURL)
			}
			if config.APIKey != "lm-studio" {
				t.Fatalf("expected lm_studio API key, got %q", config.APIKey)
			}
			if config.Model != "openai/text-embedding-3-large" {
				t.Fatalf("expected lm_studio model, got %q", config.Model)
			}
		})
	}
}

func TestResolveEmbeddingConfig_Ollama(t *testing.T) {
	tests := []struct {
		name      string
		ollamaURL string
		expectURL string
	}{
		{
			name:      "uses default base URL",
			ollamaURL: "",
			expectURL: "http://localhost:11434/v1",
		},
		{
			name:      "normalizes configured base URL",
			ollamaURL: "http://host.docker.internal:11434/",
			expectURL: "http://host.docker.internal:11434/v1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("WEVIBE_EMBEDDING_PROVIDER", "ollama")
			t.Setenv("WEVIBE_EMBEDDING_MODEL", "nomic-embed-text")
			t.Setenv("WEVIBE_OLLAMA_URL", tt.ollamaURL)

			config, err := ResolveEmbeddingConfig()
			if err != nil {
				t.Fatalf("ResolveEmbeddingConfig returned error: %v", err)
			}

			if config.BaseURL != tt.expectURL {
				t.Fatalf("expected ollama base URL %q, got %q", tt.expectURL, config.BaseURL)
			}
			if config.APIKey != "ollama" {
				t.Fatalf("expected ollama API key, got %q", config.APIKey)
			}
			if config.Model != "nomic-embed-text" {
				t.Fatalf("expected ollama model, got %q", config.Model)
			}
		})
	}
}

func TestResolveEmbeddingConfig_UnknownProviderFails(t *testing.T) {
	t.Setenv("WEVIBE_EMBEDDING_PROVIDER", "unknown_provider")
	t.Setenv("WEVIBE_EMBEDDING_MODEL", "openai/text-embedding-3-large")

	if _, err := ResolveEmbeddingConfig(); err == nil {
		t.Fatal("expected ResolveEmbeddingConfig to fail for unknown provider")
	}
}

func TestResolveEmbeddingConfig_EmptyModelFails(t *testing.T) {
	t.Setenv("WEVIBE_EMBEDDING_PROVIDER", "openrouter")
	t.Setenv("WEVIBE_EMBEDDING_MODEL", "   ")
	t.Setenv("OPENROUTER_API_KEY", "openrouter-test-key")

	if _, err := ResolveEmbeddingConfig(); err == nil {
		t.Fatal("expected ResolveEmbeddingConfig to fail when model is empty")
	}
}

func TestGetEmbedding_Dim(t *testing.T) {
	if EMBED_DIM != 3072 {
		t.Errorf("expected EMBED_DIM to be 3072, got %d", EMBED_DIM)
	}
}

func TestGetEmbedding_Live(t *testing.T) {
	key := os.Getenv("OPENROUTER_API_KEY")
	if key == "" {
		t.Skip("set OPENROUTER_API_KEY to run live embedding test")
	}

	t.Setenv("WEVIBE_EMBEDDING_PROVIDER", "openrouter")
	t.Setenv("WEVIBE_EMBEDDING_MODEL", "openai/text-embedding-3-large")
	t.Setenv("OPENROUTER_API_KEY", key)

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
