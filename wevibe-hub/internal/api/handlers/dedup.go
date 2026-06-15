package handlers

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

const (
	// CALIBRATION PLACEHOLDER: cosine is model-specific and the stored vector is the situation card;
	// calibrate on a labeled dupe/non-dupe set before trusting this number.
	defaultDuplicateClusterThreshold = 0.95
)

type duplicateCluster struct {
	Members []string `json:"members"`
	Size    int      `json:"size"`
}

type unionFind struct {
	parent []int
	rank   []int
}

func newUnionFind(size int) *unionFind {
	parent := make([]int, size)
	rank := make([]int, size)
	for i := range parent {
		parent[i] = i
	}
	return &unionFind{parent: parent, rank: rank}
}

func (u *unionFind) find(x int) int {
	if u.parent[x] != x {
		u.parent[x] = u.find(u.parent[x])
	}
	return u.parent[x]
}

func (u *unionFind) union(x, y int) {
	rx := u.find(x)
	ry := u.find(y)
	if rx == ry {
		return
	}
	if u.rank[rx] < u.rank[ry] {
		u.parent[rx] = ry
		return
	}
	if u.rank[rx] > u.rank[ry] {
		u.parent[ry] = rx
		return
	}
	u.parent[ry] = rx
	u.rank[rx]++
}

func DuplicateClusters(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "database unavailable"})
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "org_id required"})
		return
	}

	if !requireLeaderAuthorization(w, r, orgID) {
		return
	}

	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status == "" {
		status = "pending_chain"
	}
	if status != "pending_chain" && status != "pending_keyword" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "status must be pending_chain or pending_keyword"})
		return
	}

	threshold := defaultDuplicateClusterThreshold
	if rawThreshold := strings.TrimSpace(r.URL.Query().Get("threshold")); rawThreshold != "" {
		parsedThreshold, err := strconv.ParseFloat(rawThreshold, 64)
		if err != nil || math.IsNaN(parsedThreshold) || math.IsInf(parsedThreshold, 0) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "threshold must be a valid float"})
			return
		}
		threshold = parsedThreshold
	}

	rows, err := pool.Query(r.Context(), `
		SELECT submission_hash, embedding_vector
		FROM pending_submissions
		WHERE org_id = $1 AND status = $2
	`, orgID, status)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error":   "database query failed",
			"details": err.Error(),
		})
		return
	}
	defer rows.Close()

	type normalizedSubmission struct {
		hash   string
		vector []float64
	}

	total := 0
	normalized := make([]normalizedSubmission, 0)
	for rows.Next() {
		total++

		var submissionHash string
		var embeddingRaw []byte
		if err := rows.Scan(&submissionHash, &embeddingRaw); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error":   "database scan failed",
				"details": err.Error(),
			})
			return
		}

		vector, ok, parseErr := parseAndNormalizeEmbeddingVector(embeddingRaw)
		if parseErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error":   "failed to parse embedding_vector",
				"details": parseErr.Error(),
			})
			return
		}
		if !ok {
			continue
		}
		normalized = append(normalized, normalizedSubmission{hash: submissionHash, vector: vector})
	}
	if err := rows.Err(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error":   "database iteration failed",
			"details": err.Error(),
		})
		return
	}

	clusters := make([]duplicateCluster, 0)
	clusteredCount := 0
	if len(normalized) >= 2 {
		uf := newUnionFind(len(normalized))
		for i := 0; i < len(normalized); i++ {
			for j := i + 1; j < len(normalized); j++ {
				if len(normalized[i].vector) != len(normalized[j].vector) {
					continue
				}
				similarity := dot(normalized[i].vector, normalized[j].vector)
				if similarity >= threshold {
					uf.union(i, j)
				}
			}
		}

		grouped := make(map[int][]string)
		for i := range normalized {
			root := uf.find(i)
			grouped[root] = append(grouped[root], normalized[i].hash)
		}

		for _, members := range grouped {
			if len(members) < 2 {
				continue
			}
			sort.Strings(members)
			clusters = append(clusters, duplicateCluster{Members: members, Size: len(members)})
			clusteredCount += len(members)
		}
		sort.Slice(clusters, func(i, j int) bool {
			if clusters[i].Size == clusters[j].Size {
				return clusters[i].Members[0] < clusters[j].Members[0]
			}
			return clusters[i].Size > clusters[j].Size
		})
	}

	unclustered := total - clusteredCount
	if unclustered < 0 {
		unclustered = 0
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"threshold":   threshold,
		"clusters":    clusters,
		"unclustered": unclustered,
		"total":       total,
	})
}

func requireLeaderAuthorization(w http.ResponseWriter, r *http.Request, orgID string) bool {
	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return false
	}

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid timestamp format, use RFC3339"})
		return false
	}
	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "timestamp expired or too far in future"})
		return false
	}
	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return false
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: leader only"})
		return false
	}
	return true
}

func parseAndNormalizeEmbeddingVector(raw []byte) ([]float64, bool, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, false, nil
	}

	var vector []float32
	if err := json.Unmarshal(trimmed, &vector); err != nil {
		return nil, false, err
	}
	if len(vector) == 0 {
		return nil, false, nil
	}

	normSquared := 0.0
	normalized := make([]float64, len(vector))
	for i := range vector {
		value := float64(vector[i])
		normalized[i] = value
		normSquared += value * value
	}
	if normSquared == 0 {
		return nil, false, nil
	}

	invNorm := 1 / math.Sqrt(normSquared)
	for i := range normalized {
		normalized[i] *= invNorm
	}

	return normalized, true, nil
}

func dot(left, right []float64) float64 {
	if len(left) != len(right) {
		return 0
	}

	total := 0.0
	for i := range left {
		total += left[i] * right[i]
	}
	return total
}
