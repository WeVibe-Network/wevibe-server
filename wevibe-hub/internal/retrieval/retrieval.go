package retrieval

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

func injectGaussianNoise(vector []float32, sigma float64) []float32 {
	var norm float64
	for _, v := range vector {
		norm += float64(v) * float64(v)
	}
	norm = math.Sqrt(norm)
	scaledSigma := sigma * norm
	noisy := make([]float32, len(vector))
	for i, v := range vector {
		noise := float32(rand.NormFloat64() * scaledSigma)
		noisy[i] = v + noise
	}
	return noisy
}

func OrgCollectionName(orgID string) string {
	return "org_" + orgID + "_memories"
}

const EMBED_DIM = 768
const contestedThreshold = 0.20

const (
	DenialDecayBPS    = 500
	ServeBoostBPS     = 100
	MaxServesPerEpoch = 5
	IdleDecayBPS      = 50
)

var ErrInvalidOffset = errors.New("invalid offset token")

const (
	vectorRecallDepth = 30
)

func NewQdrantClient(addr string, apiKey string) (*QdrantClient, error) {
	addr = strings.TrimPrefix(addr, "https://")
	addr = strings.TrimPrefix(addr, "http://")

	host := strings.Split(addr, ":")[0]
	if host == "" {
		host = "localhost"
	}

	if strings.HasPrefix(addr, "localhost") || strings.HasPrefix(addr, "127.0.0.1") {
		host = "localhost"
	}

	return &QdrantClient{
		restURL: fmt.Sprintf("http://%s:6333", host),
		apiKey:  apiKey,
	}, nil
}

type QdrantClient struct {
	restURL         string
	apiKey          string
	pendingDenialDB DBQueryer
}

func (c *QdrantClient) SetPendingDenialDB(db DBQueryer) {
	if c == nil {
		return
	}
	c.pendingDenialDB = db
}

func (c *QdrantClient) Close() error {
	return nil
}

func (c *QdrantClient) newRequest(ctx context.Context, method, url string, body []byte) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("api-key", c.apiKey)
	return req, nil
}

func (c *QdrantClient) EnsureCollection(ctx context.Context, orgID string, vectorSize uint64) error {
	url := fmt.Sprintf("%s/collections/%s", c.restURL, OrgCollectionName(orgID))
	req, err := c.newRequest(ctx, "GET", url, nil)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("check collection exists: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		var result map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&result); err == nil {
			return nil
		}
	}

	createReq := map[string]any{
		"vectors": map[string]any{
			"size":     vectorSize,
			"distance": "Cosine",
		},
	}

	reqBody, err := json.Marshal(createReq)
	if err != nil {
		return fmt.Errorf("marshal create request: %w", err)
	}

	url = fmt.Sprintf("%s/collections/%s", c.restURL, OrgCollectionName(orgID))
	req, err = c.newRequest(ctx, "PUT", url, reqBody)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	resp, err = client.Do(req)
	if err != nil {
		return fmt.Errorf("create collection: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		var errResp map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&errResp); err == nil {
			return fmt.Errorf("create collection failed: %v", errResp)
		}
		return fmt.Errorf("create collection failed with status %d", resp.StatusCode)
	}

	return nil
}

func (c *QdrantClient) UpsertPoint(ctx context.Context, entry protocol.IndexEntry) error {
	contentFlags := make([]any, len(entry.ContentFlags))
	for i, f := range entry.ContentFlags {
		contentFlags[i] = f
	}

	// Build keyword_weights map from entry.Keywords (canonical source).
	// Per D-4.2, Qdrant stores per-keyword weights so retrieval ranking can
	// reflect serve boost / denial decay / idle decay signals. Flat keyword
	// arrays and confidence_bps (killed by D-4.1) are no longer stored.
	keywordWeights := make(map[string]float64, len(entry.Keywords))
	for _, kw := range entry.Keywords {
		keyword := strings.ToLower(strings.TrimSpace(kw.Keyword))
		if keyword == "" {
			continue
		}
		keywordWeights[keyword] = kw.Weight
	}

	payloadMap := map[string]any{
		"cid":             entry.CID,
		"org_id":          entry.OrgID,
		"epoch_id":        entry.EpochID,
		"content_flags":   contentFlags,
		"keyword_weights": keywordWeights,
		"lifecycle_state": entry.LifecycleState,
		"memory_type":     entry.MemoryType,
	}

	if entry.EmbeddingModelID != "" {
		payloadMap["embedding_model_id"] = entry.EmbeddingModelID
	}
	if entry.EmbeddingSchemaVersion != "" {
		payloadMap["embedding_schema_version"] = entry.EmbeddingSchemaVersion
	}
	if entry.VectorDim > 0 {
		payloadMap["vector_dim"] = entry.VectorDim
	}

	noisyVector := injectGaussianNoise(entry.Vector, 0.1)
	upsertReq := map[string]any{
		"points": []map[string]any{
			{
				"id":      stableID(entry.CID),
				"vector":  noisyVector,
				"payload": payloadMap,
			},
		},
	}

	reqBody, err := json.Marshal(upsertReq)
	if err != nil {
		return fmt.Errorf("marshal upsert request: %w", err)
	}

	url := fmt.Sprintf("%s/collections/%s/points", c.restURL, OrgCollectionName(entry.OrgID))
	req, err := c.newRequest(ctx, "PUT", url, reqBody)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("execute upsert request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&errResp); err == nil {
			return fmt.Errorf("upsert failed: %v", errResp)
		}
		return fmt.Errorf("upsert failed with status %d", resp.StatusCode)
	}

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}

	return nil
}

func (c *QdrantClient) QueryPoints(ctx context.Context, orgID string, epochs []int32, vector []float32, keywordWeights []protocol.KeywordWithWeight, embeddingModelID string, limit uint64, includeDormant bool) ([]protocol.MemoryResult, bool, error) {
	filterConditions := []map[string]any{
		{"key": "org_id", "match": map[string]any{"value": orgID}},
	}
	if embeddingModelID != "" {
		filterConditions = append(filterConditions, map[string]any{
			"key": "embedding_model_id", "match": map[string]any{"value": embeddingModelID},
		})
	}

	mustNotConditions := []map[string]any{
		{"key": "lifecycle_state", "match": map[string]any{"value": "ARCHIVED"}},
	}
	if !includeDormant {
		mustNotConditions = append(mustNotConditions, map[string]any{
			"key": "lifecycle_state", "match": map[string]any{"value": "DORMANT"},
		})
	}

	queryWeightsMap := make(map[string]float64, len(keywordWeights))
	for _, kw := range keywordWeights {
		normalized := strings.ToLower(strings.TrimSpace(kw.Keyword))
		if normalized == "" {
			continue
		}
		queryWeightsMap[normalized] = kw.Weight
	}

	// Per D-9.3: score = vector_similarity + Σ(query_weight × memory_weight) × boost_factor.
	// boostFactor scales the keyword contribution relative to vector similarity.
	// confidence_bps was killed by D-4.1 and is no longer part of ranking.
	const keywordBoostFactor = 0.1

	searchLimit := uint64(vectorRecallDepth)
	if limit > searchLimit {
		searchLimit = limit
	}

	searchReq := map[string]any{
		"vector":       vector,
		"limit":        searchLimit,
		"with_payload": true,
		"filter": map[string]any{
			"must":     filterConditions,
			"must_not": mustNotConditions,
		},
	}

	reqBody, err := json.Marshal(searchReq)
	if err != nil {
		return nil, false, fmt.Errorf("marshal search request: %w", err)
	}

	url := fmt.Sprintf("%s/collections/%s/points/search", c.restURL, OrgCollectionName(orgID))
	req, err := c.newRequest(ctx, "POST", url, reqBody)
	if err != nil {
		return nil, false, fmt.Errorf("create request: %w", err)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("execute search request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&errResp); err == nil {
			return nil, false, fmt.Errorf("search failed: %v", errResp)
		}
		return nil, false, fmt.Errorf("search failed with status %d", resp.StatusCode)
	}

	var searchResp struct {
		Result []struct {
			ID      any            `json:"id"`
			Score   float64        `json:"score"`
			Payload map[string]any `json:"payload"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&searchResp); err != nil {
		return nil, false, fmt.Errorf("decode search response: %w", err)
	}

	memoryIdentifiers := make([]string, 0, len(searchResp.Result))
	seenMemoryIdentifiers := make(map[string]struct{}, len(searchResp.Result))
	for _, r := range searchResp.Result {
		cid, _ := r.Payload["cid"].(string)
		if cid == "" {
			continue
		}
		if _, exists := seenMemoryIdentifiers[cid]; exists {
			continue
		}
		seenMemoryIdentifiers[cid] = struct{}{}
		memoryIdentifiers = append(memoryIdentifiers, cid)
	}

	pendingDenialCounts, err := getPendingDenialCounts(ctx, c.pendingDenialDB, orgID, memoryIdentifiers)
	if err != nil {
		return nil, false, fmt.Errorf("load pending denial counts: %w", err)
	}

	type scoredResult struct {
		result        protocol.MemoryResult
		weightedScore float64
	}

	scoredResults := make([]scoredResult, 0, len(searchResp.Result))
	for _, r := range searchResp.Result {
		payload := r.Payload
		cid, _ := payload["cid"].(string)
		if cid == "" {
			continue
		}

		epochID := int32(0)
		if epoch, ok := payload["epoch_id"].(float64); ok {
			epochID = int32(epoch)
		}
		authorized := false
		for _, e := range epochs {
			if e == epochID {
				authorized = true
				break
			}
		}
		if !authorized {
			continue
		}

		vectorScore := r.Score
		if vectorScore <= 0 {
			continue
		}

		contentFlags := getRESTStringSlice(payload, "content_flags")
		storedWeights := getRESTStringFloatMap(payload, "keyword_weights")
		storedKeywords := make([]string, 0, len(storedWeights))
		for kw := range storedWeights {
			storedKeywords = append(storedKeywords, kw)
		}

		keywordBoost, _, _ := computeKeywordScore(storedWeights, storedKeywords, queryWeightsMap)
		finalScore := vectorScore + keywordBoost*keywordBoostFactor
		if count := pendingDenialCounts[cid]; count > 0 {
			// D-2026-05-25-A invariant: consumer denials must impact ranking
			// immediately, before chain confirmation settles keyword weights.
			finalScore = applyPendingDenialDecay(finalScore, count)
		}

		lifecycleState, _ := payload["lifecycle_state"].(string)
		lifecycleState = strings.ToUpper(strings.TrimSpace(lifecycleState))
		memoryType, _ := payload["memory_type"].(string)
		memoryType = strings.TrimSpace(memoryType)

		keywords := make([]protocol.KeywordWithWeight, 0, len(storedWeights))
		for keyword, weight := range storedWeights {
			keyword = strings.TrimSpace(keyword)
			if keyword == "" {
				continue
			}
			keywords = append(keywords, protocol.KeywordWithWeight{Keyword: keyword, Weight: weight})
		}

		scoredResults = append(scoredResults, scoredResult{
			result: protocol.MemoryResult{
				CID:            cid,
				OrgID:          orgID,
				EpochID:        int(epochID),
				LifecycleState: lifecycleState,
				MemoryType:     memoryType,
				ContentFlags:   contentFlags,
				Keywords:       keywords,
			},
			weightedScore: finalScore,
		})
	}

	sort.SliceStable(scoredResults, func(i, j int) bool {
		return scoredResults[i].weightedScore > scoredResults[j].weightedScore
	})

	if limit == 0 || limit > uint64(len(scoredResults)) {
		limit = uint64(len(scoredResults))
	}

	var memoryResults []protocol.MemoryResult
	var topScore, secondScore float64
	for i := uint64(0); i < limit; i++ {
		sr := scoredResults[i]
		// CO-021: surface the post-decay final score so consumers (including
		// the denial-loop smoke test) can observe the optimistic ledger.
		// ScoringBreakdown is the pre-existing carrier for this value; only
		// CombinedScore is populated here — the other fields are reserved for
		// the full per-query scoring breakdown surface (not yet wired).
		sr.result.Breakdown = &protocol.ScoringBreakdown{CombinedScore: sr.weightedScore}
		memoryResults = append(memoryResults, sr.result)
		if i == 0 {
			topScore = sr.weightedScore
		} else if i == 1 {
			secondScore = sr.weightedScore
		}
	}

	contested := false
	if len(memoryResults) >= 2 {
		gap := topScore - secondScore
		if gap < contestedThreshold && gap >= 0 {
			contested = true
		}
	}

	return memoryResults, contested, nil
}

func getPendingDenialCounts(ctx context.Context, db DBQueryer, orgID string, memoryIdentifiers []string) (map[string]int, error) {
	counts := make(map[string]int, len(memoryIdentifiers))
	if len(memoryIdentifiers) == 0 {
		return counts, nil
	}
	if db == nil {
		return nil, fmt.Errorf("database unavailable")
	}

	// Pending counts come from serve_events and naturally drop when
	// processDenialBatchBookkeeping transitions matching rows to status='submitted'.
	rows, err := db.Query(ctx, `
		SELECT memory_content_hash, COUNT(*)
		FROM serve_events
		WHERE event_type = 'denial'
		  AND status = 'pending'
		  AND org_id = $1
		  AND memory_content_hash = ANY($2)
		GROUP BY memory_content_hash
	`, orgID, memoryIdentifiers)
	if err != nil {
		return nil, fmt.Errorf("query pending denial counts: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var memoryIdentifier string
		var count int
		if err := rows.Scan(&memoryIdentifier, &count); err != nil {
			return nil, fmt.Errorf("scan pending denial count: %w", err)
		}
		counts[memoryIdentifier] = count
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate pending denial counts: %w", err)
	}

	return counts, nil
}

func applyPendingDenialDecay(score float64, pendingDenialCount int) float64 {
	if pendingDenialCount <= 0 {
		return score
	}

	adjustment := float64(pendingDenialCount) * (float64(DenialDecayBPS) / 10000.0)
	adjustedScore := score - adjustment
	if adjustedScore < 0 {
		return 0
	}

	return adjustedScore
}

func (c *QdrantClient) CountPoints(ctx context.Context, orgID string) (int64, error) {
	countReq := map[string]any{}

	reqBody, err := json.Marshal(countReq)
	if err != nil {
		return 0, fmt.Errorf("marshal count request: %w", err)
	}

	url := fmt.Sprintf("%s/collections/%s/points/count", c.restURL, OrgCollectionName(orgID))
	req, err := c.newRequest(ctx, "POST", url, reqBody)
	if err != nil {
		return 0, fmt.Errorf("create request: %w", err)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("execute count request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("count failed with status %d", resp.StatusCode)
	}

	var countResp struct {
		Result struct {
			Count int64 `json:"count"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&countResp); err != nil {
		return 0, fmt.Errorf("decode count response: %w", err)
	}

	return countResp.Result.Count, nil
}

func getRESTStringSlice(payload map[string]any, key string) []string {
	if v, ok := payload[key]; ok {
		if arr, ok := v.([]any); ok {
			result := make([]string, 0, len(arr))
			for _, vv := range arr {
				if s, ok := vv.(string); ok {
					result = append(result, s)
				}
			}
			return result
		}
	}
	return nil
}

func getRESTUint64(payload map[string]any, key string) uint64 {
	v, ok := payload[key]
	if !ok {
		return 0
	}

	switch typed := v.(type) {
	case float64:
		if typed < 0 {
			return 0
		}
		return uint64(typed)
	case float32:
		if typed < 0 {
			return 0
		}
		return uint64(typed)
	case int:
		if typed < 0 {
			return 0
		}
		return uint64(typed)
	case int32:
		if typed < 0 {
			return 0
		}
		return uint64(typed)
	case int64:
		if typed < 0 {
			return 0
		}
		return uint64(typed)
	case uint64:
		return typed
	case uint32:
		return uint64(typed)
	default:
		return 0
	}
}

func getRESTStringFloatMap(payload map[string]any, key string) map[string]float64 {
	result := make(map[string]float64)
	if v, ok := payload[key]; ok {
		if obj, ok := v.(map[string]any); ok {
			for k, val := range obj {
				if f, ok := val.(float64); ok {
					result[k] = f
				}
			}
		}
	}
	return result
}

func computeKeywordScore(storedWeights map[string]float64, storedKeywords []string, queryWeights map[string]float64) (float64, []protocol.KeywordMatchDetail, []string) {
	if len(queryWeights) == 0 || len(storedWeights) == 0 {
		return 0, nil, nil
	}

	keywordBoost := 0.0

	matchedKeywords := make([]protocol.KeywordMatchDetail, 0)
	matchedQueryKws := make(map[string]bool)

	for _, kw := range storedKeywords {
		lowerKw := strings.ToLower(kw)
		if queryWeight, ok := queryWeights[lowerKw]; ok {
			if memWeight, ok := storedWeights[lowerKw]; ok {
				product := queryWeight * memWeight
				keywordBoost += product
				matchedKeywords = append(matchedKeywords, protocol.KeywordMatchDetail{
					Keyword:      kw,
					QueryWeight:  queryWeight,
					MemoryWeight: memWeight,
					Product:      product,
				})
				matchedQueryKws[lowerKw] = true
			}
		}
	}

	unmatchedQuery := make([]string, 0)
	for kw := range queryWeights {
		if !matchedQueryKws[kw] {
			unmatchedQuery = append(unmatchedQuery, kw)
		}
	}

	return keywordBoost, matchedKeywords, unmatchedQuery
}

func AddToIndex(ctx context.Context, client *QdrantClient, entry protocol.IndexEntry) error {
	if err := client.EnsureCollection(ctx, entry.OrgID, EMBED_DIM); err != nil {
		return fmt.Errorf("ensure collection: %w", err)
	}
	return client.UpsertPoint(ctx, entry)
}

func EnsureCollection(ctx context.Context, client *QdrantClient, orgID string) error {
	return client.EnsureCollection(ctx, orgID, EMBED_DIM)
}

func QueryByKeywords(
	ctx context.Context,
	client *QdrantClient,
	orgID string,
	accessibleEpochs []int32,
	keywordWeights []protocol.KeywordWithWeight,
	vector []float32,
	embeddingModelID string,
	limit uint64,
	includeDormant bool,
) ([]protocol.MemoryResult, bool, error) {
	return client.QueryPoints(ctx, orgID, accessibleEpochs, vector, keywordWeights, embeddingModelID, limit, includeDormant)
}

type OrgMemoryPayload struct {
	CID            string
	LifecycleState string
}

func ScrollOrgMemoryPayloads(ctx context.Context, client *QdrantClient, orgID string) ([]OrgMemoryPayload, error) {
	if client == nil {
		return nil, fmt.Errorf("qdrant client unavailable")
	}
	if orgID == "" {
		return nil, fmt.Errorf("org id required")
	}

	memories := make([]OrgMemoryPayload, 0)
	var offset any

	for {
		scrollReq := map[string]any{
			"filter": map[string]any{
				"must": []map[string]any{
					{"key": "org_id", "match": map[string]any{"value": orgID}},
				},
			},
			"with_payload": true,
			"with_vectors": false,
			"limit":        256,
		}
		if offset != nil {
			scrollReq["offset"] = offset
		}

		reqBody, err := json.Marshal(scrollReq)
		if err != nil {
			return nil, fmt.Errorf("marshal scroll request: %w", err)
		}

		url := fmt.Sprintf("%s/collections/%s/points/scroll", client.restURL, OrgCollectionName(orgID))
		req, err := client.newRequest(ctx, "POST", url, reqBody)
		if err != nil {
			return nil, fmt.Errorf("create request: %w", err)
		}

		httpClient := &http.Client{Timeout: 10 * time.Second}
		resp, err := httpClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("execute scroll request: %w", err)
		}

		if resp.StatusCode != http.StatusOK {
			defer resp.Body.Close()
			var errResp map[string]any
			if err := json.NewDecoder(resp.Body).Decode(&errResp); err == nil {
				return nil, fmt.Errorf("scroll failed: %v", errResp)
			}
			return nil, fmt.Errorf("scroll failed with status %d", resp.StatusCode)
		}

		var scrollResp struct {
			Result struct {
				Points []struct {
					Payload map[string]any `json:"payload"`
				} `json:"points"`
				NextOffset any `json:"next_page_offset"`
			} `json:"result"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&scrollResp); err != nil {
			resp.Body.Close()
			return nil, fmt.Errorf("decode scroll response: %w", err)
		}
		resp.Body.Close()

		for _, point := range scrollResp.Result.Points {
			cid, _ := point.Payload["cid"].(string)
			if cid == "" {
				continue
			}

			lifecycleState, _ := point.Payload["lifecycle_state"].(string)
			lifecycleState = strings.ToUpper(strings.TrimSpace(lifecycleState))

			memories = append(memories, OrgMemoryPayload{
				CID:            cid,
				LifecycleState: lifecycleState,
			})
		}

		offset = scrollResp.Result.NextOffset
		if offset == nil {
			break
		}
	}

	return memories, nil
}

func ScrollApprovedMemories(ctx context.Context, client *QdrantClient, orgID string, limit uint64, offset string) ([]protocol.MemoryResult, string, error) {
	if client == nil {
		return nil, "", fmt.Errorf("qdrant client unavailable")
	}
	if orgID == "" {
		return nil, "", fmt.Errorf("org id required")
	}

	if limit == 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	scrollReq := map[string]any{
		"filter": map[string]any{
			"must": []map[string]any{
				{"key": "org_id", "match": map[string]any{"value": orgID}},
			},
		},
		"with_payload": true,
		"with_vectors": false,
		"limit":        limit,
	}

	if offset != "" {
		decoded, err := base64.RawURLEncoding.DecodeString(offset)
		if err != nil {
			return nil, "", ErrInvalidOffset
		}

		var offsetPayload map[string]any
		if err := json.Unmarshal(decoded, &offsetPayload); err != nil {
			return nil, "", ErrInvalidOffset
		}
		scrollReq["offset"] = offsetPayload
	}

	reqBody, err := json.Marshal(scrollReq)
	if err != nil {
		return nil, "", fmt.Errorf("marshal scroll request: %w", err)
	}

	url := fmt.Sprintf("%s/collections/%s/points/scroll", client.restURL, OrgCollectionName(orgID))
	req, err := client.newRequest(ctx, "POST", url, reqBody)
	if err != nil {
		return nil, "", fmt.Errorf("create request: %w", err)
	}

	httpClient := &http.Client{Timeout: 10 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("execute scroll request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("scroll failed with status %d", resp.StatusCode)
	}

	var scrollResp struct {
		Result struct {
			Points []struct {
				Payload map[string]any `json:"payload"`
			} `json:"points"`
			NextOffset map[string]any `json:"next_page_offset"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&scrollResp); err != nil {
		return nil, "", fmt.Errorf("decode scroll response: %w", err)
	}

	memories := make([]protocol.MemoryResult, 0, len(scrollResp.Result.Points))
	for _, point := range scrollResp.Result.Points {
		payload := point.Payload
		cid, _ := payload["cid"].(string)
		if cid == "" {
			continue
		}

		epochID := 0
		if epoch, ok := payload["epoch_id"].(float64); ok {
			epochID = int(epoch)
		}

		contentFlags := getRESTStringSlice(payload, "content_flags")
		storedWeights := getRESTStringFloatMap(payload, "keyword_weights")
		keywords := make([]protocol.KeywordWithWeight, 0, len(storedWeights))
		for keyword, weight := range storedWeights {
			keyword = strings.TrimSpace(keyword)
			if keyword == "" {
				continue
			}
			keywords = append(keywords, protocol.KeywordWithWeight{Keyword: keyword, Weight: weight})
		}

		lifecycleState, _ := payload["lifecycle_state"].(string)
		lifecycleState = strings.ToUpper(strings.TrimSpace(lifecycleState))
		memoryType, _ := payload["memory_type"].(string)
		memoryType = strings.TrimSpace(memoryType)

		memories = append(memories, protocol.MemoryResult{
			CID:            cid,
			OrgID:          orgID,
			EpochID:        epochID,
			LifecycleState: lifecycleState,
			MemoryType:     memoryType,
			ContentFlags:   contentFlags,
			Keywords:       keywords,
		})
	}

	var nextOffset string
	if len(scrollResp.Result.NextOffset) > 0 {
		encoded, err := json.Marshal(scrollResp.Result.NextOffset)
		if err != nil {
			return nil, "", fmt.Errorf("encode next offset: %w", err)
		}
		nextOffset = base64.RawURLEncoding.EncodeToString(encoded)
	}

	return memories, nextOffset, nil
}

func (c *QdrantClient) setPointKeywordWeights(ctx context.Context, orgID string, pointID any, weights map[string]float64) error {
	payloadWeights := make(map[string]any, len(weights))
	for k, v := range weights {
		payloadWeights[k] = v
	}

	setPayloadReq := map[string]any{
		"payload": map[string]any{
			"keyword_weights": payloadWeights,
		},
		"points": []any{pointID},
	}

	reqBody, err := json.Marshal(setPayloadReq)
	if err != nil {
		return fmt.Errorf("marshal set payload request: %w", err)
	}

	url := fmt.Sprintf("%s/collections/%s/points/payload", c.restURL, OrgCollectionName(orgID))
	req, err := c.newRequest(ctx, "POST", url, reqBody)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	httpClient := &http.Client{Timeout: 10 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("execute set payload request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&errResp); err == nil {
			return fmt.Errorf("set payload failed: %v", errResp)
		}
		return fmt.Errorf("set payload failed with status %d", resp.StatusCode)
	}

	return nil
}

// UpdateKeywordWeights pushes the latest per-keyword weights for a single
// memory point to Qdrant. Used by the hub after a serve/denial TX is
// confirmed on-chain (D-4.2) and by SyncKeywordWeightsFromChain on startup
// (D-2.5) to reconcile Qdrant with chain state.
func (c *QdrantClient) UpdateKeywordWeights(ctx context.Context, orgID string, memoryCID string, weights map[string]float64) error {
	if c == nil {
		return fmt.Errorf("qdrant client unavailable")
	}
	orgID = strings.TrimSpace(orgID)
	if orgID == "" {
		return fmt.Errorf("org id required")
	}
	memoryCID = strings.TrimSpace(memoryCID)
	if memoryCID == "" {
		return fmt.Errorf("memory cid required")
	}

	payloadWeights := make(map[string]any, len(weights))
	for k, v := range weights {
		key := strings.ToLower(strings.TrimSpace(k))
		if key == "" {
			continue
		}
		payloadWeights[key] = v
	}

	setPayloadReq := map[string]any{
		"payload": map[string]any{
			"keyword_weights": payloadWeights,
		},
		"filter": map[string]any{
			"must": []map[string]any{
				{"key": "org_id", "match": map[string]any{"value": orgID}},
				{"key": "cid", "match": map[string]any{"value": memoryCID}},
			},
		},
	}

	reqBody, err := json.Marshal(setPayloadReq)
	if err != nil {
		return fmt.Errorf("marshal set payload request: %w", err)
	}

	url := fmt.Sprintf("%s/collections/%s/points/payload", c.restURL, OrgCollectionName(orgID))
	req, err := c.newRequest(ctx, "POST", url, reqBody)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	httpClient := &http.Client{Timeout: 10 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("execute set payload request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&errResp); err == nil {
			return fmt.Errorf("set payload failed: %v", errResp)
		}
		return fmt.Errorf("set payload failed with status %d", resp.StatusCode)
	}

	return nil
}

func UpdateMemoryKeywords(ctx context.Context, client *QdrantClient, orgID string, oldKeywords []string, newKeyword string) error {
	if client == nil {
		return fmt.Errorf("qdrant client unavailable")
	}
	if orgID == "" {
		return fmt.Errorf("org id required")
	}

	newKeyword = strings.ToLower(strings.TrimSpace(newKeyword))
	if newKeyword == "" {
		return fmt.Errorf("new keyword required")
	}

	oldKeywordSet := make(map[string]struct{}, len(oldKeywords))
	for _, oldKeyword := range oldKeywords {
		oldKeyword = strings.ToLower(strings.TrimSpace(oldKeyword))
		if oldKeyword == "" {
			continue
		}
		oldKeywordSet[oldKeyword] = struct{}{}
	}
	if len(oldKeywordSet) == 0 {
		return fmt.Errorf("old keywords required")
	}

	type scrollPoint struct {
		ID      any            `json:"id"`
		Payload map[string]any `json:"payload"`
	}

	var offset any
	for {
		scrollReq := map[string]any{
			"filter": map[string]any{
				"must": []map[string]any{
					{"key": "org_id", "match": map[string]any{"value": orgID}},
				},
			},
			"with_payload": true,
			"with_vectors": false,
			"limit":        256,
		}
		if offset != nil {
			scrollReq["offset"] = offset
		}

		reqBody, err := json.Marshal(scrollReq)
		if err != nil {
			return fmt.Errorf("marshal scroll request: %w", err)
		}

		url := fmt.Sprintf("%s/collections/%s/points/scroll", client.restURL, OrgCollectionName(orgID))
		req, err := client.newRequest(ctx, "POST", url, reqBody)
		if err != nil {
			return fmt.Errorf("create request: %w", err)
		}

		httpClient := &http.Client{Timeout: 10 * time.Second}
		resp, err := httpClient.Do(req)
		if err != nil {
			return fmt.Errorf("execute scroll request: %w", err)
		}

		if resp.StatusCode != http.StatusOK {
			defer resp.Body.Close()
			var errResp map[string]any
			if err := json.NewDecoder(resp.Body).Decode(&errResp); err == nil {
				return fmt.Errorf("scroll failed: %v", errResp)
			}
			return fmt.Errorf("scroll failed with status %d", resp.StatusCode)
		}

		var scrollResp struct {
			Result struct {
				Points     []scrollPoint `json:"points"`
				NextOffset any           `json:"next_page_offset"`
			} `json:"result"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&scrollResp); err != nil {
			resp.Body.Close()
			return fmt.Errorf("decode scroll response: %w", err)
		}
		resp.Body.Close()

		for _, point := range scrollResp.Result.Points {
			storedWeights := getRESTStringFloatMap(point.Payload, "keyword_weights")
			if len(storedWeights) == 0 {
				continue
			}

			rewritten := make(map[string]float64, len(storedWeights))
			changed := false

			for storedKeyword, storedWeight := range storedWeights {
				lowerStored := strings.ToLower(strings.TrimSpace(storedKeyword))
				if lowerStored == "" {
					continue
				}

				nextKeyword := lowerStored
				if _, ok := oldKeywordSet[lowerStored]; ok {
					nextKeyword = newKeyword
					changed = true
				}

				if existing, exists := rewritten[nextKeyword]; exists {
					// Keyword already present after rewrite (e.g. merging two
					// keywords into one). Keep the maximum weight to preserve
					// the strongest signal.
					if storedWeight > existing {
						rewritten[nextKeyword] = storedWeight
					}
					if nextKeyword != lowerStored {
						changed = true
					}
					continue
				}
				rewritten[nextKeyword] = storedWeight
			}

			if !changed {
				continue
			}

			if err := client.setPointKeywordWeights(ctx, orgID, point.ID, rewritten); err != nil {
				return fmt.Errorf("update point keyword weights: %w", err)
			}
		}

		offset = scrollResp.Result.NextOffset
		if offset == nil {
			break
		}
	}

	return nil
}

func UpdateMemoryState(ctx context.Context, client *QdrantClient, orgID string, memoryCID string, lifecycleState string) error {
	if client == nil {
		return fmt.Errorf("qdrant client unavailable")
	}

	orgID = strings.TrimSpace(orgID)
	if orgID == "" {
		return fmt.Errorf("org id required")
	}

	memoryCID = strings.TrimSpace(memoryCID)
	if memoryCID == "" {
		return fmt.Errorf("memory cid required")
	}

	lifecycleState = strings.ToUpper(strings.TrimSpace(lifecycleState))
	if lifecycleState == "" {
		return fmt.Errorf("lifecycle state required")
	}

	setPayloadReq := map[string]any{
		"payload": map[string]any{
			"lifecycle_state": lifecycleState,
		},
		"filter": map[string]any{
			"must": []map[string]any{
				{"key": "org_id", "match": map[string]any{"value": orgID}},
				{"key": "cid", "match": map[string]any{"value": memoryCID}},
			},
		},
	}

	reqBody, err := json.Marshal(setPayloadReq)
	if err != nil {
		return fmt.Errorf("marshal set payload request: %w", err)
	}

	url := fmt.Sprintf("%s/collections/%s/points/payload", client.restURL, OrgCollectionName(orgID))
	req, err := client.newRequest(ctx, "POST", url, reqBody)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	httpClient := &http.Client{Timeout: 10 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("execute set payload request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&errResp); err == nil {
			return fmt.Errorf("set payload failed: %v", errResp)
		}
		return fmt.Errorf("set payload failed with status %d", resp.StatusCode)
	}

	return nil
}

func (c *QdrantClient) DeletePointByCID(ctx context.Context, orgID, memoryCID string) error {
	deleteReq := map[string]any{
		"filter": map[string]any{
			"must": []map[string]any{
				{"key": "org_id", "match": map[string]any{"value": orgID}},
				{"key": "cid", "match": map[string]any{"value": memoryCID}},
			},
		},
	}

	reqBody, err := json.Marshal(deleteReq)
	if err != nil {
		return fmt.Errorf("marshal delete request: %w", err)
	}

	url := fmt.Sprintf("%s/collections/%s/points/delete", c.restURL, OrgCollectionName(orgID))
	req, err := c.newRequest(ctx, "POST", url, reqBody)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	httpClient := &http.Client{Timeout: 10 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("execute delete request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&errResp); err == nil {
			return fmt.Errorf("delete failed: %v", errResp)
		}
		return fmt.Errorf("delete failed with status %d", resp.StatusCode)
	}

	return nil
}

func stableID(cid string) uint64 {
	var h uint64 = 14695981039346656037
	for _, b := range []byte(cid) {
		h ^= uint64(b)
		h *= 1099511628211
	}
	return h
}

func ApplyServeBoostLocal(ctx context.Context, db DBExecutor, memoryCID string, orgID string) error {
	if db == nil {
		return fmt.Errorf("database unavailable")
	}
	_, err := db.Exec(ctx, `
		UPDATE memory_keywords
		SET weight = LEAST(1.0, weight + $1)
		WHERE memory_cid = $2 AND org_id = $3
	`, float64(ServeBoostBPS)/10000.0, memoryCID, orgID)
	if err != nil {
		return fmt.Errorf("apply serve boost: %w", err)
	}
	return nil
}

func ApplyDenialDecayLocal(ctx context.Context, db DBExecutor, memoryCID string, orgID string) error {
	if db == nil {
		return fmt.Errorf("database unavailable")
	}
	_, err := db.Exec(ctx, `
		UPDATE memory_keywords
		SET weight = GREATEST(0.0, weight - $1)
		WHERE memory_cid = $2 AND org_id = $3
	`, float64(DenialDecayBPS)/10000.0, memoryCID, orgID)
	if err != nil {
		return fmt.Errorf("apply denial decay: %w", err)
	}
	return nil
}

// GetKeywordWeights returns the current per-keyword weights for a single
// memory from PostgreSQL (the local mirror of chain state). Used after
// ApplyServeBoostLocal / ApplyDenialDecayLocal to push the updated weights
// into the Qdrant payload.
func GetKeywordWeights(ctx context.Context, db DBQueryer, orgID, memoryCID string) (map[string]float64, error) {
	if db == nil {
		return nil, fmt.Errorf("database unavailable")
	}
	rows, err := db.Query(ctx, `
		SELECT keyword, weight
		FROM memory_keywords
		WHERE org_id = $1 AND memory_cid = $2
	`, orgID, memoryCID)
	if err != nil {
		return nil, fmt.Errorf("query keyword weights: %w", err)
	}
	defer rows.Close()

	weights := make(map[string]float64)
	for rows.Next() {
		var keyword string
		var weight float64
		if err := rows.Scan(&keyword, &weight); err != nil {
			return nil, fmt.Errorf("scan keyword weight: %w", err)
		}
		weights[strings.ToLower(strings.TrimSpace(keyword))] = weight
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate keyword weights: %w", err)
	}
	return weights, nil
}

type DBExecutor interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

type DBQueryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}
