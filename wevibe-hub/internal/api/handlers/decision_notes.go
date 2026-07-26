package handlers

import (
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
)

const maxDecisionNoteReasonLength = 2000

type recordDecisionNoteRequest struct {
	MemoryHash string `json:"memory_hash"`
	Action     string `json:"action"`
	Reason     string `json:"reason"`
}

func RecordDecisionNote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	start := time.Now()
	status := "err"
	var count int
	defer func() {
		wlog.Op(ctx, "hub.record_decision_note", slog.LevelInfo,
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

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized: valid Authorization header required")
		return
	}

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "invalid timestamp format, use RFC3339")
		return
	}

	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "timestamp expired or too far in future")
		return
	}

	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role == "" {
		WriteError(w, http.StatusForbidden, "forbidden", "forbidden: org member required")
		return
	}

	defer r.Body.Close()
	var req recordDecisionNoteRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "invalid json")
		return
	}

	req.MemoryHash = strings.ToLower(strings.TrimSpace(req.MemoryHash))
	if req.MemoryHash == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "memory_hash required")
		return
	}
	if len(req.MemoryHash) != 64 {
		WriteError(w, http.StatusBadRequest, "invalid_request", "memory_hash must be 64 hex chars")
		return
	}
	if _, err := hex.DecodeString(req.MemoryHash); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "memory_hash must be valid hex")
		return
	}

	req.Action = strings.ToLower(strings.TrimSpace(req.Action))
	if req.Action != "deny" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "action must be deny")
		return
	}

	req.Reason = strings.TrimSpace(req.Reason)
	if len(req.Reason) > maxDecisionNoteReasonLength {
		WriteError(w, http.StatusBadRequest, "invalid_request", "reason too long")
		return
	}

	var reason *string
	if req.Reason != "" {
		reason = &req.Reason
	}

	memberFP := fingerprintHexOrString(signed.Pubkey)
	memoryFP := fingerprintHexOrString(req.MemoryHash)
	wlog.Op(ctx, "hub.record_decision_note", slog.LevelInfo,
		slog.String("phase", "entry"),
		slog.String("org", orgID),
		slog.String("member_fp", memberFP),
		slog.String("memory_fp", memoryFP),
		slog.Int("reason_len", len(req.Reason)))

	var id int64
	var createdAt time.Time
	err = pool.QueryRow(ctx, `
		INSERT INTO decision_notes (org_id, member_pubkey, memory_content_hash, action, reason)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, created_at
	`, orgID, signed.Pubkey, req.MemoryHash, req.Action, reason).Scan(&id, &createdAt)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error")
		return
	}

	_ = createdAt
	status = "ok"
	count = 1
	writeJSON(w, http.StatusCreated, map[string]any{"status": "recorded", "id": id})
}

func fingerprintHexOrString(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	b, err := hex.DecodeString(trimmed)
	if err == nil {
		return wlog.Fingerprint(b)
	}
	return wlog.Fingerprint([]byte(trimmed))
}
