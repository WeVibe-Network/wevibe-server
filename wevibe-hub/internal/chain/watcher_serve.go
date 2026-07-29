package chain

import (
	"context"
	"encoding/hex"
	"fmt"
	"log/slog"
	"time"

	servetypes "github.com/wevibe-network/wevibe-chain/x/serve/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
)

type ServeEntry struct {
	MemoryContentHash []byte
	ContributorWallet string
	ServeCount        uint64
	Fingerprint       string
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
	}

	for memoryCID := range seen {
		if err := w.recomputeStandingForMemory(ctx, orgID, memoryCID); err != nil {
			w.logger.Error("failed to recompute serve standing", "err", err, "memory_cid", memoryCID)
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
	}

	for memoryCID := range seen {
		if err := w.recomputeStandingForMemory(ctx, orgID, memoryCID); err != nil {
			w.logger.Error("failed to recompute denial standing", "err", err, "memory_cid", memoryCID)
		}
	}

	return nil
}

func (w *ChainWatcher) processEventBatchBookkeeping(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, orgID string, epoch uint64, events []*servetypes.EventEntry) error {
	start := time.Now()
	if len(events) == 0 {
		return nil
	}

	ids := make([]int64, 0, len(events))
	seen := make(map[string]bool)
	fps := make([]string, 0, len(events))
	for _, event := range events {
		if event == nil {
			continue
		}
		memoryCID := hex.EncodeToString(event.MemoryContentHash)
		canonical, err := servetypes.CanonicalEventBody(event.EventType, orgID, event.MemoryContentHash, epoch, event.SignerPubkey, event.Nonce, event)
		if err != nil {
			return fmt.Errorf("canonical event body: %w", err)
		}
		fingerprint := hex.EncodeToString(servetypes.ComputeEventFingerprint(canonical))
		fps = append(fps, first8(fingerprint))
		var id int64
		if err := w.db.QueryRow(ctx, `
			SELECT id FROM outcome_events
			WHERE org_id=$1 AND fingerprint=$2 AND status='pending'
		`, orgID, fingerprint).Scan(&id); err != nil {
			w.logger.Error("failed to locate outcome event", "err", err, "fingerprint_fp", first8(fingerprint), "memory_cid", memoryCID)
			continue
		}
		ids = append(ids, id)
		seen[memoryCID] = true
	}

	if len(ids) > 0 {
		_, err := w.db.Exec(ctx, `
			UPDATE outcome_events
			SET status='submitted', tx_hash=$1, submitted_at=NOW()
			WHERE id = ANY($2)
		`, txHash, ids)
		if err != nil {
			return fmt.Errorf("mark outcome events submitted: %w", err)
		}
	}

	for memoryCID := range seen {
		if err := w.recomputeStandingForMemory(ctx, orgID, memoryCID); err != nil {
			w.logger.Error("failed to recompute outcome standing", "err", err, "memory_cid", memoryCID)
		}
	}

	wlog.Op(ctx, "watcher.event_batch", slog.LevelInfo,
		slog.String("status", "ok"),
		slog.String("org", orgID),
		slog.Uint64("epoch", epoch),
		slog.Int("event_count", len(events)),
		slog.Int("marked_count", len(ids)),
		slog.Any("fingerprint_fps", fps),
		slog.Int64("dur_ms", time.Since(start).Milliseconds()))
	return nil
}

func (w *ChainWatcher) recomputeStandingForMemory(ctx context.Context, orgID, memoryCID string) error {
	if w.standingPolicy == nil {
		wlog.Op(ctx, "chain.standing_rebuild", slog.LevelError,
			slog.String("status", "err"),
			slog.String("org", orgID),
			slog.String("memory_fp", first8(memoryCID)),
			slog.String("err", "standing policy not configured"))
		return fmt.Errorf("standing policy not configured")
	}
	return RecomputeMemoryStanding(ctx, w.db, w.qdrantClient, w.standingPolicy, orgID, memoryCID)
}
