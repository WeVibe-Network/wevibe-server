# wevibe-infra

Deployment configuration for WeVibe Network managed infrastructure.

## Components

- Qdrant (retrieval index)
- Ollama (embeddings + LLM extraction)
- PostgreSQL (org/member state, receipts)
- Object store — S3-compatible (encrypted memory blobs)
- wevibe-hub (FastAPI service)

## Environment variables (never commit values)

WEVIBE_EXTRACTION_PROMPT — LLM extraction prompt (trade secret)
WEVIBE_KEYWORD_PROMPT    — Keyword scoring prompt (trade secret)
WEVIBE_QDRANT_URL       — Qdrant connection URL
WEVIBE_QDRANT_API_KEY   — Qdrant API key for authenticated access
WEVIBE_DATABASE_URL     — PostgreSQL connection string (exported as DATABASE_URL in docker-compose)
WEVIBE_OLLAMA_URL       — Ollama base URL
WEVIBE_HUB_NODE_PRIVKEY — Ed25519 private key for receipt countersigning


## TODO

Initialize Terraform config here for VPS or cloud deployment.
