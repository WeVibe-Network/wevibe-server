package retrieval

import (
	"math"
	"sort"
	"strings"
)

type RankCandidate struct {
	ID             string
	VectorScore    float64
	Keywords       []string
	StandingBps    int32
	Archived       bool
	PendingDenials int
	Age            int
}

type RankQuery struct {
	Keywords []string
}

// RankOpts mirrors rank.mjs options.
//
// Numeric fields are intentionally not auto-defaulted when zero-valued;
// callers must pass explicit values for parity-critical behavior.
type RankOpts struct {
	Gate               bool
	KeywordBoostFactor float64
	Delta              float64
	NewMemBoost        bool
	Grace              float64
	BoostWindow        float64
	NewMemMult         float64
	// Floor is the absolute relevance floor (D-RECALL-GOVERNOR). When > 0, a
	// candidate whose PRE-FRESHNESS combined score (VectorScore + cappedBoost)
	// is below Floor is dropped before pending-denials and the D-9.4 freshness
	// boost — mirrors wevibe-sim/recall-sim/pipeline/rank.mjs scoreDetailed.
	Floor float64
	// StandingThresholdBps is the edge archival visibility threshold. Candidates
	// at or below it, or explicitly archived by standing projection, are dropped
	// before scoring.
	StandingThresholdBps int32
}

type RankKeywordMatch struct {
	Keyword string
}

type RankedRow struct {
	ID             string
	Final          float64
	VectorScore    float64
	KeywordBoost   float64
	Gamma          float64
	Delta          float64
	CappedBoost    float64
	Matched        []string
	KeywordMatches []RankKeywordMatch
	UnmatchedQuery []string
}

type DropCount struct {
	Gate     int
	Vector   int
	Kept     int
	Total    int
	Floor    int
	Standing int
}

type RankOutput struct {
	Rows  []RankedRow
	Drops DropCount
	// FloorDropped carries the candidates dropped by the relevance floor, each
	// with Final set to its PRE-FRESHNESS combined score (VectorScore+CappedBoost),
	// so the caller can persist below_floor observability (recall inspector).
	FloorDropped    []RankedRow
	StandingDropped []RankedRow
}

type rankedRowWithIndex struct {
	row   RankedRow
	index int
}

func normalizeKeywords(keywords []string) []string {
	if len(keywords) == 0 {
		return []string{}
	}
	set := make(map[string]struct{}, len(keywords))
	for _, rawKeyword := range keywords {
		keyword := strings.ToLower(strings.TrimSpace(rawKeyword))
		if keyword == "" {
			continue
		}
		set[keyword] = struct{}{}
	}
	normalized := make([]string, 0, len(set))
	for keyword := range set {
		normalized = append(normalized, keyword)
	}
	sort.Strings(normalized)
	return normalized
}

func keywordOverlap(memoryKeywords, queryKeywords []string) (float64, []string, []RankKeywordMatch) {
	if len(memoryKeywords) == 0 || len(queryKeywords) == 0 {
		return 0, []string{}, []RankKeywordMatch{}
	}

	memorySet := make(map[string]struct{}, len(memoryKeywords))
	for _, keyword := range memoryKeywords {
		memorySet[keyword] = struct{}{}
	}

	matched := make([]string, 0)
	matchedDetails := make([]RankKeywordMatch, 0)

	for _, keyword := range queryKeywords {
		if _, ok := memorySet[keyword]; !ok {
			continue
		}
		matched = append(matched, keyword)
		matchedDetails = append(matchedDetails, RankKeywordMatch{Keyword: keyword})
	}

	return float64(len(matched)) / float64(len(queryKeywords)), matched, matchedDetails
}

func unmatchedQueryKeywords(sortedQueryKeywords []string, matched []string) []string {
	if len(sortedQueryKeywords) == 0 {
		return []string{}
	}
	if len(matched) == 0 {
		return append([]string{}, sortedQueryKeywords...)
	}

	matchedSet := make(map[string]struct{}, len(matched))
	for _, keyword := range matched {
		matchedSet[keyword] = struct{}{}
	}

	unmatched := make([]string, 0, len(sortedQueryKeywords))
	for _, keyword := range sortedQueryKeywords {
		if _, ok := matchedSet[keyword]; ok {
			continue
		}
		unmatched = append(unmatched, keyword)
	}

	return unmatched
}

func ScoreAndRank(cands []RankCandidate, query RankQuery, opts RankOpts) RankOutput {
	queryKeywords := normalizeKeywords(query.Keywords)

	rows := make([]rankedRowWithIndex, 0, len(cands))
	floorDropped := make([]RankedRow, 0)
	standingDropped := make([]RankedRow, 0)
	drops := DropCount{Total: len(cands)}

	for i, cand := range cands {
		if cand.Archived || cand.StandingBps <= opts.StandingThresholdBps {
			standingDropped = append(standingDropped, RankedRow{ID: cand.ID, VectorScore: cand.VectorScore})
			drops.Standing++
			continue
		}
		if cand.VectorScore <= 0 {
			drops.Vector++
			continue
		}

		candidateKeywords := normalizeKeywords(cand.Keywords)
		overlap, matched, matchedDetails := keywordOverlap(candidateKeywords, queryKeywords)

		if opts.Gate && len(queryKeywords) > 0 && len(matched) == 0 {
			drops.Gate++
			continue
		}

		standingFactor := float64(cand.StandingBps) / 10000.0
		gammaBoost := opts.KeywordBoostFactor * overlap * standingFactor
		cappedBoost := gammaBoost
		if opts.Delta > 0 {
			deltaCap := opts.Delta * cand.VectorScore
			if deltaCap < cappedBoost {
				cappedBoost = deltaCap
			}
		}
		final := cand.VectorScore + cappedBoost

		if opts.Floor > 0 && final < opts.Floor {
			floorDropped = append(floorDropped, RankedRow{
				ID:             cand.ID,
				Final:          final,
				VectorScore:    cand.VectorScore,
				KeywordBoost:   overlap,
				Gamma:          opts.KeywordBoostFactor,
				Delta:          opts.Delta,
				CappedBoost:    cappedBoost,
				Matched:        matched,
				KeywordMatches: matchedDetails,
				UnmatchedQuery: unmatchedQueryKeywords(queryKeywords, matched),
			})
			drops.Floor++
			continue
		}

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
				ID:             cand.ID,
				Final:          final,
				VectorScore:    cand.VectorScore,
				KeywordBoost:   overlap,
				Gamma:          opts.KeywordBoostFactor,
				Delta:          opts.Delta,
				CappedBoost:    cappedBoost,
				Matched:        matched,
				KeywordMatches: matchedDetails,
				UnmatchedQuery: unmatchedQueryKeywords(queryKeywords, matched),
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
		Rows:            outputRows,
		Drops:           drops,
		FloorDropped:    floorDropped,
		StandingDropped: standingDropped,
	}
}
