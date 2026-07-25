package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

func RegisterDashboardKey(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req protocol.RegisterDashboardKeyRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.Pubkey == "" || req.SignedBy == "" || req.Signature == "" {
		http.Error(w, `{"error":"pubkey, signed_by, and signature required"}`, http.StatusBadRequest)
		return
	}

	if req.Label == "" {
		req.Label = "dashboard"
	}

	leaderPubkey, err := orgs.GetLeaderPubkey(r.Context(), pool, orgID)
	if err == pgx.ErrNoRows {
		http.Error(w, `{"error":"org not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if leaderPubkey != req.SignedBy {
		http.Error(w, `{"error":"forbidden: only leader can register dashboard keys"}`, http.StatusForbidden)
		return
	}

	canonical := []byte(fmt.Sprintf("wevibe.register_dashboard_key.v1\norg_id:%s\npubkey:%s\nsigned_by:%s", orgID, req.Pubkey, req.SignedBy))
	if err := verify.RequestSignature(req.SignedBy, req.Signature, canonical); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	_, err = pool.Exec(r.Context(), `
		INSERT INTO dashboard_keys (org_id, pubkey, label, registered_by)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (org_id, pubkey) DO UPDATE SET
			label = EXCLUDED.label,
			active = TRUE,
			created_at = NOW()
	`, orgID, req.Pubkey, req.Label, req.SignedBy)
	if err != nil {
		http.Error(w, `{"error":"failed to register dashboard key"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "registered"})
}

func RevokeDashboardKey(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	pubkey := chi.URLParam(r, "pubkey")
	if orgID == "" || pubkey == "" {
		http.Error(w, `{"error":"org_id and pubkey required"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req protocol.RemoveMemberRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	leaderPubkey, err := orgs.GetLeaderPubkey(r.Context(), pool, orgID)
	if err == pgx.ErrNoRows {
		http.Error(w, `{"error":"org not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if leaderPubkey != req.SignedBy {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	canonical := []byte(fmt.Sprintf("wevibe.revoke_dashboard_key.v1\norg_id:%s\npubkey:%s\nsigned_by:%s", orgID, pubkey, req.SignedBy))
	if err := verify.RequestSignature(req.SignedBy, req.Signature, canonical); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	_, err = pool.Exec(r.Context(), `
		UPDATE dashboard_keys SET active = FALSE WHERE org_id = $1 AND pubkey = $2
	`, orgID, pubkey)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "revoked"})
}
