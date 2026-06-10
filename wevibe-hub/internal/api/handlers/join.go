package handlers

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

func SubmitJoinRequest(w http.ResponseWriter, r *http.Request) {
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
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		RequesterPubkey string `json:"requester_pubkey"`
		PrePubkey       string `json:"pre_pubkey,omitempty"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.RequesterPubkey != signed.Pubkey {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	requesterPubkey := signed.Pubkey

	ctx := r.Context()

	var exists bool
	err = pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM members WHERE org_id=$1 AND pubkey=$2 AND active=true)`, orgID, requesterPubkey).Scan(&exists)
	if err == nil && exists {
		http.Error(w, `{"error":"already a member"}`, http.StatusConflict)
		return
	}

	err = pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM join_requests WHERE org_id=$1 AND requester_pubkey=$2 AND status='pending')`, orgID, requesterPubkey).Scan(&exists)
	if err == nil && exists {
		http.Error(w, `{"error":"join request already pending"}`, http.StatusConflict)
		return
	}

	var cooldownUntil *time.Time
	err = pool.QueryRow(ctx, `SELECT cooldown_until FROM join_requests WHERE org_id=$1 AND requester_pubkey=$2 AND status='denied' AND cooldown_until > NOW() ORDER BY cooldown_until DESC LIMIT 1`, orgID, requesterPubkey).Scan(&cooldownUntil)
	if err == nil && cooldownUntil != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "denial cooldown active", "cooldown_until": cooldownUntil.Format(time.RFC3339)})
		return
	}

	var prePubkey []byte
	if req.PrePubkey != "" {
		decoded, err := hex.DecodeString(req.PrePubkey)
		if err == nil && len(decoded) == 33 {
			prePubkey = decoded
		}
	}

	var requestID string
	err = pool.QueryRow(ctx, `
		INSERT INTO join_requests (org_id, requester_pubkey, pre_pubkey, status)
		VALUES ($1, $2, $3, 'pending')
		RETURNING request_id
	`, orgID, requesterPubkey, prePubkey).Scan(&requestID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	var leaderPubkey string
	_ = pool.QueryRow(ctx, `SELECT leader_pubkey FROM orgs WHERE org_id=$1`, orgID).Scan(&leaderPubkey)
	if leaderPubkey != "" {
		shortPubkey := requesterPubkey[:min(8, len(requesterPubkey))]
		_ = emitUserNotification(ctx,
			leaderPubkey,
			"join_request_received",
			"New Join Request",
			fmt.Sprintf("New join request from %s", shortPubkey),
			requestID,
			orgID,
		)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"request_id":   requestID,
		"status":       "pending",
		"requested_at": time.Now().Format(time.RFC3339),
	})
}

type JoinRequestRecord struct {
	RequestID       string  `json:"request_id"`
	RequesterPubkey string  `json:"requester_pubkey"`
	Status          string  `json:"status"`
	RequestedAt     string  `json:"requested_at"`
	ReviewedBy      *string `json:"reviewed_by"`
	ReviewedAt      *string `json:"reviewed_at"`
	DenialReason    *string `json:"denial_reason"`
	CooldownUntil   *string `json:"cooldown_until"`
}

func ListJoinRequests(w http.ResponseWriter, r *http.Request) {
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

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || (role != "leader" && role != "moderator") {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	status := r.URL.Query().Get("status")
	if status == "" {
		status = "pending"
	}

	limit := 50
	if l, _ := strconv.Atoi(r.URL.Query().Get("limit")); l > 0 && l <= 100 {
		limit = l
	}

	ctx := r.Context()
	rows, err := pool.Query(ctx, `
		SELECT request_id, requester_pubkey, status, requested_at, reviewed_by, reviewed_at, denial_reason, cooldown_until
		FROM join_requests
		WHERE org_id=$1 AND (CASE WHEN $2='all' THEN true ELSE status=$2 END)
		ORDER BY requested_at DESC
		LIMIT $3
	`, orgID, status, limit)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var requests []JoinRequestRecord
	for rows.Next() {
		var jr JoinRequestRecord
		var requestedAt time.Time
		var reviewedAt *time.Time
		var cooldownUntil *time.Time
		if err := rows.Scan(&jr.RequestID, &jr.RequesterPubkey, &jr.Status, &requestedAt, &jr.ReviewedBy, &reviewedAt, &jr.DenialReason, &cooldownUntil); err != nil {
			log.Printf("ListJoinRequests scan error org=%s: %v", orgID, err)
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
		jr.RequestedAt = requestedAt.Format(time.RFC3339)
		if reviewedAt != nil {
			reviewedAtStr := reviewedAt.Format(time.RFC3339)
			jr.ReviewedAt = &reviewedAtStr
		}
		if cooldownUntil != nil {
			cooldownUntilStr := cooldownUntil.Format(time.RFC3339)
			jr.CooldownUntil = &cooldownUntilStr
		}
		requests = append(requests, jr)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"requests": requests})
}

func ApproveJoinRequest(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	requestID := chi.URLParam(r, "requestID")
	if orgID == "" || requestID == "" {
		http.Error(w, `{"error":"org_id and request_id required"}`, http.StatusBadRequest)
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || (role != "leader" && role != "moderator") {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		SignedBy string `json:"signed_by"`
		Trial    bool   `json:"trial"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	var requesterPubkey string
	var status string
	err = pool.QueryRow(ctx, `SELECT requester_pubkey, status FROM join_requests WHERE request_id=$1 AND org_id=$2`, requestID, orgID).Scan(&requesterPubkey, &status)
	if err == pgx.ErrNoRows {
		http.Error(w, `{"error":"join request not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if status != "pending" {
		http.Error(w, `{"error":"join request is not pending"}`, http.StatusBadRequest)
		return
	}

	approvalTier := "member"
	if req.Trial {
		approvalTier = "trial"
	}

	result, err := pool.Exec(ctx, `
		UPDATE join_requests
		   SET status='confirming',
		       reviewed_by=$1,
		       reviewed_at=NOW(),
		       approval_tier=$2,
		       approval_is_trial=$3
		 WHERE request_id=$4 AND org_id=$5 AND status='pending'
	`, signed.Pubkey, approvalTier, req.Trial, requestID, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if result.RowsAffected() == 0 {
		http.Error(w, `{"error":"join request is not pending"}`, http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":        "confirming",
		"member_pubkey": requesterPubkey,
	})
}

func CancelJoinApproval(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	requestID := chi.URLParam(r, "requestID")
	if orgID == "" || requestID == "" {
		http.Error(w, `{"error":"org_id and request_id required"}`, http.StatusBadRequest)
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || (role != "leader" && role != "moderator") {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	result, err := pool.Exec(r.Context(), `
		UPDATE join_requests
		   SET status='pending',
		       reviewed_by=NULL,
		       reviewed_at=NULL,
		       approval_tier=NULL,
		       approval_is_trial=FALSE
		 WHERE request_id=$1 AND org_id=$2 AND status='confirming'
	`, requestID, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if result.RowsAffected() == 0 {
		http.Error(w, `{"error":"no confirming request to cancel"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "pending",
	})
}

func DenyJoinRequest(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	requestID := chi.URLParam(r, "requestID")
	if orgID == "" || requestID == "" {
		http.Error(w, `{"error":"org_id and request_id required"}`, http.StatusBadRequest)
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || (role != "leader" && role != "moderator") {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		Reason   string `json:"reason"`
		SignedBy string `json:"signed_by"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	var requesterPubkey string
	var status string
	err = pool.QueryRow(ctx, `SELECT requester_pubkey, status FROM join_requests WHERE request_id=$1 AND org_id=$2`, requestID, orgID).Scan(&requesterPubkey, &status)
	if err == pgx.ErrNoRows {
		http.Error(w, `{"error":"join request not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if status != "pending" {
		http.Error(w, `{"error":"join request is not pending"}`, http.StatusBadRequest)
		return
	}

	cooldownUntil := time.Now().Add(7 * 24 * time.Hour)
	denialReason := req.Reason
	_, err = pool.Exec(ctx, `UPDATE join_requests SET status='denied', reviewed_by=$1, reviewed_at=NOW(), denial_reason=$2, cooldown_until=$3 WHERE request_id=$4`,
		signed.Pubkey, denialReason, cooldownUntil, requestID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	_ = emitUserNotification(ctx,
		requesterPubkey,
		"join_denied",
		"Join Request Denied",
		"Your join request was denied",
		requestID,
		orgID,
	)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":         "denied",
		"cooldown_until": cooldownUntil.Format(time.RFC3339),
	})
}
