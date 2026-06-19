package retrieval

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

type parityFixtureFile struct {
	Schema string           `json:"schema"`
	Cases  []parityCaseSpec `json:"cases"`
}

type parityCaseSpec struct {
	Name       string                  `json:"name"`
	Candidates []parityCandidateSpec   `json:"candidates"`
	Query      parityQuerySpec         `json:"query"`
	Opts       parityOptsSpec          `json:"opts"`
	Expected   parityExpectedCaseSpec  `json:"expected"`
}

type parityCandidateSpec struct {
	ID             string             `json:"id"`
	VectorScore    float64            `json:"vectorScore"`
	KeywordWeights map[string]float64 `json:"keywordWeights"`
	PendingDenials int                `json:"pendingDenials"`
	Age            int                `json:"age"`
}

type parityQuerySpec struct {
	KeywordWeights map[string]float64 `json:"keywordWeights"`
}

type parityOptsSpec struct {
	Gate               bool    `json:"gate"`
	KeywordBoostFactor float64 `json:"keywordBoostFactor"`
	Delta              float64 `json:"delta"`
	NewMemBoost        bool    `json:"newMemBoost"`
	Grace              float64 `json:"grace"`
	BoostWindow        float64 `json:"boostWindow"`
	NewMemMult         float64 `json:"newMemMult"`
}

type parityExpectedCaseSpec struct {
	Order     []string                `json:"order"`
	Finals    map[string]float64      `json:"finals"`
	DropCount parityExpectedDropCount `json:"dropCount"`
}

type parityExpectedDropCount struct {
	Gate   int `json:"gate"`
	Vector int `json:"vector"`
	Kept   int `json:"kept"`
	Total  int `json:"total"`
}

func TestRankingParity_AgainstSimFixtures(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("failed to resolve test file path")
	}

	fixturePath := filepath.Join(filepath.Dir(file), "../../../../wevibe-protocol/test-vectors/recall-ranking-parity.json")
	if _, err := os.Stat(fixturePath); err != nil {
		if os.IsNotExist(err) {
			t.Skip("parity fixtures not found (cross-repo); run via workspace make parity-check")
		}
		t.Fatalf("failed to stat parity fixtures: %v", err)
	}

	fixtureRaw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("failed reading parity fixtures: %v", err)
	}

	var fixture parityFixtureFile
	if err := json.Unmarshal(fixtureRaw, &fixture); err != nil {
		t.Fatalf("failed unmarshalling parity fixtures: %v", err)
	}

	for _, tc := range fixture.Cases {
		tc := tc
		t.Run(tc.Name, func(t *testing.T) {
			cands := make([]RankCandidate, 0, len(tc.Candidates))
			for _, cand := range tc.Candidates {
				cands = append(cands, RankCandidate{
					ID:             cand.ID,
					VectorScore:    cand.VectorScore,
					KeywordWeights: cand.KeywordWeights,
					PendingDenials: cand.PendingDenials,
					Age:            cand.Age,
				})
			}

			query := RankQuery{KeywordWeights: tc.Query.KeywordWeights}
			opts := RankOpts{
				Gate:               tc.Opts.Gate,
				KeywordBoostFactor: tc.Opts.KeywordBoostFactor,
				Delta:              tc.Opts.Delta,
				NewMemBoost:        tc.Opts.NewMemBoost,
				Grace:              tc.Opts.Grace,
				BoostWindow:        tc.Opts.BoostWindow,
				NewMemMult:         tc.Opts.NewMemMult,
			}

			out := ScoreAndRank(cands, query, opts)

			gotOrder := make([]string, 0, len(out.Rows))
			for _, row := range out.Rows {
				gotOrder = append(gotOrder, row.ID)
			}

			if !reflect.DeepEqual(gotOrder, tc.Expected.Order) {
				t.Fatalf("%s: order mismatch: got=%v want=%v", tc.Name, gotOrder, tc.Expected.Order)
			}

			wantDrops := DropCount{
				Gate:   tc.Expected.DropCount.Gate,
				Vector: tc.Expected.DropCount.Vector,
				Kept:   tc.Expected.DropCount.Kept,
				Total:  tc.Expected.DropCount.Total,
			}

			if out.Drops != wantDrops {
				t.Fatalf("%s: dropCount mismatch: got=%+v want=%+v", tc.Name, out.Drops, wantDrops)
			}

			for _, row := range out.Rows {
				wantFinal, exists := tc.Expected.Finals[row.ID]
				if !exists {
					t.Fatalf("%s: missing expected final for row %q", tc.Name, row.ID)
				}

				if math.Abs(row.Final-wantFinal) >= 1e-9 {
					t.Fatalf("%s: final mismatch for %q: got=%.17g want=%.17g", tc.Name, row.ID, row.Final, wantFinal)
				}
			}
		})
	}
}
