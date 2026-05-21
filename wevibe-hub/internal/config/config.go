package config

import (
	"os"
	"strconv"
)

type Config struct {
	Port            int
	DatabaseURL     string
	QdrantAddr      string
	QdrantAPIKey    string
	OllamaURL       string
	StripeSecretKey string
	S3Bucket        string
	NodePrivkey     string
	ChainGRPCURL    string
	// Optional in Phase 1; required for Sprint 23 WebSocket subscription.
	ChainRPCURL            string
	ChainID                string
	ChainSubmitterMnemonic string
	ChainEnabled           bool
	UmbralSidecarAddr      string
	SocialGraphURL         string
}

func Load() Config {
	port := 4440
	if p := os.Getenv("WEVIBE_HUB_PORT"); p != "" {
		if n, err := strconv.Atoi(p); err == nil {
			port = n
		}
	}
	qdrantAPIKey := os.Getenv("QDRANT_API_KEY")
	if qdrantAPIKey == "" {
		panic("QDRANT_API_KEY environment variable is required")
	}
	if len(qdrantAPIKey) < 32 {
		panic("QDRANT_API_KEY must be at least 32 characters")
	}
	return Config{
		Port:                   port,
		DatabaseURL:            os.Getenv("DATABASE_URL"),
		QdrantAddr:             getEnvOrDefault("QDRANT_ADDR", "localhost:6333"),
		QdrantAPIKey:           qdrantAPIKey,
		OllamaURL:              getEnvOrDefault("OLLAMA_URL", "http://localhost:11434"),
		StripeSecretKey:        os.Getenv("STRIPE_SECRET_KEY"),
		S3Bucket:               getEnvOrDefault("WEVIBE_S3_BUCKET", "wevibe-memories"),
		NodePrivkey:            os.Getenv("HUB_NODE_PRIVKEY"),
		ChainGRPCURL:           os.Getenv("WEVIBE_CHAIN_GRPC_URL"),
		ChainRPCURL:            os.Getenv("WEVIBE_CHAIN_RPC_URL"),
		ChainID:                os.Getenv("WEVIBE_CHAIN_ID"),
		ChainSubmitterMnemonic: os.Getenv("WEVIBE_CHAIN_SUBMITTER_MNEMONIC"),
		ChainEnabled:           os.Getenv("WEVIBE_CHAIN_ENABLED") == "true",
		UmbralSidecarAddr:      getEnvOrDefault("WEVIBE_UMBRAL_SIDECAR_ADDR", "127.0.0.1:4460"),
		SocialGraphURL:         getEnvOrDefault("WEVIBE_SOCIAL_GRAPH_URL", "http://wevibe-social-graph:4470"),
	}
}

func getEnvOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
