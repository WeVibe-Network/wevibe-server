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

	accepted, err := chainAcceptedOutcomeFingerprints(ctx, w.chainClient, orgID, epoch)
	if err != nil {
		return err
	}

	seen := make(map[string]bool)
	fps := make([]string, 0, len(events))
	acceptedCount := 0
	skippedCount := 0
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
		if !accepted[fingerprint] {
			skippedCount++
			wlog.Op(ctx, "watcher.event_batch", slog.LevelWarn,
				slog.String("status", "rejected_at_commit"),
				slog.String("org", orgID),
				slog.Uint64("epoch", epoch),
				slog.String("fingerprint_fp", first8(fingerprint)),
				slog.String("memory_fp", first8(memoryCID)))
			continue
		}
		acceptedCount++
		cmd, err := w.db.Exec(ctx, `
			UPDATE outcome_events
			SET status='submitted', tx_hash=$1, submitted_at=COALESCE(submitted_at, NOW())
			WHERE org_id=$2 AND fingerprint=$3
		`, txHash, orgID, fingerprint)
		if err != nil {
			return fmt.Errorf("mark outcome event submitted: %w", err)
		}
		if cmd.RowsAffected() == 0 {
			wlog.Op(ctx, "watcher.event_batch", slog.LevelInfo,
				slog.String("status", "no_hub_row"),
				slog.String("org", orgID),
				slog.Uint64("epoch", epoch),
				slog.String("fingerprint_fp", first8(fingerprint)),
				slog.String("memory_fp", first8(memoryCID)))
		}
		seen[memoryCID] = true
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
		slog.Int("marked_count", acceptedCount),
		slog.Int("accepted_count", acceptedCount),
		slog.Int("skipped_count", skippedCount),
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
	return RecomputeMemoryStanding(ctx, w.chainClient, w.db, w.qdrantClient, w.standingPolicy, orgID, memoryCID)
}
