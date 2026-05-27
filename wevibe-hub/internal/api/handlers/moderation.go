package handlers

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/moderation"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

func SubmitMemory(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	memberPubkey := auth.GetMemberPubkey(r.Context())
	if memberPubkey == "" {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	isTrial, _, err := members.GetTrialStatus(r.Context(), pool, orgID, memberPubkey)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if isTrial {
		http.Error(w, `{"error":"Trial members cannot contribute. Upgrade to full membership."}`, http.StatusForbidden)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req protocol.SubmitMemoryRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	req.OrgID = orgID

	if req.Ciphertext == "" || req.WrappedDekMod == "" || req.SubmissionHash == "" ||
		req.ContributorPubkey == "" || req.ContributorSig == "" || req.PlaintextHash == "" ||
		req.Salt == "" || req.CiphertextHash == "" || req.WrappedDekHash == "" {
		http.Error(w, `{"error":"missing required fields"}`, http.StatusBadRequest)
		return
	}
	if !protocol.IsValidMemoryType(req.MemoryType) {
		http.Error(w, `{"error":"memory_type must be one of: correct_implementation, negative_signal"}`, http.StatusBadRequest)
		return
	}

	if req.EpochID < 0 {
		http.Error(w, `{"error":"epoch_id is required and must be non-negative"}`, http.StatusBadRequest)
		return
	}
	epochExists, err := orgs.EpochExists(r.Context(), pool, orgID, req.EpochID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if !epochExists {
		http.Error(w, `{"error":"epoch_id does not exist for this org"}`, http.StatusBadRequest)
		return
	}

	isPending, err := orgs.IsRotationPending(r.Context(), pool, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if isPending {
		pendingSince, err := orgs.GetRotationPendingSince(r.Context(), pool, orgID)
		if err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}

		const rotationGracePeriod = 72 * time.Hour
		if pendingSince != nil && time.Since(*pendingSince) > rotationGracePeriod {
			http.Error(w, `{"error":"submissions blocked: epoch rotation required. Contact org leader."}`, http.StatusServiceUnavailable)
			return
		}

		if err := orgs.BufferSubmission(r.Context(), pool, orgID, req); err != nil {
			http.Error(w, `{"error":"failed to buffer submission"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(protocol.SubmitMemoryResponse{
			SubmissionHash: req.SubmissionHash,
			Status:         "buffered",
		})
		return
	}

	if err := moderation.SubmitToQueue(r.Context(), pool, req, nil); err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "signature") {
			http.Error(w, `{"error":"unauthorized: `+errMsg+`"}`, http.StatusUnauthorized)
			return
		}
		if strings.Contains(errMsg, "mismatch") || strings.Contains(errMsg, "invalid") {
			http.Error(w, `{"error":"`+errMsg+`"}`, http.StatusBadRequest)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(protocol.SubmitMemoryResponse{
		SubmissionHash: req.SubmissionHash,
		Status:         "pending",
	})
}

func SubmitMemoryBatch(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	memberPubkey := auth.GetMemberPubkey(r.Context())
	if memberPubkey == "" {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	isTrial, _, err := members.GetTrialStatus(r.Context(), pool, orgID, memberPubkey)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if isTrial {
		http.Error(w, `{"error":"Trial members cannot contribute. Upgrade to full membership."}`, http.StatusForbidden)
		return
	}

	var req struct {
		Submissions []protocol.SubmitMemoryRequest `json:"submissions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if len(req.Submissions) == 0 {
		http.Error(w, `{"error":"submissions required"}`, http.StatusBadRequest)
		return
	}

	isPending, err := orgs.IsRotationPending(r.Context(), pool, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if isPending {
		pendingSince, err := orgs.GetRotationPendingSince(r.Context(), pool, orgID)
		if err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}

		const rotationGracePeriod = 72 * time.Hour
		if pendingSince != nil && time.Since(*pendingSince) > rotationGracePeriod {
			http.Error(w, `{"error":"submissions blocked: epoch rotation required. Contact org leader."}`, http.StatusServiceUnavailable)
			return
		}
	}

	type batchResult struct {
		SubmissionHash       string             `json:"submission_hash"`
		Status               string             `json:"status"`
		Error                string             `json:"error,omitempty"`
		SanitizationFindings []protocol.Finding `json:"sanitization_findings,omitempty"`
	}

	results := make([]batchResult, 0, len(req.Submissions))
	submitted := 0
	failed := 0

	for _, submission := range req.Submissions {
		submission.OrgID = orgID

		if submission.Ciphertext == "" || submission.WrappedDekMod == "" || submission.SubmissionHash == "" ||
			submission.ContributorPubkey == "" || submission.ContributorSig == "" || submission.PlaintextHash == "" ||
			submission.Salt == "" || submission.CiphertextHash == "" || submission.WrappedDekHash == "" {
			results = append(results, batchResult{SubmissionHash: submission.SubmissionHash, Status: "error", Error: "missing required fields"})
			failed++
			continue
		}

		if !protocol.IsValidMemoryType(submission.MemoryType) {
			results = append(results, batchResult{SubmissionHash: submission.SubmissionHash, Status: "error", Error: "memory_type must be one of: correct_implementation, negative_signal"})
			failed++
			continue
		}

		if submission.EpochID < 0 {
			results = append(results, batchResult{SubmissionHash: submission.SubmissionHash, Status: "error", Error: "epoch_id is required and must be non-negative"})
			failed++
			continue
		}

		epochExists, err := orgs.EpochExists(r.Context(), pool, orgID, submission.EpochID)
		if err != nil {
			results = append(results, batchResult{SubmissionHash: submission.SubmissionHash, Status: "error", Error: "internal error"})
			failed++
			continue
		}
		if !epochExists {
			results = append(results, batchResult{SubmissionHash: submission.SubmissionHash, Status: "error", Error: "epoch_id does not exist for this org"})
			failed++
			continue
		}

		if isPending {
			if err := orgs.BufferSubmission(r.Context(), pool, orgID, submission); err != nil {
				results = append(results, batchResult{SubmissionHash: submission.SubmissionHash, Status: "error", Error: "failed to buffer submission"})
				failed++
				continue
			}
			results = append(results, batchResult{SubmissionHash: submission.SubmissionHash, Status: "buffered"})
			submitted++
			continue
		}

		if err := moderation.SubmitToQueue(r.Context(), pool, submission, nil); err != nil {
			errMsg := err.Error()
			if strings.Contains(errMsg, "signature") || strings.Contains(errMsg, "mismatch") || strings.Contains(errMsg, "invalid") {
				results = append(results, batchResult{SubmissionHash: submission.SubmissionHash, Status: "error", Error: errMsg})
			} else {
				results = append(results, batchResult{SubmissionHash: submission.SubmissionHash, Status: "error", Error: "internal error"})
			}
			failed++
			continue
		}

		results = append(results, batchResult{
			SubmissionHash: submission.SubmissionHash,
			Status:         "pending",
		})
		submitted++
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"submitted": submitted,
		"failed":    failed,
		"results":   results,
	})
}

func GetPendingQueue(w http.ResponseWriter, r *http.Request) {
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
		http.Error(w, `{"error":"unauthorized: valid Authorization header required"}`, http.StatusUnauthorized)
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

	pubkey := signed.Pubkey

	items, err := moderation.GetPendingQueue(r.Context(), pool, orgID, pubkey)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "insufficient role") || strings.Contains(errMsg, "not found") {
			http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	wallets := make([]string, 0, len(items))
	for _, item := range items {
		if item.ContributorWallet != "" {
			wallets = append(wallets, item.ContributorWallet)
		}
	}
	nameMap := resolveWalletDisplayNames(r.Context(), wallets)
	for idx := range items {
		wallet := strings.TrimSpace(items[idx].ContributorWallet)
		if wallet == "" {
			continue
		}
		items[idx].ContributorDisplayName = nameMap[wallet]
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(items)
}

func VoteOnSubmission(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	submissionHash := chi.URLParam(r, "submissionHash")
	if orgID == "" || submissionHash == "" {
		http.Error(w, `{"error":"org_id and submission_hash required"}`, http.StatusBadRequest)
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized: valid Authorization header required"}`, http.StatusUnauthorized)
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

	votes, required, ready, err := moderation.CastApprovalVote(r.Context(), pool, orgID, submissionHash, signed.Pubkey)
	if err != nil {
		msg := err.Error()
		switch {
		case strings.Contains(msg, "not found"):
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, msg), http.StatusNotFound)
			return
		case strings.Contains(msg, "inactive"), strings.Contains(msg, "insufficient role"):
			http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
			return
		case strings.Contains(msg, "already recorded"):
			http.Error(w, `{"error":"vote already recorded"}`, http.StatusConflict)
			return
		case strings.Contains(msg, "resolved"):
			http.Error(w, `{"error":"submission already resolved"}`, http.StatusConflict)
			return
		default:
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, msg), http.StatusInternalServerError)
			return
		}
	}

	var status string
	err = pool.QueryRow(r.Context(), `
        SELECT status FROM pending_submissions WHERE org_id = $1 AND submission_hash = $2
    `, orgID, submissionHash).Scan(&status)
	if err == pgx.ErrNoRows {
		http.Error(w, `{"error":"submission not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":             status,
		"votes":              votes,
		"required_approvals": required,
		"ready":              ready,
	})
}

func ApproveSubmission(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	submissionHash := chi.URLParam(r, "submissionHash")
	if orgID == "" || submissionHash == "" {
		http.Error(w, `{"error":"org_id and submission_hash required"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req protocol.ApproveRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.SignedBy == "" {
		http.Error(w, `{"error":"signed_by required"}`, http.StatusBadRequest)
		return
	}

	if req.ModeratorSig == "" {
		http.Error(w, `{"error":"moderator_sig required"}`, http.StatusBadRequest)
		return
	}

	if !protocol.IsValidMemoryType(req.MemoryType) {
		http.Error(w, `{"error":"memory_type must be one of: correct_implementation, negative_signal"}`, http.StatusBadRequest)
		return
	}

	if req.EpochID < 0 {
		http.Error(w, `{"error":"epoch_id must be non-negative"}`, http.StatusBadRequest)
		return
	}

	canonical := verify.ApproveSubmissionMessageSimple(orgID, submissionHash, req.EpochID, req.MemoryType, req.SignedBy)
	if err := verify.RequestSignature(req.SignedBy, req.ModeratorSig, canonical); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	if err := moderation.ApproveSubmission(r.Context(), pool, orgID, submissionHash, req.SignedBy, req.MemoryType); err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "forbidden") {
			http.Error(w, `{"error":"forbidden: not a moderator"}`, http.StatusForbidden)
			return
		}
		if strings.Contains(errMsg, "not found") {
			http.Error(w, `{"error":"`+errMsg+`"}`, http.StatusNotFound)
			return
		}
		if strings.Contains(errMsg, "invalid status") {
			http.Error(w, `{"error":"`+errMsg+`"}`, http.StatusBadRequest)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "approved"})
}

func DenySubmission(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	submissionHash := chi.URLParam(r, "submissionHash")
	if orgID == "" || submissionHash == "" {
		http.Error(w, `{"error":"org_id and submission_hash required"}`, http.StatusBadRequest)
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

	if req.SignedBy == "" || req.Reason == "" {
		http.Error(w, `{"error":"signed_by and reason required"}`, http.StatusBadRequest)
		return
	}

	canonical := verify.DenySubmissionMessage(orgID, submissionHash, req.Reason, req.SignedBy)
	if err := verify.RequestSignature(req.SignedBy, req.Signature, canonical); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	if err := moderation.DenySubmission(r.Context(), pool, orgID, submissionHash, req.SignedBy, req.Reason); err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "forbidden") {
			http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
			return
		}
		if strings.Contains(errMsg, "not found") || strings.Contains(errMsg, "already resolved") {
			http.Error(w, `{"error":"`+errMsg+`"}`, http.StatusNotFound)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "denied"})
}

func UndoApproveSubmission(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	submissionHash := chi.URLParam(r, "submissionHash")
	if orgID == "" || submissionHash == "" {
		http.Error(w, `{"error":"org_id and submission_hash required"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		SignedBy  string `json:"signed_by"`
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.SignedBy == "" {
		http.Error(w, `{"error":"signed_by required"}`, http.StatusBadRequest)
		return
	}

	ts := time.Now().Format(time.RFC3339)
	if err := verify.RequestSignature(req.SignedBy, req.Signature, []byte(ts)); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	if err := moderation.UndoApproveSubmission(r.Context(), pool, orgID, submissionHash, req.SignedBy); err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "forbidden") {
			http.Error(w, `{"error":"forbidden: not a moderator"}`, http.StatusForbidden)
			return
		}
		if strings.Contains(errMsg, "not found") {
			http.Error(w, `{"error":"`+errMsg+`"}`, http.StatusNotFound)
			return
		}
		if strings.Contains(errMsg, "not in pending_keyword") {
			http.Error(w, `{"error":"`+errMsg+`"}`, http.StatusConflict)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "pending"})
}

func BatchSubmitToChain(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	if chainClient == nil {
		http.Error(w, `{"error":"chain client required"}`, http.StatusServiceUnavailable)
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
		http.Error(w, `{"error":"invalid timestamp"}`, http.StatusBadRequest)
		return
	}
	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		http.Error(w, `{"error":"timestamp expired"}`, http.StatusUnauthorized)
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

	rows, err := pool.Query(r.Context(), `
		SELECT ps.submission_hash, ps.contributor_pubkey, ps.ciphertext_hex, ps.wrapped_dek_mod,
		       ps.plaintext_hash, ps.salt, ps.ciphertext_hash, ps.contributor_sig,
		       ps.stack_hint, ps.memory_type,
		       COALESCE(m.wallet_address, '') AS contributor_wallet
		FROM pending_submissions ps
		JOIN members m ON m.org_id = ps.org_id AND m.pubkey = ps.contributor_pubkey
		WHERE ps.org_id = $1 AND ps.status = $2
		ORDER BY ps.created_at ASC
	`, orgID, protocol.SubmissionStatusPendingChain)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type submitResult struct {
		Hash   string `json:"submission_hash"`
		TxHash string `json:"tx_hash,omitempty"`
		Error  string `json:"error,omitempty"`
	}

	var results []submitResult
	var submitted, failed int

	for rows.Next() {
		var hash, contributor, ciphertext, wrappedDekMod, plaintextHash string
		var salt, ciphertextHash, contributorSig, memoryType, walletAddress string
		var stackHint []string
		if err := rows.Scan(
			&hash,
			&contributor,
			&ciphertext,
			&wrappedDekMod,
			&plaintextHash,
			&salt,
			&ciphertextHash,
			&contributorSig,
			&stackHint,
			&memoryType,
			&walletAddress,
		); err != nil {
			log.Printf("batch submit row scan failed: %v", err)
			failed++
			continue
		}
		if !protocol.IsValidMemoryType(memoryType) {
			log.Printf("batch submit skipping %s: invalid memory_type %q", hash, memoryType)
			results = append(results, submitResult{Hash: hash, Error: "invalid memory_type"})
			failed++
			continue
		}

		decodeHex := func(fieldName, fieldValue, resultErr string) ([]byte, bool) {
			decoded, decodeErr := hex.DecodeString(fieldValue)
			if decodeErr != nil {
				log.Printf("batch submit skipping %s: invalid %s hex: %v", hash, fieldName, decodeErr)
				results = append(results, submitResult{Hash: hash, Error: resultErr})
				failed++
				return nil, false
			}
			return decoded, true
		}

		contentHashBytes, ok := decodeHex("submission_hash", hash, "invalid content hash")
		if !ok {
			continue
		}
		ciphertextBytes, ok := decodeHex("ciphertext_hex", ciphertext, "invalid ciphertext")
		if !ok {
			continue
		}
		wrappedDekEncBytes, ok := decodeHex("wrapped_dek_mod", wrappedDekMod, "invalid wrapped dek")
		if !ok {
			continue
		}
		plaintextHashBytes, ok := decodeHex("plaintext_hash", plaintextHash, "invalid plaintext hash")
		if !ok {
			continue
		}
		saltBytes, ok := decodeHex("salt", salt, "invalid salt")
		if !ok {
			continue
		}
		ciphertextHashBytes, ok := decodeHex("ciphertext_hash", ciphertextHash, "invalid ciphertext hash")
		if !ok {
			continue
		}
		contributorSigBytes, ok := decodeHex("contributor_sig", contributorSig, "invalid contributor signature")
		if !ok {
			continue
		}

		keywords := make([]*memorytypes.KeywordWeight, len(stackHint))
		for i, kw := range stackHint {
			keywords[i] = &memorytypes.KeywordWeight{
				Keyword: kw,
				Weight:  "1.0",
			}
		}

		mem := chain.BatchMemory{
			ContentHash:         contentHashBytes,
			PlaintextHash:       plaintextHashBytes,
			Salt:                saltBytes,
			CiphertextHash:      ciphertextHashBytes,
			ContributorSig:      contributorSigBytes,
			ContributorPubkey:   contributor,
			Approvers:           []string{signed.Pubkey},
			CommittingLeader:    signed.Pubkey,
			Keywords:            keywords,
			ContributorID:       contributor,
			ContributorWallet:   walletAddress,
			EncryptedBlob:       ciphertextBytes,
			WrappedDekEnc:       wrappedDekEncBytes,
			SubmittedMemoryType: memoryType,
			ApprovedMemoryType:  memoryType,
		}

		txHash, err := chainClient.SubmitMemoryToChain(r.Context(), orgID, mem)
		if err != nil {
			log.Printf("batch submit failed for %s: %v", hash, err)
			results = append(results, submitResult{Hash: hash, Error: err.Error()})
			failed++
			continue
		}

		_, _ = pool.Exec(r.Context(), `
			DELETE FROM approval_votes WHERE org_id = $1 AND submission_hash = $2
		`, orgID, hash)

		results = append(results, submitResult{Hash: hash, TxHash: txHash})
		submitted++
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"submitted": submitted,
		"failed":    failed,
		"results":   results,
	})
}
