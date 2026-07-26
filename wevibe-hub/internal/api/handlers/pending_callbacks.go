package handlers

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
)

type pendingCallbacksBuckets struct {
	GreaterThan1Hour  int `json:"gt_1h"`
	GreaterThan24Hour int `json:"gt_24h"`
	GreaterThan7Days  int `json:"gt_7d"`
}

type pendingCallbackItem struct {
	MemberPubkey      string `json:"member_pubkey"`
	MemoryContentHash string `json:"memory_content_hash"`
	DeliveredAt       string `json:"delivered_at"`
	AgeSeconds        int64  `json:"age_seconds"`
}

type pendingCallbacksResponse struct {
	Buckets pendingCallbacksBuckets `json:"buckets"`
	Items   []pendingCallbackItem   `json:"items"`
}

const pendingCallbacksCTE = `
WITH deliveries AS (
	SELECT ql.agent_pubkey AS member_pubkey, qcs.memory_cid, MAX(ql.created_at) AS delivered_at
	FROM query_candidate_scores qcs
	JOIN query_log ql ON ql.query_id = qcs.query_id
	WHERE ql.org_id = $1 AND qcs.disposition = 'returned'
	GROUP BY ql.agent_pubkey, qcs.memory_cid
),
pending AS (
	SELECT d.member_pubkey, d.memory_cid, d.delivered_at
	FROM deliveries d
	WHERE NOT EXISTS (
		SELECT 1 FROM serve_events se
		WHERE se.org_id = $1
		  AND se.reporter_pubkey = d.member_pubkey
		  AND se.memory_content_hash = d.memory_cid
		  AND se.created_at >= d.delivered_at
	)
	AND NOT EXISTS (
		SELECT 1 FROM decision_notes dn
		WHERE dn.org_id = $1
		  AND dn.member_pubkey = d.member_pubkey
		  AND dn.memory_content_hash = d.memory_cid
		  AND dn.created_at >= d.delivered_at
	)
	AND NOT EXISTS (
		SELECT 1 FROM reports r
		WHERE r.org_id = $1
		  AND r.reporter_pubkey = d.member_pubkey
		  AND r.memory_cid = d.memory_cid
		  AND r.created_at >= d.delivered_at
	)
)
`

func GetPendingCallbacks(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	start := time.Now()
	status := "err"
	var count int
	defer func() {
		wlog.Op(ctx, "hub.list_pending_callbacks", slog.LevelInfo,
			slog.String("phase", "outcome"),
			slog.String("status", status),
			slog.Int("count", count),
			slog.Int64("dur_ms", time.Since(start).Milliseconds()))
	}()

	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "org_id required")
		return
	}

	wlog.Op(ctx, "hub.list_pending_callbacks", slog.LevelInfo,
		slog.String("phase", "entry"),
		slog.String("org", orgID))

	if !requireLeaderAuthorization(w, r, orgID) {
		return
	}

	var buckets pendingCallbacksBuckets
	err := pool.QueryRow(ctx, pendingCallbacksCTE+`
SELECT
	COUNT(*) FILTER (WHERE delivered_at <= NOW() - interval '1 hour')::bigint AS gt_1h,
	COUNT(*) FILTER (WHERE delivered_at <= NOW() - interval '24 hours')::bigint AS gt_24h,
	COUNT(*) FILTER (WHERE delivered_at <= NOW() - interval '7 days')::bigint AS gt_7d
FROM pending
`, orgID).Scan(&buckets.GreaterThan1Hour, &buckets.GreaterThan24Hour, &buckets.GreaterThan7Days)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}

	rows, err := pool.Query(ctx, pendingCallbacksCTE+`
SELECT member_pubkey, memory_cid, delivered_at
FROM pending
ORDER BY delivered_at DESC
LIMIT 50
`, orgID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}
	defer rows.Close()

	items := make([]pendingCallbackItem, 0, 50)
	for rows.Next() {
		var item pendingCallbackItem
		var deliveredAt time.Time
		if err := rows.Scan(&item.MemberPubkey, &item.MemoryContentHash, &deliveredAt); err != nil {
			WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
			return
		}

		item.DeliveredAt = deliveredAt.UTC().Format(time.RFC3339)
		ageSeconds := int64(time.Since(deliveredAt).Seconds())
		if ageSeconds < 0 {
			ageSeconds = 0
		}
		item.AgeSeconds = ageSeconds
		items = append(items, item)
	}

	if err := rows.Err(); err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}

	status = "ok"
	count = len(items)
	writeJSON(w, http.StatusOK, pendingCallbacksResponse{
		Buckets: buckets,
		Items:   items,
	})
}
