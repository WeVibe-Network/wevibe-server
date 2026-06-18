package handlers

import (
	"encoding/json"
	"io"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
)

type setRecallRateLimitRequest struct {
	MaxRequests   int `json:"max_requests"`
	WindowSeconds int `json:"window_seconds"`
}

type setRecallRateLimitResponse struct {
	Status        string `json:"status"`
	MaxRequests   int    `json:"max_requests"`
	WindowSeconds int    `json:"window_seconds"`
}

func SetRecallRateLimit(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "org_id required")
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	if err := verifyTimestampSignature(*signed); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		WriteError(w, http.StatusForbidden, "forbidden", "leader only")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "bad request")
		return
	}

	var req setRecallRateLimitRequest
	if err := json.Unmarshal(body, &req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_json", "invalid json")
		return
	}

	if req.MaxRequests <= 0 || req.WindowSeconds <= 0 {
		WriteError(w, http.StatusBadRequest, "invalid_request", "max_requests and window_seconds must be greater than zero")
		return
	}

	_, err = pool.Exec(r.Context(), `
		INSERT INTO org_recall_rate_limits (org_id, max_requests, window_seconds, updated_by)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (org_id) DO UPDATE
		SET max_requests = EXCLUDED.max_requests,
		    window_seconds = EXCLUDED.window_seconds,
		    updated_by = EXCLUDED.updated_by,
		    updated_at = NOW()
	`, orgID, req.MaxRequests, req.WindowSeconds, signed.Pubkey)
	if err != nil {
		log.Printf("[recall-rate-limit] ERROR upsert FAILED org=%s actor=%s: %v", orgID, truncateForLog(signed.Pubkey, 12), err)
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(setRecallRateLimitResponse{
		Status:        "ok",
		MaxRequests:   req.MaxRequests,
		WindowSeconds: req.WindowSeconds,
	}); err != nil {
		log.Printf("[recall-rate-limit] ERROR encode response FAILED org=%s: %v", orgID, err)
	}
}
