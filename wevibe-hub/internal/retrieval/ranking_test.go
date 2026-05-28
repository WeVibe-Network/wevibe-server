package retrieval

import (
	"fmt"
	"math"
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

	gotA := r1.probabilisticRank(cloneScoredResults(scored), 5)
	gotB := r2.probabilisticRank(cloneScoredResults(scored), 5)

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
		ranked := ranker.probabilisticRank(cloneScoredResults(sortedInput), 5)
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
		ranked := ranker.probabilisticRank(cloneScoredResults(scored), 5)
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
		ranked := ranker.probabilisticRank(cloneScoredResults(scored), 5)
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

	ranked := ranker.probabilisticRank(cloneScoredResults(scored), 5)
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

	ranked := ranker.probabilisticRank(cloneScoredResults(scored), 10)
	t.Logf("limit>len ranked CIDs: %v", extractCIDs(ranked))
	if len(ranked) != len(scored) {
		t.Fatalf("expected %d results, got %d", len(scored), len(ranked))
	}
	requireSameCIDOrder(t, ranked, scored)
}

func TestApplyNewMemoryBoost_PeakAtAgeZero(t *testing.T) {
	ranker := rankerWithSeed(1, 0.7)
	rawScore := 1.0
	got := ranker.applyNewMemoryBoost(rawScore, 100, 100)
	want := 1.5
	t.Logf("age=0 boosted score got=%.12f want=%.12f", got, want)
	if !almostEqual(got, want, 1e-9) {
		t.Fatalf("unexpected boosted score: got=%.12f want=%.12f", got, want)
	}
}

func TestApplyNewMemoryBoost_HalfwayThroughWindow(t *testing.T) {
	ranker := rankerWithSeed(2, 0.7)
	rawScore := 1.0
	got := ranker.applyNewMemoryBoost(rawScore, 100, 125)
	want := 1.25
	t.Logf("half-window boosted score got=%.12f want=%.12f", got, want)
	if !almostEqual(got, want, 1e-9) {
		t.Fatalf("unexpected boosted score: got=%.12f want=%.12f", got, want)
	}
}

func TestApplyNewMemoryBoost_OutsideWindow_NoBoost(t *testing.T) {
	ranker := rankerWithSeed(3, 0.7)
	rawScore := 1.0
	got := ranker.applyNewMemoryBoost(rawScore, 100, 160)
	want := rawScore
	t.Logf("outside-window score got=%.12f want=%.12f", got, want)
	if !almostEqual(got, want, 1e-9) {
		t.Fatalf("expected no boost outside window: got=%.12f want=%.12f", got, want)
	}
}

func TestApplyNewMemoryBoost_ZeroRawScore(t *testing.T) {
	ranker := rankerWithSeed(4, 0.7)
	got := ranker.applyNewMemoryBoost(0, 100, 100)
	t.Logf("zero raw score output=%.12f", got)
	if got != 0 {
		t.Fatalf("expected zero output for zero raw score, got %.12f", got)
	}
}

func TestApplyNewMemoryBoost_DisabledViaZeroMult(t *testing.T) {
	ranker := &ProbabilisticRanker{
		Temperature:       0.7,
		NewMemBoostMult:   0,
		NewMemBoostWindow: 30,
		GraceEpochs:       20,
		RNG:               rand.New(rand.NewSource(5)),
	}
	rawScore := 0.77
	got := ranker.applyNewMemoryBoost(rawScore, 100, 100)
	t.Logf("zero-mult score got=%.12f want=%.12f", got, rawScore)
	if !almostEqual(got, rawScore, 1e-9) {
		t.Fatalf("expected raw score when multiplier is disabled: got=%.12f want=%.12f", got, rawScore)
	}
}

func TestProbabilisticRank_TwoCandidates_ServePerEqualsOne(t *testing.T) {
	scored := makeScoredResults([]float64{0.9, 0.1})
	ranker := rankerWithSeed(55, 0.7)

	ranked := ranker.probabilisticRank(cloneScoredResults(scored), 1)
	t.Logf("two-candidate limit=1 ranked CIDs: %v", extractCIDs(ranked))
	if len(ranked) != 1 {
		t.Fatalf("expected exactly one result, got %d", len(ranked))
	}
	if ranked[0].result.CID != scored[0].result.CID {
		t.Fatalf("unexpected top result: got=%s want=%s", ranked[0].result.CID, scored[0].result.CID)
	}
}

func extractCIDs(results []scoredResult) []string {
	cids := make([]string, 0, len(results))
	for _, r := range results {
		cids = append(cids, r.result.CID)
	}
	return cids
}

func almostEqual(a, b, epsilon float64) bool {
	return math.Abs(a-b) <= epsilon
}
