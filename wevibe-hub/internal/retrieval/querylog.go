package retrieval

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

type QueryLogEntry struct {
	OrgID            string
	AgentPubkey      string
	SessionID        string
	KeywordWeights   []protocol.KeywordWithWeight
	RelevanceFloor   float64
	SurfaceBudget    int
	EmbeddingModelID string
	VectorDim        int
	LimitN           int
	CandidateCount   int
	ReturnedCount    int
	Contested        bool
}

func PersistRecallQuery(ctx context.Context, db *pgxpool.Pool, entry QueryLogEntry, scores []CandidateScore) error {
	if db == nil {
		return fmt.Errorf("database unavailable")
	}

	keywordWeights := entry.KeywordWeights
	if keywordWeights == nil {
		keywordWeights = []protocol.KeywordWithWeight{}
	}
	keywordWeightsJSON, err := json.Marshal(keywordWeights)
	if err != nil {
		return fmt.Errorf("marshal keyword weights: %w", err)
	}

	tx, err := db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin query log tx: %w", err)
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	var queryID string
	err = tx.QueryRow(ctx, `
		INSERT INTO query_log (
			org_id,
			agent_pubkey,
			session_id,
			query_text,
			keyword_weights,
			relevance_floor,
			surface_budget,
			embedding_model_id,
			vector_dim,
			limit_n,
			candidate_count,
			returned_count,
			contested
		)
		VALUES (
			$1,
			$2,
			$3,
			NULL,
			$4::jsonb,
			$5,
			$6,
			$7,
			$8,
			$9,
			$10,
			$11,
			$12
		)
		RETURNING query_id
	`,
		entry.OrgID,
		entry.AgentPubkey,
		entry.SessionID,
		string(keywordWeightsJSON),
		entry.RelevanceFloor,
		entry.SurfaceBudget,
		entry.EmbeddingModelID,
		entry.VectorDim,
		entry.LimitN,
		entry.CandidateCount,
		entry.ReturnedCount,
		entry.Contested,
	).Scan(&queryID)
	if err != nil {
		return fmt.Errorf("insert query log: %w", err)
	}

	for _, score := range scores {
		_, err := tx.Exec(ctx, `
			INSERT INTO query_candidate_scores (
				query_id,
				memory_cid,
				keyword_score,
				vector_score,
				gamma,
				delta,
				capped_boost,
				combined_score,
				matched_keywords,
				rank_position,
				disposition
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		`,
			queryID,
			score.CID,
			score.KeywordScore,
			score.VectorScore,
			score.Gamma,
			score.Delta,
			score.CappedBoost,
			score.CombinedScore,
			score.MatchedKeywords,
			score.RankPosition,
			score.Disposition,
		)
		if err != nil {
			return fmt.Errorf("insert query candidate score %q: %w", score.CID, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit query log tx: %w", err)
	}

	return nil
}
