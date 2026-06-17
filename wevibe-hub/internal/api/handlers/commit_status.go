package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

const commitStatusSignedTimestampWindow = 5 * time.Minute

type commitStatusSubmission struct {
	SubmissionHash    string     `json:"submission_hash"`
	Status            string     `json:"status"`
	CommitError       *string    `json:"commit_error"`
	CommitAttemptedAt *time.Time `json:"commit_attempted_at"`
}

type commitStatusResponse struct {
	Submissions []commitStatusSubmission `json:"submissions"`
}

func CommitStatus(w http.ResponseWriter, r *http.Request) {
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

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "invalid timestamp format, use RFC3339")
		return
	}
	now := time.Now()
	if now.Sub(ts) > commitStatusSignedTimestampWindow || ts.Sub(now) > commitStatusSignedTimestampWindow {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "timestamp expired or too far in future")
		return
	}

	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	if _, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	rows, err := pool.Query(r.Context(), `
		SELECT submission_hash, status, commit_error, commit_attempted_at
		FROM pending_submissions
		WHERE org_id = $1
		ORDER BY created_at DESC
	`, orgID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error", err.Error())
		return
	}
	defer rows.Close()

	submissions := make([]commitStatusSubmission, 0)
	for rows.Next() {
		var submission commitStatusSubmission
		if err := rows.Scan(
			&submission.SubmissionHash,
			&submission.Status,
			&submission.CommitError,
			&submission.CommitAttemptedAt,
		); err != nil {
			WriteError(w, http.StatusInternalServerError, "internal_error", "internal error", err.Error())
			return
		}
		submissions = append(submissions, submission)
	}
	if err := rows.Err(); err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error", err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(commitStatusResponse{Submissions: submissions})
}
