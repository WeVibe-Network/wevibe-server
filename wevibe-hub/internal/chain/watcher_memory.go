package chain

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/embed"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
)

func (w *ChainWatcher) processApproveMemoryBookkeeping(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, orgID string, contentHash []byte, keywords []string, contributorID string, contributorWallet string, producerModelID string, attestationSessionHash string, memoryType string, encryptedBlob []byte, wrappedDekEnc []byte, mcVersion uint32) (retErr error) {
	logger := w.logger.With("org_id", orgID, "tx_hash", txHash)

	contentHashHex := hex.EncodeToString(contentHash)
	defer func() {
		if retErr == nil {
			return
		}
		if err := w.recordSubmissionCommitError(ctx, orgID, contentHashHex, retErr.Error()); err != nil {
			logger.Warn("failed to record pending_submission commit error",
				"content_hash", contentHashHex,
				"commit_error", retErr.Error(),
				"error", err)
		}
	}()

	var epochID int64
	var extractionResult json.RawMessage
	var embeddingVectorRaw json.RawMessage
	var embeddingModelID sql.NullString
	var embeddingSchemaVersion sql.NullString
	err := w.db.QueryRow(ctx, `
		SELECT epoch_id, extraction_result, embedding_vector, embedding_model_id, embedding_schema_version
		FROM pending_submissions
		WHERE org_id = $1 AND submission_hash = $2 AND status = $3
	`, orgID, contentHashHex, protocol.SubmissionStatusPendingChain).Scan(
		&epochID,
		&extractionResult,
		&embeddingVectorRaw,
		&embeddingModelID,
		&embeddingSchemaVersion,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			logger.Warn("pending_submission not found for memory bookkeeping",
				"content_hash", contentHashHex,
				"error", err)
			return nil
		}
		return fmt.Errorf("query pending_submissions: %w", err)
	}

	type classifiedKeyword struct {
		Keyword    string  `json:"keyword"`
		Weight     float64 `json:"weight"`
		BaseWeight float64 `json:"base_weight"`
	}
	type extractionPayload struct {
		Classified []classifiedKeyword `json:"classified"`
	}

	var payload extractionPayload
	if len(extractionResult) > 0 {
		if err := json.Unmarshal(extractionResult, &payload); err != nil {
			logger.Warn("failed to parse extraction_result", "error", err)
		}
	}

	keywordWeights := make(map[string]float64)
	for _, kw := range keywords {
		keywordWeights[strings.ToLower(kw)] = 1.0
	}
	for _, classified := range payload.Classified {
		keywordWeights[strings.ToLower(classified.Keyword)] = classified.Weight
	}

	var leaderVector []float32
	if len(embeddingVectorRaw) > 0 {
		if err := json.Unmarshal(embeddingVectorRaw, &leaderVector); err != nil {
			logger.Warn("failed to parse embedding_vector", "error", err)
			leaderVector = nil
		}
	}

	keywordWithWeightSlice := make([]protocol.KeywordWithWeight, 0, len(keywords))
	for _, kw := range keywords {
		weight := keywordWeights[strings.ToLower(kw)]
		keywordWithWeightSlice = append(keywordWithWeightSlice, protocol.KeywordWithWeight{
			Keyword: kw,
			Weight:  weight,
		})
	}

	entry := protocol.IndexEntry{
		CID:                    contentHashHex,
		OrgID:                  orgID,
		EpochID:                int32(epochID),
		Keywords:               keywordWithWeightSlice,
		KeywordWeights:         keywordWeights,
		LifecycleState:         "ACTIVE",
		ProducerModelId:        producerModelID,
		AttestationSessionHash: attestationSessionHash,
		MemoryType:             memoryType,
		McVersion:              mcVersion,
	}

	shouldUpsertVector := false
	if len(leaderVector) == embed.EMBED_DIM {
		entry.Vector = leaderVector
		entry.VectorDim = len(leaderVector)

		modelID := strings.TrimSpace(embeddingModelID.String)
		if modelID == "" {
			modelID = "nomic-embed-text:v1.5"
		}
		schemaVersion := strings.TrimSpace(embeddingSchemaVersion.String)
		if schemaVersion == "" {
			schemaVersion = "retrieval-card-v1"
		}
		entry.EmbeddingModelID = modelID
		entry.EmbeddingSchemaVersion = schemaVersion
		shouldUpsertVector = true
	} else if len(leaderVector) > 0 {
		logger.Warn("leader embedding vector has invalid dimension; skipping vector index — memory committed but not vector-retrievable until re-embedded",
			"cid", contentHashHex,
			"vector_dim", len(leaderVector),
			"expected_dim", embed.EMBED_DIM)
	} else {
		logger.Warn("no leader embedding vector for memory; skipping vector index — memory committed but not vector-retrievable until re-embedded",
			"cid", contentHashHex)
	}

	qdrantCommitError := ""
	if shouldUpsertVector {
		if err := retrieval.AddToIndex(ctx, w.qdrantClient, entry); err != nil {
			logger.Warn("failed to add entry to qdrant index", "error", err)
			qdrantCommitError = fmt.Sprintf("committed to chain but qdrant index failed: %v", err)
		}
	}

	for _, kw := range keywords {
		normalizedKeyword := strings.ToLower(strings.TrimSpace(kw))
		_, err := w.db.Exec(ctx, `
			INSERT INTO org_keywords (org_id, keyword)
			VALUES ($1, $2)
			ON CONFLICT (org_id, keyword) DO UPDATE SET deprecated = false
		`, orgID, normalizedKeyword)
		if err != nil {
			logger.Warn("failed to upsert org_keyword", "keyword", kw, "error", err)
		}

		_, err = w.db.Exec(ctx, `
			INSERT INTO memory_keywords (memory_cid, org_id, keyword, weight)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (memory_cid, keyword) DO UPDATE SET weight = $4
		`, contentHashHex, orgID, normalizedKeyword, keywordWeights[strings.ToLower(kw)])
		if err != nil {
			logger.Warn("failed to insert memory_keyword", "keyword", kw, "error", err)
		}
	}

	var commitError any
	if qdrantCommitError != "" {
		commitError = qdrantCommitError
	}

	_, err = w.db.Exec(ctx, `
		UPDATE pending_submissions
		SET status = $3,
		    commit_error = $5,
		    commit_attempted_at = NOW(),
		    updated_at = NOW()
		WHERE org_id = $1 AND submission_hash = $2 AND status = $4
	`, orgID, contentHashHex, protocol.SubmissionStatusCommitted, protocol.SubmissionStatusPendingChain, commitError)
	if err != nil {
		return fmt.Errorf("update pending_submissions: %w", err)
	}

	_, err = w.db.Exec(ctx, `
		UPDATE orgs
		SET last_chain_submission_at = NOW(), updated_at = NOW()
		WHERE org_id = $1
	`, orgID)
	if err != nil {
		return fmt.Errorf("update orgs: %w", err)
	}

	logger.Info("memory bookkeeping completed",
		"cid", contentHashHex,
		"epoch_id", epochID,
		"keywords_count", len(keywords),
		"memory_type", memoryType)

	return nil
}

func (w *ChainWatcher) recordSubmissionCommitError(ctx context.Context, orgID, submissionHash, commitError string) error {
	_, err := w.db.Exec(ctx, `
		UPDATE pending_submissions
		SET commit_error = $3,
		    commit_attempted_at = NOW()
		WHERE org_id = $1 AND submission_hash = $2
	`, orgID, submissionHash, commitError)
	if err != nil {
		return fmt.Errorf("update pending_submissions commit error: %w", err)
	}
	return nil
}
