package retrieval

import (
	"math"
	"testing"
)

const optimisticScoreEpsilon = 1e-9

func TestOptimisticWeight_ZeroPendingDenials(t *testing.T) {
	scoreWithoutPending := optimisticFixtureScore(0.72, 0.80, 0.60, 0)
	scoreWithExplicitZeroPending := applyPendingDenialDecay(scoreWithoutPending, 0)

	assertAlmostEqual(t, scoreWithoutPending, scoreWithExplicitZeroPending)
}

func TestOptimisticWeight_PendingDenialsReduceScore(t *testing.T) {
	baseScore := optimisticFixtureScore(0.72, 0.80, 0.60, 0)
	adjustedScore := optimisticFixtureScore(0.72, 0.80, 0.60, 3)
	expected := baseScore - 3*(float64(DenialDecayBPS)/10000.0)

	if adjustedScore >= baseScore {
		t.Fatalf("expected pending denials to reduce score: base=%.12f adjusted=%.12f", baseScore, adjustedScore)
	}
	assertAlmostEqual(t, expected, adjustedScore)
}

func TestOptimisticWeight_ParityAfterChainConfirmation(t *testing.T) {
	const pendingDenials = 3

	scoreWithZeroDenials := optimisticFixtureScore(0.72, 0.80, 0.60, 0)
	scoreWithPendingDenials := optimisticFixtureScore(0.72, 0.80, 0.60, pendingDenials)
	scoreAfterChainConfirmation := optimisticFixtureScore(0.72, 0.80, 0.60, 0)

	restored := scoreWithPendingDenials + float64(pendingDenials)*(float64(DenialDecayBPS)/10000.0)
	assertAlmostEqual(t, restored, scoreAfterChainConfirmation)
	assertAlmostEqual(t, scoreWithZeroDenials, scoreAfterChainConfirmation)
}

func TestOptimisticWeight_ScoreFloorAtZero(t *testing.T) {
	flooredScore := optimisticFixtureScore(0.02, 0.0, 0.0, 1)
	assertAlmostEqual(t, 0, flooredScore)
}

func optimisticFixtureScore(vectorScore, storedWeight, queryWeight float64, pendingDenials int) float64 {
	storedWeights := map[string]float64{"safety": storedWeight}
	storedKeywords := []string{"Safety"}
	queryWeights := map[string]float64{"safety": queryWeight}

	keywordBoost, _, _ := computeKeywordScore(storedWeights, storedKeywords, queryWeights)
	finalScore := vectorScore + keywordBoost*0.1

	return applyPendingDenialDecay(finalScore, pendingDenials)
}

func assertAlmostEqual(t *testing.T, expected, actual float64) {
	t.Helper()

	if math.Abs(expected-actual) > optimisticScoreEpsilon {
		t.Fatalf("expected %.12f, got %.12f (epsilon %.1e)", expected, actual, optimisticScoreEpsilon)
	}
}
