package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
)

type recordExtractedSessionRequest struct {
	SessionID string `json:"session_id"`
}

type extractedSession struct {
	SessionID   string `json:"session_id"`
	ExtractedAt string `json:"extracted_at"`
}

type listExtractedSessionsResponse struct {
	Sessions []extractedSession `json:"sessions"`
}

func RecordExtractedSession(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	routeOrgID := chi.URLParam(r, "orgID")
	if routeOrgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	orgID := auth.GetMemberOrgID(r.Context())
	if orgID == "" || orgID != routeOrgID {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	memberPubkey := auth.GetMemberPubkey(r.Context())
	if memberPubkey == "" {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req recordExtractedSessionRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	sessionID := strings.TrimSpace(req.SessionID)
	if sessionID == "" {
		http.Error(w, `{"error":"session_id required"}`, http.StatusBadRequest)
		return
	}

	var extractedAt time.Time
	err = pool.QueryRow(r.Context(), `
		INSERT INTO extracted_sessions (org_id, contributor_pubkey, session_id)
		VALUES ($1, $2, $3)
		ON CONFLICT (org_id, contributor_pubkey, session_id)
		DO UPDATE SET extracted_at = NOW()
		RETURNING extracted_at
	`, orgID, memberPubkey, sessionID).Scan(&extractedAt)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(extractedSession{
		SessionID:   sessionID,
		ExtractedAt: extractedAt.UTC().Format(time.RFC3339),
	})
}

func ListExtractedSessions(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	routeOrgID := chi.URLParam(r, "orgID")
	if routeOrgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	orgID := auth.GetMemberOrgID(r.Context())
	if orgID == "" || orgID != routeOrgID {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	memberPubkey := auth.GetMemberPubkey(r.Context())
	if memberPubkey == "" {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	rows, err := pool.Query(r.Context(), `
		SELECT session_id, extracted_at
		FROM extracted_sessions
		WHERE org_id = $1 AND contributor_pubkey = $2
		ORDER BY extracted_at DESC
	`, orgID, memberPubkey)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	sessions := make([]extractedSession, 0)
	for rows.Next() {
		var sessionID string
		var extractedAt time.Time
		if err := rows.Scan(&sessionID, &extractedAt); err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}

		sessions = append(sessions, extractedSession{
			SessionID:   sessionID,
			ExtractedAt: extractedAt.UTC().Format(time.RFC3339),
		})
	}
	if err := rows.Err(); err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(listExtractedSessionsResponse{Sessions: sessions})
}
