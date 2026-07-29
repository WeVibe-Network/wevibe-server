package retrieval

import (
	"math"
	"reflect"
	"testing"
)

func TestScoreAndRank_SelftestParity(t *testing.T) {
	query := RankQuery{
		Keywords: []string{"nginx"},
	}

	cands := []RankCandidate{
		{
			ID:          "A",
			VectorScore: 0.9,
			Keywords:    []string{"nginx"},
			StandingBps: 10000,
		},
		{
			ID:          "B",
			VectorScore: 0.8,
			Keywords:    []string{"node"},
			StandingBps: 10000,
		},
		{
			ID:          "C",
			VectorScore: 0.6,
			Keywords:    []string{"nginx"},
			StandingBps: 10000,
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

func TestScoreAndRank_DropsBelowStandingThreshold(t *testing.T) {
	out := ScoreAndRank([]RankCandidate{
		{ID: "visible", VectorScore: 0.8, Keywords: []string{"nginx"}, StandingBps: 1501},
		{ID: "threshold", VectorScore: 0.9, Keywords: []string{"nginx"}, StandingBps: 1500},
		{ID: "archived", VectorScore: 0.95, Keywords: []string{"nginx"}, StandingBps: 10000, Archived: true},
	}, RankQuery{Keywords: []string{"nginx"}}, RankOpts{KeywordBoostFactor: 0.1, StandingThresholdBps: 1500})

	if got, want := rankedIDs(out.Rows), []string{"visible"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("visible rows mismatch: got=%v want=%v", got, want)
	}
	if out.Drops.Standing != 2 {
		t.Fatalf("standing drop mismatch: got=%d want=2", out.Drops.Standing)
	}
}

func TestScoreAndRank_OverlapBoostScaledByStanding(t *testing.T) {
	out := ScoreAndRank([]RankCandidate{{
		ID:          "half-standing",
		VectorScore: 0.8,
		Keywords:    []string{"alpha", "beta"},
		StandingBps: 5000,
	}}, RankQuery{Keywords: []string{"alpha", "gamma"}}, RankOpts{KeywordBoostFactor: 0.1, Delta: 0.15, StandingThresholdBps: 1500})

	if len(out.Rows) != 1 {
		t.Fatalf("expected one row, got %d", len(out.Rows))
	}
	row := out.Rows[0]
	if row.KeywordBoost != 0.5 {
		t.Fatalf("overlap mismatch: got=%f want=0.5", row.KeywordBoost)
	}
	if row.CappedBoost != 0.025 {
		t.Fatalf("capped boost mismatch: got=%f want=0.025", row.CappedBoost)
	}
	if math.Abs(row.Final-0.825) > 1e-9 {
		t.Fatalf("final mismatch: got=%f want=0.825", row.Final)
	}
}

func TestScoreAndRank_EmptyQueryKeywordsNoBoostNotDropped(t *testing.T) {
	out := ScoreAndRank([]RankCandidate{{
		ID:          "no-query-keywords",
		VectorScore: 0.8,
		Keywords:    []string{"alpha"},
		StandingBps: 10000,
	}}, RankQuery{}, RankOpts{KeywordBoostFactor: 0.1, StandingThresholdBps: 1500})

	if len(out.Rows) != 1 {
		t.Fatalf("expected one row, got %d", len(out.Rows))
	}
	if out.Rows[0].KeywordBoost != 0 || out.Rows[0].CappedBoost != 0 || out.Rows[0].Final != 0.8 {
		t.Fatalf("unexpected empty-query scoring: %#v", out.Rows[0])
	}
}

func rankedIDs(rows []RankedRow) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids
}
