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

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/serves"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
	"github.com/go-chi/chi/v5"
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
			strings.Contains(errMsg, "epoch_id") {
			http.Error(w, fmt.Sprintf(`{"error":"validation: %s"}`, errMsg), http.StatusBadRequest)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "recorded",
		"nullifier": record.Nullifier,
	})
}

func BatchSubmitServes(w http.ResponseWriter, r *http.Request) {
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
		http.Error(w, `{"error":"invalid timestamp format, use RFC3339"}`, http.StatusBadRequest)
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

	epoch, err := orgs.GetCurrentEpoch(r.Context(), pool, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	pending, err := serves.GetPendingServes(r.Context(), pool, orgID, 100)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if len(pending) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"submitted": 0,
			"message":   "no pending serves",
		})
		return
	}

	entries := make([]chain.ServeEntryInput, len(pending))
	ids := make([]int64, len(pending))
	for i, p := range pending {
		entries[i] = chain.ServeEntryInput{
			ServeKey:          p.ServeKey,
			ContributorID:     p.ContributorID,
			ContributorWallet: p.ContributorWallet,
			ModelID:           p.ModelID,
			TurnCount:         uint32(p.TurnCount),
		}
		entries[i].MemoryContentHash, err = hex.DecodeString(p.MemoryContentHash)
		if err != nil {
			log.Printf("invalid memory_content_hash for serve event %d: %v", p.ID, err)
			ids = append(ids[:len(ids)-1], ids[len(ids)-1:]...)
			continue
		}
		entries[i].Nullifier, err = hex.DecodeString(p.Nullifier)
		if err != nil {
			log.Printf("invalid nullifier for serve event %d: %v", p.ID, err)
			continue
		}
		ids[i] = p.ID
	}

	var validEntries []chain.ServeEntryInput
	var validIDs []int64
	var validMemoryCIDs []string
	for i := range entries {
		if len(entries[i].MemoryContentHash) == 32 && len(entries[i].Nullifier) == 32 {
			validEntries = append(validEntries, entries[i])
			validIDs = append(validIDs, ids[i])
			validMemoryCIDs = append(validMemoryCIDs, pending[i].MemoryContentHash)
		}
	}

	if len(validEntries) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"submitted": 0,
			"message":   "no valid serves to submit",
		})
		return
	}

	txHash, err := chainClient.SubmitServeBatch(r.Context(), orgID, uint64(epoch), validEntries)
	if err != nil {
		log.Printf("SubmitServeBatch failed: %v", err)
		if markErr := serves.MarkFailed(r.Context(), pool, validIDs); markErr != nil {
			log.Printf("MarkFailed failed: %v", markErr)
		}
		http.Error(w, fmt.Sprintf(`{"error":"chain submission failed: %s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	if err := serves.MarkSubmitted(r.Context(), pool, validIDs, txHash); err != nil {
		log.Printf("MarkSubmitted failed: %v", err)
	}

	seen := make(map[string]bool)
	for _, cid := range validMemoryCIDs {
		if seen[cid] {
			continue
		}
		seen[cid] = true
		if boostErr := retrieval.ApplyServeBoostLocal(r.Context(), pool, cid, orgID); boostErr != nil {
			log.Printf("ApplyServeBoostLocal failed for cid %s: %v", cid, boostErr)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"submitted": len(validEntries),
		"tx_hash":   txHash,
		"failed":    0,
	})
}

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

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "recorded",
		"nullifier": record.Nullifier,
	})
}

func BatchSubmitDenials(w http.ResponseWriter, r *http.Request) {
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
		http.Error(w, `{"error":"invalid timestamp format, use RFC3339"}`, http.StatusBadRequest)
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

	epoch, err := orgs.GetCurrentEpoch(r.Context(), pool, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	pending, err := serves.GetPendingDenials(r.Context(), pool, orgID, 100)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if len(pending) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"submitted": 0,
			"message":   "no pending denials",
		})
		return
	}

	validEntries := make([]chain.DenialEntryInput, 0, len(pending))
	validIDs := make([]int64, 0, len(pending))
	validMemoryCIDs := make([]string, 0, len(pending))
	for _, p := range pending {
		memoryHash, err := hex.DecodeString(p.MemoryContentHash)
		if err != nil {
			log.Printf("invalid memory_content_hash for denial event %d: %v", p.ID, err)
			continue
		}
		nullifier, err := hex.DecodeString(p.Nullifier)
		if err != nil {
			log.Printf("invalid nullifier for denial event %d: %v", p.ID, err)
			continue
		}
		if len(memoryHash) != 32 || len(nullifier) != 32 {
			log.Printf("invalid hash/nullifier length for denial event %d", p.ID)
			continue
		}

		validEntries = append(validEntries, chain.DenialEntryInput{
			MemoryHash: memoryHash,
			Nullifier:  nullifier,
			DenyKey:    p.ReporterPubkey,
			Reason:     p.Reason,
		})
		validIDs = append(validIDs, p.ID)
		validMemoryCIDs = append(validMemoryCIDs, p.MemoryContentHash)
	}

	if len(validEntries) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"submitted": 0,
			"message":   "no valid denials to submit",
		})
		return
	}

	txHash, err := chainClient.SubmitDenialBatch(r.Context(), orgID, uint64(epoch), validEntries)
	if err != nil {
		log.Printf("SubmitDenialBatch failed: %v", err)
		if markErr := serves.MarkFailed(r.Context(), pool, validIDs); markErr != nil {
			log.Printf("MarkFailed failed: %v", markErr)
		}
		http.Error(w, fmt.Sprintf(`{"error":"chain submission failed: %s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	if err := serves.MarkSubmitted(r.Context(), pool, validIDs, txHash); err != nil {
		log.Printf("MarkSubmitted failed: %v", err)
	}

	seen := make(map[string]bool)
	for _, cid := range validMemoryCIDs {
		if seen[cid] {
			continue
		}
		seen[cid] = true
		if decayErr := retrieval.ApplyDenialDecayLocal(r.Context(), pool, cid, orgID); decayErr != nil {
			log.Printf("ApplyDenialDecayLocal failed for cid %s: %v", cid, decayErr)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"submitted": len(validEntries),
		"tx_hash":   txHash,
		"failed":    0,
	})
}
