package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
)

const EARNED_MIN_CONTRIBUTORS = 2

type KeywordInfo struct {
	Keyword    string `json:"keyword"`
	CreatedAt  string `json:"created_at"`
	Deprecated bool   `json:"deprecated"`
	UsageCount int    `json:"usage_count"`
}

func ListKeywords(w http.ResponseWriter, r *http.Request) {
	// ListKeywords: any active member can read the org keyword vocabulary.
	// Write operations (add, merge, rename, deprecate) remain leader-only.
	// Relaxed from moderator/leader in CO-084, retained per ADR-025 for
	// future vocabulary-aware features (precomputed expansion, browsing).
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

	_, err = members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	rows, err := pool.Query(r.Context(), `
		SELECT ok.keyword, ok.created_at, ok.deprecated,
		       COALESCE(mk.cnt, 0) as usage_count
		FROM org_keywords ok
		LEFT JOIN (
			SELECT keyword, COUNT(*) as cnt
			FROM memory_keywords
			WHERE org_id = $1
			GROUP BY keyword
		) mk ON ok.keyword = mk.keyword
		WHERE ok.org_id = $1
		ORDER BY ok.keyword
	`, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	keywords := []KeywordInfo{}
	for rows.Next() {
		var ki KeywordInfo
		if err := rows.Scan(&ki.Keyword, &ki.CreatedAt, &ki.Deprecated, &ki.UsageCount); err != nil {
			continue
		}
		keywords = append(keywords, ki)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(keywords)
}

func ListKeywordCandidates(w http.ResponseWriter, r *http.Request) {
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

	_, err = members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	rows, err := pool.Query(r.Context(), `
		SELECT kc.keyword, COUNT(DISTINCT kc.contributor_pubkey) AS distinct_contributors
		FROM keyword_candidates kc
		WHERE kc.org_id = $1
		  AND NOT EXISTS (
			SELECT 1 FROM org_keywords ok
			WHERE ok.org_id = kc.org_id
			  AND ok.keyword = kc.keyword
			  AND ok.deprecated = false
		  )
		GROUP BY kc.keyword
		ORDER BY distinct_contributors DESC, kc.keyword ASC
	`, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	candidates := []protocol.KeywordCandidate{}
	for rows.Next() {
		var candidate protocol.KeywordCandidate
		var distinctContributors int64
		if err := rows.Scan(&candidate.Keyword, &distinctContributors); err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
		candidate.DistinctContributors = int(distinctContributors)
		candidate.Earned = candidate.DistinctContributors >= EARNED_MIN_CONTRIBUTORS
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(candidates)
}

type AddKeywordRequest struct {
	Keyword string `json:"keyword"`
}

func AddKeyword(w http.ResponseWriter, r *http.Request) {
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

	var req AddKeywordRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	req.Keyword = strings.ToLower(strings.TrimSpace(req.Keyword))
	if req.Keyword == "" {
		http.Error(w, `{"error":"keyword required"}`, http.StatusBadRequest)
		return
	}
	if !keywordFormatRegex.MatchString(req.Keyword) {
		http.Error(w, `{"error":"keyword must match `+keywordFormatRegex.String()+`"}`, http.StatusBadRequest)
		return
	}

	_, err = pool.Exec(r.Context(), `
		INSERT INTO org_keywords (org_id, keyword)
		VALUES ($1, $2)
		ON CONFLICT (org_id, keyword) DO UPDATE SET deprecated = false
	`, orgID, req.Keyword)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "added", "keyword": req.Keyword})
}

type MergeKeywordsRequest struct {
	Source string `json:"source"`
	Target string `json:"target"`
}

func MergeKeywords(w http.ResponseWriter, r *http.Request) {
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

	var req MergeKeywordsRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	req.Source = strings.ToLower(strings.TrimSpace(req.Source))
	req.Target = strings.ToLower(strings.TrimSpace(req.Target))
	if req.Source == "" || req.Target == "" {
		http.Error(w, `{"error":"source and target keywords required"}`, http.StatusBadRequest)
		return
	}

	if req.Source == req.Target {
		http.Error(w, `{"error":"source and target must be different"}`, http.StatusBadRequest)
		return
	}

	tx, err := pool.Begin(r.Context())
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	defer tx.Rollback(r.Context())

	_, err = tx.Exec(r.Context(), `
		UPDATE memory_keywords SET keyword = $1 WHERE keyword = $2 AND org_id = $3
	`, req.Target, req.Source, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	_, err = tx.Exec(r.Context(), `
		UPDATE org_keywords SET deprecated = true WHERE keyword = $1 AND org_id = $2
	`, req.Source, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if err := retrieval.UpdateMemoryKeywords(r.Context(), qdrantClient, orgID, []string{req.Source}, req.Target); err != nil {
		http.Error(w, `{"error":"failed to sync qdrant keywords"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": "merged",
		"source": req.Source,
		"target": req.Target,
	})
}

type RenameKeywordRequest struct {
	NewName string `json:"new_name"`
}

func RenameKeyword(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	keyword := chi.URLParam(r, "keyword")
	if orgID == "" || keyword == "" {
		http.Error(w, `{"error":"org_id and keyword required"}`, http.StatusBadRequest)
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
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

	var req RenameKeywordRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	req.NewName = strings.ToLower(strings.TrimSpace(req.NewName))
	if req.NewName == "" {
		http.Error(w, `{"error":"new_name required"}`, http.StatusBadRequest)
		return
	}

	keywordLower := strings.ToLower(keyword)
	if req.NewName == keywordLower {
		http.Error(w, `{"error":"new_name must be different"}`, http.StatusBadRequest)
		return
	}

	tx, err := pool.Begin(r.Context())
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	defer tx.Rollback(r.Context())

	_, err = tx.Exec(r.Context(), `
		UPDATE memory_keywords SET keyword = $1 WHERE keyword = $2 AND org_id = $3
	`, req.NewName, keywordLower, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	_, err = tx.Exec(r.Context(), `
		UPDATE org_keywords SET keyword = $1 WHERE keyword = $2 AND org_id = $3
	`, req.NewName, keywordLower, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if err := retrieval.UpdateMemoryKeywords(r.Context(), qdrantClient, orgID, []string{keywordLower}, req.NewName); err != nil {
		http.Error(w, `{"error":"failed to sync qdrant keywords"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":   "renamed",
		"old_name": keywordLower,
		"new_name": req.NewName,
	})
}

func DeprecateKeyword(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	keyword := chi.URLParam(r, "keyword")
	if orgID == "" || keyword == "" {
		http.Error(w, `{"error":"org_id and keyword required"}`, http.StatusBadRequest)
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		http.Error(w, `{"error":"forbidden: leader only"}`, http.StatusForbidden)
		return
	}

	keywordLower := strings.ToLower(keyword)

	_, err = pool.Exec(r.Context(), `
		UPDATE org_keywords SET deprecated = true WHERE keyword = $1 AND org_id = $2
	`, keywordLower, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "deprecated",
		"keyword": keywordLower,
	})
}
