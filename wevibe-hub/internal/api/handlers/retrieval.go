package handlers

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/receipts"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const defaultTrialDailyQueryLimit = 5

func QueryMemories(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		log.Printf("[recall] ERROR query init database unavailable")
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		log.Printf("[recall] ERROR parse request body FAILED: %v", err)
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req protocol.QueryRequest
	if err := json.Unmarshal(body, &req); err != nil {
		log.Printf("[recall] ERROR parse json FAILED bodyLen=%d: %v", len(body), err)
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	agentLogID := truncateForLog(req.AgentPubkey, 12)
	log.Printf("[recall] query org=%s agent=%s vecDim=%d kw=%d model=%s limit=%d includeDormant=%v prePubkeyPresent=%v", req.OrgID, agentLogID, len(req.Vector), len(req.KeywordWeights), req.EmbeddingModelID, req.Limit, req.IncludeDormant, req.PrePubkey != "")

	if req.OrgID == "" || req.AgentPubkey == "" {
		log.Printf("[recall] DENY/ERROR missing required fields org=%s agentPresent=%v", req.OrgID, req.AgentPubkey != "")
		http.Error(w, `{"error":"missing required fields"}`, http.StatusBadRequest)
		return
	}

	if req.PrePubkey == "" {
		log.Printf("[recall] DENY/ERROR missing pre_pubkey org=%s agent=%s", req.OrgID, agentLogID)
		http.Error(w, `{"error":"pre_pubkey is required for PRE retrieval"}`, http.StatusBadRequest)
		return
	}

	if req.Limit <= 0 {
		req.Limit = 10
	}

	ctx := r.Context()

	member, err := members.GetMember(ctx, pool, req.OrgID, req.AgentPubkey)
	if err != nil {
		log.Printf("[recall] DENY/ERROR getMember org=%s agent=%s: %v", req.OrgID, agentLogID, err)
		http.Error(w, `{"error":"not a member of this org"}`, http.StatusForbidden)
		return
	}

	isTrial, trialExpiresAt, err := members.GetTrialStatus(ctx, pool, req.OrgID, req.AgentPubkey)
	if err != nil {
		log.Printf("[recall] ERROR getTrialStatus org=%s agent=%s: %v", req.OrgID, agentLogID, err)
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if isTrial {
		if trialExpiresAt != nil && time.Now().After(*trialExpiresAt) {
			log.Printf("[recall] DENY trial expired org=%s agent=%s expiresAt=%s", req.OrgID, agentLogID, trialExpiresAt.UTC().Format(time.RFC3339))
			http.Error(w, `{"error":"Trial expired. Contact org leader to upgrade."}`, http.StatusForbidden)
			return
		}

		trialDailyLimit, limitErr := getTrialDailyQueryLimit(ctx, pool, req.OrgID)
		if limitErr != nil {
			log.Printf("[recall] ERROR trial gate load limit FAILED org=%s: %v", req.OrgID, limitErr)
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}

		queryCount, countErr := getTodayMemberQueryCount(ctx, pool, req.OrgID, req.AgentPubkey)
		if countErr != nil {
			log.Printf("[recall] ERROR trial gate count queries FAILED org=%s agent=%s: %v", req.OrgID, agentLogID, countErr)
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
		if queryCount >= trialDailyLimit {
			log.Printf("[recall] DENY trial daily limit reached org=%s agent=%s count=%d limit=%d", req.OrgID, agentLogID, queryCount, trialDailyLimit)
			http.Error(w, `{"error":"trial daily query limit reached"}`, http.StatusForbidden)
			return
		}
	} else if !member.MembershipActive {
		// Non-trial members must hold an active subscription. Trial members are
		// governed by the orthogonal trial path above (expiry + daily limit).
		log.Printf("[recall] DENY inactive membership org=%s agent=%s", req.OrgID, agentLogID)
		http.Error(w, `{"error":"membership not active — subscribe to query"}`, http.StatusForbidden)
		return
	}

	currentEpoch, err := orgs.GetCurrentEpoch(ctx, pool, req.OrgID)
	if err != nil {
		log.Printf("[recall] ERROR resolve current epoch FAILED org=%s: %v", req.OrgID, err)
		http.Error(w, `{"error":"failed to resolve epoch access"}`, http.StatusInternalServerError)
		return
	}

	accessibleEpochs := make([]int32, 0, currentEpoch-member.HistoryAccessFromEpoch+1)
	for e := member.HistoryAccessFromEpoch; e <= currentEpoch; e++ {
		accessibleEpochs = append(accessibleEpochs, int32(e))
	}

	if len(req.KeywordWeights) == 0 && len(req.Vector) == 0 {
		log.Printf("[recall] DENY/ERROR empty query payload org=%s agent=%s", req.OrgID, agentLogID)
		http.Error(w, `{"error":"keywords or vector required"}`, http.StatusBadRequest)
		return
	}

	log.Printf("[recall] qdrant QueryByKeywords start org=%s agent=%s vecDim=%d kw=%d model=%s limit=%d includeDormant=%v", req.OrgID, agentLogID, len(req.Vector), len(req.KeywordWeights), req.EmbeddingModelID, req.Limit, req.IncludeDormant)
	results, contested, err := retrieval.QueryByKeywords(
		ctx, qdrantClient, req.OrgID, accessibleEpochs,
		req.KeywordWeights, req.Vector, req.EmbeddingModelID, uint64(req.Limit), req.IncludeDormant,
	)
	if err != nil {
		log.Printf("[recall] qdrant QueryByKeywords FAILED org=%s: %v", req.OrgID, err)
		http.Error(w, `{"error":"query failed"}`, http.StatusInternalServerError)
		return
	}
	log.Printf("[recall] qdrant returned %d candidates contested=%v org=%s", len(results), contested, req.OrgID)

	contentHashes := make([][]byte, 0, len(results))
	cidToIndex := make(map[string]int, len(results))
	for i, res := range results {
		hashBytes, err := hex.DecodeString(res.CID)
		if err != nil {
			log.Printf("[recall] ERROR malformed CID skipped org=%s cid=%s: %v", req.OrgID, res.CID, err)
			continue
		}
		contentHashes = append(contentHashes, hashBytes)
		cidToIndex[res.CID] = i
	}

	if len(contentHashes) == 0 {
		receipt, receiptErr := receipts.CreateReceipt(
			ctx, pool, nodePrivkeyHex,
			req.OrgID, 0, accessibleEpochs,
			req.AgentPubkey, map[string]any{"query": "memory_query"},
			[]string{}, req.AgentSig,
		)
		if receiptErr != nil {
			log.Printf("[recall] receipt CreateReceipt FAILED org=%s agent=%s zeroResults=true: %v", req.OrgID, agentLogID, receiptErr)
		}

		w.Header().Set("Content-Type", "application/json")
		log.Printf("[recall] returning %d results org=%s", 0, req.OrgID)
		if err := json.NewEncoder(w).Encode(protocol.QueryResponse{Results: []protocol.MemoryResult{}, Contested: false, ReceiptID: receipt.ReceiptID}); err != nil {
			log.Printf("[recall] ERROR encode zero-result response FAILED org=%s: %v", req.OrgID, err)
		}
		return
	}

	chainMemories, notFound, err := chainClient.GetMemoriesBatch(ctx, req.OrgID, contentHashes)
	if err != nil {
		log.Printf("[recall] ERROR chain GetMemoriesBatch FAILED org=%s hashCount=%d: %v", req.OrgID, len(contentHashes), err)
		http.Error(w, `{"error":"chain unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	if len(notFound) > 0 {
		log.Printf("[recall] WARNING qdrant-chain mismatch org=%s missingOnChain=%d", req.OrgID, len(notFound))
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
			log.Printf("[recall] ERROR load umbral payloads FAILED org=%s candidateCount=%d: %v", req.OrgID, len(cids), err)
			http.Error(w, `{"error":"query failed"}`, http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		for rows.Next() {
			var cid string
			var capsule []byte
			var ciphertext []byte
			if err := rows.Scan(&cid, &capsule, &ciphertext); err != nil {
				log.Printf("[recall] ERROR scan umbral payload row FAILED org=%s: %v", req.OrgID, err)
				http.Error(w, `{"error":"query failed"}`, http.StatusInternalServerError)
				return
			}
			umbralByCID[cid] = umbralPayload{capsule: capsule, ciphertext: ciphertext}
		}
		if err := rows.Err(); err != nil {
			log.Printf("[recall] ERROR iterate umbral payload rows FAILED org=%s: %v", req.OrgID, err)
			http.Error(w, `{"error":"query failed"}`, http.StatusInternalServerError)
			return
		}
	}

	memberPKBytes, err := hex.DecodeString(req.PrePubkey)
	if err != nil {
		log.Printf("[recall] DENY/ERROR decode pre_pubkey FAILED org=%s agent=%s: %v", req.OrgID, agentLogID, err)
		http.Error(w, `{"error":"invalid pre_pubkey format"}`, http.StatusBadRequest)
		return
	}

	merged := make([]protocol.MemoryResult, 0, len(results))
	requiresReencryption := make([]string, 0)
	reencryptedCount := 0
	for _, res := range results {
		cm, ok := chainMap[res.CID]
		if !ok {
			continue
		}
		if !protocol.IsValidMemoryType(cm.MemoryType) {
			log.Printf("[recall] ERROR invalid chain memory_type org=%s cid=%s memoryType=%s", req.OrgID, res.CID, cm.MemoryType)
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
			log.Printf("[recall] umbral ReEncrypt FAILED org=%s cid=%s epoch=%d member=%s: %v", req.OrgID, res.CID, cm.Epoch, agentLogID, err)
			requiresReencryption = append(requiresReencryption, res.CID)
			merged = append(merged, res)
			continue
		}
		res.Capsule = hex.EncodeToString(payload.capsule)
		res.Cfrag = hex.EncodeToString(cfrag)
		reencryptedCount++

		merged = append(merged, res)
	}
	results = merged
	log.Printf("[recall] umbral re-encryption complete org=%s reencrypted=%d requiresReencryption=%d total=%d", req.OrgID, reencryptedCount, len(requiresReencryption), len(results))

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
		log.Printf("[recall] receipt CreateReceipt FAILED org=%s agent=%s zeroResults=false: %v", req.OrgID, agentLogID, err)
		http.Error(w, `{"error":"receipt failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	log.Printf("[recall] returning %d results org=%s", len(results), req.OrgID)
	if err := json.NewEncoder(w).Encode(protocol.QueryResponse{
		Results:              results,
		Contested:            contested,
		ReceiptID:            receipt.ReceiptID,
		RequiresReencryption: requiresReencryption,
	}); err != nil {
		log.Printf("[recall] ERROR encode query response FAILED org=%s: %v", req.OrgID, err)
	}
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

func truncateForLog(value string, max int) string {
	if max <= 0 || len(value) <= max {
		return value
	}
	return value[:max]
}
