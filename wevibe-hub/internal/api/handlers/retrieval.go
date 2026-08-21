package handlers

import (
	"context"
	"crypto/ed25519"
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
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/receipts"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
)

const defaultTrialDailyQueryLimit = 5

func QueryMemories(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		log.Printf("[recall] ERROR query init database unavailable")
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	trace := wlog.TraceFromContext(r.Context())

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		log.Printf("[recall] ERROR parse request body FAILED: %v", err)
		WriteError(w, http.StatusBadRequest, "invalid_request", "bad request")
		return
	}

	bodySignatureHex := r.Header.Get("X-Agent-Signature")
	if bodySignatureHex == "" {
		log.Printf("[recall] DENY missing X-Agent-Signature header")
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	bodySignatureBytes, err := hex.DecodeString(bodySignatureHex)
	if err != nil || len(bodySignatureBytes) != ed25519.SignatureSize {
		log.Printf("[recall] DENY invalid X-Agent-Signature format: %v", err)
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	authenticatedAgentPubkey := auth.GetMemberPubkey(r.Context())
	if authenticatedAgentPubkey == "" {
		var pubkeyPayload struct {
			AgentPubkey string `json:"agent_pubkey"`
		}
		if err := json.Unmarshal(bodyBytes, &pubkeyPayload); err != nil {
			log.Printf("[recall] ERROR parse json FAILED bodyLen=%d: %v", len(bodyBytes), err)
			WriteError(w, http.StatusBadRequest, "invalid_json", "invalid json")
			return
		}
		authenticatedAgentPubkey = pubkeyPayload.AgentPubkey
	}

	if authenticatedAgentPubkey == "" {
		log.Printf("[recall] DENY missing authenticated agent pubkey for body-signature verification")
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	agentPubkeyBytes, err := hex.DecodeString(authenticatedAgentPubkey)
	if err != nil || len(agentPubkeyBytes) != ed25519.PublicKeySize {
		log.Printf("[recall] DENY invalid authenticated agent pubkey format: %v", err)
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	if !ed25519.Verify(ed25519.PublicKey(agentPubkeyBytes), bodyBytes, bodySignatureBytes) {
		log.Printf("[recall] DENY X-Agent-Signature verification failed agent=%s", truncateForLog(authenticatedAgentPubkey, 12))
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	var req protocol.QueryRequest
	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		log.Printf("[recall] ERROR parse json FAILED bodyLen=%d: %v", len(bodyBytes), err)
		WriteError(w, http.StatusBadRequest, "invalid_json", "invalid json")
		return
	}

	if req.AgentPubkey != "" && req.AgentPubkey != authenticatedAgentPubkey {
		log.Printf("[recall] DENY agent_pubkey mismatch body=%s auth=%s", truncateForLog(req.AgentPubkey, 12), truncateForLog(authenticatedAgentPubkey, 12))
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	agentLogID := truncateForLog(req.AgentPubkey, 12)
	log.Printf("[recall] query org=%s agent=%s vecDim=%d kw=%d model=%s limit=%d includeDormant=%v prePubkeyPresent=%v trace=%s", req.OrgID, agentLogID, len(req.Vector), len(req.KeywordWeights), req.EmbeddingModelID, req.Limit, req.IncludeDormant, req.PrePubkey != "", trace)

	if req.OrgID == "" || req.AgentPubkey == "" {
		log.Printf("[recall] DENY/ERROR missing required fields org=%s agentPresent=%v", req.OrgID, req.AgentPubkey != "")
		WriteError(w, http.StatusBadRequest, "invalid_request", "missing required fields")
		return
	}

	if req.PrePubkey == "" {
		log.Printf("[recall] DENY/ERROR missing pre_pubkey org=%s agent=%s", req.OrgID, agentLogID)
		WriteError(w, http.StatusBadRequest, "pre_pubkey_required", "pre_pubkey is required for PRE retrieval")
		return
	}

	if req.Limit <= 0 {
		if recallModeIsTest() {
			req.Limit = 1000
		} else {
			req.Limit = 3
		}
	}

	effectiveFloor, effectiveBudget, defaultedFields := resolveRecallGovernor(req.RelevanceFloor, req.SurfaceBudget)
	if len(defaultedFields) > 0 {
		log.Printf("[recall] WARNING recall governor defaults applied org=%s agent=%s defaulted=%v floor=%.4f budget=%d test_mode=%v", req.OrgID, agentLogID, defaultedFields, effectiveFloor, effectiveBudget, recallModeIsTest())
	}

	ctx := r.Context()
	if recallModeIsTest() {
		log.Printf("[recall] TEST MODE bypass throttles org=%s agent=%s", req.OrgID, agentLogID)
	}

	member, err := members.GetMember(ctx, pool, req.OrgID, req.AgentPubkey)
	if err != nil {
		log.Printf("[recall] DENY/ERROR getMember org=%s agent=%s: %v", req.OrgID, agentLogID, err)
		WriteError(w, http.StatusForbidden, "not_a_member", "not a member of this org")
		return
	}

	isTrial, trialExpiresAt, err := members.GetTrialStatus(ctx, pool, req.OrgID, req.AgentPubkey)
	if err != nil {
		log.Printf("[recall] ERROR getTrialStatus org=%s agent=%s: %v", req.OrgID, agentLogID, err)
		WriteError(w, http.StatusInternalServerError, "internal_error", "internal error", err.Error())
		return
	}
	if isTrial {
		if trialExpiresAt != nil && time.Now().After(*trialExpiresAt) {
			log.Printf("[recall] DENY trial expired org=%s agent=%s expiresAt=%s", req.OrgID, agentLogID, trialExpiresAt.UTC().Format(time.RFC3339))
			WriteError(w, http.StatusForbidden, "trial_expired", "Trial expired. Contact org leader to upgrade.")
			return
		}

		if !recallModeIsTest() {
			trialDailyLimit, limitErr := getTrialDailyQueryLimit(ctx, pool, req.OrgID)
			if limitErr != nil {
				log.Printf("[recall] ERROR trial gate load limit FAILED org=%s: %v", req.OrgID, limitErr)
				WriteError(w, http.StatusInternalServerError, "internal_error", "internal error", limitErr.Error())
				return
			}

			queryCount, countErr := getTodayMemberQueryCount(ctx, pool, req.OrgID, req.AgentPubkey)
			if countErr != nil {
				log.Printf("[recall] ERROR trial gate count queries FAILED org=%s agent=%s: %v", req.OrgID, agentLogID, countErr)
				WriteError(w, http.StatusInternalServerError, "internal_error", "internal error", countErr.Error())
				return
			}
			if queryCount >= trialDailyLimit {
				log.Printf("[recall] DENY trial daily limit reached org=%s agent=%s count=%d limit=%d", req.OrgID, agentLogID, queryCount, trialDailyLimit)
				WriteError(w, http.StatusForbidden, "trial_limit", "trial daily query limit reached")
				return
			}
		}
	} else if !member.MembershipActive {
		// Non-trial members must hold an active subscription. Trial members are
		// governed by the orthogonal trial path above (expiry + daily limit).
		log.Printf("[recall] DENY inactive membership org=%s agent=%s", req.OrgID, agentLogID)
		WriteError(w, http.StatusForbidden, "membership_inactive", "membership not active — subscribe to query")
		return
	}

	if !recallModeIsTest() {
		var maxRequests int
		var windowSeconds int
		err = pool.QueryRow(ctx, `
			SELECT max_requests, window_seconds
			FROM org_recall_rate_limits
			WHERE org_id = $1
		`, req.OrgID).Scan(&maxRequests, &windowSeconds)
		if err == nil {
			if maxRequests > 0 {
				recentCount, countErr := getRecentMemberQueryCount(ctx, pool, req.OrgID, req.AgentPubkey, windowSeconds)
				if countErr != nil {
					log.Printf("[recall] ERROR rate limit count queries FAILED org=%s agent=%s windowSeconds=%d: %v (fail-open)", req.OrgID, agentLogID, windowSeconds, countErr)
				} else if recentCount >= maxRequests {
					log.Printf("[recall] DENY recall rate limit reached org=%s agent=%s count=%d max=%d windowSeconds=%d", req.OrgID, agentLogID, recentCount, maxRequests, windowSeconds)
					WriteError(
						w,
						http.StatusTooManyRequests,
						"rate_limited",
						"recall rate limit exceeded",
						fmt.Sprintf("max %d requests per %d seconds", maxRequests, windowSeconds),
					)
					return
				}
			}
		} else if err != pgx.ErrNoRows {
			log.Printf("[recall] ERROR rate limit load config FAILED org=%s: %v (fail-open)", req.OrgID, err)
		}
	}

	if len(req.KeywordWeights) == 0 && len(req.Vector) == 0 {
		log.Printf("[recall] DENY/ERROR empty query payload org=%s agent=%s", req.OrgID, agentLogID)
		WriteError(w, http.StatusBadRequest, "invalid_request", "keywords or vector required")
		return
	}

	log.Printf("[recall] qdrant QueryByKeywords start org=%s agent=%s vecDim=%d kw=%d model=%s limit=%d includeDormant=%v", req.OrgID, agentLogID, len(req.Vector), len(req.KeywordWeights), req.EmbeddingModelID, req.Limit, req.IncludeDormant)
	results, contested, scorecard, err := retrieval.QueryByKeywords(
		ctx, qdrantClient, req.OrgID,
		req.KeywordWeights, req.Vector, req.EmbeddingModelID, uint64(req.Limit), req.IncludeDormant, effectiveFloor, effectiveBudget,
	)
	if err != nil {
		log.Printf("[recall] qdrant QueryByKeywords FAILED org=%s: %v", req.OrgID, err)
		WriteError(w, http.StatusInternalServerError, "query_failed", "query failed", err.Error())
		return
	}
	log.Printf("[recall] qdrant returned %d candidates contested=%v org=%s", len(results), contested, req.OrgID)
	persistRecallQueryLog(req, scorecard, contested, effectiveFloor, effectiveBudget)

	if req.SessionID != "" && len(results) > 0 {
		rows, err := pool.Query(ctx, `
			SELECT memory_cid FROM session_served_memories
			WHERE org_id = $1 AND session_id = $2 AND served_at > NOW() - INTERVAL '24 hours'
		`, req.OrgID, req.SessionID)
		if err == nil {
			served := make(map[string]struct{})
			for rows.Next() {
				var cid string
				if rows.Scan(&cid) == nil {
					served[cid] = struct{}{}
				}
			}
			rows.Close()
			filtered := results[:0]
			for _, m := range results {
				if _, ok := served[m.CID]; ok {
					continue
				}
				filtered = append(filtered, m)
			}
			results = filtered
		}
	}

	if len(results) == 0 {
		receipt, receiptErr := receipts.CreateReceipt(
			ctx, pool, nodePrivkeyHex,
			req.OrgID, 0, []int32{0},
			req.AgentPubkey, map[string]any{"query": "memory_query"},
			[]string{}, bodySignatureHex,
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

	chainHashes := make([][]byte, 0, len(results))
	for _, res := range results {
		hashBytes, err := hex.DecodeString(res.CID)
		if err != nil {
			log.Printf("[recall] ERROR invalid candidate cid org=%s cid=%s: %v", req.OrgID, res.CID, err)
			WriteError(w, http.StatusInternalServerError, "query_failed", "query failed", err.Error())
			return
		}
		chainHashes = append(chainHashes, hashBytes)
	}
	chainRecs, _, err := chainClient.GetMemoriesBatch(ctx, req.OrgID, chainHashes)
	if err != nil {
		log.Printf("[recall] ERROR chain GetMemoriesBatch FAILED org=%s: %v", req.OrgID, err)
		WriteError(w, http.StatusServiceUnavailable, "chain_unavailable", "chain unavailable")
		return
	}

	chainMap := make(map[string]chain.MemoryBatchResult, len(chainRecs))
	for _, cm := range chainRecs {
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
			WriteError(w, http.StatusInternalServerError, "query_failed", "query failed", err.Error())
			return
		}
		defer rows.Close()

		for rows.Next() {
			var cid string
			var capsule []byte
			var ciphertext []byte
			if err := rows.Scan(&cid, &capsule, &ciphertext); err != nil {
				log.Printf("[recall] ERROR scan umbral payload row FAILED org=%s: %v", req.OrgID, err)
				WriteError(w, http.StatusInternalServerError, "query_failed", "query failed", err.Error())
				return
			}
			umbralByCID[cid] = umbralPayload{capsule: capsule, ciphertext: ciphertext}
		}
		if err := rows.Err(); err != nil {
			log.Printf("[recall] ERROR iterate umbral payload rows FAILED org=%s: %v", req.OrgID, err)
			WriteError(w, http.StatusInternalServerError, "query_failed", "query failed", err.Error())
			return
		}
	}

	memberPKBytes, err := hex.DecodeString(req.PrePubkey)
	if err != nil {
		log.Printf("[recall] DENY/ERROR decode pre_pubkey FAILED org=%s agent=%s: %v", req.OrgID, agentLogID, err)
		WriteError(w, http.StatusBadRequest, "invalid_pre_pubkey", "invalid pre_pubkey format")
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
			WriteError(w, http.StatusInternalServerError, "invalid_memory_type", "invalid memory_type from chain")
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

		cfrag, err := umbralService.ReEncryptForMember(ctx, req.OrgID, memberPKBytes, payload.capsule)
		if err != nil {
			log.Printf("[recall] umbral ReEncrypt FAILED org=%s cid=%s member_pk_fp=%s capsule_fp=%s trace=%s: %v", req.OrgID, res.CID, wlog.Fingerprint(memberPKBytes), wlog.Fingerprint(payload.capsule), trace, err)
			requiresReencryption = append(requiresReencryption, res.CID)
			merged = append(merged, res)
			continue
		}
		res.Capsule = hex.EncodeToString(payload.capsule)
		res.Cfrag = hex.EncodeToString(cfrag)
		reencryptedCount++
		log.Printf("[recall] umbral ReEncrypt ok org=%s cid=%s member_pk_fp=%s capsule_fp=%s cfrag_len=%d trace=%s", req.OrgID, res.CID, wlog.Fingerprint(memberPKBytes), wlog.Fingerprint(payload.capsule), len(cfrag), trace)

		merged = append(merged, res)
	}
	results = merged
	log.Printf("[recall] umbral re-encryption complete org=%s reencrypted=%d requiresReencryption=%d total=%d trace=%s", req.OrgID, reencryptedCount, len(requiresReencryption), len(results), trace)

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
		req.OrgID, 0, []int32{0},
		req.AgentPubkey, map[string]any{"query": "memory_query"},
		extractCIDs(results), bodySignatureHex,
	)
	if err != nil {
		log.Printf("[recall] receipt CreateReceipt FAILED org=%s agent=%s zeroResults=false: %v", req.OrgID, agentLogID, err)
		WriteError(w, http.StatusInternalServerError, "receipt_failed", "receipt failed", err.Error())
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

func getRecentMemberQueryCount(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string, windowSeconds int) (int, error) {
	var count int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM usage_receipts
		WHERE org_id = $1
		  AND agent_pubkey = $2
		  AND created_at > NOW() - make_interval(secs => $3)
	`, orgID, pubkey, windowSeconds).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

func GetMemory(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	cid := chi.URLParam(r, "cid")
	if orgID == "" || cid == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "org_id and cid required")
		return
	}

	hashBytes, err := hex.DecodeString(cid)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "invalid cid format")
		return
	}

	chainMems, _, err := chainClient.GetMemoriesBatch(r.Context(), orgID, [][]byte{hashBytes})
	if err != nil {
		WriteError(w, http.StatusServiceUnavailable, "chain_unavailable", "chain unavailable")
		return
	}

	if len(chainMems) > 0 {
		cm := chainMems[0]
		if !protocol.IsValidMemoryType(cm.MemoryType) {
			WriteError(w, http.StatusInternalServerError, "invalid_memory_type", "invalid memory_type from chain")
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
			"last_active_epoch":  cm.LastActiveEpoch,
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
		WriteError(w, http.StatusNotFound, "memory_not_found", "memory not found or not approved")
		return
	}
	if !protocol.IsValidMemoryType(memoryType) {
		WriteError(w, http.StatusInternalServerError, "invalid_memory_type", "invalid memory_type in hub cache")
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

// resolveRecallGovernor returns the effective relevance floor / surface budget.
// A field the client omitted (nil) gets the mode governor default; an explicit value
// (including 0, the bench test-mode bypass) is honored as sent.
func resolveRecallGovernor(floor *float64, budget *int) (float64, int, []string) {
	defaultFloor := 0.55
	defaultBudget := 3
	if recallModeIsTest() {
		defaultFloor = 0
		defaultBudget = 1000
	}

	effectiveFloor := defaultFloor
	effectiveBudget := defaultBudget
	defaulted := make([]string, 0, 2)

	if floor == nil {
		defaulted = append(defaulted, "relevance_floor")
	} else {
		effectiveFloor = *floor
	}

	if budget == nil {
		defaulted = append(defaulted, "surface_budget")
	} else {
		effectiveBudget = *budget
	}

	return effectiveFloor, effectiveBudget, defaulted
}

func persistRecallQueryLog(req protocol.QueryRequest, scorecard []retrieval.CandidateScore, contested bool, effectiveFloor float64, effectiveBudget int) {
	if pool == nil {
		return
	}

	returnedCount := 0
	for _, score := range scorecard {
		if score.Disposition == "returned" {
			returnedCount++
		}
	}

	entry := retrieval.QueryLogEntry{
		OrgID:            req.OrgID,
		AgentPubkey:      req.AgentPubkey,
		SessionID:        req.SessionID,
		RelevanceFloor:   effectiveFloor,
		SurfaceBudget:    effectiveBudget,
		EmbeddingModelID: req.EmbeddingModelID,
		VectorDim:        len(req.Vector),
		LimitN:           req.Limit,
		CandidateCount:   len(scorecard),
		ReturnedCount:    returnedCount,
		Contested:        contested,
	}

	scorecardCopy := cloneCandidateScores(scorecard)
	go func(entry retrieval.QueryLogEntry, scores []retrieval.CandidateScore) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := retrieval.PersistRecallQuery(ctx, pool, entry, scores); err != nil {
			log.Printf("[recall-log] persist failed: %v", err)
		}
	}(entry, scorecardCopy)
}

func cloneCandidateScores(scores []retrieval.CandidateScore) []retrieval.CandidateScore {
	if len(scores) == 0 {
		return nil
	}

	cloned := make([]retrieval.CandidateScore, len(scores))
	for i, score := range scores {
		cloned[i] = score
		cloned[i].MatchedKeywords = append([]string{}, score.MatchedKeywords...)
	}

	return cloned
}
