package retrieval

import (
	"math"
	"sort"
	"strings"
)

type RankCandidate struct {
	ID             string
	VectorScore    float64
	KeywordWeights map[string]float64
	PendingDenials int
	Age            int
}

type RankQuery struct {
	KeywordWeights map[string]float64
}

// RankOpts mirrors rank.mjs options.
//
// Numeric fields are intentionally not auto-defaulted when zero-valued;
// callers must pass explicit values for parity-critical behavior.
type RankOpts struct {
	Gate               bool
	KeywordBoostFactor float64
	NewMemBoost        bool
	Grace              float64
	BoostWindow        float64
	NewMemMult         float64
}

type RankedRow struct {
	ID           string
	Final        float64
	VectorScore  float64
	KeywordBoost float64
	Matched      []string
}

type DropCount struct {
	Gate   int
	Vector int
	Kept   int
	Total  int
}

type RankOutput struct {
	Rows  []RankedRow
	Drops DropCount
}

type rankedRowWithIndex struct {
	row   RankedRow
	index int
}

func normalizeWeightMap(weights map[string]float64) map[string]float64 {
	normalized := make(map[string]float64)
	if len(weights) == 0 {
		return normalized
	}

	rawKeys := make([]string, 0, len(weights))
	for rawKey := range weights {
		rawKeys = append(rawKeys, rawKey)
	}
	sort.Strings(rawKeys)

	for _, rawKey := range rawKeys {
		keyword := strings.ToLower(strings.TrimSpace(rawKey))
		if keyword == "" {
			continue
		}

		weight := weights[rawKey]
		if math.IsNaN(weight) || math.IsInf(weight, 0) {
			normalized[keyword] = 0
			continue
		}

		normalized[keyword] = weight
	}

	return normalized
}

func keywordScore(memoryWeights, queryWeights map[string]float64) (float64, []string) {
	if len(memoryWeights) == 0 || len(queryWeights) == 0 {
		return 0, []string{}
	}

	keywords := make([]string, 0, len(memoryWeights))
	for keyword := range memoryWeights {
		keywords = append(keywords, keyword)
	}
	sort.Strings(keywords)

	boost := 0.0
	matched := make([]string, 0)

	for _, keyword := range keywords {
		queryWeight, ok := queryWeights[keyword]
		if !ok {
			continue
		}

		boost += queryWeight * memoryWeights[keyword]
		matched = append(matched, keyword)
	}

	return boost, matched
}

func ScoreAndRank(cands []RankCandidate, query RankQuery, opts RankOpts) RankOutput {
	normalizedQueryWeights := normalizeWeightMap(query.KeywordWeights)

	rows := make([]rankedRowWithIndex, 0, len(cands))
	drops := DropCount{Total: len(cands)}

	for i, cand := range cands {
		if cand.VectorScore <= 0 {
			drops.Vector++
			continue
		}

		candidateKeywordWeights := normalizeWeightMap(cand.KeywordWeights)
		boost, matched := keywordScore(candidateKeywordWeights, normalizedQueryWeights)

		if opts.Gate && len(normalizedQueryWeights) > 0 && len(matched) == 0 {
			drops.Gate++
			continue
		}

		final := cand.VectorScore + boost*opts.KeywordBoostFactor

		if cand.PendingDenials > 0 {
			final = math.Max(0, final-float64(cand.PendingDenials)*0.05)
		}

		if opts.NewMemBoost && final > 0 {
			window := opts.Grace + opts.BoostWindow
			fraction := 0.0
			if window > 0 {
				fraction = math.Max(0, 1-float64(cand.Age)/window)
			}
			final = final * (1 + opts.NewMemMult*fraction)
		}

		rows = append(rows, rankedRowWithIndex{
			row: RankedRow{
				ID:           cand.ID,
				Final:        final,
				VectorScore:  cand.VectorScore,
				KeywordBoost: boost,
				Matched:      matched,
			},
			index: i,
		})
	}

	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].row.Final != rows[j].row.Final {
			return rows[i].row.Final > rows[j].row.Final
		}
		return rows[i].index < rows[j].index
	})

	outputRows := make([]RankedRow, 0, len(rows))
	for _, row := range rows {
		outputRows = append(outputRows, row.row)
	}

	drops.Kept = len(outputRows)

	return RankOutput{
		Rows:  outputRows,
		Drops: drops,
	}
}
