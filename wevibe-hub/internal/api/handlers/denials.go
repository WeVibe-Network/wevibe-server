package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
)

type pendingDenial struct {
	Nullifier  string    `json:"nullifier"`
	MemoryHash string    `json:"memory_hash"`
	CreatedAt  time.Time `json:"created_at"`
	Reason     string    `json:"reason"`
}

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

	rows, err := pool.Query(r.Context(), `
		SELECT nullifier, memory_content_hash, created_at, reason
		FROM serve_events
		WHERE event_type = 'denial' AND status = 'pending' AND org_id = $1
		ORDER BY created_at DESC
		LIMIT 200
	`, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	denials := make([]pendingDenial, 0)
	for rows.Next() {
		var denial pendingDenial
		if err := rows.Scan(&denial.Nullifier, &denial.MemoryHash, &denial.CreatedAt, &denial.Reason); err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
		denials = append(denials, denial)
	}
	if err := rows.Err(); err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"denials":     denials,
		"total_count": totalCount,
	})
}
