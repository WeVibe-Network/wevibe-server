package retrieval

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"log/slog"
	"math"
	"math/rand"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
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

const defaultStandingBps int32 = 10000
const defaultStandingThresholdBps int32 = 1500

type scoredResult struct {
	result             protocol.MemoryResult
	weightedScore      float64
	memoryCreatedEpoch uint64
}

type CandidateScore struct {
	CID             string
	StandingBps     int32
	KeywordOverlap  float64
	VectorScore     float64
	Gamma           float64
	Delta           float64
	CappedBoost     float64
	CombinedScore   float64
	MatchedKeywords []string
	RankPosition    int
	Disposition     string
}

type ProbabilisticRanker struct {
	Temperature               float64
	NewMemBoostMult           float64
	NewMemBoostWindow         uint64
	GraceEpochs               uint64
	UniformExposureFraction   float64
	CounterfactualStandingBps int32
	RNG                       *rand.Rand
}

var defaultRanker *ProbabilisticRanker

func SetRetrievalRanker(r *ProbabilisticRanker) {
	defaultRanker = r
}

func getRanker() *ProbabilisticRanker {
	if defaultRanker != nil {
		return defaultRanker
	}

	return &ProbabilisticRanker{
		Temperature:       0.7,
		NewMemBoostMult:   0.5,
		NewMemBoostWindow: 30,
		GraceEpochs:       20,
		RNG:               rand.New(rand.NewSource(1)),
	}
}

func (r *ProbabilisticRanker) probabilisticRank(scored []scoredResult, limit int) ([]scoredResult, bool) {
	if len(scored) == 0 || limit <= 0 {
		return nil, false
	}
	if limit > len(scored) {
		limit = len(scored)
	}
	if len(scored) <= 1 {
		return scored[:limit], false
	}

	rng := r.RNG
	if rng == nil {
		rng = rand.New(rand.NewSource(1))
	}

	probe := r.UniformExposureFraction > 0 && rng.Float64() < r.UniformExposureFraction
	if probe {
		availIdx := make([]int, len(scored))
		for i := range availIdx {
			availIdx[i] = i
		}

		out := make([]scoredResult, 0, limit)
		for draw := 0; draw < limit && len(availIdx) > 0; draw++ {
			chosen := rng.Intn(len(availIdx))
			out = append(out, scored[availIdx[chosen]])
			availIdx = append(availIdx[:chosen], availIdx[chosen+1:]...)
		}
		return out, true
	}
	if limit <= 1 {
		return scored[:limit], false
	}

	top := scored[0]
	rest := scored[1:]
	maxScore := rest[0].weightedScore

	temp := r.Temperature
	if temp < 0.01 {
		temp = 0.01
	}
	invT := 1.0 / temp

	weights := make([]float64, len(rest))
	for i, sr := range rest {
		if maxScore <= 0 {
			weights[i] = 0
			continue
		}
		ratio := sr.weightedScore / maxScore
		if ratio < 0 {
			ratio = 0
		}
		weights[i] = math.Pow(ratio, invT)
	}

	k := limit - 1
	if k > len(rest) {
		k = len(rest)
	}

	sampled := make([]int, 0, k)
	availIdx := make([]int, len(rest))
	for i := range availIdx {
		availIdx[i] = i
	}
	availW := append([]float64(nil), weights...)

	for draw := 0; draw < k && len(availIdx) > 0; draw++ {
		total := 0.0
		for _, w := range availW {
			total += w
		}
		if total <= 0 {
			break
		}

		target := rng.Float64() * total
		chosen := len(availIdx) - 1
		cum := 0.0
		for j, w := range availW {
			cum += w
			if target <= cum {
				chosen = j
				break
			}
		}

		sampled = append(sampled, availIdx[chosen])
		availIdx = append(availIdx[:chosen], availIdx[chosen+1:]...)
		availW = append(availW[:chosen], availW[chosen+1:]...)
	}

	sampledSet := make(map[int]struct{}, len(sampled))
	for _, idx := range sampled {
		sampledSet[idx] = struct{}{}
	}

	out := make([]scoredResult, 0, len(sampled)+1)
	out = append(out, top)
	for idx, sr := range rest {
		if _, ok := sampledSet[idx]; ok {
			out = append(out, sr)
		}
	}

	return out, false
}

const (
	vectorRecallDepth = 5000
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
		restURL:          fmt.Sprintf("http://%s:6333", host),
		apiKey:           apiKey,
		vectorNoiseSigma: 0.0,
		recallDepth:      vectorRecallDepth,
	}, nil
}

type QdrantClient struct {
	restURL          string
	apiKey           string
	pendingDenialDB  DBQueryer
	vectorNoiseSigma float64
	recallDepth      uint64
}

func (c *QdrantClient) SetRetrievalConfig(vectorNoiseSigma float64, recallDepth uint64) {
	if c == nil {
		return
	}
	c.vectorNoiseSigma = vectorNoiseSigma
	c.recallDepth = recallDepth
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

	collectionEnsured := false
	if resp.StatusCode == http.StatusOK {
		var result map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&result); err == nil {
			collectionEnsured = true
		}
	}

	if !collectionEnsured {
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
	}

	if err := c.ensureCollectionPayloadIndexes(ctx, orgID, client); err != nil {
		return err
	}

	return nil
}

func (c *QdrantClient) ensureCollectionPayloadIndexes(ctx context.Context, orgID string, client *http.Client) error {
	collectionName := OrgCollectionName(orgID)
	url := fmt.Sprintf("%s/collections/%s/index", c.restURL, collectionName)
	payloadIndexFields := []string{"org_id", "language", "superseded_by"}

	for _, fieldName := range payloadIndexFields {
		indexReq := map[string]any{
			"field_name":   fieldName,
			"field_schema": "keyword",
		}
		reqBody, err := json.Marshal(indexReq)
		if err != nil {
			return fmt.Errorf("marshal payload index request: %w", err)
		}

		req, err := c.newRequest(ctx, "PUT", url, reqBody)
		if err != nil {
			return fmt.Errorf("create request: %w", err)
		}

		resp, err := client.Do(req)
		if err != nil {
			return fmt.Errorf("create payload index for %s: %w", fieldName, err)
		}

		respBody, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			return fmt.Errorf("read payload index response for %s: %w", fieldName, readErr)
		}

		if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated {
			continue
		}

		if strings.Contains(strings.ToLower(string(respBody)), "already exists") {
			continue
		}

		var errResp map[string]any
		if err := json.Unmarshal(respBody, &errResp); err == nil {
			return fmt.Errorf("create payload index failed for %s: %v", fieldName, errResp)
		}
		return fmt.Errorf("create payload index failed for %s with status %d", fieldName, resp.StatusCode)
	}

	return nil
}

func (c *QdrantClient) UpsertPoint(ctx context.Context, entry protocol.IndexEntry) error {
	contentFlags := make([]any, len(entry.ContentFlags))
	for i, f := range entry.ContentFlags {
		contentFlags[i] = f
	}

	keywords := make([]string, 0, len(entry.Keywords))
	seenKeywords := make(map[string]struct{}, len(entry.Keywords))
	for _, kw := range entry.Keywords {
		keyword := strings.ToLower(strings.TrimSpace(kw.Keyword))
		if keyword == "" {
			continue
		}
		if _, seen := seenKeywords[keyword]; seen {
			continue
		}
		seenKeywords[keyword] = struct{}{}
		keywords = append(keywords, keyword)
	}
	sort.Strings(keywords)

	payloadMap := map[string]any{
		"cid":               entry.CID,
		"org_id":            entry.OrgID,
		"epoch_id":          entry.EpochID,
		"content_flags":     contentFlags,
		"keywords":          keywords,
		"standing_bps":      defaultStandingBps,
		"standing_archived": false,
		"lifecycle_state":   entry.LifecycleState,
		"memory_type":       entry.MemoryType,
		// Producer-model provenance (T3): immutable fields carried in Qdrant payload.
		// These are rebuildable read-index fields, not authority — the source of truth
		// is pending_submissions + chain types. SESSION_REFERENCED means a session
		// reference exists, not cryptographic verification (fact-vs-policy separation).
	}
	if entry.ProducerModelId != "" {
		payloadMap["producer_model_id"] = entry.ProducerModelId
	}
	if entry.AttestationSessionHash != "" {
		payloadMap["attestation_session_hash"] = entry.AttestationSessionHash
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

	noisyVector := injectGaussianNoise(entry.Vector, c.vectorNoiseSigma)
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

func (c *QdrantClient) QueryPoints(ctx context.Context, orgID string, vector []float32, keywordWeights []protocol.KeywordWithWeight, embeddingModelID string, limit uint64, includeDormant bool, relevanceFloor float64, surfaceBudget int) ([]protocol.MemoryResult, bool, []CandidateScore, error) {
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

	queryKeywords := make([]string, 0, len(keywordWeights))
	for _, kw := range keywordWeights {
		normalized := strings.ToLower(strings.TrimSpace(kw.Keyword))
		if normalized == "" {
			continue
		}
		queryKeywords = append(queryKeywords, normalized)
	}

	// Recall-pivot scoring: vector similarity plus a capped keyword-overlap boost
	// scaled by Qdrant-projected memory standing.
	const keywordBoostFactor = 0.1
	const keywordBoostDelta = 0.15

	searchLimit := c.recallDepth
	if searchLimit == 0 {
		searchLimit = vectorRecallDepth
	}
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
		log.Printf("[recall] qdrant search marshal FAILED org=%s collection=%s vecDim=%d: %v", orgID, OrgCollectionName(orgID), len(vector), err)
		return nil, false, nil, fmt.Errorf("marshal search request: %w", err)
	}

	collectionName := OrgCollectionName(orgID)
	url := fmt.Sprintf("%s/collections/%s/points/search", c.restURL, collectionName)
	log.Printf("[recall] qdrant search request org=%s collection=%s url=%s vecDim=%d limit=%d includeDormant=%v kw=%d", orgID, collectionName, url, len(vector), searchLimit, includeDormant, len(keywordWeights))
	req, err := c.newRequest(ctx, "POST", url, reqBody)
	if err != nil {
		log.Printf("[recall] qdrant search create request FAILED org=%s collection=%s url=%s: %v", orgID, collectionName, url, err)
		return nil, false, nil, fmt.Errorf("create request: %w", err)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[recall] qdrant search http call FAILED org=%s collection=%s url=%s: %v", orgID, collectionName, url, err)
		return nil, false, nil, fmt.Errorf("execute search request: %w", err)
	}
	defer resp.Body.Close()
	log.Printf("[recall] qdrant search response org=%s collection=%s status=%d", orgID, collectionName, resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		bodyBytes, readErr := io.ReadAll(resp.Body)
		if readErr != nil {
			log.Printf("[recall] qdrant search non-2xx read body FAILED org=%s collection=%s status=%d: %v", orgID, collectionName, resp.StatusCode, readErr)
		}
		body := string(bodyBytes)
		if body == "" {
			body = "<empty>"
		}
		log.Printf("[recall] qdrant search non-2xx org=%s collection=%s status=%d queryVecDim=%d body=%s", orgID, collectionName, resp.StatusCode, len(vector), body)
		if resp.StatusCode == http.StatusNotFound && strings.Contains(body, "doesn't exist") {
			log.Printf("[recall] qdrant collection not yet created org=%s collection=%s — returning empty result", orgID, collectionName)
			return []protocol.MemoryResult{}, false, []CandidateScore{}, nil
		}
		if expectedDim, ok := extractExpectedVectorDim(body); ok {
			log.Printf("[recall] qdrant vector dimensions org=%s collection=%s queryVecDim=%d expectedVecDim=%d", orgID, collectionName, len(vector), expectedDim)
		}
		var errResp map[string]any
		if err := json.Unmarshal(bodyBytes, &errResp); err == nil {
			return nil, false, nil, fmt.Errorf("search failed: %v", errResp)
		}
		return nil, false, nil, fmt.Errorf("search failed with status %d", resp.StatusCode)
	}

	var searchResp struct {
		Result []struct {
			ID      any            `json:"id"`
			Score   float64        `json:"score"`
			Payload map[string]any `json:"payload"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&searchResp); err != nil {
		log.Printf("[recall] qdrant search decode FAILED org=%s collection=%s: %v", orgID, collectionName, err)
		return nil, false, nil, fmt.Errorf("decode search response: %w", err)
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
		return nil, false, nil, fmt.Errorf("load pending denial counts: %w", err)
	}

	currentEpoch := uint64(0)
	ranker := getRanker()

	type queryPointRichData struct {
		orgID              string
		epochID            int32
		lifecycleState     string
		memoryType         string
		producerModelID    string
		contentFlags       []string
		keywords           []string
		standingBps        int32
		memoryCreatedEpoch uint64
	}

	ageFrom := func(currentEpoch, memoryCreatedEpoch uint64) int {
		if currentEpoch > memoryCreatedEpoch {
			return int(currentEpoch - memoryCreatedEpoch)
		}
		return 0
	}

	cands := make([]RankCandidate, 0, len(searchResp.Result))
	richDataByCID := make(map[string]queryPointRichData, len(searchResp.Result))

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
		memoryCreatedEpoch := getRESTUint64(payload, "epoch_id")

		vectorScore := r.Score

		contentFlags := getRESTStringSlice(payload, "content_flags")
		keywords := normalizeKeywords(getRESTStringSlice(payload, "keywords"))
		standingBps := getRESTInt32(payload, "standing_bps", defaultStandingBps)
		standingArchived := getRESTBool(payload, "standing_archived")

		lifecycleState, _ := payload["lifecycle_state"].(string)
		lifecycleState = strings.ToUpper(strings.TrimSpace(lifecycleState))
		memoryType, _ := payload["memory_type"].(string)
		memoryType = strings.TrimSpace(memoryType)
		producerModelID, _ := payload["producer_model_id"].(string)

		cands = append(cands, RankCandidate{
			ID:             cid,
			VectorScore:    vectorScore,
			Keywords:       keywords,
			StandingBps:    standingBps,
			Archived:       standingArchived,
			PendingDenials: pendingDenialCounts[cid],
			Age:            ageFrom(currentEpoch, memoryCreatedEpoch),
		})

		richDataByCID[cid] = queryPointRichData{
			orgID:              orgID,
			epochID:            epochID,
			lifecycleState:     lifecycleState,
			memoryType:         memoryType,
			producerModelID:    producerModelID,
			contentFlags:       contentFlags,
			keywords:           keywords,
			standingBps:        standingBps,
			memoryCreatedEpoch: memoryCreatedEpoch,
		}
	}

	candidatesTotal := len(cands)
	wlog.Op(ctx, "hub.recall_standing_projection", slog.LevelInfo,
		slog.String("phase", "outcome"),
		slog.Int("candidates", candidatesTotal),
		slog.Int("qdrant_projected", len(cands)))

	out := ScoreAndRank(cands, RankQuery{Keywords: queryKeywords}, RankOpts{
		Gate:                 false,
		KeywordBoostFactor:   keywordBoostFactor,
		Delta:                keywordBoostDelta,
		NewMemBoost:          ranker.NewMemBoostMult > 0 && ranker.NewMemBoostWindow > 0,
		Grace:                float64(ranker.GraceEpochs),
		BoostWindow:          float64(ranker.NewMemBoostWindow),
		NewMemMult:           ranker.NewMemBoostMult,
		Floor:                relevanceFloor,
		StandingThresholdBps: defaultStandingThresholdBps,
	})
	if ranker.CounterfactualStandingBps > 0 {
		counterfactualCands := make([]RankCandidate, len(cands))
		copy(counterfactualCands, cands)
		for i := range counterfactualCands {
			counterfactualCands[i].StandingBps = ranker.CounterfactualStandingBps
		}

		counterfactualOut := ScoreAndRank(counterfactualCands, RankQuery{Keywords: queryKeywords}, RankOpts{
			Gate:                 false,
			KeywordBoostFactor:   keywordBoostFactor,
			Delta:                keywordBoostDelta,
			NewMemBoost:          ranker.NewMemBoostMult > 0 && ranker.NewMemBoostWindow > 0,
			Grace:                float64(ranker.GraceEpochs),
			BoostWindow:          float64(ranker.NewMemBoostWindow),
			NewMemMult:           ranker.NewMemBoostMult,
			Floor:                relevanceFloor,
			StandingThresholdBps: defaultStandingThresholdBps,
		})
		setDiff, overlapCount, rankDeltaSum := rankingDivergence(out.Rows, counterfactualOut.Rows)
		wlog.Op(ctx, "hub.recall_counterfactual_ranking", slog.LevelInfo,
			slog.String("phase", "outcome"),
			slog.Int("live_admitted", len(out.Rows)),
			slog.Int("counterfactual_admitted", len(counterfactualOut.Rows)),
			slog.Int("admitted_set_difference", setDiff),
			slog.Int("overlap", overlapCount),
			slog.Int("rank_delta_sum", rankDeltaSum))
	}

	wlog.Op(ctx, "hub.recall_floor_gate", slog.LevelInfo,
		slog.String("phase", "outcome"),
		slog.Float64("relevance_floor", relevanceFloor),
		slog.Int("candidates_scored", len(cands)),
		slog.Int("admitted", len(out.Rows)),
		slog.Int("dropped_by_floor", out.Drops.Floor))

	scoredResults := make([]scoredResult, 0, len(out.Rows))
	for _, row := range out.Rows {
		richData, ok := richDataByCID[row.ID]
		if !ok {
			continue
		}

		matchedKeywords := append([]string{}, row.Matched...)
		sort.Strings(matchedKeywords)

		keywordMatches := make([]protocol.KeywordMatchDetail, 0, len(row.KeywordMatches))
		for _, match := range row.KeywordMatches {
			keywordMatches = append(keywordMatches, protocol.KeywordMatchDetail{
				Keyword: match.Keyword,
			})
		}
		resultKeywords := make([]protocol.KeywordWithWeight, 0, len(richData.keywords))
		for _, keyword := range richData.keywords {
			resultKeywords = append(resultKeywords, protocol.KeywordWithWeight{Keyword: keyword, Weight: 1})
		}

		unmatchedQuery := append([]string{}, row.UnmatchedQuery...)

		scoredResults = append(scoredResults, scoredResult{
			result: protocol.MemoryResult{
				CID:             row.ID,
				OrgID:           richData.orgID,
				EpochID:         int(richData.epochID),
				LifecycleState:  richData.lifecycleState,
				MemoryType:      richData.memoryType,
				ProducerModelId: richData.producerModelID,
				ContentFlags:    richData.contentFlags,
				Keywords:        resultKeywords,
				MatchedKeywords: matchedKeywords,
				Breakdown: &protocol.ScoringBreakdown{
					KeywordScore:   row.KeywordBoost,
					VectorScore:    row.VectorScore,
					Gamma:          row.Gamma,
					Delta:          row.Delta,
					CappedBoost:    row.CappedBoost,
					CombinedScore:  row.Final,
					KeywordMatches: keywordMatches,
					UnmatchedQuery: unmatchedQuery,
				},
			},
			weightedScore:      row.Final,
			memoryCreatedEpoch: richData.memoryCreatedEpoch,
		})
	}
	cap := limit
	if surfaceBudget > 0 && (cap == 0 || uint64(surfaceBudget) < cap) {
		cap = uint64(surfaceBudget)
	}
	if cap == 0 || cap > uint64(len(scoredResults)) {
		cap = uint64(len(scoredResults))
	}
	// D-9.4 power-law sampler. Source: wevibe-sim/ranking-fix.js:73-111.
	rankedResults, openLoopProbe := ranker.probabilisticRank(scoredResults, int(cap))
	if ranker.UniformExposureFraction > 0 || openLoopProbe {
		wlog.Op(ctx, "hub.recall_open_loop_probe", slog.LevelInfo,
			slog.String("phase", "outcome"),
			slog.Float64("fraction", ranker.UniformExposureFraction),
			slog.Bool("probed", openLoopProbe),
			slog.Int("candidates", len(scoredResults)),
			slog.Int("returned", len(rankedResults)))
	}
	rankedPositions := make(map[string]int, len(rankedResults))
	for idx, sr := range rankedResults {
		rankedPositions[sr.result.CID] = idx
	}

	candidateScores := make([]CandidateScore, 0, len(scoredResults)+len(out.FloorDropped))
	for _, sr := range scoredResults {
		candidate := CandidateScore{
			CID:             sr.result.CID,
			MatchedKeywords: append([]string{}, sr.result.MatchedKeywords...),
			RankPosition:    -1,
			Disposition:     "over_budget_unsampled",
		}

		if breakdown := sr.result.Breakdown; breakdown != nil {
			candidate.StandingBps = richDataByCID[sr.result.CID].standingBps
			candidate.KeywordOverlap = breakdown.KeywordScore
			candidate.VectorScore = breakdown.VectorScore
			candidate.Gamma = breakdown.Gamma
			candidate.Delta = breakdown.Delta
			candidate.CappedBoost = breakdown.CappedBoost
			candidate.CombinedScore = breakdown.CombinedScore
		}

		if rankPosition, ok := rankedPositions[sr.result.CID]; ok {
			candidate.Disposition = "returned"
			candidate.RankPosition = rankPosition
		}

		candidateScores = append(candidateScores, candidate)
	}

	// D-RECALL-GOVERNOR: below-floor candidates were dropped on the PRE-FRESHNESS
	// combined score inside ScoreAndRank. Persist them for recall-inspector
	// observability (below_floor disposition + combined_score on the gated scale).
	for _, row := range out.FloorDropped {
		matched := append([]string{}, row.Matched...)
		sort.Strings(matched)
		candidateScores = append(candidateScores, CandidateScore{
			CID:             row.ID,
			StandingBps:     richDataByCID[row.ID].standingBps,
			KeywordOverlap:  row.KeywordBoost,
			VectorScore:     row.VectorScore,
			Gamma:           row.Gamma,
			Delta:           row.Delta,
			CappedBoost:     row.CappedBoost,
			CombinedScore:   row.Final, // pre-freshness combined — the score the floor gated on
			MatchedKeywords: matched,
			RankPosition:    -1,
			Disposition:     "below_floor",
		})
	}
	for _, row := range out.StandingDropped {
		candidateScores = append(candidateScores, CandidateScore{
			CID:          row.ID,
			StandingBps:  richDataByCID[row.ID].standingBps,
			VectorScore:  row.VectorScore,
			RankPosition: -1,
			Disposition:  "below_standing",
		})
	}

	var memoryResults []protocol.MemoryResult
	var topScore, secondScore float64
	for i, sr := range rankedResults {
		// CO-021 surfaced CombinedScore. The full per-query breakdown fields are
		// now threaded from ScoreAndRank without changing ranking behavior.
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

	return memoryResults, contested, candidateScores, nil
}

func rankingDivergence(liveRows []RankedRow, counterfactualRows []RankedRow) (int, int, int) {
	livePositions := make(map[string]int, len(liveRows))
	for i, row := range liveRows {
		livePositions[row.ID] = i
	}
	counterfactualPositions := make(map[string]int, len(counterfactualRows))
	for i, row := range counterfactualRows {
		counterfactualPositions[row.ID] = i
	}

	setDiff := 0
	overlapCount := 0
	rankDeltaSum := 0
	for id, livePosition := range livePositions {
		counterfactualPosition, ok := counterfactualPositions[id]
		if !ok {
			setDiff++
			continue
		}
		overlapCount++
		if livePosition > counterfactualPosition {
			rankDeltaSum += livePosition - counterfactualPosition
		} else {
			rankDeltaSum += counterfactualPosition - livePosition
		}
	}
	for id := range counterfactualPositions {
		if _, ok := livePositions[id]; !ok {
			setDiff++
		}
	}

	return setDiff, overlapCount, rankDeltaSum
}

func extractExpectedVectorDim(body string) (int, bool) {
	lower := strings.ToLower(body)
	idx := strings.Index(lower, "expected dim")
	if idx == -1 {
		return 0, false
	}

	segment := lower[idx+len("expected dim"):]
	start := -1
	for i := 0; i < len(segment); i++ {
		if segment[i] >= '0' && segment[i] <= '9' {
			start = i
			break
		}
	}
	if start == -1 {
		return 0, false
	}

	end := start
	for end < len(segment) && segment[end] >= '0' && segment[end] <= '9' {
		end++
	}

	value, err := strconv.Atoi(segment[start:end])
	if err != nil {
		return 0, false
	}

	return value, true
}

type NearDupMatch struct {
	CID   string  `json:"cid"`
	Score float64 `json:"score"`
}

// NearestExistingMemories returns up to `limit` most-similar committed memories
// to the candidate vector by RAW cosine (no boost/epoch), ordered by score desc,
// ARCHIVED excluded. For near-duplicate detection at leader curation. Empty
// slice if none. Caller applies any floor.
func (c *QdrantClient) NearestExistingMemories(ctx context.Context, orgID string, vector []float32, limit int) ([]NearDupMatch, error) {
	if c == nil {
		return nil, fmt.Errorf("qdrant client unavailable")
	}
	if len(vector) == 0 {
		return nil, fmt.Errorf("vector required")
	}
	if limit <= 0 {
		return nil, fmt.Errorf("limit must be positive")
	}

	searchReq := map[string]any{
		"vector":       vector,
		"limit":        limit,
		"with_payload": true,
		"filter": map[string]any{
			"must": []map[string]any{
				{"key": "org_id", "match": map[string]any{"value": orgID}},
			},
			"must_not": []map[string]any{
				{"key": "lifecycle_state", "match": map[string]any{"value": "ARCHIVED"}},
			},
		},
	}

	reqBody, err := json.Marshal(searchReq)
	if err != nil {
		return nil, fmt.Errorf("marshal search request: %w", err)
	}

	url := fmt.Sprintf("%s/collections/%s/points/search", c.restURL, OrgCollectionName(orgID))
	req, err := c.newRequest(ctx, "POST", url, reqBody)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("execute search request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&errResp); err == nil {
			return nil, fmt.Errorf("search failed: %v", errResp)
		}
		return nil, fmt.Errorf("search failed with status %d", resp.StatusCode)
	}

	var searchResp struct {
		Result []struct {
			Score   float64        `json:"score"`
			Payload map[string]any `json:"payload"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&searchResp); err != nil {
		return nil, fmt.Errorf("decode search response: %w", err)
	}

	matches := make([]NearDupMatch, 0, len(searchResp.Result))
	for _, result := range searchResp.Result {
		cid, _ := result.Payload["cid"].(string)
		if cid == "" {
			continue
		}
		matches = append(matches, NearDupMatch{CID: cid, Score: result.Score})
	}

	return matches, nil
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

func getRESTInt32(payload map[string]any, key string, fallback int32) int32 {
	v, ok := payload[key]
	if !ok {
		return fallback
	}
	switch typed := v.(type) {
	case float64:
		return int32(typed)
	case float32:
		return int32(typed)
	case int:
		return int32(typed)
	case int32:
		return typed
	case int64:
		return int32(typed)
	case uint64:
		return int32(typed)
	case uint32:
		return int32(typed)
	default:
		return fallback
	}
}

func getRESTBool(payload map[string]any, key string) bool {
	v, ok := payload[key]
	if !ok {
		return false
	}
	b, _ := v.(bool)
	return b
}

func AddToIndex(ctx context.Context, client *QdrantClient, entry protocol.IndexEntry) error {
	dim := uint64(len(entry.Vector))
	if dim == 0 {
		dim = EMBED_DIM
	}

	if err := client.EnsureCollection(ctx, entry.OrgID, dim); err != nil {
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
	keywordWeights []protocol.KeywordWithWeight,
	vector []float32,
	embeddingModelID string,
	limit uint64,
	includeDormant bool,
	relevanceFloor float64,
	surfaceBudget int,
) ([]protocol.MemoryResult, bool, []CandidateScore, error) {
	return client.QueryPoints(ctx, orgID, vector, keywordWeights, embeddingModelID, limit, includeDormant, relevanceFloor, surfaceBudget)
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

func (c *QdrantClient) UpdateStanding(ctx context.Context, orgID string, memoryCID string, standingBps int32, archived bool) error {
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
	if standingBps < 0 || standingBps > 10000 {
		return fmt.Errorf("standing bps must be in [0,10000]")
	}

	setPayloadReq := map[string]any{
		"payload": map[string]any{
			"standing_bps":      standingBps,
			"standing_archived": archived,
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
			storedKeywords := normalizeKeywords(getRESTStringSlice(point.Payload, "keywords"))
			if len(storedKeywords) == 0 {
				continue
			}

			rewritten := make([]string, 0, len(storedKeywords))
			seen := make(map[string]struct{}, len(storedKeywords))
			changed := false

			for _, lowerStored := range storedKeywords {
				nextKeyword := lowerStored
				if _, ok := oldKeywordSet[lowerStored]; ok {
					nextKeyword = newKeyword
					changed = true
				}
				if _, exists := seen[nextKeyword]; exists {
					if nextKeyword != lowerStored {
						changed = true
					}
					continue
				}
				seen[nextKeyword] = struct{}{}
				rewritten = append(rewritten, nextKeyword)
			}

			if !changed {
				continue
			}

			sort.Strings(rewritten)
			if err := client.setPointKeywords(ctx, orgID, point.ID, rewritten); err != nil {
				return fmt.Errorf("update point keywords: %w", err)
			}
		}

		offset = scrollResp.Result.NextOffset
		if offset == nil {
			break
		}
	}

	return nil
}

func (c *QdrantClient) setPointKeywords(ctx context.Context, orgID string, pointID any, keywords []string) error {
	setPayloadReq := map[string]any{
		"payload": map[string]any{
			"keywords": keywords,
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

type DBQueryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}
