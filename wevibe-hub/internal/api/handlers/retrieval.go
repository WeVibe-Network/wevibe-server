package handlers

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/receipts"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const defaultTrialDailyQueryLimit = 5

func QueryMemories(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req protocol.QueryRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.OrgID == "" || req.AgentPubkey == "" {
		http.Error(w, `{"error":"missing required fields"}`, http.StatusBadRequest)
		return
	}

	if req.PrePubkey == "" {
		http.Error(w, `{"error":"pre_pubkey is required for PRE retrieval"}`, http.StatusBadRequest)
		return
	}

	if req.Limit <= 0 {
		req.Limit = 10
	}

	ctx := r.Context()

	member, err := members.GetMember(ctx, pool, req.OrgID, req.AgentPubkey)
	if err != nil {
		http.Error(w, `{"error":"not a member of this org"}`, http.StatusForbidden)
		return
	}

	isTrial, trialExpiresAt, err := members.GetTrialStatus(ctx, pool, req.OrgID, req.AgentPubkey)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if isTrial {
		if trialExpiresAt != nil && time.Now().After(*trialExpiresAt) {
			http.Error(w, `{"error":"Trial expired. Contact org leader to upgrade."}`, http.StatusForbidden)
			return
		}

		trialDailyLimit, limitErr := getTrialDailyQueryLimit(ctx, pool, req.OrgID)
		if limitErr != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}

		queryCount, countErr := getTodayMemberQueryCount(ctx, pool, req.OrgID, req.AgentPubkey)
		if countErr != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
		if queryCount >= trialDailyLimit {
			http.Error(w, `{"error":"trial daily query limit reached"}`, http.StatusForbidden)
			return
		}
	} else if !member.MembershipActive {
		// Non-trial members must hold an active subscription. Trial members are
		// governed by the orthogonal trial path above (expiry + daily limit).
		http.Error(w, `{"error":"membership not active — subscribe to query"}`, http.StatusForbidden)
		return
	}

	currentEpoch, err := orgs.GetCurrentEpoch(ctx, pool, req.OrgID)
	if err != nil {
		http.Error(w, `{"error":"failed to resolve epoch access"}`, http.StatusInternalServerError)
		return
	}

	accessibleEpochs := make([]int32, 0, currentEpoch-member.HistoryAccessFromEpoch+1)
	for e := member.HistoryAccessFromEpoch; e <= currentEpoch; e++ {
		accessibleEpochs = append(accessibleEpochs, int32(e))
	}

	if len(req.KeywordWeights) == 0 && len(req.Vector) == 0 {
		http.Error(w, `{"error":"keywords or vector required"}`, http.StatusBadRequest)
		return
	}

	results, contested, err := retrieval.QueryByKeywords(
		ctx, qdrantClient, req.OrgID, accessibleEpochs,
		req.KeywordWeights, req.Vector, req.EmbeddingModelID, uint64(req.Limit), req.IncludeDormant,
	)
	if err != nil {
		http.Error(w, `{"error":"query failed"}`, http.StatusInternalServerError)
		return
	}

	contentHashes := make([][]byte, 0, len(results))
	cidToIndex := make(map[string]int, len(results))
	for i, res := range results {
		hashBytes, err := hex.DecodeString(res.CID)
		if err != nil {
			log.Printf("ERROR: malformed CID %s, skipping", res.CID)
			continue
		}
		contentHashes = append(contentHashes, hashBytes)
		cidToIndex[res.CID] = i
	}

	if len(contentHashes) == 0 {
		receipt, _ := receipts.CreateReceipt(
			ctx, pool, nodePrivkeyHex,
			req.OrgID, 0, accessibleEpochs,
			req.AgentPubkey, map[string]any{"query": "memory_query"},
			[]string{}, req.AgentSig,
		)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(protocol.QueryResponse{Results: []protocol.MemoryResult{}, Contested: false, ReceiptID: receipt.ReceiptID})
		return
	}

	chainMemories, notFound, err := chainClient.GetMemoriesBatch(ctx, req.OrgID, contentHashes)
	if err != nil {
		log.Printf("ERROR: chain batch query failed for org %s: %v", req.OrgID, err)
		http.Error(w, `{"error":"chain unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	if len(notFound) > 0 {
		log.Printf("WARNING: %d memories in qdrant not on chain (org=%s)", len(notFound), req.OrgID)
	}

	chainMap := make(map[string]chain.MemoryBatchResult, len(chainMemories))
	for _, cm := range chainMemories {
		chainMap[hex.EncodeToString(cm.ContentHash)] = cm
	}

	type umbralPayload struct {
		capsule    []byte
		ciphertext []byte
	}
	umbralByCID := make(map[string]umbralPayload, len(results))
	if len(results) > 0 {
		cids := make([]string, 0, len(results))
		for _, res := range results {
			cids = append(cids, res.CID)
		}

		rows, err := pool.Query(ctx, `
			SELECT submission_hash, umbral_capsule, umbral_ciphertext
			FROM pending_submissions
			WHERE org_id = $1 AND status = $2 AND submission_hash = ANY($3)
		`, req.OrgID, protocol.SubmissionStatusCommitted, cids)
		if err != nil {
			http.Error(w, `{"error":"query failed"}`, http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		for rows.Next() {
			var cid string
			var capsule []byte
			var ciphertext []byte
			if err := rows.Scan(&cid, &capsule, &ciphertext); err != nil {
				http.Error(w, `{"error":"query failed"}`, http.StatusInternalServerError)
				return
			}
			umbralByCID[cid] = umbralPayload{capsule: capsule, ciphertext: ciphertext}
		}
		if err := rows.Err(); err != nil {
			http.Error(w, `{"error":"query failed"}`, http.StatusInternalServerError)
			return
		}
	}

	memberPKBytes, err := hex.DecodeString(req.PrePubkey)
	if err != nil {
		http.Error(w, `{"error":"invalid pre_pubkey format"}`, http.StatusBadRequest)
		return
	}

	merged := make([]protocol.MemoryResult, 0, len(results))
	requiresReencryption := make([]string, 0)
	for _, res := range results {
		cm, ok := chainMap[res.CID]
		if !ok {
			continue
		}
		if !protocol.IsValidMemoryType(cm.MemoryType) {
			http.Error(w, `{"error":"invalid memory_type from chain"}`, http.StatusInternalServerError)
			return
		}
		res.ChainAttested = true
		res.MemoryType = cm.MemoryType

		payload := umbralByCID[res.CID]
		if len(payload.ciphertext) > 0 {
			res.UmbralCiphertext = hex.EncodeToString(payload.ciphertext)
		}

		if len(payload.capsule) == 0 || umbralService == nil {
			requiresReencryption = append(requiresReencryption, res.CID)
			merged = append(merged, res)
			continue
		}

		cfrag, err := umbralService.ReEncryptForMember(ctx, req.OrgID, uint64(cm.Epoch), memberPKBytes, payload.capsule)
		if err != nil {
			log.Printf("WARNING: re-encryption failed for cid=%s org=%s epoch=%d: %v", res.CID, req.OrgID, cm.Epoch, err)
			requiresReencryption = append(requiresReencryption, res.CID)
			merged = append(merged, res)
			continue
		}
		res.Capsule = hex.EncodeToString(payload.capsule)
		res.Cfrag = hex.EncodeToString(cfrag)

		merged = append(merged, res)
	}
	results = merged

	if len(results) > 0 {
		cids := make([]string, 0, len(results))
		for _, r := range results {
			cids = append(cids, r.CID)
		}
		var bannedCIDs []string
		if dbErr := pool.QueryRow(ctx, `
			SELECT ARRAY_AGG(submission_hash) FROM pending_submissions
			WHERE submission_hash = ANY($1) AND banned = TRUE
		`, cids).Scan(&bannedCIDs); dbErr == nil && len(bannedCIDs) > 0 {
			bannedSet := make(map[string]bool, len(bannedCIDs))
			for _, c := range bannedCIDs {
				bannedSet[c] = true
			}
			filtered := make([]protocol.MemoryResult, 0, len(results))
			for _, r := range results {
				if !bannedSet[r.CID] {
					filtered = append(filtered, r)
				}
			}
			results = filtered
		}
	}

	if len(results) > 0 {
		contributorStats := make(map[string]*protocol.ContributorStats)
		for i := range results {
			cm, ok := chainMap[results[i].CID]
			if !ok {
				continue
			}
			acceptCount, _ := retrieval.GetAcceptanceCount(ctx, pool, req.OrgID, results[i].CID)
			results[i].AcceptanceCount = acceptCount

			stats, ok := contributorStats[cm.ContributorPubkey]
			if !ok {
				stats, err = retrieval.GetContributorStats(ctx, pool, chainClient, req.OrgID, cm.ContributorPubkey)
				if err == nil {
					contributorStats[cm.ContributorPubkey] = stats
				}
			}
			if stats != nil {
				results[i].ContributorStats = stats
			}
		}
	}

	receipt, err := receipts.CreateReceipt(
		ctx, pool, nodePrivkeyHex,
		req.OrgID, 0, accessibleEpochs,
		req.AgentPubkey, map[string]any{"query": "memory_query"},
		extractCIDs(results), req.AgentSig,
	)
	if err != nil {
		http.Error(w, `{"error":"receipt failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(protocol.QueryResponse{
		Results:              results,
		Contested:            contested,
		ReceiptID:            receipt.ReceiptID,
		RequiresReencryption: requiresReencryption,
	})
}

func ListMemories(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	limit := 50
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if parsed, err := strconv.Atoi(limitStr); err == nil && parsed > 0 && parsed <= 200 {
			limit = parsed
		}
	}

	offsetToken := r.URL.Query().Get("offset")

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil || time.Since(ts).Abs() > 5*time.Minute {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	if _, err := members.GetMember(r.Context(), pool, orgID, signed.Pubkey); err != nil {
		http.Error(w, `{"error":"not a member of this org"}`, http.StatusForbidden)
		return
	}

	results, nextOffset, err := retrieval.ScrollApprovedMemories(r.Context(), qdrantClient, orgID, uint64(limit), offsetToken)
	if err != nil {
		if errors.Is(err, retrieval.ErrInvalidOffset) {
			http.Error(w, `{"error":"invalid offset"}`, http.StatusBadRequest)
			return
		}
		http.Error(w, `{"error":"list failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"memories":    results,
		"count":       len(results),
		"next_offset": nextOffset,
	})
}

func getTrialDailyQueryLimit(ctx context.Context, pool *pgxpool.Pool, orgID string) (int, error) {
	trialDailyLimit := defaultTrialDailyQueryLimit
	var configuredLimit *string
	err := pool.QueryRow(ctx, `
		SELECT fee_model->>'trial_daily_query_limit'
		FROM orgs
		WHERE org_id = $1
	`, orgID).Scan(&configuredLimit)
	if err != nil {
		return 0, err
	}
	if configuredLimit == nil {
		return trialDailyLimit, nil
	}

	parsedLimit, parseErr := strconv.Atoi(*configuredLimit)
	if parseErr != nil || parsedLimit < 1 {
		return trialDailyLimit, nil
	}

	return parsedLimit, nil
}

func getTodayMemberQueryCount(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string) (int, error) {
	var count int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM usage_receipts
		WHERE org_id = $1
		  AND agent_pubkey = $2
		  AND created_at >= date_trunc('day', NOW())
	`, orgID, pubkey).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

func GetMemory(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	cid := chi.URLParam(r, "cid")
	if orgID == "" || cid == "" {
		http.Error(w, `{"error":"org_id and cid required"}`, http.StatusBadRequest)
		return
	}

	hashBytes, err := hex.DecodeString(cid)
	if err != nil {
		http.Error(w, `{"error":"invalid cid format"}`, http.StatusBadRequest)
		return
	}

	chainMems, _, err := chainClient.GetMemoriesBatch(r.Context(), orgID, [][]byte{hashBytes})
	if err != nil {
		http.Error(w, `{"error":"chain unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	if len(chainMems) > 0 {
		cm := chainMems[0]
		if !protocol.IsValidMemoryType(cm.MemoryType) {
			http.Error(w, `{"error":"invalid memory_type from chain"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"cid":                cid,
			"org_id":             orgID,
			"epoch":              cm.Epoch,
			"encrypted_blob":     hex.EncodeToString(cm.EncryptedBlob),
			"wrapped_dek_enc":    hex.EncodeToString(cm.WrappedDekEnc),
			"contributor_pubkey": cm.ContributorPubkey,
			"state":              cm.State,
			"memory_type":        cm.MemoryType,
			"serve_count_total":  cm.ServeCountTotal,
			"denial_count_total": cm.DenialCountTotal,
			"last_active_epoch":  cm.LastActiveEpoch,
			"archived_epoch":     cm.ArchivedEpoch,
			"source":             "chain",
		})
		return
	}

	var ciphertextHex string
	var epochID int
	var memoryType string
	err = pool.QueryRow(r.Context(), `
		SELECT ciphertext_hex, epoch_id, memory_type
		FROM pending_submissions
		WHERE submission_hash = $1 AND org_id = $2 AND status = $3
	`, cid, orgID, protocol.SubmissionStatusCommitted).Scan(&ciphertextHex, &epochID, &memoryType)
	if err != nil {
		http.Error(w, `{"error":"memory not found or not approved"}`, http.StatusNotFound)
		return
	}
	if !protocol.IsValidMemoryType(memoryType) {
		http.Error(w, `{"error":"invalid memory_type in hub cache"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"cid":            cid,
		"org_id":         orgID,
		"epoch_id":       epochID,
		"ciphertext_hex": ciphertextHex,
		"memory_type":    memoryType,
	})
}

func extractCIDs(results []protocol.MemoryResult) []string {
	cids := make([]string, len(results))
	for i, res := range results {
		cids[i] = res.CID
	}
	return cids
}
