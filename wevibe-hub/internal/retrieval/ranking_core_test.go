package retrieval

import (
	"reflect"
	"testing"
)

func TestScoreAndRank_SelftestParity(t *testing.T) {
	query := RankQuery{
		KeywordWeights: map[string]float64{"nginx": 1},
	}

	cands := []RankCandidate{
		{
			ID:             "A",
			VectorScore:    0.9,
			KeywordWeights: map[string]float64{"nginx": 1},
		},
		{
			ID:             "B",
			VectorScore:    0.8,
			KeywordWeights: map[string]float64{"node": 1},
		},
		{
			ID:             "C",
			VectorScore:    0.6,
			KeywordWeights: map[string]float64{"nginx": 0.2},
		},
	}

	opts := RankOpts{
		Gate:               true,
		KeywordBoostFactor: 0.1,
		NewMemBoost:        false,
		Grace:              20,
		BoostWindow:        30,
		NewMemMult:         0.5,
	}

	gateOn := ScoreAndRank(cands, query, opts)
	if got, want := rankedIDs(gateOn.Rows), []string{"A", "C"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("gate on order mismatch: got=%v want=%v", got, want)
	}
	if gateOn.Drops.Gate != 1 {
		t.Fatalf("gate on gate-drop mismatch: got=%d want=1", gateOn.Drops.Gate)
	}

	opts.Gate = false
	gateOff := ScoreAndRank(cands, query, opts)
	if got, want := rankedIDs(gateOff.Rows), []string{"A", "B", "C"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("gate off order mismatch: got=%v want=%v", got, want)
	}
	if gateOff.Drops.Gate != 0 {
		t.Fatalf("gate off gate-drop mismatch: got=%d want=0", gateOff.Drops.Gate)
	}
}

func rankedIDs(rows []RankedRow) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids
}
