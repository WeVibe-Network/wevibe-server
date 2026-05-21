package handlers

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/embed"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
	"github.com/go-chi/chi/v5"
)

type BatchChainSubmitRequest struct {
	SubmissionHashes []string `json:"submission_hashes"`
}

type BatchChainSubmitResponse struct {
	TxHash         string   `json:"tx_hash,omitempty"`
	CommittedCount int      `json:"committed_count"`
	Errors         []string `json:"errors,omitempty"`
}

func BatchChainSubmit(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	if chainClient == nil {
		http.Error(w, `{"error":"chain client required"}`, http.StatusServiceUnavailable)
		return
	}
	if qdrantClient == nil {
		http.Error(w, `{"error":"qdrant client required"}`, http.StatusServiceUnavailable)
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
		http.Error(w, `{"error":"timestamp expired or too far in future"}`, http.StatusUnauthorized)
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

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req BatchChainSubmitRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if len(req.SubmissionHashes) == 0 {
		http.Error(w, `{"error":"submission_hashes required"}`, http.StatusBadRequest)
		return
	}

	type submissionData struct {
		hash              string
		contributorPubkey string
		walletAddress     string
		ciphertextHex     string
		wrappedDekEnc     string
		memoryType        string
		epochID           int
		extractionResult  json.RawMessage
		keywords          []string
		weights           []float64
	}

	submissions := make([]submissionData, 0, len(req.SubmissionHashes))
	var errors []string

	for _, hash := range req.SubmissionHashes {
		contentHashBytes, err := hex.DecodeString(hash)
		if err != nil {
			errors = append(errors, fmt.Sprintf("%s: invalid content hash", hash))
			continue
		}

		var contributorPubkey, walletAddress, ciphertextHex, wrappedDekEnc, memoryType string
		var epochID int
		var extractionResult json.RawMessage
		err = pool.QueryRow(r.Context(), `
			SELECT ps.contributor_pubkey, COALESCE(m.wallet_address, ''), ps.ciphertext_hex, ps.wrapped_dek_mod,
			       ps.memory_type, ps.epoch_id, ps.extraction_result
			FROM pending_submissions ps
			LEFT JOIN members m ON m.org_id = ps.org_id AND m.pubkey = ps.contributor_pubkey
			WHERE ps.org_id = $1 AND ps.submission_hash = $2 AND ps.status = 'pending_chain'
		`, orgID, hash).Scan(&contributorPubkey, &walletAddress, &ciphertextHex, &wrappedDekEnc, &memoryType, &epochID, &extractionResult)
		if err != nil {
			errors = append(errors, fmt.Sprintf("%s: submission not found or not in pending_chain status", hash))
			continue
		}

		if !protocol.IsValidMemoryType(memoryType) {
			errors = append(errors, fmt.Sprintf("%s: invalid memory_type", hash))
			continue
		}

		var kwData struct {
			Classified []struct {
				Keyword string  `json:"keyword"`
				Weight  float64 `json:"weight"`
			} `json:"classified"`
		}
		if err := json.Unmarshal(extractionResult, &kwData); err != nil || len(kwData.Classified) == 0 {
			errors = append(errors, fmt.Sprintf("%s: no classified keywords found", hash))
			continue
		}

		keywords := make([]string, len(kwData.Classified))
		weights := make([]float64, len(kwData.Classified))
		for i, kw := range kwData.Classified {
			keywords[i] = kw.Keyword
			weights[i] = kw.Weight
		}

		submissions = append(submissions, submissionData{
			hash:              hash,
			contributorPubkey: contributorPubkey,
			walletAddress:     walletAddress,
			ciphertextHex:     ciphertextHex,
			wrappedDekEnc:     wrappedDekEnc,
			memoryType:        memoryType,
			epochID:           epochID,
			extractionResult:  extractionResult,
			keywords:          keywords,
			weights:           weights,
		})
		_ = contentHashBytes
	}

	if len(submissions) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(BatchChainSubmitResponse{
			CommittedCount: 0,
			Errors:         errors,
		})
		return
	}

	if len(submissions) > protocol.MaxBatchMemories {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(BatchChainSubmitResponse{
			CommittedCount: 0,
			Errors:         append(errors, fmt.Sprintf("batch size %d exceeds MaxBatchMemories %d; split the batch", len(submissions), protocol.MaxBatchMemories)),
		})
		return
	}

	batchMemories := make([]chain.BatchMemory, len(submissions))
	for i, sub := range submissions {
		contentHashBytes, _ := hex.DecodeString(sub.hash)
		ciphertextBytes, _ := hex.DecodeString(sub.ciphertextHex)
		wrappedDekBytes, _ := hex.DecodeString(sub.wrappedDekEnc)

		keywords := make([]*memorytypes.KeywordWeight, len(sub.keywords))
		for j, kw := range sub.keywords {
			keywords[j] = &memorytypes.KeywordWeight{
				Keyword: kw,
				Weight:  fmt.Sprintf("%f", sub.weights[j]),
			}
		}

		batchMemories[i] = chain.BatchMemory{
			ContentHash:         contentHashBytes,
			Keywords:            keywords,
			ContributorID:       sub.contributorPubkey,
			ContributorWallet:   sub.walletAddress,
			EncryptedBlob:       ciphertextBytes,
			WrappedDekEnc:       wrappedDekBytes,
			SubmittedMemoryType: sub.memoryType,
			ApprovedMemoryType:  sub.memoryType,
		}
	}

	txHash, submissionHashes, err := chainClient.SubmitMemoryBatchAtomic(r.Context(), orgID, batchMemories)
	if err != nil {
		errors = append(errors, fmt.Sprintf("batch submit failed: %v", err))
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(BatchChainSubmitResponse{
			CommittedCount: 0,
			Errors:         errors,
		})
		return
	}

	log.Printf("Batch chain submit: tx=%s for %d submissions", txHash, len(submissionHashes))

	committedCount := 0
	var postCommitErrors []string

	for _, sub := range submissions {
		contentHashBytes, _ := hex.DecodeString(sub.hash)

		vector, err := computeEmbeddingForSubmission(r.Context(), sub.extractionResult, sub.keywords)
		if err != nil {
			log.Printf("WARN: failed to compute embedding for %s: %v", sub.hash, err)
			vector = make([]float32, embed.EMBED_DIM)
		}

		keywordWeights := make([]protocol.KeywordWithWeight, len(sub.keywords))
		keywordWeightMap := make(map[string]float64)
		for i, kw := range sub.keywords {
			keywordWeights[i] = protocol.KeywordWithWeight{Keyword: kw, Weight: sub.weights[i]}
			keywordWeightMap[kw] = sub.weights[i]
		}

		indexEntry := protocol.IndexEntry{
			CID:            sub.hash,
			OrgID:          orgID,
			EpochID:        int32(sub.epochID),
			Keywords:       keywordWeights,
			KeywordWeights: keywordWeightMap,
			Vector:         vector,
			ConfidenceBps:  10000,
			LifecycleState: "ACTIVE",
			MemoryType:     sub.memoryType,
		}

		if err := retrieval.AddToIndex(r.Context(), qdrantClient, indexEntry); err != nil {
			log.Printf("ERROR: failed to insert into Qdrant for %s: %v", sub.hash, err)
			postCommitErrors = append(postCommitErrors, fmt.Sprintf("%s: qdrant insert failed", sub.hash))
			continue
		}

		for i, kw := range sub.keywords {
			_, err := pool.Exec(r.Context(), `
				INSERT INTO memory_keywords (memory_cid, org_id, keyword, weight)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (memory_cid, keyword) DO UPDATE SET weight = $4
			`, sub.hash, orgID, kw, sub.weights[i])
			if err != nil {
				log.Printf("ERROR: failed to insert keyword %s for %s: %v", kw, sub.hash, err)
				postCommitErrors = append(postCommitErrors, fmt.Sprintf("%s: keyword insert failed for %s", sub.hash, kw))
			}
		}

		_, err = pool.Exec(r.Context(), `
			UPDATE pending_submissions
			SET status = 'committed', updated_at = NOW()
			WHERE org_id = $1 AND submission_hash = $2 AND status = 'pending_chain'
		`, orgID, sub.hash)
		if err != nil {
			log.Printf("ERROR: failed to update status to committed for %s: %v", sub.hash, err)
			postCommitErrors = append(postCommitErrors, fmt.Sprintf("%s: status update failed", sub.hash))
			continue
		}

		committedCount++
		_ = contentHashBytes
	}

	_, _ = pool.Exec(r.Context(), `
		UPDATE orgs SET last_chain_submission_at = NOW(), updated_at = NOW()
		WHERE org_id = $1
	`, orgID)

	if len(postCommitErrors) > 0 {
		errors = append(errors, postCommitErrors...)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(BatchChainSubmitResponse{
		TxHash:         txHash,
		CommittedCount: committedCount,
		Errors:         errors,
	})
}

func computeEmbeddingForSubmission(ctx context.Context, extractionResult json.RawMessage, keywords []string) ([]float32, error) {
	if len(keywords) == 0 {
		return make([]float32, embed.EMBED_DIM), nil
	}

	combinedText := ""
	for _, kw := range keywords {
		if combinedText != "" {
			combinedText += " "
		}
		combinedText += kw
	}

	vector, err := embed.GetEmbedding(ctx, "http://localhost:11434", combinedText)
	if err != nil || len(vector) == 0 {
		return make([]float32, embed.EMBED_DIM), nil
	}

	return vector, nil
}

type OrgHealthResponse struct {
	LastBatchExtractionAt string `json:"last_batch_extraction_at"`
	LastChainSubmissionAt string `json:"last_chain_submission_at"`
	PendingKeywordCount   int    `json:"pending_keyword_count"`
	PendingChainCount     int    `json:"pending_chain_count"`
}

func OrgHealth(w http.ResponseWriter, r *http.Request) {
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
	if err != nil || role != "leader" {
		http.Error(w, `{"error":"forbidden: leader only"}`, http.StatusForbidden)
		return
	}

	var lastBatchExtractionAt, lastChainSubmissionAt *time.Time
	var pendingKeywordCount, pendingChainCount int

	err = pool.QueryRow(r.Context(), `
		SELECT last_batch_extraction_at, last_chain_submission_at
		FROM orgs WHERE org_id = $1
	`, orgID).Scan(&lastBatchExtractionAt, &lastChainSubmissionAt)
	if err != nil {
		http.Error(w, `{"error":"org not found"}`, http.StatusNotFound)
		return
	}

	err = pool.QueryRow(r.Context(), `
		SELECT COUNT(*) FROM pending_submissions
		WHERE org_id = $1 AND status = 'pending_keyword'
	`, orgID).Scan(&pendingKeywordCount)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	err = pool.QueryRow(r.Context(), `
		SELECT COUNT(*) FROM pending_submissions
		WHERE org_id = $1 AND status = 'pending_chain'
	`, orgID).Scan(&pendingChainCount)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	extractionAtStr := ""
	if lastBatchExtractionAt != nil {
		extractionAtStr = lastBatchExtractionAt.Format(time.RFC3339)
	}
	chainAtStr := ""
	if lastChainSubmissionAt != nil {
		chainAtStr = lastChainSubmissionAt.Format(time.RFC3339)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(OrgHealthResponse{
		LastBatchExtractionAt: extractionAtStr,
		LastChainSubmissionAt: chainAtStr,
		PendingKeywordCount:   pendingKeywordCount,
		PendingChainCount:     pendingChainCount,
	})
}
