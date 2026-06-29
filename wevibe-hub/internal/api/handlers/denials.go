package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/serves"
)

func GetPendingDenialCount(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	var pendingCount int
	err := pool.QueryRow(r.Context(), `
		SELECT COUNT(*)
		FROM serve_events
		WHERE event_type = 'denial' AND status = 'pending' AND org_id = $1
	`, orgID).Scan(&pendingCount)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"pending_count": pendingCount})
}

func GetPendingDenials(w http.ResponseWriter, r *http.Request) {
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

	if err := verifyTimestampSignature(*signed); err != nil {
		http.Error(w, err.Error(), statusFromAuthError(err))
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		http.Error(w, `{"error":"forbidden: leader only"}`, http.StatusForbidden)
		return
	}

	var totalCount int
	err = pool.QueryRow(r.Context(), `
		SELECT COUNT(*)
		FROM serve_events
		WHERE event_type = 'denial' AND status = 'pending' AND org_id = $1
	`, orgID).Scan(&totalCount)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	records, err := serves.GetPendingDenials(r.Context(), pool, orgID, 200)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"denials":     records,
		"total_count": totalCount,
	})
}
