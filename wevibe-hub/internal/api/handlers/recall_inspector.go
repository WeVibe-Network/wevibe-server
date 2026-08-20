package handlers

import (
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

const (
	defaultRecallInspectorLimit = 50
	maxRecallInspectorLimit     = 200
)

type recallQueryListItem struct {
	QueryID          string  `json:"query_id"`
	SessionID        string  `json:"session_id"`
	RelevanceFloor   float64 `json:"relevance_floor"`
	SurfaceBudget    int     `json:"surface_budget"`
	EmbeddingModelID string  `json:"embedding_model_id"`
	VectorDim        int     `json:"vector_dim"`
	LimitN           int     `json:"limit_n"`
	CandidateCount   int     `json:"candidate_count"`
	ReturnedCount    int     `json:"returned_count"`
	Contested        bool    `json:"contested"`
	CreatedAt        string  `json:"created_at"`
}

type listRecallQueriesResponse struct {
	Queries []recallQueryListItem `json:"queries"`
}

type recallQueryDetail struct {
	QueryID          string  `json:"query_id"`
	OrgID            string  `json:"org_id"`
	AgentPubkey      string  `json:"agent_pubkey"`
	SessionID        string  `json:"session_id"`
	QueryText        *string `json:"query_text"`
	RelevanceFloor   float64 `json:"relevance_floor"`
	SurfaceBudget    int     `json:"surface_budget"`
	EmbeddingModelID string  `json:"embedding_model_id"`
	VectorDim        int     `json:"vector_dim"`
	LimitN           int     `json:"limit_n"`
	CandidateCount   int     `json:"candidate_count"`
	ReturnedCount    int     `json:"returned_count"`
	Contested        bool    `json:"contested"`
	CreatedAt        string  `json:"created_at"`
}

type recallQueryCandidate struct {
	MemoryCID       string   `json:"memory_cid"`
	KeywordOverlap  float64  `json:"keyword_overlap"`
	VectorScore     float64  `json:"vector_score"`
	Gamma           float64  `json:"gamma"`
	Delta           float64  `json:"delta"`
	CappedBoost     float64  `json:"capped_boost"`
	CombinedScore   float64  `json:"combined_score"`
	MatchedKeywords []string `json:"matched_keywords"`
	RankPosition    int      `json:"rank_position"`
	Disposition     string   `json:"disposition"`
}

type getRecallQueryDetailResponse struct {
	Query      recallQueryDetail      `json:"query"`
	Candidates []recallQueryCandidate `json:"candidates"`
}

type recallHealthDisposition struct {
	Returned            int `json:"returned"`
	BelowFloor          int `json:"below_floor"`
	OverBudgetUnsampled int `json:"over_budget_unsampled"`
}

type recallHealthScoreSeparation struct {
	AvgReturnedScore   *float64 `json:"avg_returned_score"`
	AvgBelowFloorScore *float64 `json:"avg_below_floor_score"`
	Gap                *float64 `json:"gap"`
}

type recallHealthFeedback struct {
	ServeCount       int      `json:"serve_count"`
	DenialCount      int      `json:"denial_count"`
	ServeDenialRatio *float64 `json:"serve_denial_ratio"`
}

type recallHealthResponse struct {
	WindowHours         *int                        `json:"window_hours"`
	QueryCount          int                         `json:"query_count"`
	AvgReturned         float64                     `json:"avg_returned"`
	AvgCandidates       float64                     `json:"avg_candidates"`
	ZeroInjectionPct    float64                     `json:"zero_injection_pct"`
	ContestedPct        float64                     `json:"contested_pct"`
	Disposition         recallHealthDisposition     `json:"disposition"`
	ScoreSeparation     recallHealthScoreSeparation `json:"score_separation"`
	Feedback            recallHealthFeedback        `json:"feedback"`
	PendingServeBacklog int                         `json:"pending_serve_backlog"`
}

func ListRecallQueries(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "org_id required")
		return
	}

	if !requireLeaderAuthorization(w, r, orgID) {
		return
	}

	limit, err := parseRecallInspectorLimit(r)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	offset, err := parseRecallInspectorOffset(r)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	rows, err := pool.Query(r.Context(), `
		SELECT
			query_id,
			session_id,
			relevance_floor,
			surface_budget,
			embedding_model_id,
			vector_dim,
			limit_n,
			candidate_count,
			returned_count,
			contested,
			created_at
		FROM query_log
		WHERE org_id = $1
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3
	`, orgID, limit, offset)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}
	defer rows.Close()

	queries := make([]recallQueryListItem, 0)
	for rows.Next() {
		var query recallQueryListItem
		var createdAt time.Time

		if err := rows.Scan(
			&query.QueryID,
			&query.SessionID,
			&query.RelevanceFloor,
			&query.SurfaceBudget,
			&query.EmbeddingModelID,
			&query.VectorDim,
			&query.LimitN,
			&query.CandidateCount,
			&query.ReturnedCount,
			&query.Contested,
			&createdAt,
		); err != nil {
			WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
			return
		}

		query.CreatedAt = createdAt.Format(time.RFC3339)
		queries = append(queries, query)
	}

	if err := rows.Err(); err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}

	writeJSON(w, http.StatusOK, listRecallQueriesResponse{Queries: queries})
}

func GetRecallQueryDetail(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	queryID := chi.URLParam(r, "queryID")
	if orgID == "" || queryID == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "org_id and query_id required")
		return
	}

	if !requireLeaderAuthorization(w, r, orgID) {
		return
	}

	var query recallQueryDetail
	var createdAt time.Time

	err := pool.QueryRow(r.Context(), `
		SELECT
			query_id,
			org_id,
			agent_pubkey,
			session_id,
			query_text,
			relevance_floor,
			surface_budget,
			embedding_model_id,
			vector_dim,
			limit_n,
			candidate_count,
			returned_count,
			contested,
			created_at
		FROM query_log
		WHERE query_id = $1 AND org_id = $2
	`, queryID, orgID).Scan(
		&query.QueryID,
		&query.OrgID,
		&query.AgentPubkey,
		&query.SessionID,
		&query.QueryText,
		&query.RelevanceFloor,
		&query.SurfaceBudget,
		&query.EmbeddingModelID,
		&query.VectorDim,
		&query.LimitN,
		&query.CandidateCount,
		&query.ReturnedCount,
		&query.Contested,
		&createdAt,
	)
	if err == pgx.ErrNoRows {
		WriteError(w, http.StatusNotFound, "query_not_found", "query not found")
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}

	query.CreatedAt = createdAt.Format(time.RFC3339)

	rows, err := pool.Query(r.Context(), `
		SELECT
			memory_cid,
			keyword_overlap,
			vector_score,
			gamma,
			delta,
			capped_boost,
			combined_score,
			matched_keywords,
			rank_position,
			disposition
		FROM query_candidate_scores
		WHERE query_id = $1
		ORDER BY (disposition = 'returned') DESC, rank_position ASC NULLS LAST, combined_score DESC
	`, queryID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}
	defer rows.Close()

	candidates := make([]recallQueryCandidate, 0)
	for rows.Next() {
		var candidate recallQueryCandidate
		if err := rows.Scan(
			&candidate.MemoryCID,
			&candidate.KeywordOverlap,
			&candidate.VectorScore,
			&candidate.Gamma,
			&candidate.Delta,
			&candidate.CappedBoost,
			&candidate.CombinedScore,
			&candidate.MatchedKeywords,
			&candidate.RankPosition,
			&candidate.Disposition,
		); err != nil {
			WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
			return
		}
		candidates = append(candidates, candidate)
	}

	if err := rows.Err(); err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}

	writeJSON(w, http.StatusOK, getRecallQueryDetailResponse{
		Query:      query,
		Candidates: candidates,
	})
}

func GetRecallHealth(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "org_id required")
		return
	}

	if !requireLeaderAuthorization(w, r, orgID) {
		return
	}

	hours, windowHours, err := parseRecallInspectorHours(r)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	var (
		queryCount       int64
		avgReturned      float64
		avgCandidates    float64
		zeroInjectionPct float64
		contestedPct     float64
	)

	err = pool.QueryRow(r.Context(), `
		SELECT
			COUNT(*)::bigint,
			COALESCE(AVG(returned_count::double precision), 0),
			COALESCE(AVG(candidate_count::double precision), 0),
			COALESCE(
				100.0 * SUM(CASE WHEN returned_count = 0 THEN 1 ELSE 0 END)::double precision / NULLIF(COUNT(*)::double precision, 0),
				0
			),
			COALESCE(
				100.0 * SUM(CASE WHEN contested THEN 1 ELSE 0 END)::double precision / NULLIF(COUNT(*)::double precision, 0),
				0
			)
		FROM query_log
		WHERE org_id = $1
		  AND ($2 <= 0 OR created_at > NOW() - make_interval(hours => $2))
	`, orgID, hours).Scan(
		&queryCount,
		&avgReturned,
		&avgCandidates,
		&zeroInjectionPct,
		&contestedPct,
	)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}

	var (
		dispositionReturned            int64
		dispositionBelowFloor          int64
		dispositionOverBudgetUnsampled int64
	)

	err = pool.QueryRow(r.Context(), `
		SELECT
			COALESCE(SUM(CASE WHEN qcs.disposition = 'returned' THEN 1 ELSE 0 END), 0)::bigint,
			COALESCE(SUM(CASE WHEN qcs.disposition = 'below_floor' THEN 1 ELSE 0 END), 0)::bigint,
			COALESCE(SUM(CASE WHEN qcs.disposition = 'over_budget_unsampled' THEN 1 ELSE 0 END), 0)::bigint
		FROM query_candidate_scores qcs
		JOIN query_log ql ON ql.query_id = qcs.query_id
		WHERE ql.org_id = $1
		  AND ($2 <= 0 OR ql.created_at > NOW() - make_interval(hours => $2))
	`, orgID, hours).Scan(
		&dispositionReturned,
		&dispositionBelowFloor,
		&dispositionOverBudgetUnsampled,
	)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}

	var avgReturnedScore *float64
	var avgBelowFloorScore *float64

	err = pool.QueryRow(r.Context(), `
		SELECT
			AVG(CASE WHEN qcs.disposition = 'returned' THEN qcs.combined_score END)::double precision,
			AVG(CASE WHEN qcs.disposition = 'below_floor' THEN qcs.combined_score END)::double precision
		FROM query_candidate_scores qcs
		JOIN query_log ql ON ql.query_id = qcs.query_id
		WHERE ql.org_id = $1
		  AND ($2 <= 0 OR ql.created_at > NOW() - make_interval(hours => $2))
	`, orgID, hours).Scan(
		&avgReturnedScore,
		&avgBelowFloorScore,
	)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}

	var (
		serveCount          int64
		denialCount         int64
		pendingServeBacklog int64
	)

	err = pool.QueryRow(r.Context(), `
		SELECT
			COALESCE(SUM(CASE WHEN event_type = 'serve' THEN 1 ELSE 0 END), 0)::bigint,
			COALESCE(SUM(CASE WHEN event_type = 'denial' THEN 1 ELSE 0 END), 0)::bigint,
			COALESCE(SUM(CASE WHEN event_type = 'serve' AND status = 'pending' THEN 1 ELSE 0 END), 0)::bigint
		FROM serve_events
		WHERE org_id = $1
		  AND ($2 <= 0 OR created_at > NOW() - make_interval(hours => $2))
	`, orgID, hours).Scan(
		&serveCount,
		&denialCount,
		&pendingServeBacklog,
	)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}

	var scoreGap *float64
	if avgReturnedScore != nil && avgBelowFloorScore != nil {
		gap := *avgReturnedScore - *avgBelowFloorScore
		scoreGap = &gap
	}

	var serveDenialRatio *float64
	if denialCount > 0 {
		ratio := float64(serveCount) / float64(denialCount)
		serveDenialRatio = &ratio
	}

	writeJSON(w, http.StatusOK, recallHealthResponse{
		WindowHours:      windowHours,
		QueryCount:       int(queryCount),
		AvgReturned:      roundRecallHealthValue(avgReturned, 2),
		AvgCandidates:    roundRecallHealthValue(avgCandidates, 2),
		ZeroInjectionPct: roundRecallHealthValue(zeroInjectionPct, 2),
		ContestedPct:     roundRecallHealthValue(contestedPct, 2),
		Disposition: recallHealthDisposition{
			Returned:            int(dispositionReturned),
			BelowFloor:          int(dispositionBelowFloor),
			OverBudgetUnsampled: int(dispositionOverBudgetUnsampled),
		},
		ScoreSeparation: recallHealthScoreSeparation{
			AvgReturnedScore:   roundRecallHealthValuePointer(avgReturnedScore, 3),
			AvgBelowFloorScore: roundRecallHealthValuePointer(avgBelowFloorScore, 3),
			Gap:                roundRecallHealthValuePointer(scoreGap, 3),
		},
		Feedback: recallHealthFeedback{
			ServeCount:       int(serveCount),
			DenialCount:      int(denialCount),
			ServeDenialRatio: roundRecallHealthValuePointer(serveDenialRatio, 2),
		},
		PendingServeBacklog: int(pendingServeBacklog),
	})
}

func parseRecallInspectorLimit(r *http.Request) (int, error) {
	rawLimit := strings.TrimSpace(r.URL.Query().Get("limit"))
	if rawLimit == "" {
		return defaultRecallInspectorLimit, nil
	}

	parsed, err := strconv.Atoi(rawLimit)
	if err != nil || parsed <= 0 {
		return 0, errInvalidLimit
	}

	if parsed > maxRecallInspectorLimit {
		parsed = maxRecallInspectorLimit
	}

	return parsed, nil
}

func parseRecallInspectorOffset(r *http.Request) (int, error) {
	rawOffset := strings.TrimSpace(r.URL.Query().Get("offset"))
	if rawOffset == "" {
		return 0, nil
	}

	parsed, err := strconv.Atoi(rawOffset)
	if err != nil || parsed < 0 {
		return 0, errInvalidOffset
	}

	return parsed, nil
}

func parseRecallInspectorHours(r *http.Request) (int, *int, error) {
	rawHours := strings.TrimSpace(r.URL.Query().Get("hours"))
	if rawHours == "" {
		return 0, nil, nil
	}

	parsed, err := strconv.Atoi(rawHours)
	if err != nil {
		return 0, nil, errInvalidHours
	}

	if parsed <= 0 {
		return 0, nil, nil
	}

	hours := parsed
	return hours, &hours, nil
}

func roundRecallHealthValue(value float64, precision int) float64 {
	factor := math.Pow10(precision)
	return math.Round(value*factor) / factor
}

func roundRecallHealthValuePointer(value *float64, precision int) *float64 {
	if value == nil {
		return nil
	}

	rounded := roundRecallHealthValue(*value, precision)
	return &rounded
}

var (
	errInvalidLimit  = &recallInspectorParamError{message: "invalid limit"}
	errInvalidOffset = &recallInspectorParamError{message: "invalid offset"}
	errInvalidHours  = &recallInspectorParamError{message: "invalid hours"}
)

type recallInspectorParamError struct {
	message string
}

func (e *recallInspectorParamError) Error() string {
	return e.message
}
