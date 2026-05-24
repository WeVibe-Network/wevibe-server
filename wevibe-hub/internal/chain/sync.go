package chain

import (
	"context"
	"encoding/hex"
	"fmt"
	"log"
	"strconv"
	"strings"

	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
	"github.com/jackc/pgx/v5/pgxpool"
)

const epochSyncBatchSize = 128

// SyncEpochData polls the chain for confidence/state changes and updates Qdrant.
// Called once per epoch (or on a configurable interval).
func SyncEpochData(ctx context.Context, chainClient *GrpcClient, qdrantClient *retrieval.QdrantClient, pool *pgxpool.Pool) error {
	if chainClient == nil {
		return fmt.Errorf("chain client unavailable")
	}
	if qdrantClient == nil {
		return fmt.Errorf("qdrant client unavailable")
	}
	if pool == nil {
		return fmt.Errorf("database pool unavailable")
	}

	orgIDs, err := loadApprovedOrgIDs(ctx, pool)
	if err != nil {
		return fmt.Errorf("load approved org ids: %w", err)
	}

	totalMemories := 0
	updatedCount := 0

	for _, orgID := range orgIDs {
		if err := ctx.Err(); err != nil {
			return err
		}

		qdrantMemories, err := retrieval.ScrollOrgMemoryPayloads(ctx, qdrantClient, orgID)
		if err != nil {
			return fmt.Errorf("scroll qdrant memories for org %s: %w", orgID, err)
		}
		if len(qdrantMemories) == 0 {
			continue
		}

		totalMemories += len(qdrantMemories)

		qdrantByCID := make(map[string]retrieval.OrgMemoryPayload, len(qdrantMemories))
		cidBatch := make([]string, 0, len(qdrantMemories))
		for _, memory := range qdrantMemories {
			qdrantByCID[memory.CID] = memory
			cidBatch = append(cidBatch, memory.CID)
		}

		for start := 0; start < len(cidBatch); start += epochSyncBatchSize {
			end := start + epochSyncBatchSize
			if end > len(cidBatch) {
				end = len(cidBatch)
			}

			batchCIDs := cidBatch[start:end]
			contentHashes := make([][]byte, 0, len(batchCIDs))
			for _, cid := range batchCIDs {
				contentHash, err := hex.DecodeString(cid)
				if err != nil {
					log.Printf("WARNING: epoch sync skipping malformed cid=%s org=%s: %v", cid, orgID, err)
					continue
				}
				contentHashes = append(contentHashes, contentHash)
			}

			if len(contentHashes) == 0 {
				continue
			}

			chainMemories, notFound, err := chainClient.GetMemoriesBatch(ctx, orgID, contentHashes)
			if err != nil {
				return fmt.Errorf("chain batch query for org %s: %w", orgID, err)
			}
			if len(notFound) > 0 {
				log.Printf("WARNING: epoch sync found %d qdrant memories missing on chain (org=%s)", len(notFound), orgID)
			}

			for _, chainMemory := range chainMemories {
				cid := hex.EncodeToString(chainMemory.ContentHash)
				qdrantMemory, ok := qdrantByCID[cid]
				if !ok {
					continue
				}

				chainLifecycle := normalizeLifecycleState(chainMemory.State)
				qdrantLifecycle := strings.ToUpper(strings.TrimSpace(qdrantMemory.LifecycleState))
				if qdrantLifecycle == chainLifecycle {
					continue
				}

				if err := retrieval.UpdateMemoryState(ctx, qdrantClient, orgID, cid, chainLifecycle); err != nil {
					return fmt.Errorf("update qdrant state for org=%s cid=%s: %w", orgID, cid, err)
				}
				updatedCount++
			}
		}
	}

	log.Printf("Synced %d memories across %d orgs, updated %d confidence/state values", totalMemories, len(orgIDs), updatedCount)
	return nil
}

func loadApprovedOrgIDs(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT org_id
		FROM pending_submissions
		WHERE status = 'approved'
		ORDER BY org_id
	`)
	if err != nil {
		return nil, fmt.Errorf("query approved org ids: %w", err)
	}
	defer rows.Close()

	orgIDs := make([]string, 0)
	for rows.Next() {
		var orgID string
		if err := rows.Scan(&orgID); err != nil {
			return nil, fmt.Errorf("scan approved org id: %w", err)
		}
		orgIDs = append(orgIDs, orgID)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate approved org ids: %w", err)
	}

	return orgIDs, nil
}

func normalizeLifecycleState(state int32) string {
	normalized := memorytypes.MemoryState(state).String()
	normalized = strings.TrimPrefix(normalized, "MEMORY_STATE_")
	normalized = strings.ToUpper(strings.TrimSpace(normalized))
	if normalized == "" {
		return "UNSPECIFIED"
	}
	return normalized
}

// SyncKeywordWeightsFromChain reconciles Qdrant keyword weights with chain
// state. Called once at hub startup (after SyncEpochData). For each approved
// org, queries the chain for all committed memories currently in Qdrant and
// pushes their KeywordWeight slice into Qdrant's keyword_weights payload.
//
// Limitations: this is a full scan per startup. For solo dogfood scale
// (<100 memories) this completes in seconds. Production scale will require
// incremental sync — deferred to post-alpha.
func SyncKeywordWeightsFromChain(ctx context.Context, chainClient *GrpcClient, qdrantClient *retrieval.QdrantClient, pool *pgxpool.Pool) error {
	if chainClient == nil {
		return fmt.Errorf("chain client unavailable")
	}
	if qdrantClient == nil {
		return fmt.Errorf("qdrant client unavailable")
	}
	if pool == nil {
		return fmt.Errorf("database pool unavailable")
	}

	orgIDs, err := loadApprovedOrgIDs(ctx, pool)
	if err != nil {
		return fmt.Errorf("load approved org ids: %w", err)
	}

	totalSynced := 0
	totalSkipped := 0

	for _, orgID := range orgIDs {
		if err := ctx.Err(); err != nil {
			return err
		}

		qdrantMemories, err := retrieval.ScrollOrgMemoryPayloads(ctx, qdrantClient, orgID)
		if err != nil {
			return fmt.Errorf("scroll qdrant memories for org %s: %w", orgID, err)
		}
		if len(qdrantMemories) == 0 {
			continue
		}

		cidBatch := make([]string, 0, len(qdrantMemories))
		for _, m := range qdrantMemories {
			cidBatch = append(cidBatch, m.CID)
		}

		for start := 0; start < len(cidBatch); start += epochSyncBatchSize {
			end := start + epochSyncBatchSize
			if end > len(cidBatch) {
				end = len(cidBatch)
			}

			batchCIDs := cidBatch[start:end]
			contentHashes := make([][]byte, 0, len(batchCIDs))
			for _, cid := range batchCIDs {
				contentHash, err := hex.DecodeString(cid)
				if err != nil {
					log.Printf("WARNING: keyword weight sync skipping malformed cid=%s org=%s: %v", cid, orgID, err)
					totalSkipped++
					continue
				}
				contentHashes = append(contentHashes, contentHash)
			}
			if len(contentHashes) == 0 {
				continue
			}

			chainMemories, notFound, err := chainClient.GetMemoriesBatch(ctx, orgID, contentHashes)
			if err != nil {
				return fmt.Errorf("chain batch query for org %s: %w", orgID, err)
			}
			if len(notFound) > 0 {
				log.Printf("WARNING: keyword weight sync found %d qdrant memories missing on chain (org=%s)", len(notFound), orgID)
			}

			for _, chainMemory := range chainMemories {
				cid := hex.EncodeToString(chainMemory.ContentHash)
				if len(chainMemory.Keywords) == 0 {
					continue
				}

				weights := make(map[string]float64, len(chainMemory.Keywords))
				for _, kw := range chainMemory.Keywords {
					keyword := strings.ToLower(strings.TrimSpace(kw.Keyword))
					if keyword == "" {
						continue
					}
					weight, parseErr := strconv.ParseFloat(strings.TrimSpace(kw.Weight), 64)
					if parseErr != nil {
						log.Printf("WARNING: keyword weight sync failed to parse weight %q for org=%s cid=%s keyword=%s: %v", kw.Weight, orgID, cid, keyword, parseErr)
						continue
					}
					weights[keyword] = weight
				}
				if len(weights) == 0 {
					continue
				}

				if err := qdrantClient.UpdateKeywordWeights(ctx, orgID, cid, weights); err != nil {
					log.Printf("WARNING: keyword weight sync UpdateKeywordWeights failed for org=%s cid=%s: %v", orgID, cid, err)
					totalSkipped++
					continue
				}
				totalSynced++
			}
		}
	}

	log.Printf("SyncKeywordWeightsFromChain: synced=%d skipped=%d across %d orgs", totalSynced, totalSkipped, len(orgIDs))
	return nil
}
