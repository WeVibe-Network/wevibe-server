package chain

import (
	"context"
	"encoding/hex"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
)

type ServeEntry struct {
	MemoryContentHash []byte
	ContributorWallet string
	ServeCount        uint64
	Nullifier         string
	ModelID           string
}

type DenialEntry struct {
	MemoryContentHash []byte
	ContributorWallet string
	DenialCount       uint64
}

func (w *ChainWatcher) processServeBatchBookkeeping(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, orgID string, epoch uint64, serves []ServeEntry) error {
	if len(serves) == 0 {
		return nil
	}

	for _, serve := range serves {
		memoryCID := hex.EncodeToString(serve.MemoryContentHash)
		_, err := w.db.Exec(ctx,
			"UPDATE serve_events SET status='submitted', tx_hash=$1, submitted_at=NOW() WHERE org_id=$2 AND memory_content_hash=$3 AND status='pending' AND event_type='serve'",
			txHash, orgID, memoryCID)
		if err != nil {
			w.logger.Error("failed to update serve_event", "err", err, "memory_cid", memoryCID)
		}
	}

	seen := make(map[string]bool)
	for _, serve := range serves {
		memoryCID := hex.EncodeToString(serve.MemoryContentHash)
		if seen[memoryCID] {
			continue
		}
		seen[memoryCID] = true

		if err := retrieval.ApplyServeBoostLocal(ctx, w.db, memoryCID, orgID); err != nil {
			w.logger.Error("failed to apply serve boost", "err", err, "memory_cid", memoryCID)
		}
	}

	for memoryCID := range seen {
		weights, err := retrieval.GetKeywordWeights(ctx, w.db, orgID, memoryCID)
		if err != nil {
			w.logger.Error("failed to get keyword weights", "err", err, "memory_cid", memoryCID)
			continue
		}
		if err := w.qdrantClient.UpdateKeywordWeights(ctx, orgID, memoryCID, weights); err != nil {
			w.logger.Error("failed to update qdrant weights", "err", err, "memory_cid", memoryCID)
		}
	}

	return nil
}

func (w *ChainWatcher) processDenialBatchBookkeeping(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, orgID string, epoch uint64, denials []DenialEntry) error {
	if len(denials) == 0 {
		return nil
	}

	for _, denial := range denials {
		memoryCID := hex.EncodeToString(denial.MemoryContentHash)
		_, err := w.db.Exec(ctx,
			"UPDATE serve_events SET status='submitted', tx_hash=$1, submitted_at=NOW() WHERE org_id=$2 AND memory_content_hash=$3 AND status='pending' AND event_type='denial'",
			txHash, orgID, memoryCID)
		if err != nil {
			w.logger.Error("failed to update denial event", "err", err, "memory_cid", memoryCID)
		}
	}

	seen := make(map[string]bool)
	for _, denial := range denials {
		memoryCID := hex.EncodeToString(denial.MemoryContentHash)
		if seen[memoryCID] {
			continue
		}
		seen[memoryCID] = true

		if err := retrieval.ApplyDenialDecayLocal(ctx, w.db, memoryCID, orgID); err != nil {
			w.logger.Error("failed to apply denial decay", "err", err, "memory_cid", memoryCID)
		}
	}

	for memoryCID := range seen {
		weights, err := retrieval.GetKeywordWeights(ctx, w.db, orgID, memoryCID)
		if err != nil {
			w.logger.Error("failed to get keyword weights", "err", err, "memory_cid", memoryCID)
			continue
		}
		if err := w.qdrantClient.UpdateKeywordWeights(ctx, orgID, memoryCID, weights); err != nil {
			w.logger.Error("failed to update qdrant weights", "err", err, "memory_cid", memoryCID)
		}
	}

	return nil
}
