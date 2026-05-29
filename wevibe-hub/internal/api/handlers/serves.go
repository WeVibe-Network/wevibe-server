package handlers

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/serves"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

func RecordServeEvent(w http.ResponseWriter, r *http.Request) {
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

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role == "" {
		http.Error(w, `{"error":"forbidden: org member required"}`, http.StatusForbidden)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req serves.RecordServeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	req.OrgID = orgID

	record, err := serves.RecordServe(r.Context(), pool, req, signed.Pubkey)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "duplicate") {
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, errMsg), http.StatusConflict)
			return
		}
		if strings.Contains(errMsg, "memory_content_hash") || strings.Contains(errMsg, "nullifier") ||
			strings.Contains(errMsg, "serve_key") || strings.Contains(errMsg, "contributor_id") ||
			strings.Contains(errMsg, "epoch_id") || strings.Contains(errMsg, "matched_keywords") {
			http.Error(w, fmt.Sprintf(`{"error":"validation: %s"}`, errMsg), http.StatusBadRequest)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	// Synchronous chain relay (CO-035 R-SYNC-RELAY): submit the just-recorded
	// serve to chain immediately, in the same request cycle. On success update
	// the Postgres row to status='submitted'. On failure log and leave the row
	// status='pending' for a future retry sweep — but do NOT fail the HTTP
	// response to the consumer; the local record is durable regardless.
	if chainClient != nil {
		submitServeToChainSync(r.Context(), chainClient, pool, orgID, record)
	} else {
		slog.Warn("chain client not configured; serve recorded to Postgres only",
			"org_id", orgID, "serve_id", record.ID)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "recorded",
		"nullifier": record.Nullifier,
	})
}

// submitServeToChainSync constructs a single-entry MsgSubmitServeBatch and
// broadcasts it. Errors are logged and the Postgres row is left as 'pending'
// — never propagated to the HTTP caller. The contributor wallet is resolved
// from the members table; absence is logged but does not block submission
// because the chain accepts an empty contributor_wallet on a serve entry
// (the chain x/serve keeper treats empty wallet as "no wallet on file").
func submitServeToChainSync(ctx context.Context, cc *chain.GrpcClient, p poolType, orgID string, record *serves.ServeEventRecord) {
	memHash, err := hex.DecodeString(record.MemoryContentHash)
	if err != nil || len(memHash) != 32 {
		slog.Error("invalid memory_content_hash on just-recorded serve; cannot relay",
			"id", record.ID, "memory_content_hash", record.MemoryContentHash, "err", err)
		return
	}
	nullifier, err := hex.DecodeString(record.Nullifier)
	if err != nil || len(nullifier) != 32 {
		slog.Error("invalid nullifier on just-recorded serve; cannot relay",
			"id", record.ID, "nullifier", record.Nullifier, "err", err)
		return
	}
	if len(record.MatchedKeywords) == 0 {
		// RecordServe already enforces non-empty matched_keywords; defensive log.
		slog.Error("empty matched_keywords on just-recorded serve; cannot relay",
			"id", record.ID)
		return
	}

	wallet := record.ContributorWallet
	if wallet == "" {
		// Resolve from members; wallet may be NULL for non-leader members.
		if w, lookupErr := members.GetWalletAddress(ctx, p, orgID, record.ContributorID); lookupErr == nil && w != nil {
			wallet = *w
		}
	}

	entry := chain.ServeEntryInput{
		MemoryContentHash: memHash,
		ServeKey:          record.ServeKey,
		ContributorID:     record.ContributorID,
		ContributorWallet: wallet,
		Nullifier:         nullifier,
		ModelID:           record.ModelID,
		TurnCount:         uint32(record.TurnCount),
		MatchedKeywords:   record.MatchedKeywords,
	}

	txHash, err := cc.SubmitServeBatch(ctx, orgID, uint64(record.EpochID), []chain.ServeEntryInput{entry})
	if err != nil {
		slog.Error("synchronous serve chain submission failed; row left as pending",
			"org_id", orgID, "serve_id", record.ID, "memory_cid", record.MemoryContentHash,
			"epoch", record.EpochID, "err", err)
		return
	}
	if markErr := serves.MarkServesSubmitted(ctx, p, []int64{record.ID}, txHash); markErr != nil {
		slog.Error("mark serve submitted failed (chain TX already broadcast)",
			"org_id", orgID, "serve_id", record.ID, "tx_hash", txHash, "err", markErr)
		return
	}
	slog.Info("synchronous serve submitted to chain",
		"org_id", orgID, "serve_id", record.ID, "memory_cid", record.MemoryContentHash,
		"epoch", record.EpochID, "tx_hash", txHash)
}

// poolType is the concrete pgxpool.Pool type used throughout the handlers
// package. Declared as a named alias so submitServe/DenialToChainSync read
// clearly without re-importing pgxpool here.
type poolType = *pgxpool.Pool

func RecordDenialEvent(w http.ResponseWriter, r *http.Request) {
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

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role == "" {
		http.Error(w, `{"error":"forbidden: org member required"}`, http.StatusForbidden)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		MemoryHash string `json:"memory_hash"`
		Nullifier  string `json:"nullifier"`
		Reason     string `json:"reason"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	epoch, err := orgs.GetCurrentEpoch(r.Context(), pool, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	record, err := serves.RecordDenial(r.Context(), pool, serves.RecordDenialRequest{
		OrgID:             orgID,
		EpochID:           epoch,
		MemoryContentHash: req.MemoryHash,
		Nullifier:         req.Nullifier,
		Reason:            req.Reason,
	}, signed.Pubkey)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "duplicate") {
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, errMsg), http.StatusConflict)
			return
		}
		if strings.Contains(errMsg, "memory_content_hash") || strings.Contains(errMsg, "nullifier") || strings.Contains(errMsg, "reason") {
			http.Error(w, fmt.Sprintf(`{"error":"validation: %s"}`, errMsg), http.StatusBadRequest)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	// Synchronous chain relay (CO-035 R-SYNC-RELAY): same pattern as serves.
	if chainClient != nil {
		submitDenialToChainSync(r.Context(), chainClient, pool, orgID, record)
	} else {
		slog.Warn("chain client not configured; denial recorded to Postgres only",
			"org_id", orgID, "denial_id", record.ID)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "recorded",
		"nullifier": record.Nullifier,
	})
}

// submitDenialToChainSync constructs a single-entry MsgSubmitDenialBatch and
// broadcasts it. Mirrors submitServeToChainSync — failures are logged, the
// Postgres row remains 'pending' for a future retry sweep, HTTP response is
// unaffected.
func submitDenialToChainSync(ctx context.Context, cc *chain.GrpcClient, p poolType, orgID string, record *serves.ServeEventRecord) {
	memHash, err := hex.DecodeString(record.MemoryContentHash)
	if err != nil || len(memHash) != 32 {
		slog.Error("invalid memory_content_hash on just-recorded denial; cannot relay",
			"id", record.ID, "memory_content_hash", record.MemoryContentHash, "err", err)
		return
	}
	nullifier, err := hex.DecodeString(record.Nullifier)
	if err != nil || len(nullifier) != 32 {
		slog.Error("invalid nullifier on just-recorded denial; cannot relay",
			"id", record.ID, "nullifier", record.Nullifier, "err", err)
		return
	}
	if record.Reason == "" {
		slog.Error("empty reason on just-recorded denial; cannot relay",
			"id", record.ID)
		return
	}

	// RecordDenial stores reporter_pubkey in the serve_key column for denial
	// rows (serves.go INSERT). Chain-side validation requires deny_key
	// non-empty; reporter_pubkey is the natural fit.
	denyKey := record.ServeKey
	if denyKey == "" {
		denyKey = record.ReporterPubkey
	}

	entry := chain.DenialEntryInput{
		MemoryHash:      memHash,
		Nullifier:       nullifier,
		DenyKey:         denyKey,
		Reason:          record.Reason,
		MatchedKeywords: record.MatchedKeywords,
	}

	txHash, err := cc.SubmitDenialBatch(ctx, orgID, uint64(record.EpochID), []chain.DenialEntryInput{entry})
	if err != nil {
		slog.Error("synchronous denial chain submission failed; row left as pending",
			"org_id", orgID, "denial_id", record.ID, "memory_cid", record.MemoryContentHash,
			"epoch", record.EpochID, "err", err)
		return
	}
	if markErr := serves.MarkDenialsSubmitted(ctx, p, []int64{record.ID}, txHash); markErr != nil {
		slog.Error("mark denial submitted failed (chain TX already broadcast)",
			"org_id", orgID, "denial_id", record.ID, "tx_hash", txHash, "err", markErr)
		return
	}
	slog.Info("synchronous denial submitted to chain",
		"org_id", orgID, "denial_id", record.ID, "memory_cid", record.MemoryContentHash,
		"epoch", record.EpochID, "tx_hash", txHash)
}
