package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/embed"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/moderation"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

type KeywordResultSubmission struct {
	Memories []MemoryKeywordResult `json:"memories"`
}

type MemoryKeywordResult struct {
	SubmissionHash string              `json:"submission_hash"`
	Classified     []KeywordWeight     `json:"classified"`
	Suggestions    []KeywordSuggestion `json:"suggestions"`
}

type VerifyEntry struct {
	SubmissionHash         string    `json:"submission_hash"`
	Vector                 []float32 `json:"vector"`
	EmbeddingModelID       string    `json:"embedding_model_id"`
	EmbeddingSchemaVersion string    `json:"embedding_schema_version"`
}

type VerifyKeywordsRequest struct {
	Entries []VerifyEntry `json:"entries"`
}

type KeywordWeight struct {
	Keyword string  `json:"keyword"`
	Weight  float64 `json:"weight"`
}

type KeywordSuggestion struct {
	Keyword   string  `json:"keyword"`
	Weight    float64 `json:"weight"`
	Rationale string  `json:"rationale"`
}

type UpdateKeywordsRequest struct {
	Classified  []KeywordWeight     `json:"classified"`
	Suggestions []KeywordSuggestion `json:"suggestions"`
}

type SubmissionRecord struct {
	SubmissionHash           string                               `json:"submission_hash"`
	OrgID                    string                               `json:"org_id"`
	EpochID                  int                                  `json:"epoch_id"`
	ContributorPubkey        string                               `json:"contributor_pubkey"`
	CiphertextHex            string                               `json:"ciphertext_hex"`
	WrappedDekMod            string                               `json:"wrapped_dek_mod"`
	Status                   string                               `json:"status"`
	MemoryType               string                               `json:"memory_type"`
	PreferenceConfidence     float64                              `json:"preference_confidence"`
	Derivation               string                               `json:"derivation"`
	MatchedKeywords          []string                             `json:"matched_keywords"`
	ExtractionResult         *json.RawMessage                     `json:"extraction_result,omitempty"`
	ExtractionFeedback       *string                              `json:"extraction_feedback,omitempty"`
	ModeratorPubkey          *string                              `json:"moderator_pubkey,omitempty"`
	ApprovedAt               *time.Time                           `json:"approved_at,omitempty"`
	VerifiedAt               *time.Time                           `json:"verified_at,omitempty"`
	DenialReason             *string                              `json:"denial_reason,omitempty"`
	ModVotes                 SubmissionModVotes                   `json:"mod_votes"`
	KeywordVotes             map[string]SubmissionKeywordVotes    `json:"keyword_votes"`
	ModeratorRecommendations []moderation.ModeratorRecommendation `json:"moderator_recommendations"`
	UpdatedAt                time.Time                            `json:"updated_at"`
	CreatedAt                time.Time                            `json:"created_at"`
}

type SubmissionModVotes struct {
	Approve int `json:"approve"`
	Flag    int `json:"flag"`
}

type SubmissionKeywordVotes struct {
	Include int `json:"include"`
	Exclude int `json:"exclude"`
}

var keywordFormatRegex = regexp.MustCompile(protocol.KeywordFormatRegex)

func SubmitKeywordResults(w http.ResponseWriter, r *http.Request) {
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

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req KeywordResultSubmission
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if len(req.Memories) == 0 {
		http.Error(w, `{"error":"memories required"}`, http.StatusBadRequest)
		return
	}

	type result struct {
		Hash  string `json:"submission_hash"`
		Error string `json:"error,omitempty"`
	}
	var results []result

	for _, mem := range req.Memories {
		if mem.SubmissionHash == "" {
			results = append(results, result{Error: "submission_hash required"})
			continue
		}

		extractionData, err := json.Marshal(map[string]interface{}{
			"classified":  mem.Classified,
			"suggestions": mem.Suggestions,
		})
		if err != nil {
			results = append(results, result{Hash: mem.SubmissionHash, Error: "failed to marshal extraction result"})
			continue
		}

		res, err := pool.Exec(r.Context(), `
			UPDATE pending_submissions
			SET extraction_result = $1, updated_at = NOW()
			WHERE org_id = $2 AND submission_hash = $3 AND status = 'pending_keyword'
		`, extractionData, orgID, mem.SubmissionHash)
		if err != nil {
			results = append(results, result{Hash: mem.SubmissionHash, Error: "internal error"})
			continue
		}
		if res.RowsAffected() == 0 {
			results = append(results, result{Hash: mem.SubmissionHash, Error: "submission not found or not in pending_keyword status"})
			continue
		}

		results = append(results, result{Hash: mem.SubmissionHash})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"submitted": len(results),
		"results":   results,
	})
}

func VerifyKeywords(w http.ResponseWriter, r *http.Request) {
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

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req VerifyKeywordsRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if len(req.Entries) == 0 {
		http.Error(w, `{"error":"entries required"}`, http.StatusBadRequest)
		return
	}

	type result struct {
		Hash   string `json:"submission_hash"`
		Passed bool   `json:"passed"`
		Error  string `json:"error,omitempty"`
	}
	var results []result
	verifiedCount := 0

	type storedExtractionResult struct {
		Classified  []KeywordWeight     `json:"classified"`
		Suggestions []KeywordSuggestion `json:"suggestions"`
	}

	for _, entry := range req.Entries {
		if entry.SubmissionHash == "" {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: "submission_hash required"})
			continue
		}

		var status, memoryType, ciphertextHex string
		var extractionResult []byte
		err := pool.QueryRow(r.Context(), `
			SELECT status, memory_type, ciphertext_hex, extraction_result
			FROM pending_submissions
			WHERE org_id = $1 AND submission_hash = $2
		`, orgID, entry.SubmissionHash).Scan(&status, &memoryType, &ciphertextHex, &extractionResult)
		if err != nil {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: "submission not found"})
			continue
		}

		if status != "pending_keyword" {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: fmt.Sprintf("invalid status: %s (expected pending_keyword)", status)})
			continue
		}
		if !protocol.IsValidMemoryType(memoryType) {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: fmt.Sprintf("invalid memory_type: %s", memoryType)})
			continue
		}

		var storedExtraction storedExtractionResult
		if err := json.Unmarshal(extractionResult, &storedExtraction); err != nil || len(storedExtraction.Classified) == 0 {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: "no stored classified keywords"})
			continue
		}

		if len(storedExtraction.Classified) > protocol.MaxKeywordsPerMemory {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: fmt.Sprintf("too many keywords: %d (max %d)", len(storedExtraction.Classified), protocol.MaxKeywordsPerMemory)})
			continue
		}

		var weightSum float64
		invalidKeyword := ""
		for _, kw := range storedExtraction.Classified {
			if !keywordFormatRegex.MatchString(kw.Keyword) {
				invalidKeyword = kw.Keyword
				break
			}
			weightSum += kw.Weight
		}
		if invalidKeyword != "" {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: fmt.Sprintf("invalid keyword format: %s", invalidKeyword)})
			continue
		}

		if abs(weightSum-1.0) > protocol.KeywordWeightTolerance {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: fmt.Sprintf("keyword weights sum to %.4f, must be 1.0 (±%.2f)", weightSum, protocol.KeywordWeightTolerance)})
			continue
		}

		placeholders := make([]string, len(storedExtraction.Classified))
		args := make([]interface{}, len(storedExtraction.Classified))
		for i, kw := range storedExtraction.Classified {
			placeholders[i] = fmt.Sprintf("$%d", i+1)
			args[i] = kw.Keyword
		}

		validKeywords := 0
		queryArgs := append(args, orgID)
		err = pool.QueryRow(r.Context(), fmt.Sprintf(`
			SELECT COUNT(*) FROM org_keywords
			WHERE org_id = $%d AND keyword IN (%s) AND deprecated = false
		`, len(args)+1, strings.Join(placeholders, ",")), queryArgs...).Scan(&validKeywords)
		if err != nil {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: "internal error checking keywords"})
			continue
		}
		if validKeywords != len(storedExtraction.Classified) {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: "one or more keywords not found in org_keywords or are deprecated"})
			continue
		}

		if len(storedExtraction.Suggestions) > 0 {
			hasPendingSuggestions := false
			for _, s := range storedExtraction.Suggestions {
				if s.Rationale == "" {
					hasPendingSuggestions = true
					break
				}
			}
			if hasPendingSuggestions {
				results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: "suggestions must be approved/rejected (all must have rationale)"})
				continue
			}
		}

		if len(ciphertextHex) > protocol.MaxMemoryChars*2 {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: fmt.Sprintf("memory plaintext too long: %d chars (max %d)", len(ciphertextHex)/2, protocol.MaxMemoryChars)})
			continue
		}

		if len(entry.Vector) != embed.EMBED_DIM {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: fmt.Sprintf("missing or wrong-dimension embedding vector (got %d, expected %d)", len(entry.Vector), embed.EMBED_DIM)})
			continue
		}

		embeddingVector, err := json.Marshal(entry.Vector)
		if err != nil {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: "failed to marshal embedding vector"})
			continue
		}

		res, err := pool.Exec(r.Context(), `
			UPDATE pending_submissions
			SET status = 'pending_chain',
			    embedding_vector = $1,
			    embedding_model_id = $2,
			    embedding_schema_version = $3,
			    verified_at = NOW(),
			    updated_at = NOW()
			WHERE org_id = $4 AND submission_hash = $5 AND status = 'pending_keyword'
		`, embeddingVector, entry.EmbeddingModelID, entry.EmbeddingSchemaVersion, orgID, entry.SubmissionHash)
		if err != nil {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: "internal error"})
			continue
		}
		if res.RowsAffected() == 0 {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Error: "submission not found or status changed"})
			continue
		}

		verifiedCount++
		results = append(results, result{Hash: entry.SubmissionHash, Passed: true})
	}

	if len(results) > 0 {
		_, _ = pool.Exec(r.Context(), `
			UPDATE orgs SET last_batch_extraction_at = NOW(), updated_at = NOW()
			WHERE org_id = $1
		`, orgID)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"verified": verifiedCount,
		"results":  results,
	})
}

func RerunKeywords(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	submissionHash := chi.URLParam(r, "hash")
	if orgID == "" || submissionHash == "" {
		http.Error(w, `{"error":"org_id and hash required"}`, http.StatusBadRequest)
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

	var currentStatus string
	err = pool.QueryRow(r.Context(), `
		SELECT status FROM pending_submissions WHERE org_id = $1 AND submission_hash = $2
	`, orgID, submissionHash).Scan(&currentStatus)
	if err != nil {
		http.Error(w, `{"error":"submission not found"}`, http.StatusNotFound)
		return
	}

	if currentStatus != "pending_keyword" && currentStatus != "pending_chain" {
		http.Error(w, fmt.Sprintf(`{"error":"cannot rerun: submission status is %s (must be pending_keyword or pending_chain)"}`, currentStatus), http.StatusBadRequest)
		return
	}

	res, err := pool.Exec(r.Context(), `
		UPDATE pending_submissions
		SET status = 'pending_keyword',
		    extraction_result = NULL,
		    extraction_feedback = NULL,
		    verified_at = NULL,
		    updated_at = NOW()
		WHERE org_id = $1 AND submission_hash = $2
	`, orgID, submissionHash)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if res.RowsAffected() == 0 {
		http.Error(w, `{"error":"submission not found"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":          "rerun",
		"submission_hash": submissionHash,
	})
}

func UpdateKeywords(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	submissionHash := chi.URLParam(r, "hash")
	if orgID == "" || submissionHash == "" {
		http.Error(w, `{"error":"org_id and hash required"}`, http.StatusBadRequest)
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

	var req UpdateKeywordsRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	var currentStatus string
	err = pool.QueryRow(r.Context(), `
		SELECT status FROM pending_submissions WHERE org_id = $1 AND submission_hash = $2
	`, orgID, submissionHash).Scan(&currentStatus)
	if err != nil {
		http.Error(w, `{"error":"submission not found"}`, http.StatusNotFound)
		return
	}

	if currentStatus != "pending_keyword" && currentStatus != "pending_chain" {
		http.Error(w, fmt.Sprintf(`{"error":"cannot update keywords: submission status is %s (must be pending_keyword or pending_chain)"}`, currentStatus), http.StatusBadRequest)
		return
	}

	if len(req.Classified) > protocol.MaxKeywordsPerMemory {
		http.Error(w, fmt.Sprintf(`{"error":"too many keywords: %d (max %d)"}`, len(req.Classified), protocol.MaxKeywordsPerMemory), http.StatusBadRequest)
		return
	}

	var weightSum float64
	for _, kw := range req.Classified {
		if !keywordFormatRegex.MatchString(kw.Keyword) {
			http.Error(w, fmt.Sprintf(`{"error":"invalid keyword format: %s"}`, kw.Keyword), http.StatusBadRequest)
			return
		}
		weightSum += kw.Weight
	}

	if abs(weightSum-1.0) > protocol.KeywordWeightTolerance {
		http.Error(w, fmt.Sprintf(`{"error":"keyword weights sum to %.4f, must be 1.0 (±%.2f)"}`, weightSum, protocol.KeywordWeightTolerance), http.StatusBadRequest)
		return
	}

	keywordSet := make(map[string]bool)
	for _, kw := range req.Classified {
		keywordSet[kw.Keyword] = true
	}

	placeholders := make([]string, len(req.Classified))
	args := make([]interface{}, len(req.Classified))
	for i, kw := range req.Classified {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
		args[i] = kw.Keyword
	}

	validKeywords := 0
	queryArgs := append(args, orgID)
	err = pool.QueryRow(r.Context(), fmt.Sprintf(`
		SELECT COUNT(*) FROM org_keywords
		WHERE org_id = $%d AND keyword IN (%s) AND deprecated = false
	`, len(args)+1, strings.Join(placeholders, ",")), queryArgs...).Scan(&validKeywords)
	if err != nil {
		http.Error(w, `{"error":"internal error checking keywords"}`, http.StatusInternalServerError)
		return
	}
	if validKeywords != len(req.Classified) {
		http.Error(w, `{"error":"one or more keywords not found in org_keywords or are deprecated"}`, http.StatusBadRequest)
		return
	}

	extractionData, err := json.Marshal(map[string]interface{}{
		"classified":  req.Classified,
		"suggestions": req.Suggestions,
	})
	if err != nil {
		http.Error(w, `{"error":"failed to marshal extraction result"}`, http.StatusInternalServerError)
		return
	}

	res, err := pool.Exec(r.Context(), `
		UPDATE pending_submissions
		SET extraction_result = $1, updated_at = NOW()
		WHERE org_id = $2 AND submission_hash = $3 AND status IN ('pending_keyword', 'pending_chain')
	`, extractionData, orgID, submissionHash)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if res.RowsAffected() == 0 {
		http.Error(w, `{"error":"submission not found or status changed"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":          "updated",
		"submission_hash": submissionHash,
	})
}

func RemoveSubmission(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	submissionHash := chi.URLParam(r, "hash")
	if orgID == "" || submissionHash == "" {
		http.Error(w, `{"error":"org_id and hash required"}`, http.StatusBadRequest)
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

	var currentStatus string
	err = pool.QueryRow(r.Context(), `
		SELECT status FROM pending_submissions WHERE org_id = $1 AND submission_hash = $2
	`, orgID, submissionHash).Scan(&currentStatus)
	if err != nil {
		http.Error(w, `{"error":"submission not found"}`, http.StatusNotFound)
		return
	}

	if currentStatus != "pending_keyword" && currentStatus != "pending_chain" {
		http.Error(w, fmt.Sprintf(`{"error":"cannot remove: submission status is %s (must be pending_keyword or pending_chain)"}`, currentStatus), http.StatusBadRequest)
		return
	}

	res, err := pool.Exec(r.Context(), `
		DELETE FROM pending_submissions
		WHERE org_id = $1 AND submission_hash = $2 AND status IN ('pending_keyword', 'pending_chain')
	`, orgID, submissionHash)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if res.RowsAffected() == 0 {
		http.Error(w, `{"error":"submission not found or status changed"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":          "removed",
		"submission_hash": submissionHash,
	})
}

func ListSubmissions(w http.ResponseWriter, r *http.Request) {
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

	statusFilter := r.URL.Query().Get("status")
	if statusFilter != "" {
		validStatuses := map[string]bool{
			protocol.SubmissionStatusPendingKeyword: true,
			protocol.SubmissionStatusPendingChain:   true,
			protocol.SubmissionStatusCommitted:      true,
		}
		if !validStatuses[statusFilter] {
			http.Error(w, `{"error":"invalid status filter"}`, http.StatusBadRequest)
			return
		}
	}

	var rows interface {
		Next() bool
		Scan(...interface{}) error
		Err() error
	}
	if statusFilter != "" {
		rows, err = pool.Query(r.Context(), `
			SELECT submission_hash, org_id, epoch_id, contributor_pubkey, ciphertext_hex, wrapped_dek_mod, status, memory_type,
			       preference_confidence, derivation, extraction_result, extraction_feedback, moderator_pubkey, approved_at, verified_at, updated_at, created_at
			FROM pending_submissions ps
			WHERE ps.org_id = $1 AND ps.status = $2
			ORDER BY ps.created_at DESC
		`, orgID, statusFilter)
	} else {
		rows, err = pool.Query(r.Context(), `
			SELECT submission_hash, org_id, epoch_id, contributor_pubkey, ciphertext_hex, wrapped_dek_mod, status, memory_type,
			       preference_confidence, derivation, extraction_result, extraction_feedback, moderator_pubkey, approved_at, verified_at, updated_at, created_at
			FROM pending_submissions ps
			WHERE ps.org_id = $1
			ORDER BY ps.created_at DESC
		`, orgID)
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	type queryRows interface {
		Next() bool
		Scan(dest ...interface{}) error
		Err() error
		Close()
	}

	qr := rows.(queryRows)
	defer qr.Close()

	var submissions []SubmissionRecord
	for qr.Next() {
		var sub SubmissionRecord
		err := qr.Scan(&sub.SubmissionHash, &sub.OrgID, &sub.EpochID, &sub.ContributorPubkey,
			&sub.CiphertextHex, &sub.WrappedDekMod, &sub.Status, &sub.MemoryType, &sub.PreferenceConfidence, &sub.Derivation, &sub.ExtractionResult, &sub.ExtractionFeedback,
			&sub.ModeratorPubkey, &sub.ApprovedAt, &sub.VerifiedAt, &sub.UpdatedAt, &sub.CreatedAt)
		if err != nil {
			continue
		}
		sub.MatchedKeywords = []string{}
		sub.ModVotes = SubmissionModVotes{}
		sub.KeywordVotes = make(map[string]SubmissionKeywordVotes)
		sub.ModeratorRecommendations = []moderation.ModeratorRecommendation{}
		submissions = append(submissions, sub)
	}
	if qr.Err() != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	submissionHashes := make([]string, 0, len(submissions))
	for _, sub := range submissions {
		submissionHashes = append(submissionHashes, sub.SubmissionHash)
	}

	modTallies, err := moderation.GetSubmissionVoteTallies(r.Context(), pool, orgID, submissionHashes)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	keywordTallies, err := moderation.GetKeywordVoteTallies(r.Context(), pool, orgID, submissionHashes)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	moderatorRecommendations, err := moderation.GetModeratorRecommendations(r.Context(), pool, orgID, submissionHashes)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	for idx := range submissions {
		hash := submissions[idx].SubmissionHash
		if tally, ok := modTallies[hash]; ok {
			submissions[idx].ModVotes = SubmissionModVotes{
				Approve: tally.ApproveCount,
				Flag:    tally.FlagCount,
			}
		}
		if keywordMap, ok := keywordTallies[hash]; ok {
			for keyword, tally := range keywordMap {
				submissions[idx].KeywordVotes[keyword] = SubmissionKeywordVotes{
					Include: tally.IncludeCount,
					Exclude: tally.ExcludeCount,
				}
			}
		}
		if recommendations, ok := moderatorRecommendations[hash]; ok {
			submissions[idx].ModeratorRecommendations = recommendations
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"submissions": submissions,
		"total":       len(submissions),
	})
}

func ListMySubmissions(w http.ResponseWriter, r *http.Request) {
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

	_, err = members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	rows, err := pool.Query(r.Context(), `
		SELECT submission_hash, org_id, epoch_id, contributor_pubkey, status, memory_type,
		       preference_confidence, derivation, extraction_result, extraction_feedback, moderator_pubkey, approved_at, verified_at,
		       denial_reason, updated_at, created_at
		FROM pending_submissions
		WHERE org_id = $1 AND contributor_pubkey = $2
		ORDER BY created_at DESC
		LIMIT 100
	`, orgID, signed.Pubkey)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var submissions []SubmissionRecord
	for rows.Next() {
		var sub SubmissionRecord
		err := rows.Scan(&sub.SubmissionHash, &sub.OrgID, &sub.EpochID, &sub.ContributorPubkey,
			&sub.Status, &sub.MemoryType, &sub.PreferenceConfidence, &sub.Derivation, &sub.ExtractionResult, &sub.ExtractionFeedback,
			&sub.ModeratorPubkey, &sub.ApprovedAt, &sub.VerifiedAt, &sub.DenialReason, &sub.UpdatedAt, &sub.CreatedAt)
		if err != nil {
			continue
		}
		sub.MatchedKeywords = []string{}
		submissions = append(submissions, sub)
	}
	if rows.Err() != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"submissions": submissions,
		"total":       len(submissions),
	})
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}
