package handlers

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/embed"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/moderation"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
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
	UmbralCapsule          string    `json:"umbral_capsule"`
	UmbralCiphertext       string    `json:"umbral_ciphertext"`
}

type VerifyKeywordsRequest struct {
	Entries []VerifyEntry `json:"entries"`
}

type KeywordWeight struct {
	Keyword    string  `json:"keyword"`
	Weight     float64 `json:"weight"`
	BaseWeight float64 `json:"base_weight"`
}

type KeywordSuggestion struct {
	Keyword    string  `json:"keyword"`
	Weight     float64 `json:"weight"`
	BaseWeight float64 `json:"base_weight"`
	Rationale  string  `json:"rationale"`
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
	NearDupMatches           json.RawMessage                      `json:"near_dup_matches,omitempty"`
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

// Canonical embedding model is nomic-embed-text:v1.5 (768-d).
// The >=0.84 duplicate signal and near-duplicate floor calibration were established on the prior 4x-dimension model
// and are pending re-validation against nomic-embed-text:v1.5.
const nearDupProbeLimit = 25
const nearDupFloor = 0.80

func SubmitKeywordResults(w http.ResponseWriter, r *http.Request) {
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
		WriteError(w, http.StatusBadRequest, "timestamp_invalid", "invalid timestamp format, use RFC3339")
		return
	}
	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		WriteError(w, http.StatusUnauthorized, "timestamp_expired", "timestamp expired or too far in future")
		return
	}
	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		WriteError(w, http.StatusForbidden, "forbidden_leader_only", "forbidden: leader only")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "bad request")
		return
	}

	var req KeywordResultSubmission
	if err := json.Unmarshal(body, &req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_json", "invalid json")
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
		WriteError(w, http.StatusBadRequest, "timestamp_invalid", "invalid timestamp format, use RFC3339")
		return
	}
	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		WriteError(w, http.StatusUnauthorized, "timestamp_expired", "timestamp expired or too far in future")
		return
	}
	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		WriteError(w, http.StatusForbidden, "forbidden_leader_only", "forbidden: leader only")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "bad request")
		return
	}

	var req VerifyKeywordsRequest
	if err := json.Unmarshal(body, &req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_json", "invalid json")
		return
	}

	if len(req.Entries) == 0 {
		WriteError(w, http.StatusBadRequest, "invalid_request", "entries required")
		return
	}

	type result struct {
		Hash   string `json:"submission_hash"`
		Passed bool   `json:"passed"`
		Code   string `json:"code,omitempty"`
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
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "submission_hash_required", Error: "submission_hash required"})
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
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "submission_not_found", Error: "submission not found"})
			continue
		}

		if status != "pending_keyword" {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "invalid_status", Error: fmt.Sprintf("invalid status: %s (expected pending_keyword)", status)})
			continue
		}
		if !protocol.IsValidMemoryType(memoryType) {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "invalid_memory_type", Error: fmt.Sprintf("invalid memory_type: %s", memoryType)})
			continue
		}

		var storedExtraction storedExtractionResult
		if err := json.Unmarshal(extractionResult, &storedExtraction); err != nil || len(storedExtraction.Classified) == 0 {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "no_classified_keywords", Error: "no stored classified keywords"})
			continue
		}

		if len(storedExtraction.Classified) > protocol.MaxKeywordsPerMemory {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "too_many_keywords", Error: fmt.Sprintf("too many keywords: %d (max %d)", len(storedExtraction.Classified), protocol.MaxKeywordsPerMemory)})
			continue
		}

		invalidKeyword := ""
		for _, kw := range storedExtraction.Classified {
			if !keywordFormatRegex.MatchString(kw.Keyword) {
				invalidKeyword = kw.Keyword
				break
			}
		}
		if invalidKeyword != "" {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "invalid_keyword_format", Error: fmt.Sprintf("invalid keyword format: %s", invalidKeyword)})
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
				results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "suggestion_rationale_required", Error: "suggestions must be approved/rejected (all must have rationale)"})
				continue
			}
		}

		if len(ciphertextHex) > protocol.MaxMemoryChars*2 {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "plaintext_too_long", Error: fmt.Sprintf("memory plaintext too long: %d chars (max %d)", len(ciphertextHex)/2, protocol.MaxMemoryChars)})
			continue
		}

		if len(entry.Vector) != embed.EMBED_DIM {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "vector_dim_mismatch", Error: fmt.Sprintf("missing or wrong-dimension embedding vector (got %d, expected %d)", len(entry.Vector), embed.EMBED_DIM)})
			continue
		}

		if entry.UmbralCapsule == "" || entry.UmbralCiphertext == "" {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "missing_capsule", Error: "missing umbral capsule/ciphertext"})
			continue
		}

		capsuleBytes, err := hex.DecodeString(entry.UmbralCapsule)
		if err != nil {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "invalid_capsule_hex", Error: "invalid umbral_capsule hex"})
			continue
		}

		ciphertextBytes, err := hex.DecodeString(entry.UmbralCiphertext)
		if err != nil {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "invalid_ciphertext_hex", Error: "invalid umbral_ciphertext hex"})
			continue
		}

		embeddingVector, err := json.Marshal(entry.Vector)
		if err != nil {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "vector_marshal_failed", Error: "failed to marshal embedding vector"})
			continue
		}

		var nearDupMatchesJSON []byte
		if qdrantClient != nil {
			matches, probeErr := qdrantClient.NearestExistingMemories(r.Context(), orgID, entry.Vector, nearDupProbeLimit)
			if probeErr != nil {
				log.Printf("WARNING: near-duplicate probe failed for submission=%s org=%s: %v", entry.SubmissionHash, orgID, probeErr)
			} else {
				filteredMatches := make([]retrieval.NearDupMatch, 0, len(matches))
				for _, match := range matches {
					if match.Score >= nearDupFloor {
						filteredMatches = append(filteredMatches, match)
					}
				}

				if len(filteredMatches) > 0 {
					serializedMatches, marshalErr := json.Marshal(filteredMatches)
					if marshalErr != nil {
						log.Printf("WARNING: failed to marshal near-duplicate matches for submission=%s org=%s: %v", entry.SubmissionHash, orgID, marshalErr)
					} else {
						nearDupMatchesJSON = serializedMatches
					}
				}
			}
		}

		res, err := pool.Exec(r.Context(), `
			UPDATE pending_submissions
			SET status = 'pending_chain',
			    embedding_vector = $1,
			    embedding_model_id = $2,
			    embedding_schema_version = $3,
			    near_dup_matches = $4,
			    umbral_capsule = $5,
			    umbral_ciphertext = $6,
			    verified_at = NOW(),
			    updated_at = NOW()
			WHERE org_id = $7 AND submission_hash = $8 AND status = 'pending_keyword'
		`, embeddingVector, entry.EmbeddingModelID, entry.EmbeddingSchemaVersion, nearDupMatchesJSON, capsuleBytes, ciphertextBytes, orgID, entry.SubmissionHash)
		if err != nil {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "transition_failed", Error: "internal error"})
			continue
		}
		if res.RowsAffected() == 0 {
			results = append(results, result{Hash: entry.SubmissionHash, Passed: false, Code: "submission_status_changed", Error: "submission not found or status changed"})
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

func UpdateKeywords(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
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
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "timestamp_invalid", "invalid timestamp format, use RFC3339")
		return
	}
	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		WriteError(w, http.StatusUnauthorized, "timestamp_expired", "timestamp expired or too far in future")
		return
	}
	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		WriteError(w, http.StatusForbidden, "forbidden_leader_only", "forbidden: leader only")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "bad request")
		return
	}

	var req UpdateKeywordsRequest
	if err := json.Unmarshal(body, &req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_json", "invalid json")
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

	for _, kw := range req.Classified {
		if !keywordFormatRegex.MatchString(kw.Keyword) {
			http.Error(w, fmt.Sprintf(`{"error":"invalid keyword format: %s"}`, kw.Keyword), http.StatusBadRequest)
			return
		}
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
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
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
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "timestamp_invalid", "invalid timestamp format, use RFC3339")
		return
	}
	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		WriteError(w, http.StatusUnauthorized, "timestamp_expired", "timestamp expired or too far in future")
		return
	}
	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		WriteError(w, http.StatusForbidden, "forbidden_leader_only", "forbidden: leader only")
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
		WriteError(w, http.StatusBadRequest, "timestamp_invalid", "invalid timestamp format, use RFC3339")
		return
	}
	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		WriteError(w, http.StatusUnauthorized, "timestamp_expired", "timestamp expired or too far in future")
		return
	}
	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		WriteError(w, http.StatusForbidden, "forbidden_leader_only", "forbidden: leader only")
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
			       preference_confidence, derivation, extraction_result, extraction_feedback, moderator_pubkey, approved_at, verified_at,
			       near_dup_matches, updated_at, created_at
			FROM pending_submissions ps
			WHERE ps.org_id = $1 AND ps.status = $2
			ORDER BY ps.created_at DESC
		`, orgID, statusFilter)
	} else {
		rows, err = pool.Query(r.Context(), `
			SELECT submission_hash, org_id, epoch_id, contributor_pubkey, ciphertext_hex, wrapped_dek_mod, status, memory_type,
			       preference_confidence, derivation, extraction_result, extraction_feedback, moderator_pubkey, approved_at, verified_at,
			       near_dup_matches, updated_at, created_at
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
		var nearDupMatches []byte
		err := qr.Scan(&sub.SubmissionHash, &sub.OrgID, &sub.EpochID, &sub.ContributorPubkey,
			&sub.CiphertextHex, &sub.WrappedDekMod, &sub.Status, &sub.MemoryType, &sub.PreferenceConfidence, &sub.Derivation, &sub.ExtractionResult, &sub.ExtractionFeedback,
			&sub.ModeratorPubkey, &sub.ApprovedAt, &sub.VerifiedAt, &nearDupMatches, &sub.UpdatedAt, &sub.CreatedAt)
		if err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
		if nearDupMatches != nil {
			sub.NearDupMatches = json.RawMessage(nearDupMatches)
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
		WriteError(w, http.StatusBadRequest, "timestamp_invalid", "invalid timestamp format, use RFC3339")
		return
	}
	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		WriteError(w, http.StatusUnauthorized, "timestamp_expired", "timestamp expired or too far in future")
		return
	}
	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
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
