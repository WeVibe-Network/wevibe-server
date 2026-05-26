package chain

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
)

func (w *ChainWatcher) processApproveMemoryBookkeeping(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, orgID string, contentHash []byte, keywords []string, contributorID string, contributorWallet string, memoryType string, encryptedBlob []byte, wrappedDekEnc []byte) error {
	logger := w.logger.With("org_id", orgID, "tx_hash", txHash)

	contentHashHex := hex.EncodeToString(contentHash)

	var epochID int64
	var extractionResult json.RawMessage

	err := w.db.QueryRow(ctx, `
		SELECT epoch_id, extraction_result
		FROM pending_submissions
		WHERE org_id = $1 AND submission_hash = $2 AND status = $3
	`, orgID, contentHashHex, protocol.SubmissionStatusPendingChain).Scan(&epochID, &extractionResult)
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
		Keyword string  `json:"keyword"`
		Weight  float64 `json:"weight"`
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

	var vector []float32
	if len(keywords) > 0 {
		vec, err := w.computeEmbedding(ctx, keywords)
		if err != nil {
			logger.Warn("failed to compute embedding", "error", err)
		} else {
			vector = vec
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
		CID:                  contentHashHex,
		OrgID:                orgID,
		EpochID:              int32(epochID),
		Keywords:             keywordWithWeightSlice,
		KeywordWeights:       keywordWeights,
		Vector:               vector,
		LifecycleState:       "ACTIVE",
		MemoryType:           memoryType,
		EmbeddingSchemaVersion: "1.0",
	}

	if len(vector) > 0 {
		entry.VectorDim = len(vector)
	}

	if err := retrieval.AddToIndex(ctx, w.qdrantClient, entry); err != nil {
		logger.Warn("failed to add entry to qdrant index", "error", err)
	}

	for _, kw := range keywords {
		_, err := w.db.Exec(ctx, `
			INSERT INTO memory_keywords (memory_cid, org_id, keyword, weight)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (memory_cid, keyword) DO UPDATE SET weight = $4
		`, contentHashHex, orgID, strings.ToLower(kw), keywordWeights[strings.ToLower(kw)])
		if err != nil {
			logger.Warn("failed to insert memory_keyword", "keyword", kw, "error", err)
		}
	}

	_, err = w.db.Exec(ctx, `
		UPDATE pending_submissions
		SET status = $3, updated_at = NOW()
		WHERE org_id = $1 AND submission_hash = $2 AND status = $3
	`, orgID, contentHashHex, protocol.SubmissionStatusCommitted)
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

	_, err = w.db.Exec(ctx, `
		DELETE FROM approval_votes WHERE org_id = $1 AND submission_hash = $2
	`, orgID, contentHashHex)
	if err != nil {
		logger.Warn("failed to delete approval_votes", "error", err)
	}

	logger.Info("memory bookkeeping completed",
		"cid", contentHashHex,
		"epoch_id", epochID,
		"keywords_count", len(keywords),
		"memory_type", memoryType)

	return nil
}