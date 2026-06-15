package handlers

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

func DenyPendingForContributor(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	contributorPubkey := chi.URLParam(r, "contributorPubkey")
	if orgID == "" || contributorPubkey == "" {
		http.Error(w, `{"error":"org_id and contributor_pubkey required"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req protocol.DenyRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.SignedBy == "" {
		http.Error(w, `{"error":"signed_by required"}`, http.StatusBadRequest)
		return
	}

	canonical := verify.BanContributorMessage(orgID, contributorPubkey, req.SignedBy)
	if err := verify.RequestSignature(req.SignedBy, req.Signature, canonical); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, req.SignedBy)
	if err != nil || role != "leader" {
		http.Error(w, `{"error":"forbidden: leader only"}`, http.StatusForbidden)
		return
	}

	reason := req.Reason
	if reason == "" {
		reason = "banned"
	}

	result, err := pool.Exec(r.Context(), `
		UPDATE pending_submissions
		SET status='denied', denial_reason=$1, moderator_pubkey=$2, resolved_at=NOW(), updated_at=NOW()
		WHERE org_id=$3 AND contributor_pubkey=$4 AND status IN ('pending_keyword','pending_chain')
	`, reason, req.SignedBy, orgID, contributorPubkey)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":       "banned",
		"denied_count": result.RowsAffected(),
	})
}
