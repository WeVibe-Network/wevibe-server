package config

import (
	"log"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Port            int
	DatabaseURL     string
	QdrantAddr      string
	QdrantAPIKey    string
	StripeSecretKey string
	S3Bucket        string
	NodePrivkey     string
	ChainGRPCURL    string
	FaucetURL       string
	// Optional in Phase 1; required for Sprint 23 WebSocket subscription.
	ChainRPCURL                    string
	ChainID                        string
	ChainSubmitterMnemonic         string
	ChainEnabled                   bool
	UmbralSidecarAddr              string
	SocialGraphURL                 string
	RetrievalTemperature           float64
	RetrievalNewMemBoostMult       float64
	RetrievalNewMemBoostWindow     uint64
	RetrievalVectorNoiseSigma      float64
	RetrievalRecallDepth           uint64
	RetrievalOpenLoopFraction      float64
	RetrievalCounterfactualLogging bool
	RecallMode                     string
	RelayHoldHours                 int
	RelayHoldExemptOrgs            []string
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
	recallMode := getEnvOrDefault("WEVIBE_RECALL_MODE", "prod")
	if recallMode != "test" {
		recallMode = "prod"
	}
	cfg := Config{
		Port:                           port,
		DatabaseURL:                    os.Getenv("DATABASE_URL"),
		QdrantAddr:                     getEnvOrDefault("QDRANT_ADDR", "localhost:6333"),
		QdrantAPIKey:                   qdrantAPIKey,
		StripeSecretKey:                os.Getenv("STRIPE_SECRET_KEY"),
		S3Bucket:                       getEnvOrDefault("WEVIBE_S3_BUCKET", "wevibe-memories"),
		NodePrivkey:                    os.Getenv("HUB_NODE_PRIVKEY"),
		ChainGRPCURL:                   os.Getenv("WEVIBE_CHAIN_GRPC_URL"),
		FaucetURL:                      getEnvOrDefault("FAUCET_URL", "http://wevibe-faucet:4470"),
		ChainRPCURL:                    os.Getenv("WEVIBE_CHAIN_RPC_URL"),
		ChainID:                        os.Getenv("WEVIBE_CHAIN_ID"),
		ChainSubmitterMnemonic:         os.Getenv("WEVIBE_CHAIN_SUBMITTER_MNEMONIC"),
		ChainEnabled:                   os.Getenv("WEVIBE_CHAIN_ENABLED") == "true",
		UmbralSidecarAddr:              getEnvOrDefault("WEVIBE_UMBRAL_SIDECAR_ADDR", "127.0.0.1:4460"),
		SocialGraphURL:                 getEnvOrDefault("WEVIBE_SOCIAL_GRAPH_URL", "http://wevibe-social-graph:4470"),
		RetrievalTemperature:           getEnvOrDefaultFloat("RETRIEVAL_TEMPERATURE", 0.7),
		RetrievalNewMemBoostMult:       getEnvOrDefaultFloat("RETRIEVAL_NEW_MEM_BOOST_MULT", 0.5),
		RetrievalNewMemBoostWindow:     getEnvOrDefaultUint64("RETRIEVAL_NEW_MEM_BOOST_WINDOW", 30),
		RetrievalVectorNoiseSigma:      getEnvOrDefaultFloat("RETRIEVAL_VECTOR_NOISE_SIGMA", 0.0),
		RetrievalRecallDepth:           getEnvOrDefaultUint64("RETRIEVAL_RECALL_DEPTH", 5000),
		RetrievalOpenLoopFraction:      getEnvOrDefaultFloat("RETRIEVAL_OPEN_LOOP_FRACTION", 0.0),
		RetrievalCounterfactualLogging: getEnvOrDefaultBool("RETRIEVAL_COUNTERFACTUAL_LOGGING", false),
		RecallMode:                     recallMode,
		RelayHoldHours:                 getEnvOrDefaultInt("WEVIBE_RELAY_HOLD_HOURS", 24),
		RelayHoldExemptOrgs:            parseCSVEnv("WEVIBE_RELAY_HOLD_EXEMPT_ORGS"),
	}

	if cfg.RetrievalTemperature <= 0 {
		log.Printf("WARNING: RETRIEVAL_TEMPERATURE should be > 0, got %v", cfg.RetrievalTemperature)
	}

	if cfg.RetrievalNewMemBoostMult < 0 {
		log.Printf("WARNING: RETRIEVAL_NEW_MEM_BOOST_MULT should be >= 0, got %v", cfg.RetrievalNewMemBoostMult)
	}
	if cfg.RetrievalOpenLoopFraction < 0 {
		log.Printf("WARNING: RETRIEVAL_OPEN_LOOP_FRACTION should be between 0 and 1, got %v; clamping to 0", cfg.RetrievalOpenLoopFraction)
		cfg.RetrievalOpenLoopFraction = 0
	}
	if cfg.RetrievalOpenLoopFraction > 1 {
		log.Printf("WARNING: RETRIEVAL_OPEN_LOOP_FRACTION should be between 0 and 1, got %v; clamping to 1", cfg.RetrievalOpenLoopFraction)
		cfg.RetrievalOpenLoopFraction = 1
	}

	return cfg
}

func getEnvOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getEnvOrDefaultFloat(key string, def float64) float64 {
	v := os.Getenv(key)
	if v == "" {
		return def
	}

	parsed, err := strconv.ParseFloat(v, 64)
	if err != nil {
		log.Printf("WARNING: env var %s = %q is not a valid float; using default %v", key, v, def)
		return def
	}

	return parsed
}

func getEnvOrDefaultUint64(key string, def uint64) uint64 {
	v := os.Getenv(key)
	if v == "" {
		return def
	}

	parsed, err := strconv.ParseUint(v, 10, 64)
	if err != nil {
		log.Printf("WARNING: env var %s = %q is not a valid uint64; using default %d", key, v, def)
		return def
	}

	return parsed
}

func getEnvOrDefaultBool(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}

	parsed, err := strconv.ParseBool(v)
	if err != nil {
		log.Printf("WARNING: env var %s = %q is not a valid bool; using default %v", key, v, def)
		return def
	}

	return parsed
}

func getEnvOrDefaultInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}

	parsed, err := strconv.Atoi(v)
	if err != nil {
		log.Printf("WARNING: env var %s = %q is not a valid int; using default %d", key, v, def)
		return def
	}

	return parsed
}

func parseCSVEnv(key string) []string {
	raw := os.Getenv(key)
	if strings.TrimSpace(raw) == "" {
		return nil
	}

	parts := strings.Split(raw, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		values = append(values, trimmed)
	}
	if len(values) == 0 {
		return nil
	}

	return values
}
