package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
	"github.com/go-chi/chi/v5"
)

type OrgHealthResponse struct {
	LastBatchExtractionAt string `json:"last_batch_extraction_at"`
	LastChainSubmissionAt string `json:"last_chain_submission_at"`
	PendingKeywordCount   int    `json:"pending_keyword_count"`
	PendingChainCount     int    `json:"pending_chain_count"`
}

func OrgHealth(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		http.Error(w, `{"error":"invalid timestamp format, use RFC3339"}`, http.StatusBadRequest)
		return
	}
	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		http.Error(w, `{"error":"timestamp expired or too far in future"}`, http.StatusUnauthorized)
		return
	}
	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		http.Error(w, `{"error":"forbidden: leader only"}`, http.StatusForbidden)
		return
	}

	var lastBatchExtractionAt, lastChainSubmissionAt *time.Time
	var pendingKeywordCount, pendingChainCount int

	err = pool.QueryRow(r.Context(), `
		SELECT last_batch_extraction_at, last_chain_submission_at
		FROM orgs WHERE org_id = $1
	`, orgID).Scan(&lastBatchExtractionAt, &lastChainSubmissionAt)
	if err != nil {
		http.Error(w, `{"error":"org not found"}`, http.StatusNotFound)
		return
	}

	err = pool.QueryRow(r.Context(), `
		SELECT COUNT(*) FROM pending_submissions
		WHERE org_id = $1 AND status = 'pending_keyword'
	`, orgID).Scan(&pendingKeywordCount)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	err = pool.QueryRow(r.Context(), `
		SELECT COUNT(*) FROM pending_submissions
		WHERE org_id = $1 AND status = 'pending_chain'
	`, orgID).Scan(&pendingChainCount)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	extractionAtStr := ""
	if lastBatchExtractionAt != nil {
		extractionAtStr = lastBatchExtractionAt.Format(time.RFC3339)
	}
	chainAtStr := ""
	if lastChainSubmissionAt != nil {
		chainAtStr = lastChainSubmissionAt.Format(time.RFC3339)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(OrgHealthResponse{
		LastBatchExtractionAt: extractionAtStr,
		LastChainSubmissionAt: chainAtStr,
		PendingKeywordCount:   pendingKeywordCount,
		PendingChainCount:     pendingChainCount,
	})
}
