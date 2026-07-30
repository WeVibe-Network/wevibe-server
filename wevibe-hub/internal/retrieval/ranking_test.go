package retrieval

import (
	"fmt"
	"math/rand"
	"sort"
	"testing"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

func makeScoredResults(scores []float64) []scoredResult {
	results := make([]scoredResult, len(scores))
	for i, score := range scores {
		results[i] = scoredResult{
			result:        protocol.MemoryResult{CID: fmt.Sprintf("mem-%02d", i)},
			weightedScore: score,
		}
	}
	return results
}

func cloneScoredResults(in []scoredResult) []scoredResult {
	out := make([]scoredResult, len(in))
	copy(out, in)
	return out
}

func rankerWithSeed(seed int64, temperature float64) *ProbabilisticRanker {
	return &ProbabilisticRanker{
		Temperature:       temperature,
		NewMemBoostMult:   0.5,
		NewMemBoostWindow: 30,
		GraceEpochs:       20,
		RNG:               rand.New(rand.NewSource(seed)),
	}
}

func requireSameCIDOrder(t *testing.T, got, want []scoredResult) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("length mismatch: got=%d want=%d", len(got), len(want))
	}
	for i := range got {
		if got[i].result.CID != want[i].result.CID {
			t.Fatalf("CID mismatch at %d: got=%s want=%s", i, got[i].result.CID, want[i].result.CID)
		}
	}
}

func TestProbabilisticRank_DeterministicWithFixedSeed(t *testing.T) {
	scored := makeScoredResults([]float64{1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1})

	r1 := rankerWithSeed(42, 0.7)
	r2 := rankerWithSeed(42, 0.7)

	gotA, probeA := r1.probabilisticRank(cloneScoredResults(scored), 5)
	gotB, probeB := r2.probabilisticRank(cloneScoredResults(scored), 5)
	if probeA || probeB {
		t.Fatalf("uniform exposure probe unexpectedly enabled: A=%v B=%v", probeA, probeB)
	}

	t.Logf("deterministic run A: %v", extractCIDs(gotA))
	t.Logf("deterministic run B: %v", extractCIDs(gotB))
	requireSameCIDOrder(t, gotA, gotB)
}

func TestProbabilisticRank_Position1IsStrictArgmax(t *testing.T) {
	rng := rand.New(rand.NewSource(77))
	rawScores := make([]float64, 10)
	for i := range rawScores {
		rawScores[i] = rng.Float64() + float64(i)*1e-9
	}

	input := makeScoredResults(rawScores)
	argmaxCID := input[0].result.CID
	argmaxScore := input[0].weightedScore
	for _, sr := range input[1:] {
		if sr.weightedScore > argmaxScore {
			argmaxScore = sr.weightedScore
			argmaxCID = sr.result.CID
		}
	}

	sortedInput := cloneScoredResults(input)
	sort.SliceStable(sortedInput, func(i, j int) bool {
		return sortedInput[i].weightedScore > sortedInput[j].weightedScore
	})

	t.Logf("argmax CID=%s score=%.8f", argmaxCID, argmaxScore)
	for seed := int64(1); seed <= 100; seed++ {
		ranker := rankerWithSeed(seed, 0.7)
		ranked, probed := ranker.probabilisticRank(cloneScoredResults(sortedInput), 5)
		if probed {
			t.Fatalf("seed=%d uniform exposure probe unexpectedly enabled", seed)
		}
		if len(ranked) == 0 {
			t.Fatalf("seed=%d returned no results", seed)
		}
		if ranked[0].result.CID != argmaxCID {
			t.Fatalf("seed=%d top CID mismatch: got=%s want=%s", seed, ranked[0].result.CID, argmaxCID)
		}
	}
}

func TestProbabilisticRank_LowTemperatureConcentratesTop(t *testing.T) {
	scored := makeScoredResults([]float64{1.0, 0.5, 0.49, 0.48, 0.47, 0.46, 0.45, 0.44, 0.43, 0.42})
	expectedSecond := scored[1].result.CID
	expectedThird := scored[2].result.CID

	matchCount := 0
	for seed := int64(1); seed <= 100; seed++ {
		ranker := rankerWithSeed(seed, 0.01)
		ranked, _ := ranker.probabilisticRank(cloneScoredResults(scored), 5)
		if len(ranked) >= 3 && ranked[1].result.CID == expectedSecond && ranked[2].result.CID == expectedThird {
			matchCount++
		}
	}

	t.Logf("low-temp top-rest match count: %d/100", matchCount)
	if matchCount < 60 {
		t.Fatalf("low temperature did not concentrate enough near top rest candidates: got=%d want>=60", matchCount)
	}
}

func TestProbabilisticRank_HighTemperatureFlattensDistribution(t *testing.T) {
	scored := makeScoredResults([]float64{1.0, 0.5, 0.49, 0.48, 0.47, 0.46, 0.45, 0.44, 0.43, 0.42})
	frequency := make(map[string]int, len(scored)-1)
	for _, sr := range scored[1:] {
		frequency[sr.result.CID] = 0
	}

	for seed := int64(1); seed <= 100; seed++ {
		ranker := rankerWithSeed(seed, 2.0)
		ranked, _ := ranker.probabilisticRank(cloneScoredResults(scored), 5)
		for i := 1; i < len(ranked); i++ {
			frequency[ranked[i].result.CID]++
		}
	}

	maxFreq := 0
	minFreq := int(^uint(0) >> 1)
	for cid, count := range frequency {
		t.Logf("high-temp frequency %s=%d", cid, count)
		if count > maxFreq {
			maxFreq = count
		}
		if count < minFreq {
			minFreq = count
		}
	}

	if minFreq == 0 {
		t.Fatalf("high temperature flattening check invalid: min frequency is zero, max=%d", maxFreq)
	}
	ratio := float64(maxFreq) / float64(minFreq)
	t.Logf("high-temp max/min ratio=%.4f", ratio)
	if ratio >= 5.0 {
		t.Fatalf("distribution too concentrated at high temperature: ratio=%.4f (max=%d min=%d)", ratio, maxFreq, minFreq)
	}
}

func TestProbabilisticRank_AllScoresZero_NoSampling(t *testing.T) {
	scored := makeScoredResults([]float64{0, 0, 0, 0, 0})
	ranker := rankerWithSeed(9, 0.7)

	ranked, probed := ranker.probabilisticRank(cloneScoredResults(scored), 5)
	if probed {
		t.Fatalf("uniform exposure probe unexpectedly enabled")
	}
	t.Logf("all-zero ranked CIDs: %v", extractCIDs(ranked))
	if len(ranked) != 1 {
		t.Fatalf("expected only strict position-1 result when all sampling weights are zero; got %d", len(ranked))
	}
	if ranked[0].result.CID != scored[0].result.CID {
		t.Fatalf("unexpected top result: got=%s want=%s", ranked[0].result.CID, scored[0].result.CID)
	}
}

func TestProbabilisticRank_LimitGreaterThanCandidates(t *testing.T) {
	scored := makeScoredResults([]float64{1.0, 0.8, 0.6})
	ranker := rankerWithSeed(15, 0.7)

	ranked, probed := ranker.probabilisticRank(cloneScoredResults(scored), 10)
	if probed {
		t.Fatalf("uniform exposure probe unexpectedly enabled")
	}
	t.Logf("limit>len ranked CIDs: %v", extractCIDs(ranked))
	if len(ranked) != len(scored) {
		t.Fatalf("expected %d results, got %d", len(scored), len(ranked))
	}
	requireSameCIDOrder(t, ranked, scored)
}

func TestProbabilisticRank_TwoCandidates_ServePerEqualsOne(t *testing.T) {
	scored := makeScoredResults([]float64{0.9, 0.1})
	ranker := rankerWithSeed(55, 0.7)

	ranked, probed := ranker.probabilisticRank(cloneScoredResults(scored), 1)
	if probed {
		t.Fatalf("uniform exposure probe unexpectedly enabled")
	}
	t.Logf("two-candidate limit=1 ranked CIDs: %v", extractCIDs(ranked))
	if len(ranked) != 1 {
		t.Fatalf("expected exactly one result, got %d", len(ranked))
	}
	if ranked[0].result.CID != scored[0].result.CID {
		t.Fatalf("unexpected top result: got=%s want=%s", ranked[0].result.CID, scored[0].result.CID)
	}
}

func TestProbabilisticRank_UniformExposureOffMatchesExistingSampler(t *testing.T) {
	scored := makeScoredResults([]float64{1.0, 0.9, 0.8, 0.7, 0.6, 0.5})

	baseline := rankerWithSeed(123, 0.7)
	off := rankerWithSeed(123, 0.7)
	off.UniformExposureFraction = 0

	want, wantProbed := baseline.probabilisticRank(cloneScoredResults(scored), 4)
	got, gotProbed := off.probabilisticRank(cloneScoredResults(scored), 4)
	if wantProbed || gotProbed {
		t.Fatalf("uniform exposure probe unexpectedly enabled: baseline=%v off=%v", wantProbed, gotProbed)
	}
	requireSameCIDOrder(t, got, want)
}

func TestProbabilisticRank_UniformExposureSamplesTopUniformly(t *testing.T) {
	scored := makeScoredResults([]float64{1.0, 0.01, 0.01, 0.01, 0.01})
	argmaxCID := scored[0].result.CID
	topCounts := make(map[string]int, len(scored))
	argmaxTopCount := 0

	for seed := int64(1); seed <= 500; seed++ {
		ranker := rankerWithSeed(seed, 0.7)
		ranker.UniformExposureFraction = 1.0
		ranked, probed := ranker.probabilisticRank(cloneScoredResults(scored), 3)
		if !probed {
			t.Fatalf("seed=%d expected uniform exposure probe", seed)
		}
		if len(ranked) == 0 {
			t.Fatalf("seed=%d returned no results", seed)
		}
		topCounts[ranked[0].result.CID]++
		if ranked[0].result.CID == argmaxCID {
			argmaxTopCount++
		}
	}

	if argmaxTopCount == 500 {
		t.Fatalf("uniform exposure kept strict argmax at position 0 for every draw")
	}
	for _, sr := range scored[1:] {
		count := topCounts[sr.result.CID]
		t.Logf("uniform top frequency %s=%d", sr.result.CID, count)
		if count < 60 || count > 140 {
			t.Fatalf("low-scoring candidate %s top frequency outside rough uniform band: got=%d", sr.result.CID, count)
		}
	}
}

func TestProbabilisticRank_UniformExposureReturnsLimitDistinctCandidates(t *testing.T) {
	scored := makeScoredResults([]float64{1.0, 0.9, 0.8, 0.7, 0.6})
	ranker := rankerWithSeed(88, 0.7)
	ranker.UniformExposureFraction = 1.0

	ranked, probed := ranker.probabilisticRank(cloneScoredResults(scored), 4)
	if !probed {
		t.Fatalf("expected uniform exposure probe")
	}
	if len(ranked) != 4 {
		t.Fatalf("expected exactly 4 results, got %d", len(ranked))
	}
	seen := make(map[string]struct{}, len(ranked))
	for _, sr := range ranked {
		if _, ok := seen[sr.result.CID]; ok {
			t.Fatalf("duplicate CID returned: %s", sr.result.CID)
		}
		seen[sr.result.CID] = struct{}{}
	}
}

func TestProbabilisticRank_UniformExposureDeterministicWithFixedSeed(t *testing.T) {
	scored := makeScoredResults([]float64{1.0, 0.9, 0.8, 0.7, 0.6, 0.5})
	r1 := rankerWithSeed(321, 0.7)
	r2 := rankerWithSeed(321, 0.7)
	r1.UniformExposureFraction = 0.5
	r2.UniformExposureFraction = 0.5

	gotA, probeA := r1.probabilisticRank(cloneScoredResults(scored), 4)
	gotB, probeB := r2.probabilisticRank(cloneScoredResults(scored), 4)
	if probeA != probeB {
		t.Fatalf("probe decision mismatch: A=%v B=%v", probeA, probeB)
	}
	requireSameCIDOrder(t, gotA, gotB)
}

func extractCIDs(results []scoredResult) []string {
	cids := make([]string, 0, len(results))
	for _, r := range results {
		cids = append(cids, r.result.CID)
	}
	return cids
}
