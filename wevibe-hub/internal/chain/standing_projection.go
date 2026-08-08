package chain

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/standing"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
)

type standingReplayEvent struct {
	OrgID       string
	MemoryCID   string
	Epoch       uint64
	Kind        standing.Kind
	Ref         string
	Seq         string
	Fingerprint string
	ChainGated  bool
}

type standingReplayStats struct {
	Serves          int
	Outcomes        int
	DroppedOutcomes int
}

func SyncStandingFromEvents(ctx context.Context, chainClient *GrpcClient, qdrantClient *retrieval.QdrantClient, pool *pgxpool.Pool, pol *standing.Policy) error {
	if pool == nil {
		return fmt.Errorf("database pool unavailable")
	}
	if qdrantClient == nil {
		return fmt.Errorf("qdrant client unavailable")
	}
	if pol == nil {
		return fmt.Errorf("standing policy unavailable")
	}
	if wlog.TraceFromContext(ctx) == "" {
		ctx = wlog.WithTrace(ctx, uuid.NewString())
	}

	start := time.Now()
	wlog.Op(ctx, "chain.standing_rebuild", slog.LevelInfo,
		slog.String("status", "start"),
		slog.String("policy_version", pol.Version))

	events, stats, err := loadStandingReplayEvents(ctx, chainClient, pool, "", "")
	if err != nil {
		wlog.Op(ctx, "chain.standing_rebuild", slog.LevelError,
			slog.String("status", "err"),
			slog.String("err", err.Error()),
			slog.Int64("dur_ms", time.Since(start).Milliseconds()))
		return err
	}

	grouped := groupStandingEvents(events)
	standingKeys, err := loadExistingStandingKeys(ctx, pool)
	if err != nil {
		return err
	}
	for _, key := range standingKeys {
		if _, ok := grouped[key]; !ok {
			grouped[key] = nil
		}
	}
	updated := 0
	var voidServes uint64
	for key := range grouped {
		memoryVoidServes, err := recomputeMemoryStandingFromGrouped(ctx, pool, qdrantClient, pol, key.orgID, key.memoryCID, grouped[key])
		if err != nil {
			wlog.Op(ctx, "chain.standing_rebuild", slog.LevelError,
				slog.String("status", "err"),
				slog.String("org", key.orgID),
				slog.String("memory_fp", first8(key.memoryCID)),
				slog.String("err", err.Error()),
				slog.Int64("dur_ms", time.Since(start).Milliseconds()))
			return err
		}
		voidServes += memoryVoidServes
		updated++
	}

	wlog.Op(ctx, "chain.standing_rebuild", slog.LevelInfo,
		slog.String("status", "ok"),
		slog.Int("memory_count", updated),
		slog.Int("event_count", len(events)),
		slog.Int("serve_count", stats.Serves),
		slog.Int("outcome_count", stats.Outcomes),
		slog.Int("dropped_outcome_count", stats.DroppedOutcomes),
		slog.Uint64("void_serves", voidServes),
		slog.String("policy_version", pol.Version),
		slog.Int64("dur_ms", time.Since(start).Milliseconds()))
	return nil
}

func RecomputeMemoryStanding(ctx context.Context, chainClient *GrpcClient, pool *pgxpool.Pool, qdrantClient *retrieval.QdrantClient, pol *standing.Policy, orgID, memoryCID string) error {
	if pool == nil {
		return fmt.Errorf("database pool unavailable")
	}
	if qdrantClient == nil {
		return fmt.Errorf("qdrant client unavailable")
	}
	if pol == nil {
		return fmt.Errorf("standing policy unavailable")
	}
	if wlog.TraceFromContext(ctx) == "" {
		ctx = wlog.WithTrace(ctx, uuid.NewString())
	}

	start := time.Now()
	events, stats, err := loadStandingReplayEvents(ctx, chainClient, pool, orgID, memoryCID)
	if err != nil {
		return err
	}
	voidServes, err := recomputeMemoryStandingFromGrouped(ctx, pool, qdrantClient, pol, orgID, memoryCID, events)
	if err != nil {
		wlog.Op(ctx, "chain.standing_rebuild", slog.LevelError,
			slog.String("status", "err"),
			slog.String("org", orgID),
			slog.String("memory_fp", first8(memoryCID)),
			slog.String("err", err.Error()),
			slog.Int64("dur_ms", time.Since(start).Milliseconds()))
		return err
	}
	wlog.Op(ctx, "chain.standing_rebuild", slog.LevelInfo,
		slog.String("status", "ok"),
		slog.String("org", orgID),
		slog.String("memory_fp", first8(memoryCID)),
		slog.Int("event_count", len(events)),
		slog.Int("serve_count", stats.Serves),
		slog.Int("outcome_count", stats.Outcomes),
		slog.Int("dropped_outcome_count", stats.DroppedOutcomes),
		slog.Uint64("void_serves", voidServes),
		slog.String("policy_version", pol.Version),
		slog.Int64("dur_ms", time.Since(start).Milliseconds()))
	return nil
}

type standingKey struct {
	orgID     string
	memoryCID string
}

func groupStandingEvents(events []standingReplayEvent) map[standingKey][]standingReplayEvent {
	grouped := make(map[standingKey][]standingReplayEvent)
	for _, event := range events {
		key := standingKey{orgID: event.OrgID, memoryCID: event.MemoryCID}
		grouped[key] = append(grouped[key], event)
	}
	return grouped
}

func loadStandingReplayEvents(ctx context.Context, chainClient *GrpcClient, pool *pgxpool.Pool, orgID, memoryCID string) ([]standingReplayEvent, standingReplayStats, error) {
	rows, err := pool.Query(ctx, `
				SELECT org_id, memory_content_hash, epoch_id, kind, ref, fingerprint, chain_gated
				FROM (
					SELECT org_id, memory_content_hash, epoch_id,
					       CASE WHEN event_type = 'serve' THEN 'serve' ELSE 'block' END AS kind,
					       serve_fingerprint AS ref,
					       serve_fingerprint AS fingerprint,
					       FALSE AS chain_gated
					FROM serve_events
					WHERE status = 'submitted'
					UNION ALL
					SELECT org_id, memory_content_hash, epoch_id,
					       CASE resolution WHEN 'worked' THEN 'outcome_worked' WHEN 'didnt_work' THEN 'outcome_failed' ELSE 'outcome_unobserved' END AS kind,
					       serve_ref AS ref,
					       fingerprint,
					       TRUE AS chain_gated
					FROM outcome_events
					WHERE status = 'submitted'
			) events
			WHERE ($1 = '' OR org_id = $1) AND ($2 = '' OR memory_content_hash = $2)
			ORDER BY org_id, memory_content_hash, epoch_id, fingerprint
		`, orgID, memoryCID)
	if err != nil {
		return nil, standingReplayStats{}, fmt.Errorf("load standing replay events: %w", err)
	}
	defer rows.Close()

	events := make([]standingReplayEvent, 0)
	for rows.Next() {
		var event standingReplayEvent
		var kind string
		var epoch int64
		if err := rows.Scan(&event.OrgID, &event.MemoryCID, &epoch, &kind, &event.Ref, &event.Fingerprint, &event.ChainGated); err != nil {
			return nil, standingReplayStats{}, fmt.Errorf("scan standing replay event: %w", err)
		}
		if epoch < 0 {
			return nil, standingReplayStats{}, fmt.Errorf("negative epoch for org=%s memory=%s", event.OrgID, event.MemoryCID)
		}
		event.Epoch = uint64(epoch)
		event.Seq = event.Fingerprint
		switch kind {
		case "serve":
			event.Kind = standing.Serve
		case "block":
			event.Kind = standing.Block
		case "outcome_unobserved":
			event.Kind = standing.OutcomeUnobserved
		case "outcome_worked":
			event.Kind = standing.OutcomeWorked
		case "outcome_failed":
			event.Kind = standing.OutcomeFailed
		default:
			return nil, standingReplayStats{}, fmt.Errorf("unknown standing event kind %q", kind)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, standingReplayStats{}, fmt.Errorf("iterate standing replay events: %w", err)
	}
	stats := countStandingReplayEvents(events)
	filtered, err := filterOutcomeReplayEventsFromChain(ctx, chainClient, events)
	if err != nil {
		return nil, standingReplayStats{}, err
	}
	stats.DroppedOutcomes = len(events) - len(filtered)
	return filtered, stats, nil
}

func countStandingReplayEvents(events []standingReplayEvent) standingReplayStats {
	var stats standingReplayStats
	for _, event := range events {
		switch event.Kind {
		case standing.Serve:
			stats.Serves++
		case standing.OutcomeWorked, standing.OutcomeFailed:
			stats.Outcomes++
		}
	}
	return stats
}

func filterOutcomeReplayEventsFromChain(ctx context.Context, chainClient *GrpcClient, events []standingReplayEvent) ([]standingReplayEvent, error) {
	acceptedByOrgEpoch := make(map[string]map[uint64]map[string]bool)
	for _, event := range events {
		if !event.ChainGated {
			continue
		}
		if acceptedByOrgEpoch[event.OrgID] == nil {
			acceptedByOrgEpoch[event.OrgID] = make(map[uint64]map[string]bool)
		}
		acceptedByOrgEpoch[event.OrgID][event.Epoch] = nil
	}
	for org, byEpoch := range acceptedByOrgEpoch {
		for epoch := range byEpoch {
			accepted, err := chainAcceptedOutcomeFingerprints(ctx, chainClient, org, epoch)
			if err != nil {
				return nil, err
			}
			byEpoch[epoch] = accepted
		}
	}
	logDroppedOutcomeReplayEvents(ctx, events, acceptedByOrgEpoch)
	return filterOutcomeReplayEvents(events, acceptedByOrgEpoch), nil
}

func filterOutcomeReplayEvents(events []standingReplayEvent, acceptedByOrgEpoch map[string]map[uint64]map[string]bool) []standingReplayEvent {
	filtered := make([]standingReplayEvent, 0, len(events))
	for _, event := range events {
		if !event.ChainGated {
			filtered = append(filtered, event)
			continue
		}
		accepted := acceptedByOrgEpoch[event.OrgID][event.Epoch]
		if accepted[event.Fingerprint] {
			filtered = append(filtered, event)
			continue
		}
	}
	return filtered
}

func logDroppedOutcomeReplayEvents(ctx context.Context, events []standingReplayEvent, acceptedByOrgEpoch map[string]map[uint64]map[string]bool) {
	droppedByOrgEpoch := make(map[string]map[uint64][]string)
	for _, event := range events {
		if !event.ChainGated {
			continue
		}
		accepted := acceptedByOrgEpoch[event.OrgID][event.Epoch]
		if accepted[event.Fingerprint] {
			continue
		}
		if droppedByOrgEpoch[event.OrgID] == nil {
			droppedByOrgEpoch[event.OrgID] = make(map[uint64][]string)
		}
		droppedByOrgEpoch[event.OrgID][event.Epoch] = append(droppedByOrgEpoch[event.OrgID][event.Epoch], first8(event.Fingerprint))
	}
	for org, byEpoch := range droppedByOrgEpoch {
		for epoch, dropped := range byEpoch {
			wlog.Op(ctx, "chain.standing_replay", slog.LevelWarn,
				slog.String("org", org),
				slog.Uint64("epoch", epoch),
				slog.Int("dropped", len(dropped)),
				slog.Any("fingerprint_fps", dropped))
		}
	}
}

func loadExistingStandingKeys(ctx context.Context, pool *pgxpool.Pool) ([]standingKey, error) {
	rows, err := pool.Query(ctx, `SELECT memory_cid, org_id FROM memory_standing`)
	if err != nil {
		return nil, fmt.Errorf("load existing standing keys: %w", err)
	}
	defer rows.Close()

	keys := make([]standingKey, 0)
	for rows.Next() {
		var key standingKey
		if err := rows.Scan(&key.memoryCID, &key.orgID); err != nil {
			return nil, fmt.Errorf("scan existing standing key: %w", err)
		}
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate existing standing keys: %w", err)
	}
	return keys, nil
}

func recomputeMemoryStandingFromGrouped(ctx context.Context, pool *pgxpool.Pool, qdrantClient *retrieval.QdrantClient, pol *standing.Policy, orgID, memoryCID string, replay []standingReplayEvent) (uint64, error) {
	ordered := make([]standing.Event, 0, len(replay))
	for _, event := range replay {
		ordered = append(ordered, standing.Event{Epoch: event.Epoch, Kind: event.Kind, Ref: event.Ref, Seq: event.Seq})
	}

	createdEpoch := uint64(0)
	currentEpoch := uint64(0)
	if len(ordered) > 0 {
		createdEpoch = ordered[0].Epoch
		currentEpoch = ordered[0].Epoch
		for _, event := range ordered[1:] {
			if event.Epoch < createdEpoch {
				createdEpoch = event.Epoch
			}
			if event.Epoch > currentEpoch {
				currentEpoch = event.Epoch
			}
		}
	}
	// Recall-pivot projection is rebuildable from hub event rows. If the original
	// commitment epoch is not cheaply present here, the earliest known event epoch
	// anchors createdEpoch; this is accepted by the chunk directive.
	result := standing.Compute(ordered, createdEpoch, currentEpoch, *pol)

	_, err := pool.Exec(ctx, `
		INSERT INTO memory_standing (memory_cid, org_id, standing_bps, serve_count, denial_count, denial_rate, trusted, archived, policy_version, computed_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
		ON CONFLICT (memory_cid, org_id) DO UPDATE SET
			standing_bps = EXCLUDED.standing_bps,
			serve_count = EXCLUDED.serve_count,
			denial_count = EXCLUDED.denial_count,
			denial_rate = EXCLUDED.denial_rate,
			trusted = EXCLUDED.trusted,
			archived = EXCLUDED.archived,
			policy_version = EXCLUDED.policy_version,
			computed_at = NOW()
	`, memoryCID, orgID, result.StandingBps, result.ServeCount, result.DenialCount, result.DenialRate, result.Trusted, result.Archived, pol.Version)
	if err != nil {
		return 0, fmt.Errorf("upsert memory standing: %w", err)
	}

	if err := qdrantClient.UpdateStanding(ctx, orgID, memoryCID, result.StandingBps, result.Archived); err != nil {
		return 0, fmt.Errorf("update qdrant standing: %w", err)
	}
	return result.VoidServes, nil
}

func first8(value string) string {
	if len(value) <= 8 {
		return value
	}
	return value[:8]
}
